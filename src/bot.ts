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
import {
  decideReviewRequest,
  decideServerRequest,
  type PendingReview,
  type ServerRequest,
} from "./review.ts";
import {
  ADMIN_ROLE_ID,
  CLASS_NAMES,
  CLASS_ROLE_IDS,
  SECTION_ROLE_IDS,
} from "./roles.ts";
import {
  decideVerification,
  store,
  type ClassServerRecord,
  type VerifyRecord,
} from "./store.ts";
import { verifyEmail } from "./verify.ts";

const MODAL_ID = "verify:email";
const EMAIL_FIELD_ID = "email";
const SERVER_REQUEST_MODAL_ID = "request:server";
const COOLDOWN_MS = 5_000;

/** Same answer for both "another user already used this email" and "there is no data for it". */
const MANUAL_REVIEW_MESSAGE =
  "A user has already used this email address, or I have no data for it — you may need a manual review from a server admin.";
const STORAGE_DOWN_MESSAGE =
  "I can't reach the verification store right now — please try again in a minute.";

const INVITE_PERMISSIONS = 1024 + 2048 + 65536 + 131072 + 268435456;

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

/** Set once the Discord client exists — review approvals need it for DMs. */
let botClient: Client | null = null;

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
  botClient = client;

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
    } else if (interaction.commandName === "review") {
      await handleReviewCommand(interaction);
    } else if (interaction.commandName === "class-server") {
      await handleClassServerCommand(interaction);
    } else if (interaction.commandName === "request") {
      await handleRequestCommand(interaction);
    } else if (interaction.commandName === "server-request") {
      await handleServerRequestCommand(interaction);
    }
    return;
  }

  if (
    interaction.isModalSubmit() &&
    interaction.customId === SERVER_REQUEST_MODAL_ID
  ) {
    await handleServerRequestModal(interaction);
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
      await handleRosterMatch(
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

/**
 * Admin gate: role 1557298773951123476 instead of permission bits — the only
 * requirement for review, class-server and counting admin commands.
 */
async function hasAdminRole(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!interaction.guild) return false;
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null);
  return member?.roles.cache.has(ADMIN_ROLE_ID) ?? false;
}

const ADMIN_ROLE_MESSAGE = `This is admin-only — you need the <@&${ADMIN_ROLE_ID}> role.`;

/**
 * DMs every member holding the admin role in a guild (reviewers). Returns how
 * many were actually messaged — reviewers with DMs closed are skipped.
 */
async function notifyReviewers(guildId: string, content: string): Promise<number> {
  try {
    if (!botClient) return 0;
    const guild = await botClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) return 0;
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return 0;
    const reviewers = members.filter(
      (m) => m.roles.cache.has(ADMIN_ROLE_ID) && !m.user.bot,
    );
    let sent = 0;
    for (const member of reviewers.values()) {
      try {
        await member.send(content);
        sent += 1;
      } catch {
        // DMs closed — skip this reviewer.
      }
    }
    return sent;
  } catch {
    return 0;
  }
}

