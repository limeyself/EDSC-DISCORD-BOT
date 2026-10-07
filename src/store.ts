import { createClient } from "redis";
import { isCountingState, type CountingState } from "./counting.ts";
import type { PendingReview } from "./review.ts";

/**
 * Default connection supplied by the server admins. Override with the
 * REDIS_URL environment variable if the instance ever moves.
 */
export const DEFAULT_REDIS_URL = "redis://red-db2m8kvavr4c73ejq3g0:6379";

/** One verification record: which Discord user claimed which school email. */
export interface VerifyRecord {
  userId: string;
  userTag: string;
  email: string;
  className: string;
  verifiedAt: string;
}

export type StoreStatus = "connecting" | "ready" | "error";

const EMAIL_PREFIX = "classbot:verify:email:";
const USER_PREFIX = "classbot:verify:user:";
const COUNTING_CHANNEL_PREFIX = "classbot:counting:channel:";
const COUNTING_STATE_PREFIX = "classbot:counting:state:";
const PENDING_PREFIX = "classbot:verify:pending:";
const SLOT_PREFIX = "classbot:verify:slot:";
const CLASS_SERVER_PREFIX = "classbot:classserver:";

/** A class's registered Discord server (used for the invite DM on approval). */
export interface ClassServerRecord {
  guildId: string;
  invite: string | null;
  setAt: string;
}

export function emailKey(email: string): string {
  return `${EMAIL_PREFIX}${email}`;
}

