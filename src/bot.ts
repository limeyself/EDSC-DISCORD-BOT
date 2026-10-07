import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  evaluateCountingMessage,
  expectedNumber,
  initialCountingState,
  resetCounting,
  type CountingState,
} from "./counting.ts";
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

/**
 * Counting channel cache per guild. Maps hold "" for "no channel configured"
 * so busy servers don't hammer Redis on every message; setup overwrites it.
 */
const countingChannelByGuild = new Map<string, string>();
const countingStateByGuild = new Map<string, CountingState>();
let warnedMissingContentIntent = false;

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
    if (/intent/i.test(state.detail)) {
      state.detail +=
        " — enable the Message Content Intent in the Developer Portal (Bot → Privileged Gateway Intents), or set DISABLE_MESSAGE_CONTENT_INTENT=1 to run without counting.";
    }
    console.error(`[bot] failed to start: ${state.detail}`);
  });
}

async function startBot(botToken: string): Promise<void> {
  // GuildMessages + Message Content let the bot read the counting channel.
  // Message Content is privileged: it must be toggled ON in the Developer
  // Portal or the gateway is refused with close code 4014 — set
  // DISABLE_MESSAGE_CONTENT_INTENT=1 to boot without it (counting stays inert,
  // /verify still works).
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (!process.env.DISABLE_MESSAGE_CONTENT_INTENT) {
    intents.push(GatewayIntentBits.MessageContent);
  }
  const client = new Client({ intents });

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
    void registerCommands(client);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch(async (error) => {
      console.error(
        `[bot] interaction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await safeReply(interaction, "Something went wrong — please try `/verify` again.");
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleCountingMessage(message).catch((error) => {
      console.error(
        `[counting] could not handle message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });

  await client.login(botToken);
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "verify") await handleVerifyCommand(interaction);
    else if (interaction.commandName === "counting") {
      await handleCountingCommand(interaction);
    }
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
 * Counting channel: validates each message against the current count,
 * advances on the right number and resets (with an explanation) on a wrong one.
 */
async function handleCountingMessage(message: Message): Promise<void> {
  if (message.author.bot || !message.guildId) return;

  const guildId = message.guildId;
  const channelId = await resolveCountingChannel(guildId);
  if (!channelId || channelId !== message.channelId) return;

  // Message Content is privileged — without it every message body arrives
  // empty and counting can't work at all. Say so once instead of staying silent.
  if (
    !warnedMissingContentIntent &&
    message.content === "" &&
    message.embeds.length === 0 &&
    message.attachments.size === 0
  ) {
    warnedMissingContentIntent = true;
    console.warn(
      "[counting] messages arrive with empty content — enable the Message Content Intent in the Developer Portal (Bot → Privileged Gateway Intents), then restart the preview.",
    );
  }

  const state = await resolveCountingState(guildId);
  const outcome = evaluateCountingMessage(state, {
    content: message.content,
    authorIsBot: message.author.bot,
  });
  if (outcome.kind === "ignore") return;

  countingStateByGuild.set(guildId, outcome.next);
  persistCountingState(guildId, outcome.next);
  if (outcome.kind === "correct") return;

  // Wrong number: delete it if we can (Manage Messages), then explain the reset.
  await message.delete().catch(() => undefined);
  const recordNote =
    outcome.next.record > 0
      ? ` The record of **${outcome.next.record}** still stands.`
      : "";
  if ("send" in message.channel) {
    await message.channel
      .send(
        `**${outcome.value}** isn't it — I expected **${outcome.expected}**. The count is back to **1**.${recordNote}`,
      )
      .catch(() => undefined);
  }
}

/** Channel config for a guild: memory first, then Redis (once it's up). */
async function resolveCountingChannel(guildId: string): Promise<string | null> {
  const cached = countingChannelByGuild.get(guildId);
  if (cached !== undefined) return cached || null;
  // Don't queue reads behind a store that is down — try again once it's back.
  if (store.statusInfo().status !== "ready") return null;
  try {
    const channelId = await store.getCountingChannel(guildId);
    countingChannelByGuild.set(guildId, channelId ?? "");
    return channelId;
  } catch {
    return null;
  }
}

/** Counting progress: memory first, then Redis (once it's up). */
async function resolveCountingState(guildId: string): Promise<CountingState> {
  const cached = countingStateByGuild.get(guildId);
  if (cached) return cached;
  const fallback = initialCountingState();
  // Uncached and the store is down: use a scratch state but don't cache it,
  // so a restart with a healthy store still loads the real saved count.
  if (store.statusInfo().status !== "ready") return fallback;
  try {
    const loaded = (await store.getCountingState(guildId)) ?? fallback;
    countingStateByGuild.set(guildId, loaded);
    return loaded;
  } catch {
    countingStateByGuild.set(guildId, fallback);
    return fallback;
  }
}

/** Write-through to Redis; the in-memory count keeps working if the store is down. */
function persistCountingState(guildId: string, counting: CountingState): void {
  if (store.statusInfo().status !== "ready") return;
  void store.setCountingState(guildId, counting).catch(() => {
    // The Redis client already logs outages; memory stays authoritative and
    // the next message writes the full state again anyway.
  });
}

function canManageCounting(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function handleCountingCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({
      content: "Please run `/counting` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guild.id;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "setup") {
    if (!canManageCounting(interaction)) {
      await interaction.reply({
        content: "You need the **Manage Server** permission to pick the counting channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    if (channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "Pick a normal text channel for counting.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const me =
      interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    if ("permissionsFor" in channel && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      await interaction.reply({
        content: `I can't send messages in <#${channel.id}> — give me **Send Messages** there first.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    countingChannelByGuild.set(guildId, channel.id);
    countingStateByGuild.delete(guildId); // a new channel starts from scratch

    let persisted = false;
    if (store.statusInfo().status === "ready") {
      try {
        await store.setCountingChannel(guildId, channel.id);
        persisted = true;
      } catch {
        persisted = false;
      }
    }
    const note = persisted
      ? ""
      : " ⚠️ I can't reach the verification store, so this only lasts until a restart.";
    await interaction.reply({
      content: `Counting channel set to <#${channel.id}> — post **1**, **2**, **3** … in order. Get one wrong and the count starts over.${note}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "status") {
    const channelId = await resolveCountingChannel(guildId);
    if (!channelId) {
      await interaction.reply({
        content: "No counting channel yet — an admin can run `/counting setup`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.guild.channels.cache.has(channelId)) {
      await interaction.reply({
        content: "The counting channel has been deleted — run `/counting setup` again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const counting = await resolveCountingState(guildId);
    const recordLine =
      counting.record > 0 ? ` · record **${counting.record}**` : "";
    await interaction.reply({
      content: `<#${channelId}> is at **${counting.count}** — next up is **${expectedNumber(counting)}**${recordLine}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "reset") {
    if (!canManageCounting(interaction)) {
      await interaction.reply({
        content: "You need the **Manage Server** permission to reset the count.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const counting = await resolveCountingState(guildId);
    const next = resetCounting(counting);
    countingStateByGuild.set(guildId, next);
    persistCountingState(guildId, next);
    const recordLine =
      counting.record > 0 ? ` The record of **${counting.record}** stays.` : "";
    await interaction.reply({
      content: `Count reset — start again at **1**.${recordLine}`,
      flags: MessageFlags.Ephemeral,
    });
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

export const COUNTING_COMMAND = {
  name: "counting",
  description: "Count up together in a channel — get one wrong and it resets",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "setup",
      description: "Choose the channel where members count",
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: "channel",
          description: "The counting channel",
          channel_types: [ChannelType.GuildText],
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "status",
      description: "Show the current count, the next number and the record",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "reset",
      description: "Reset the count back to 1 (keeps the record)",
    },
  ],
};

/**
 * Registers the commands globally (new guilds get them once Discord
 * propagates) and in every guild the bot is already in (appears instantly).
 */
async function registerCommands(client: Client): Promise<void> {
  const applicationId = client.user?.id;
  if (!applicationId) return;

  const commands = [VERIFY_COMMAND, COUNTING_COMMAND];

  const globalRegistration = client.rest
    .put(Routes.applicationCommands(applicationId), { body: commands })
    .then(() =>
      console.log(
        "[bot] registered global /verify and /counting (can take up to an hour to appear)",
      ),
    );

  const guildRegistrations = client.guilds.cache.map((guild) =>
    client.rest
      .put(Routes.applicationGuildCommands(applicationId, guild.id), {
        body: commands,
      })
      .then(() => console.log(`[bot] registered /verify and /counting in ${guild.name}`)),
  );

  const registrations = [globalRegistration, ...guildRegistrations];

  const results = await Promise.allSettled(registrations);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        `[bot] could not register commands: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
  }
}

/** Ready-to-paste invite link with the permissions this bot needs. */
function inviteUrl(applicationId: string): string {
  // View Channel (1024) + Send Messages (2048) + Read Message History (65536) + Manage Messages (131072) + Manage Roles (268435456)
  const permissions = 1024 + 2048 + 65536 + 131072 + 268435456;
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: String(permissions),
    disable_guild_select: "true",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}&scope=bot%20applications.commands`;
}
