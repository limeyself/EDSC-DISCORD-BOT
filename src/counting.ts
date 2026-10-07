/**
 * Rules for the counting channel: members post 1, 2, 3 … in order, a wrong
 * number resets the count to the start, and the all-time record is kept.
 *
 * Pure functions only (no Discord or Redis imports) so the game logic stays
 * unit-testable and the bot wiring stays thin.
 */

/** Progress for one guild's counting channel. */
export interface CountingState {
  /** Last correctly counted number — 0 means nobody has started yet. */
  count: number;
  /** Highest number ever reached before a reset (survives resets). */
  record: number;
}

/** A fresh count: nothing counted, no record yet. */
export function initialCountingState(): CountingState {
  return { count: 0, record: 0 };
}

/** The number the next correct message must be. */
export function expectedNumber(state: CountingState): number {
  return state.count + 1;
}

/**
 * Back to square one, but the record stands — used both when someone gets a
 * number wrong and when an admin runs `/counting reset`.
 */
export function resetCounting(state: CountingState): CountingState {
  return { count: 0, record: state.record };
}

/**
 * Parses a counting message to its number.
 *
 * Only a bare run of digits counts ("7", " 42 ", "007"). Chat, decimals,
 * negatives and comma-grouped numbers return null so ordinary conversation in
 * the channel is never treated as (or punished as) a wrong number.
 */
export function parseCountMessage(content: string): number | null {
  const text = content.trim();
  if (!/^\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Runtime guard for state loaded from Redis (corrupt values start fresh). */
export function isCountingState(value: unknown): value is CountingState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { count?: unknown; record?: unknown };
  return (
    typeof candidate.count === "number" &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count >= 0 &&
    typeof candidate.record === "number" &&
    Number.isSafeInteger(candidate.record) &&
    candidate.record >= 0
  );
}

export type CountingOutcome =
  /** Not a countable message (chat, bots, empty content) — do nothing. */
  | { kind: "ignore" }
  /** The right number: advance the count (and the record if beaten). */
  | { kind: "correct"; value: number; next: CountingState }
  /** A number, but the wrong one: reset and tell the channel what was due. */
  | { kind: "wrong"; value: number; expected: number; next: CountingState };

/** Applies one message from the counting channel to the current state. */
export function evaluateCountingMessage(
  state: CountingState,
  message: { content: string; authorIsBot: boolean },
): CountingOutcome {
  if (message.authorIsBot) return { kind: "ignore" };

  const value = parseCountMessage(message.content);
  if (value === null) return { kind: "ignore" };

  const expected = expectedNumber(state);
  if (value === expected) {
    return {
      kind: "correct",
      value,
      next: { count: value, record: Math.max(state.record, value) },
    };
  }

  return { kind: "wrong", value, expected, next: resetCounting(state) };
}
