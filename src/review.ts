/**
 * Pure decision logic for the manual verification flow.
 *
 * A student submits their school email in the main server; an admin then
 * approves or denies the request with /review. On top of the roster and email
 * checks, a review request must pass the class-server rules:
 *
 *   - the class's Discord server must be registered (/class-server set) AND
 *     the bot must have been invited to it before the review is requested,
 *   - nobody may hold the class's server slot (one review at a time per
 *     class — the slot is claimed with the request and freed by /review
 *     release or a denial),
 *   - a student may only ever be pending once at a time.
 *
 * Pure data in, decision out — no Discord or Redis imports, so every branch
 * is unit-testable.
 */

/** A verification waiting for an admin decision. */
export interface PendingReview {
  userId: string;
  userTag: string;
  email: string;
  /** Roster class (7A–7R) the email matched. */
  className: string;
  /** Guild where /verify ran (the main server) — the class role is granted here. */
  guildId: string;
  /** ISO timestamp of the request. */
  requestedAt: string;
}

export interface ReviewRequestInput {
  currentUserId: string;
  /** This student's existing pending request, if any. */
  pending: PendingReview | null;
  /** Stored claim for the submitted email, if any. */
  record: { userId: string } | null | undefined;
  /** Who currently holds the class's server slot, if anyone. */
  slotHolder: string | null | undefined;
  /** Guild ID registered for the student's class, if any. */
  classServerGuildId: string | null | undefined;
  /** Whether the bot has been invited to that class server. */
  botInClassServer: boolean;
}

export type ReviewRequestDecision =
  /** Everything checks out — open a pending review and claim the slot. */
  | { action: "create" }
  /** This student is already approved — re-grant the role without a review. */
  | { action: "reverify" }
  | {
      action: "reject";
      reason:
        /** They already have a request waiting for review. */
        | "already_pending"
        /** Another Discord user already claimed this email. */
        | "taken"
        /** Someone holds the class's server slot right now. */
        | "slot_taken"
        /** The class has no registered server (/class-server set). */
        | "server_missing"
        /** The class server exists but the bot hasn't been invited yet. */
        | "bot_missing";
    };

/** Decides what /verify should do for a roster-matched email. */
export function decideReviewRequest(
  input: ReviewRequestInput,
): ReviewRequestDecision {
  if (input.pending) return { action: "reject", reason: "already_pending" };

  if (input.record) {
    if (input.record.userId === input.currentUserId) {
      return { action: "reverify" };
    }
    return { action: "reject", reason: "taken" };
  }

  if (input.slotHolder) return { action: "reject", reason: "slot_taken" };
  if (!input.classServerGuildId) {
    return { action: "reject", reason: "server_missing" };
  }
  if (!input.botInClassServer) {
    return { action: "reject", reason: "bot_missing" };
  }

  return { action: "create" };
}
