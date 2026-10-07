import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { startHealthServer } from "./health.ts";
import { loadRoster, rosterPath } from "./roster.ts";
import { SECTION_ROLE_IDS } from "./roles.ts";
import { decideVerification, store, type VerifyRecord } from "./store.ts";
import { verifyEmail } from "./verify.ts";

const MODAL_ID = "verify:email";
const EMAIL_FIELD_ID = "email";
const COOLDOWN_MS = 5_000;

/** Same answer for both "another user already used this email" and "there is no data for it". */
const MANUAL_REVIEW_MESSAGE =
  "A user has already used this email address, or I have no data for it — you may need a manual review from a server admin.";
const STORAGE_DOWN_MESSAGE =
  "I can't reach the verification store right now — please try again in a minute.";

const startedAt = Date.now();
const state = {
  gateway: "starting",
  detail: "Starting up…",
  rosterEntries: 0,
  startedAt,
};

// Readiness endpoint runs first so it can report misconfiguration instead of hanging.
// The preview is only "ready" once BOTH the Discord gateway and Redis are up.
startHealthServer(
  () => {
    const redis = store.statusInfo();
    return {
      ...state,
      redis: redis.status,
      redisDetail: redis.detail,
      ok: state.gateway === "ready" && redis.status === "ready",
    };
  },
  async () => {
    try {
      return { records: await store.listRecords() };
    } catch (error) {
      const message =
        (error instanceof Error ? error.message : String(error)).trim() ||
        "the verification store is unreachable";
      console.error(`[panel] could not list records: ${message}`);
      return { records: null, recordsError: message };
    }
  },
);
void store.start();

const lastAttemptByUser = new Map<string, number>();

const token = process.env.DISCORD_BOT_TOKEN?.trim();

if (!token) {
  state.gateway = "stopped";
  state.detail =
    "DISCORD_BOT_TOKEN is not set. Add it in Settings → Environment, then restart the preview.";
  console.error(`[bot] ${state.detail}`);
} else {
  void startBot(token).catch((error) => {
    state.gateway = "error";
    state.detail = error instanceof Error ? error.message : String(error);
    console.error(`[bot] failed to start: ${state.detail}`);
  });
}

async function startBot(botToken: string): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.Error, (error) => {
    console.error(`[bot] gateway error: ${error.message}`);
  });

  client.once(Events.ClientReady, (ready) => {
    state.gateway = "ready";
    state.detail = `Logged in as ${ready.user.tag}`;

    try {
      state.rosterEntries = loadRoster().size;
      console.log(
        `[bot] roster loaded: ${state.rosterEntries} students from ${rosterPath()}`,
      );
    } catch (error) {
      state.detail = `Could not read the roster CSV: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(`[bot] ${state.detail}`);
    }

    console.log(`[bot] ready as ${ready.user.tag}`);
    console.log(`[bot] invite URL: ${inviteUrl(ready.user.id)}`);
    void registerVerifyCommand(client);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch(async (error) => {
      console.error(
        `[bot] interaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await safeReply(interaction, "Something went wrong — please try `/verify` again.");
    });
  });

  await client.login(botToken);
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "verify") await handleVerifyCommand(interaction);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
    await handleVerifyModal(interaction);
  }
}

async function handleVerifyCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Please run `/verify` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildVerifyModal());
}