/** Melbourne-local time for review listings (invalid input → "—"). */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    dateStyle: "medium",
    timeStyle: "short",
  });
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
    if (!(await hasAdminRole(interaction))) {
      await interaction.reply({
        content: ADMIN_ROLE_MESSAGE,
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
    if (!(await hasAdminRole(interaction))) {
      await interaction.reply({
        content: ADMIN_ROLE_MESSAGE,
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
 * Roster matched — apply the manual-review gates: either open a pending
 * review (claiming the class's server slot) or re-grant to an approved student.
 */
async function handleRosterMatch(
  interaction: ModalSubmitInteraction,
  email: string,
  className: string,
  roleId: string,
): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Please run `/verify` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let pending: PendingReview | null;
  let record: VerifyRecord | null;
  let slotHolder: string | null;
  let classServer: ClassServerRecord | null;
  try {
    pending = await store.getPending(userId);
    record = await store.getRecord(email);
    slotHolder = await store.getClassSlot(className);
    classServer = await store.getClassServer(className);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const decision = decideReviewRequest({
    currentUserId: userId,
    pending,
    record,
    slotHolder,
    classServerGuildId: classServer?.guildId ?? null,
    botInClassServer: Boolean(
      classServer && botClient?.guilds.cache.has(classServer.guildId),
    ),
  });

  if (decision.action === "reject") {
    await interaction.reply({
      content: rejectMessage(decision.reason, className),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (decision.action === "reverify") {
    await completeReverification(interaction, email, className, roleId);
    return;
  }

  // Claim the class's server slot first (atomic — one review per class at a
  // time), then park the request for an admin.
  let claimedSlot = false;
  try {
    claimedSlot = await store.claimClassSlot(className, userId);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!claimedSlot) {
    await interaction.reply({
      content: rejectMessage("slot_taken", className),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await store.setPending({
      userId,
      userTag: interaction.user.tag,
      email,
      className,
      guildId,
      requestedAt: new Date().toISOString(),
    });
  } catch {
    await store.releaseClassSlot(className).catch(() => undefined);
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  console.log(
    `[bot] ${interaction.user.tag} requested a review for ${className}`,
  );
  const notified = await notifyReviewers(
    guildId,
    `🔔 New verification review requested by **${interaction.user.tag}** for class **${className}**.\n` +
      `Review it with \`/review list\` and \`/review approve user:${interaction.user.tag}\`.`,
  );
  if (notified === 0) {
    console.warn(
      `[review] no admin-role reviewers could be DMed for ${className}'s request`,
    );
  }
  await interaction.reply({
    content:
      notified > 0
        ? "Review requested ✅ The reviewers have been notified by DM — you'll get a DM with your class server invite once you're approved."
        : "Review requested ✅ An admin will check it with `/review list` — you'll get a DM with your class server invite once you're approved.",
    flags: MessageFlags.Ephemeral,
  });
}

/** Why a review request was refused. */
function rejectMessage(
  reason:
    | "already_pending"
    | "taken"
    | "slot_taken"
    | "server_missing"
    | "bot_missing",
  className: string,
): string {
  switch (reason) {
    case "already_pending":
      return `Your **${className}** review is already waiting for an admin — you'll hear back by DM.`;
    case "taken":
      return MANUAL_REVIEW_MESSAGE;
    case "slot_taken":
      return `Someone already holds the **${className}** server slot, so only one review runs at a time. Ask an admin to free it with \`/review release class:${className}\`.`;
    case "server_missing":
      return `I don't have a server registered for **${className}** yet — ask an admin to run \`/class-server set class:${className} server:<id>\`, then try again.`;
    case "bot_missing":
      return `I'm not in the **${className}** server yet — invite me there first, then run \`/verify\` again.`;
  }
}

/**
 * Re-verification by an already-approved student: refresh the record and
 * re-grant the class role. Never creates a claim — approvals only happen
 * through /review approve.
 */
async function completeReverification(
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
  if (decision === "free") {
    // The claim vanished between checks — never grant without a review.
    await interaction.reply({
      content: "That address needs a fresh review — please run `/verify` again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Already approved: refresh the record, then re-grant the class role.
  await store.refresh(record).catch((error: unknown) => {
    console.error(
      `[redis] could not refresh record: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });

  const granted = await assignClassRole(interaction, className, roleId);
  if (!granted) return; // assignClassRole already replied with the reason

  console.log(`[bot] re-verified ${interaction.user.tag} -> ${className}`);
  await interaction.reply({
    content: `Verified ✅ You now have the **${className}** class role.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── Manual review: /review list | approve | deny | release ─────────────

async function handleReviewCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Please run `/review` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!(await hasAdminRole(interaction))) {
    await interaction.reply({
      content: ADMIN_ROLE_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    let reviews: PendingReview[];
    try {
      reviews = await store.listPending();
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (reviews.length === 0) {
      await interaction.reply({
        content: "No pending reviews ✅",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    reviews.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const lines = reviews.slice(0, 40).map(
      (r) =>
        `• <@${r.userId}> — **${r.className}** — \`${r.email}\` — ${formatWhen(r.requestedAt)}`,
    );
    if (reviews.length > 40) lines.push("…and more — approve by user.");
    await interaction.reply({
      content: `**${reviews.length} pending review(s):**\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "approve") {
    await approveReview(interaction);
    return;
  }
  if (subcommand === "deny") {
    await denyReview(interaction);
    return;
  }

  // release
  const className = interaction.options.getString("class", true);
  let holder: string | null;
  try {
    holder = await store.getClassSlot(className);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!holder) {
    await interaction.reply({
      content: `Nobody holds the **${className}** slot.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    await store.releaseClassSlot(className);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: `Released the **${className}** server slot (was held by <@${holder}>) — the next student can request a review.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function approveReview(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const target = interaction.options.getUser("user", true);
  let pending: PendingReview | null;
  try {
    pending = await store.getPending(target.id);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!pending) {
    await interaction.reply({
      content: `No pending review for ${target.tag}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const record: VerifyRecord = {
    userId: pending.userId,
    userTag: pending.userTag,
    email: pending.email,
    className: pending.className,
    verifiedAt: new Date().toISOString(),
  };

  // Claim the email atomically — the same guard /verify has always used.
  let claimedNow = false;
  try {
    const existing = await store.getRecord(pending.email);
    if (existing && existing.userId !== pending.userId) {
      await interaction.reply({
        content:
          "That email is claimed by a different user — deny this review and resolve the clash first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (existing) {
      await store.refresh(record);
    } else {
      claimedNow = await store.claim(record);
      if (!claimedNow) {
        await interaction.reply({
          content: "That email was just claimed elsewhere — deny this review.",
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

  const roleId = CLASS_ROLE_IDS[pending.className] ?? "";
  const granted = await grantRoleInGuild(
    pending.guildId,
    pending.userId,
    pending.userTag,
    pending.className,
    roleId,
  );
  if (!granted.ok) {
    if (claimedNow) {
      await store.release(record).catch(() => undefined); // don't burn the email
    }
    await interaction.reply({
      content: `Couldn't grant the class role: ${granted.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await store.deletePending(pending.userId);
  } catch {
    console.error("[review] could not clear the pending entry after approval");
  }

  const invite = await resolveClassInvite(pending.className);
  const dm = await sendApprovalDm(pending, invite);
  let dmNote: string;
  if (dm.ok && invite) dmNote = " — invite DMed";
  else if (invite) dmNote = ` — couldn't DM them, invite: ${invite}`;
  else if (dm.ok) dmNote = " (no invite configured — they'll need one)";
  else dmNote = " — DM failed and no invite is set";

  console.log(`[review] approved ${pending.userTag} -> ${pending.className}`);
  await interaction.reply({
    content: `Approved **${pending.userTag}** ✅ — **${pending.className}** class role granted${dmNote}. The slot stays held until an admin runs \`/review release\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function denyReview(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const target = interaction.options.getUser("user", true);
  const reason = (interaction.options.getString("reason") ?? "").trim();
  let pending: PendingReview | null;
  try {
    pending = await store.getPending(target.id);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!pending) {
    await interaction.reply({
      content: `No pending review for ${target.tag}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let released = false;
  try {
    const holder = await store.getClassSlot(pending.className);
    if (holder === pending.userId) {
      await store.releaseClassSlot(pending.className);
      released = true;
    }
    await store.deletePending(pending.userId);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const user = await botClient?.users.fetch(pending.userId);
    await user?.send(
      `Your verification review was declined${reason ? `: ${reason}` : "."} — you can run \`/verify\` to request it again.`,
    );
  } catch {
    // DMs closed — the admin's reply below is the fallback.
  }

  await interaction.reply({
    content: `Denied **${pending.userTag}**'s review${released ? " and freed the slot" : ""}${reason ? ` (${reason})` : ""}.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** Grants the class role in a guild by ID; returns an error message on failure. */
async function grantRoleInGuild(
  guildId: string,
  userId: string,
  userTag: string,
  className: string,
  roleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!botClient) return { ok: false, error: "the bot is not running." };
  const guild = await botClient.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    return { ok: false, error: `I'm not in the server where they verified (${guildId}).` };
  }
  const member =
    guild.members.cache.get(userId) ??
    (await guild.members.fetch(userId).catch(() => null));
  if (!member) {
    return { ok: false, error: "I couldn't find that member in the server." };
  }
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
      `[bot] could not update roles for ${userTag}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, error: describeRoleError(error) };
  }
  return { ok: true };
}

/** Invite for the class server: stored link first, else create one live. */
async function resolveClassInvite(className: string): Promise<string | null> {
  try {
    const binding = await store.getClassServer(className);
    if (!binding) return null;
    if (binding.invite) return binding.invite;
    if (!botClient) return null;
    const guild = await botClient.guilds.fetch(binding.guildId).catch(() => null);
    if (!guild) return null;
    const me =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) return null;
    const channel = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite),
    );
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    const invite = await channel
      .createInvite({ maxAge: 0, maxUses: 0, unique: false })
      .catch(() => null);
    return invite?.url ?? null;
  } catch {
    return null;
  }
}

async function sendApprovalDm(
  pending: PendingReview,
  invite: string | null,
): Promise<{ ok: true } | { ok: false }> {
  try {
    const user = await botClient?.users.fetch(pending.userId);
    if (!user) return { ok: false };
    await user.send(
      `Verified ✅ You now have the **${pending.className}** class role.` +
        (invite
          ? `\n\nJoin the **${pending.className}** server: ${invite}`
          : "\n\nAsk an admin for the class server invite."),
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ── Student server requests: /request (student) + /server-request (admin) ──

/**
 * A student asks for their class's Discord server to be added: /request opens
 * a modal for the server ID (and optional invite). An admin later approves it
 * with /server-request approve, which binds the class and unlocks reviews.
 */
async function handleRequestCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Please run `/request` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Server IDs need Developer Mode to copy — tell them how up front.
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(SERVER_REQUEST_MODAL_ID)
      .setTitle("Add your class's server")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("server_id")
            .setLabel("The class server's ID")
            .setPlaceholder("Right-click the server → Copy Server ID")
            .setStyle(TextInputStyle.Short)
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("server_invite")
            .setLabel("Invite link to that server (optional)")
            .setPlaceholder("https://discord.gg/… (recommended)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(EMAIL_FIELD_ID)
            .setLabel("Your school email (proof of class)")
            .setPlaceholder("e.g. firstlast0@schools.vic.edu.au")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(120)
            .setRequired(true),
        ),
      ),
  );
}

/**
 * Handles the /request modal: validates the input, proves the student's class
 * from their roster email, then stores the request for admin approval.
 */
async function handleServerRequestModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
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

  const serverInput = interaction.fields.getTextInputValue("server_id").trim();
  const inviteInput =
    (interaction.fields.getTextInputValue("server_invite") ?? "").trim() || null;
  const serverId = serverInput.replace(/\D/g, "");

  if (!/^\d{17,20}$/.test(serverId)) {
    await interaction.reply({
      content:
        "That doesn't look like a server ID — enable Developer Mode, right-click the server → **Copy Server ID**.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (
    inviteInput &&
    !/^https:\/\/(discord\.gg|discord\.com\/invite)\/\S+$/i.test(inviteInput)
  ) {
    await interaction.reply({
      content: "The invite must be a discord.gg or discord.com/invite link.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = verifyEmail(interaction.fields.getTextInputValue(EMAIL_FIELD_ID));
  if (result.status === "invalid_email") {
    await interaction.reply({
      content:
        "That doesn't look like an email address — it should look like `firstlast0@schools.vic.edu.au`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (result.status === "not_found") {
    await interaction.reply({
      content: "I have no data for that email — you may need a manual review from a server admin.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // On the roster (ok or no_role): their class is what matters here.
  const className = result.entry.className;

  let ownRequest: ServerRequest | null;
  let existing: ClassServerRecord | null;
  try {
    ownRequest = await store.getServerRequest(interaction.user.id);
    existing = await store.getClassServer(className);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const decision = decideServerRequest({
    currentUserId: interaction.user.id,
    ownRequest,
    existingGuildId: existing?.guildId ?? null,
    className,
  });
  // The class always comes from the student's own verified roster email, so
  // "your own class only" holds by construction — nothing else can be entered.

  if (decision.action === "reject") {
    await interaction.reply({
      content: `**${className}** already has a server bound to it — ask an admin to run \`/class-server clear class:${className}\` if it needs to change.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (decision.action === "duplicate") {
    await interaction.reply({
      content: `Your request for **${className}** (server \`${ownRequest!.serverId}\`) is already waiting for an admin.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    await store.setServerRequest({
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      className,
      serverId,
      invite: inviteInput,
      guildId: interaction.guildId ?? "",
      requestedAt: new Date(now).toISOString(),
    });
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  console.log(
    `[request] ${interaction.user.tag} requested a server for ${className}`,
  );
  const notified = await notifyReviewers(
    interaction.guildId ?? "",
    `🔔 **${interaction.user.tag}** requested a Discord server for class **${className}**: \`${serverId}\`${inviteInput ? " (invite attached)" : ""}.\n` +
      `Approve with \`/server-request approve user:${interaction.user.tag}\`.`,
  );
  if (notified === 0) {
    console.warn(
      `[request] no admin-role reviewers could be DMed about ${className}'s server request`,
    );
  }
  await interaction.reply({
    content:
      notified > 0
        ? `Request in ✅ The reviewers have been notified by DM — you'll get a DM once the **${className}** server is added, then you can run \`/verify\`.`
        : `Request in ✅ An admin will review it with \`/server-request list\` — you'll get a DM once the **${className}** server is added, then you can run \`/verify\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleClassServerCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Please run `/class-server` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!(await hasAdminRole(interaction))) {
    await interaction.reply({
      content: ADMIN_ROLE_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "set") {
    const className = interaction.options.getString("class", true);
    const serverId = (interaction.options.getString("server") ?? "").trim();
    const invite =
      (interaction.options.getString("invite") ?? "").trim() || null;
    if (!/^\d{17,20}$/.test(serverId)) {
      await interaction.reply({
        content:
          "That doesn't look like a Discord server ID — enable Developer Mode, right-click the server → **Copy Server ID**.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      invite &&
      !/^https:\/\/(discord\.gg|discord\.com\/invite)\/\S+$/i.test(invite)
    ) {
      await interaction.reply({
        content: "The invite must be a discord.gg or discord.com/invite link.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await store.setClassServer(className, {
        guildId: serverId,
        invite,
        setAt: new Date().toISOString(),
      });
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const botThere = botClient?.guilds.cache.has(serverId) ?? false;
    const presence = botThere
      ? "I'm already in that server ✅"
      : "⚠️ I'm not in that server yet — invite me before approving any review.";
    const inviteNote = invite
      ? ""
      : " No invite link stored — I'll create one when I approve someone (needs Create Instant Invite).";
    await interaction.reply({
      content: `**${className}** is now bound to server \`${serverId}\` — ${presence}.${inviteNote}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "clear") {
    const className = interaction.options.getString("class", true);
    try {
      await store.deleteClassServer(className);
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `Cleared the **${className}** server binding — reviews for that class are blocked until it's set again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // list
  try {
    const rows = await Promise.all(
      CLASS_NAMES.map(async (className) => {
        const [binding, holder] = await Promise.all([
          store.getClassServer(className),
          store.getClassSlot(className),
        ]);
        const slot = holder ? `· slot: <@${holder}>` : "· slot free";
        if (!binding) return `**${className}** — no server — ${slot}`;
        const botThere = botClient?.guilds.cache.has(binding.guildId) ?? false;
        return `**${className}** — \`${binding.guildId}\` · bot ${botThere ? "✅" : "❌"} · ${slot}`;
      }),
    );
    await interaction.reply({
      content: `**Class servers:**\n${rows.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
  }
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

const CLASS_CHOICES = CLASS_NAMES.map((name) => ({ name, value: name }));

// ── Admin side of student server requests: /server-request ─────────────

async function handleServerRequestCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "Please run `/server-request` inside the server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!(await hasAdminRole(interaction))) {
    await interaction.reply({
      content: ADMIN_ROLE_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "list") {
    let requests: ServerRequest[];
    try {
      requests = await store.listServerRequests();
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (requests.length === 0) {
      await interaction.reply({
        content: "No server requests ✅",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const lines = requests.slice(0, 40).map(
      (r) =>
        `• <@${r.userId}> wants **${r.className}** → \`${r.serverId}\`${r.invite ? " (invite attached)" : ""} — ${formatWhen(r.requestedAt)}`,
    );
    if (requests.length > 40) lines.push("…and more.");
    await interaction.reply({
      content: `**${requests.length} server request(s):**\n${lines.join("\n")}`, flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === "approve") {
    const target = interaction.options.getUser("user", true);
    let request: ServerRequest | null;
    try {
      request = await store.getServerRequest(target.id);
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!request) {
      await interaction.reply({
        content: `No server request from ${target.tag}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const existing = await store
      .getClassServer(request.className)
      .catch(() => null);
    if (existing) {
      await interaction.reply({
        content: `**${request.className}** already has server \`${existing.guildId}\` — deny this request or clear the binding first.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await store.setClassServer(request.className, {
        guildId: request.serverId,
        invite: request.invite,
        setAt: new Date().toISOString(),
      });
      await store.deleteServerRequest(request.userId);
    } catch {
      await interaction.reply({
        content: STORAGE_DOWN_MESSAGE,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const botThere = botClient?.guilds.cache.has(request.serverId) ?? false;
    const appInvite = classServerInviteUrl(botClient, request.serverId);
    try {
      const user = await botClient?.users.fetch(request.userId);
      await user?.send(
        botThere
          ? `Your request was approved ✅ The **${request.className}** server is set up — run \`/verify\` in the main server.`
          : `Your request was approved ✅ The **${request.className}** server is registered — **you now need to invite the bot to that server**:` +
            (appInvite ? `\n\n${appInvite}` : "\n\n(the invite link is in the admin's reply — my logs weren't ready when you were messaged)") +
            `\n\nOnce I'm in, run \`/verify\` in the main server.`,
      );
    } catch {
      // DMs closed — the admin reply carries the info instead.
    }

    console.log(`[request] approved ${request.userTag} -> ${request.className}`);
    await interaction.reply({
      content:
        `Approved ✅ **${request.className}** → server \`${request.serverId}\` (invite ${request.invite ? "stored" : "created later on approval"}).\n` +
        (botThere
          ? "I'm already in that server ✅ — reviews for this class are unlocked."
          : `⚠️ Not in that server yet — reviews stay locked until I'm invited${appInvite ? `: ${appInvite}` : " (use the invite URL from the startup logs)"}.`),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // deny
  const target = interaction.options.getUser("user", true);
  const reason = (interaction.options.getString("reason") ?? "").trim();
  let request: ServerRequest | null;
  try {
    request = await store.getServerRequest(target.id);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!request) {
    await interaction.reply({
      content: `No server request from ${target.tag}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    await store.deleteServerRequest(request.userId);
  } catch {
    await interaction.reply({
      content: STORAGE_DOWN_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  try {
    const user = await botClient?.users.fetch(request.userId);
    await user?.send(
      `Your request to add the **${request.className}** server was declined${reason ? `: ${reason}` : "."} — you can run \`/request\` again.`,
    );
  } catch {
    // DMs closed — the admin reply carries the info instead.
  }
  await interaction.reply({
    content: `Denied **${request.userTag}**'s server request (${request.className} → \`${request.serverId}\`)${reason ? ` — ${reason}` : ""}.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** Invite URL for adding the bot to a specific server (same permissions as the main one). */
function classServerInviteUrl(client: Client | null, guildId: string): string {
  const applicationId = client?.user?.id;
  if (!applicationId) return "";
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: String(INVITE_PERMISSIONS),
    guild_id: guildId,
    disable_guild_select: "true",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}&scope=bot%20applications.commands`;
}

export const REQUEST_COMMAND = {
  name: "request",
  description: "Ask for your class's Discord server to be added",
  dm_permission: false,
} as const;

export const SERVER_REQUEST_COMMAND = {
  name: "server-request",
  description: "Handle student requests to add class servers (admin role)",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "list",
      description: "List open server requests",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "approve",
      description: "Approve a request — binds the class's server",
      options: [
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "Whose request to approve",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "deny",
      description: "Decline a request",
      options: [
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "Whose request to decline",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "reason",
          description: "Why (sent to the student)",
          required: false,
        },
      ],
    },
  ],
};

export const REVIEW_COMMAND = {
  name: "review",
  description: "Approve or deny pending student verifications (admin role)",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "list",
      description: "List pending verification requests",
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "approve",
      description: "Approve a student's verification",
      options: [
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "The student to approve",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "deny",
      description: "Deny a student's verification",
      options: [
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "The student to deny",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "reason",
          description: "Why (sent to the student)",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "release",
      description: "Free a class's server slot so the next student can review",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "class",
          description: "Which class slot",
          required: true,
          choices: CLASS_CHOICES,
        },
      ],
    },
  ],
};

export const CLASS_SERVER_COMMAND = {
  name: "class-server",
  description: "Register which Discord server each class uses (admin role)",
  dm_permission: false,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "set",
      description: "Bind a class to a Discord server (works from anywhere)",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "class",
          description: "Which class",
          required: true,
          choices: CLASS_CHOICES,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "server",
          description: "The class server's ID (Copy Server ID)",
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "invite",
          description: "Invite link to that server (optional)",
          required: false,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "clear",
      description: "Unbind a class's server",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "class",
          description: "Which class",
          required: true,
          choices: CLASS_CHOICES,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "list",
      description: "Show bindings, bot presence and slot holders",
    },
  ],
};

/**
 * Registers the commands globally (new guilds get them once Discord
 * Propagates everywhere (up to an hour for brand-new servers) and clears the
 * stale per-guild copies older versions created, fixing the duplicated
 * entries in the slash-command picker.
 */
async function registerCommands(client: Client): Promise<void> {
  const applicationId = client.user?.id;
  if (!applicationId) return;

  const commands = [
    VERIFY_COMMAND,
    COUNTING_COMMAND,
    REVIEW_COMMAND,
    CLASS_SERVER_COMMAND,
    REQUEST_COMMAND,
    SERVER_REQUEST_COMMAND,
  ];

  // Single source of truth: register only GLOBALLY. Registering per-guild as
  // well makes Discord list every command twice (one from each scope) — that
  // was the duplicated /class-server & co. in the command picker.
  const results = await Promise.allSettled([
    client.rest.put(Routes.applicationCommands(applicationId), { body: commands }),
    // Sweep any guild-scoped copies left behind by earlier versions so each
    // command appears exactly once again.
    ...client.guilds.cache.map((guild) =>
      client.rest.put(Routes.applicationGuildCommands(applicationId, guild.id), {
        body: [],
      }),
    ),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        `[bot] could not register commands: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
  }

  if (results.every((r) => r.status === "fulfilled")) {
    console.log(
      `[bot] registered ${commands.length} global commands and cleared guild-scoped copies`,
    );
  }
}

/** Ready-to-paste invite link with the permissions this bot needs. */
function inviteUrl(applicationId: string): string {
  const permissions = INVITE_PERMISSIONS;
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: String(permissions),
    disable_guild_select: "true",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}&scope=bot%20applications.commands`;
}