export function userKey(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

export function countingChannelKey(guildId: string): string {
  return `${COUNTING_CHANNEL_PREFIX}${guildId}`;
}

export function countingStateKey(guildId: string): string {
  return `${COUNTING_STATE_PREFIX}${guildId}`;
}

export function pendingKey(userId: string): string {
  return `${PENDING_PREFIX}${userId}`;
}

export function classSlotKey(className: string): string {
  return `${SLOT_PREFIX}${className}`;
}

export function classServerKey(className: string): string {
  return `${CLASS_SERVER_PREFIX}${className}`;
}

export type VerificationDecision =
  /** Nobody has claimed this email yet. */
  | "free"
  /** This exact Discord user already claimed it (re-verification). */
  | "reverify"
  /** A different Discord user already claimed it — manual review. */
  | "taken";

/**
 * Pure decision helper (unit tested): given the stored record for an email —
 * if any — is the current user allowed to proceed?
 */
export function decideVerification(
  record: VerifyRecord | null | undefined,
  currentUserId: string,
): VerificationDecision {
  if (!record) return "free";
  return record.userId === currentUserId ? "reverify" : "taken";
}

/**
 * Redis-backed registry of claimed email addresses.
 *
 * Keys (namespaced so this bot never touches another app's data):
 *   classbot:verify:email:<email> -> VerifyRecord JSON
 *   classbot:verify:user:<userId> -> email (reverse index for manual review)
 *
 * All operations reject when Redis is unreachable so callers can show a
 * truthful "storage unavailable" message instead of pretending success.
 */
export class VerifyStore {
  private readonly client: ReturnType<typeof createClient>;
  private status: StoreStatus = "connecting";
  private detail = "Connecting to Redis…";
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private lastLoggedError = "";

  constructor(url: string = process.env.REDIS_URL?.trim() || DEFAULT_REDIS_URL) {
    this.client = createClient({
      url,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) => Math.min(retries * 500, 10_000),
      },
    });

    this.client.on("ready", () => {
      this.setStatus("ready", "Connected to Redis");
    });

    this.client.on("error", (error: Error) => {
      this.setStatus("error", error.message);
      // Reconnect storms repeat the same message; log only new causes.
      if (error.message !== this.lastLoggedError) {
        this.lastLoggedError = error.message;
        console.error(`[redis] ${error.message}`);
      }
    });

    this.client.on("end", () => {
      this.setStatus("connecting", "Redis connection closed, retrying…");
    });
  }

  /** Connects, and keeps retrying in the background if the host is down. */
  async start(): Promise<void> {
    try {
      await this.client.connect();
      this.setStatus("ready", "Connected to Redis");
    } catch (error) {
      this.setStatus("error", error instanceof Error ? error.message : String(error));
      this.scheduleRetry();
    }
  }

  statusInfo(): { status: StoreStatus; detail: string } {
    return { status: this.status, detail: this.detail };
  }

  async getRecord(email: string): Promise<VerifyRecord | null> {
    const raw = await this.client.get(emailKey(email));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VerifyRecord;
    } catch {
      // Corrupt/unrelated value: treat as taken so a human reviews it.
      return { userId: "__unparsable__", userTag: "", email, className: "", verifiedAt: "" };
    }
  }

  /** Atomic claim (SET NX): true when this user now owns the email. */
  async claim(record: VerifyRecord): Promise<boolean> {
    const result = await this.client.set(emailKey(record.email), JSON.stringify(record), {
      NX: true,
    });
    if (result !== "OK") return false;
    await this.client.set(userKey(record.userId), record.email);
    return true;
  }

  /** Updates an existing record (same user re-verifying). */
  async refresh(record: VerifyRecord): Promise<void> {
    await this.client.set(emailKey(record.email), JSON.stringify(record));
    await this.client.set(userKey(record.userId), record.email);
  }

  /** Rolls back a claim made moments earlier when the role grant failed. */
  async release(record: VerifyRecord): Promise<void> {
    const heldEmail = await this.client.get(userKey(record.userId));
    await this.client.del(emailKey(record.email));
    if (heldEmail === record.email) {
      await this.client.del(userKey(record.userId));
    }
  }

  /** Every verification record (used by the /panel page), capped at 1000. */
  async listRecords(): Promise<VerifyRecord[]> {
    const records: VerifyRecord[] = [];
    for await (const keys of this.client.scanIterator({
      MATCH: `${EMAIL_PREFIX}*`,
      COUNT: 100,
    })) {
      for (const key of keys) {
        const raw = await this.client.get(key);
        if (!raw) continue;
        try {
          records.push(JSON.parse(raw) as VerifyRecord);
        } catch {
          // Skip an unreadable entry instead of failing the whole panel.
        }
      }
      if (records.length >= 1000) break;
    }
    return records;
  }

  /** Which channel this guild counts in, or null if none is configured. */
  async getCountingChannel(guildId: string): Promise<string | null> {
    const raw = await this.client.get(countingChannelKey(guildId));
    return raw || null;
  }

  async setCountingChannel(guildId: string, channelId: string): Promise<void> {
    await this.client.set(countingChannelKey(guildId), channelId);
  }

  /** Saved counting progress; null when unset or unreadable. */
  async getCountingState(guildId: string): Promise<CountingState | null> {
    const raw = await this.client.get(countingStateKey(guildId));
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCountingState(parsed) ? parsed : null;
    } catch {
      return null; // Corrupt value: start the count from scratch.
    }
  }

  async setCountingState(guildId: string, state: CountingState): Promise<void> {
    await this.client.set(countingStateKey(guildId), JSON.stringify(state));
  }

  /** A verification waiting for an admin decision. */
  async getPending(userId: string): Promise<PendingReview | null> {
    const raw = await this.client.get(pendingKey(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingReview>;
      return typeof parsed.userId === "string" && typeof parsed.className === "string"
        ? (parsed as PendingReview)
        : null;
    } catch {
      return null; // Corrupt entry: treat as no review so the student can retry.
    }
  }

  async setPending(review: PendingReview): Promise<void> {
    await this.client.set(pendingKey(review.userId), JSON.stringify(review));
  }

  async deletePending(userId: string): Promise<void> {
    await this.client.del(pendingKey(userId));
  }

  /** Every pending review (for /review list), capped at 500. */
  async listPending(): Promise<PendingReview[]> {
    const reviews: PendingReview[] = [];
    for await (const keys of this.client.scanIterator({
      MATCH: `${PENDING_PREFIX}*`,
      COUNT: 100,
    })) {
      for (const key of keys) {
        const raw = await this.client.get(key);
        if (!raw) continue;
        try {
          reviews.push(JSON.parse(raw) as PendingReview);
        } catch {
          // Skip an unreadable entry instead of failing the whole list.
        }
      }
      if (reviews.length >= 500) break;
    }
    return reviews;
  }

  /** Who holds this class's server slot (one review per class at a time). */
  async getClassSlot(className: string): Promise<string | null> {
    return (await this.client.get(classSlotKey(className))) || null;
  }

  /** Atomic slot claim (SET NX): true when this student now holds it. */
  async claimClassSlot(className: string, userId: string): Promise<boolean> {
    const result = await this.client.set(classSlotKey(className), userId, {
      NX: true,
    });
    return result === "OK";
  }

  async releaseClassSlot(className: string): Promise<void> {
    await this.client.del(classSlotKey(className));
  }

  /** Which Discord server a class uses (for the approval DM). */
  async getClassServer(className: string): Promise<ClassServerRecord | null> {
    const raw = await this.client.get(classServerKey(className));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ClassServerRecord>;
      return typeof parsed.guildId === "string" && parsed.guildId
        ? (parsed as ClassServerRecord)
        : null;
    } catch {
      return null;
    }
  }

  async setClassServer(className: string, record: ClassServerRecord): Promise<void> {
    await this.client.set(classServerKey(className), JSON.stringify(record));
  }

  async deleteClassServer(className: string): Promise<void> {
    await this.client.del(classServerKey(className));
  }

  async close(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.client.isOpen) await this.client.quit().catch(() => undefined);
  }

  private setStatus(status: StoreStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    if (status === "ready" && this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.lastLoggedError = "";
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.client.isOpen) return;
      void this.client
        .connect()
        .then(() => this.setStatus("ready", "Connected to Redis"))
        .catch(() => {
          /* status already set by the error handler; retry again shortly */
        });
    }, 15_000);
    this.retryTimer.unref?.();
  }
}

/** Process-wide store instance. */
export const store = new VerifyStore();