async function handleVerifyModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "Please run `/verify` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const now = Date.now();
  const lastAttempt = lastAttemptByUser.get(interaction.user.id);
  if (lastAttempt && now - lastAttempt < COOLDOWN_MS) {
    await interaction.reply({
      content: "Hang on a second before trying again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  lastAttemptByUser.set(interaction.user.id, now);

  const submitted = interaction.fields.getTextInputValue(EMAIL_FIELD_ID);
  const result = verifyEmail(submitted);

  switch (result.status) {
    case "invalid_email":
      await interaction.reply({
        content:
          "That doesn't look like an email address — it should look like `firstlast0@schools.vic.edu.au`.",
        flags: MessageFlags.Ephemeral,
      });
      return;

    case "not_found":
      // "Their data is not there" → the same manual-review answer as a claimed email.
      console.log(`[bot] ${interaction.user.tag} submitted an address with no roster data`);
      await interaction.reply({
        content: MANUAL_REVIEW_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;

    case "no_role":
      await interaction.reply({
        content: `Found you, ${result.entry.firstName}, but there is no Discord role set up for class **${result.entry.className}** yet — ask a server admin to add one.`,
        flags: MessageFlags.Ephemeral,
      });
      return;

    case "ok":
      await completeVerification(
        interaction,
        result.email,
        result.entry.className,
        result.roleId,
      );
      return;
  }
}

/**
 * Full verification pipeline: check the Redis registry, claim the email if it
 * is free, grant the class role, then persist the record.
 */
async function completeVerification(
  interaction: ModalSubmitInteraction,
  email: string,
  className: string,
  roleId: string,
): Promise<void> {
  const record: VerifyRecord = {
    userId: interaction.user.id,
    userTag: interaction.user.tag,
    email,
    className,
    verifiedAt: new Date().toISOString(),
  };

  let stored: VerifyRecord | null;
  try {
    stored = await store.getRecord(email);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const decision = decideVerification(stored, interaction.user.id);
  if (decision === "taken") {
    console.log(
      `[bot] ${interaction.user.tag} submitted an email already claimed by another user`,
    );
    await interaction.reply({
      content: MANUAL_REVIEW_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let claimedNow = false;
  if (decision === "free") {
    try {
      const claimed = await store.claim(record);
      if (claimed) {
        claimedNow = true;
      } else {
        // Lost the race: someone claimed this email while we were checking.
        const current = await store.getRecord(email);
        if (current && current.userId !== interaction.user.id) {
          console.log(
            `[bot] ${interaction.user.tag} submitted an email already claimed by another user`,
          );
          await interaction.reply({
            content: MANUAL_REVIEW_MESSAGE,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  const granted = await assignClassRole(interaction, className, roleId);
  if (!granted) {
    if (claimedNow) {
      // Don't burn the email on a failed grant — roll the claim back.
      await store.release(record).catch((error: unknown) => {
        console.error(
          `[redis] could not roll back claim: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return;
  }

  if (!claimedNow) {
    // Re-verification by the same user: refresh the stored record.
    await store.refresh(record).catch((error: unknown) => {
      console.error(
        `[redis] could not refresh record: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  console.log(`[bot] verified ${interaction.user.tag} -> ${className}`);
  await interaction.reply({
    content: `Verified ✅ You now have the **${className}** class role.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** Grants the class role. Returns false after replying with the reason. */
async function assignClassRole(
  interaction: ModalSubmitInteraction,
  className: string,
  roleId: string,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild) return false;

  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(interaction.user.id);

  try {
    // Drop any other class role first so nobody sits in two sections at once.
    const staleRoleIds = member.roles.cache
      .filter((role) => SECTION_ROLE_IDS.has(role.id) && role.id !== roleId)
      .map((role) => role.id);

    if (staleRoleIds.length > 0) {
      await member.roles.remove(staleRoleIds, "Verified for a different class");
    }

    await member.roles.add(roleId, `School email verified (${className})`);
  } catch (error) {
    console.error(
      `[bot] could not update roles for ${interaction.user.tag}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await interaction.reply({
      content: describeRoleError(error),
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

function describeRoleError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 50013 || code === "50013") {
    return "I don't have permission to manage roles. In Server Settings → Roles, move my role **above** every class role (7A–7R) and give it the Manage Roles permission.";
  }
  if (code === 50001 || code === "50001") {
    return "I can't access that server — check my role's channel permissions.";
  }
  return "I couldn't update your roles just now — please try again in a moment.";
}

async function safeReply(interaction: Interaction, content: string): Promise<void> {
  try {
    if (!interaction.isRepliable() || interaction.replied || interaction.deferred) {
      return;
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    // The interaction may have expired; the error is already logged.
  }
}

function buildVerifyModal(): ModalBuilder {
  const emailInput = new TextInputBuilder()
    .setCustomId(EMAIL_FIELD_ID)
    .setLabel("Your school email address")
    .setPlaceholder("e.g. firstlast0@schools.vic.edu.au")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(120)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle("Verify your school email")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput),
    );
}

export const VERIFY_COMMAND = {
  name: "verify",
  description: "Verify your school email to get your class role",
  dm_permission: false,
} as const;

/**
 * Registers /verify globally (new guilds get it once Discord propagates) and
 * in every guild the bot is already in (appears instantly).
 */
async function registerVerifyCommand(client: Client): Promise<void> {
  const applicationId = client.user?.id;
  if (!applicationId) return;

  const globalRegistration = client.rest
    .put(Routes.applicationCommands(applicationId), { body: [VERIFY_COMMAND] })
    .then(() =>
      console.log("[bot] registered global /verify (can take up to an hour to appear)"),
    );

  const guildRegistrations = client.guilds.cache.map((guild) =>
    client.rest
      .put(Routes.applicationGuildCommands(applicationId, guild.id), {
        body: [VERIFY_COMMAND],
      })
      .then(() => console.log(`[bot] registered /verify in ${guild.name}`)),
  );

  const registrations = [globalRegistration, ...guildRegistrations];

  const results = await Promise.allSettled(registrations);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        `[bot] could not register /verify: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
  }
}

/** Ready-to-paste invite link with the permissions this bot needs. */
function inviteUrl(applicationId: string): string {
  // View Channel (1024) + Send Messages (2048) + Read Message History (65536) + Manage Roles (268435456)
  const permissions = 1024 + 2048 + 65536 + 268435456;
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: String(permissions),
    disable_guild_select: "true",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}&scope=bot%20applications.commands`;
}
