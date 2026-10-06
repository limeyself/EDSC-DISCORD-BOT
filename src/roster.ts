import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RosterEntry {
  firstName: string;
  lastName: string;
  className: string;
}

/** Repo root, derived from this file's location (src/roster.ts). */
const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export const DEFAULT_ROSTER_PATH = resolve(
  REPO_ROOT,
  "the final data(Sheet1).csv",
);

/** Loose email shape check: something@something.tld with no spaces. */
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Canonical form used for matching: lowercased, all whitespace removed so
 * pasted addresses (" zabb1@schools.vic.edu.au ") still match.
 */
export function normalizeEmail(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

export function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/** Absolute path of the roster CSV (override with the ROSTER_CSV env var). */
export function rosterPath(): string {
  const override = process.env.ROSTER_CSV?.trim();
  if (override) return resolve(REPO_ROOT, override);
  return DEFAULT_ROSTER_PATH;
}

/**
 * Parses the exported Google Sheet:
 *   First Name,Last Name,Gender,Class,Email Address,School,Year
 *
 * Rows without a usable school email (e.g. the "UNKNOWN" placeholder row) are
 * skipped, so only real addresses can ever match. Returns a map of
 * normalized email -> student.
 */
export function parseRoster(csv: string): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  const lines = csv.split(/\r?\n/);

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    const columns = line.split(",");
    if (columns.length < 5) continue;

    const email = normalizeEmail(columns[4] ?? "");
    if (!email || !looksLikeEmail(email)) continue;

    roster.set(email, {
      firstName: (columns[0] ?? "").trim(),
      lastName: (columns[1] ?? "").trim(),
      className: (columns[3] ?? "").trim().toUpperCase(),
    });
  }

  return roster;
}

/**
 * Reads the roster fresh from disk. Called on every verification so roster
 * edits (a student changing class, a new student) apply without a restart.
 */
export function loadRoster(path: string = rosterPath()): Map<string, RosterEntry> {
  return parseRoster(readFileSync(path, "utf8"));
}
