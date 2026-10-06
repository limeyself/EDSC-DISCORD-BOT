import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROSTER_PATH,
  loadRoster,
  looksLikeEmail,
  normalizeEmail,
  parseRoster,
} from "./roster";
import { CLASS_ROLE_IDS, SECTION_ROLE_IDS } from "./roles";
import { verifyEmail } from "./verify";

describe("class role config", () => {
  test("has a role for every class 7A-7R, all unique snowflakes", () => {
    const classes = Object.keys(CLASS_ROLE_IDS).sort();
    expect(classes).toEqual([
      "7A", "7B", "7C", "7D", "7E", "7F", "7G", "7H", "7I",
      "7J", "7K", "7L", "7M", "7N", "7O", "7P", "7Q", "7R",
    ]);

    const ids = Object.values(CLASS_ROLE_IDS);
    for (const id of ids) expect(id).toMatch(/^\d{17,20}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SECTION_ROLE_IDS.size).toBe(ids.length);
  });
});

describe("email normalization", () => {
  test("lowercases and strips whitespace", () => {
    expect(normalizeEmail("  ZABBI@schools.vic.edu.au  ")).toBe(
      "zabbi@schools.vic.edu.au",
    );
    expect(normalizeEmail("zabbi @schools .vic.edu.au")).toBe(
      "zabbi@schools.vic.edu.au",
    );
  });

  test("rejects things that are not emails", () => {
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail("not-an-email")).toBe(false);
    expect(looksLikeEmail("zabbi@schools")).toBe(false);
    expect(looksLikeEmail("zabbi@schools.vic.edu.au")).toBe(true);
  });
});

describe("roster parsing", () => {
  test("parses CRLF rows and skips placeholder rows", () => {
    const csv = [
      "First Name,Last Name,Gender,Class,Email Address,School,Year\r",
      "Zaynab,Abbas,Girl,7J,ZABBI@schools.vic.edu.au,EDSC,7\r",
      "Alvin,Li,Boy,UNKNOWN,UNKNOWN,EDSC,7\r",
      "Broken,Row\r",
    ].join("\n");

    const roster = parseRoster(csv);
    expect(roster.size).toBe(1);
    expect(roster.get("zabbi@schools.vic.edu.au")).toEqual({
      firstName: "Zaynab",
      lastName: "Abbas",
      className: "7J",
    });
  });

  test("loads the real roster from disk", () => {
    const roster = loadRoster(DEFAULT_ROSTER_PATH);
    expect(roster.size).toBe(395);

    // Spot-check the first row of the sheet.
    const entry = roster.get("zabbi@schools.vic.edu.au");
    expect(entry?.className).toBe("7J");
    expect(entry?.firstName).toBe("Zaynab");

    // Every student on the roster must map to a configured class role.
    for (const [email, student] of roster) {
      expect(CLASS_ROLE_IDS[student.className]).toBeDefined();
      expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      expect(student.className).toMatch(/^7[A-R]$/);
    }

    // No duplicate addresses anywhere on the sheet.
    expect(new Set(roster.keys()).size).toBe(roster.size);
  });
});

describe("verifyEmail", () => {
  test("resolves a real student to their class role", () => {
    const result = verifyEmail("ZABBI@schools.vic.edu.au");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.entry.className).toBe("7J");
      expect(result.roleId).toBe("1446218992439267348");
    }
  });

  test("is tolerant of case and stray spaces", () => {
    expect(verifyEmail("  zabbi@schools.vic.edu.au ").status).toBe("ok");
  });

  test("rejects malformed input", () => {
    expect(verifyEmail("not an email").status).toBe("invalid_email");
    expect(verifyEmail("").status).toBe("invalid_email");
  });

  test("rejects emails that are not on the roster", () => {
    expect(verifyEmail("nobody@schools.vic.edu.au").status).toBe("not_found");
    expect(verifyEmail("someone@example.com").status).toBe("not_found");
  });

  test("every class on the roster has a matching role", () => {
    const roster = loadRoster(DEFAULT_ROSTER_PATH);
    const classes = new Set([...roster.values()].map((s) => s.className));
    expect(classes.size).toBe(18);
    for (const className of classes) {
      expect(SECTION_ROLE_IDS.has(CLASS_ROLE_IDS[className])).toBe(true);
    }
  });
});
