import { loadRoster, looksLikeEmail, normalizeEmail } from "./roster";
import type { RosterEntry } from "./roster";
import { CLASS_ROLE_IDS } from "./roles";

export type VerifyResult =
  /** Email is on the roster and the class has a Discord role. */
  | { status: "ok"; entry: RosterEntry; roleId: string }
  /** Input does not look like an email address at all. */
  | { status: "invalid_email" }
  /** Well-formed email, but not on the roster. */
  | { status: "not_found" }
  /** On the roster, but no Discord role is configured for that class. */
  | { status: "no_role"; entry: RosterEntry };

/**
 * Checks a submitted email against the class roster and resolves the class
 * role it should receive. Matching is case-insensitive and whitespace-tolerant;
 * the address itself is never logged.
 */
export function verifyEmail(rawInput: string): VerifyResult {
  const email = normalizeEmail(rawInput);
  if (!looksLikeEmail(email)) return { status: "invalid_email" };

  const entry = loadRoster().get(email);
  if (!entry) return { status: "not_found" };

  const roleId = CLASS_ROLE_IDS[entry.className];
  if (!roleId) return { status: "no_role", entry };

  return { status: "ok", entry, roleId };
}
