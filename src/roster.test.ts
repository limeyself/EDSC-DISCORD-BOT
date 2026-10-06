import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_ROSTER_PATH,
  loadRoster,
  looksLikeEmail,
  normalizeEmail,
  parseRoster,
} from "./roster.ts";
import { CLASS_ROLE_IDS, SECTION_ROLE_IDS } from "./roles.ts";
import { verifyEmail } from "./verify.ts";

describe("class role config", () => {
  test("has a role for every class 7A-7R, all unique snowflakes", () => {
    const classes = Object.keys(CLASS_ROLE_IDS).sort();
    assert.deepStrictEqual(classes, [
      "7A", "7B", "7C", "7D", "7E", "7F", "7G", "7H", "7I",
      "7J", "7K", "7L", "7M", "7N", "7O", "7P", "7Q", "7R",
    ]);

    const ids = Object.values(CLASS_ROLE_IDS);
    for (const id of ids) assert.match(id, /^\d{17,20}$/);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(SECTION_ROLE_IDS.size, ids.length);
  });
});

describe("email normalization", () => {
  test("lowercases and strips whitespace", () => {
    assert.equal(
      normalizeEmail("  ZABBI@schools.vic.edu.au  "),
      "zabbi@schools.vic.edu.au",
    );
    assert.equal(
      normalizeEmail("zabbi @schools .vic.edu.au"),
      "zabbi@schools.vic.edu.au",
    );
  });

  test("rejects things that are not emails", () => {
    assert.equal(looksLikeEmail(""), false);
    assert.equal(looksLikeEmail("not-an-email"), false);
    assert.equal(looksLikeEmail("zabbi@schools"), false);
    assert.equal(looksLikeEmail("zabbi@schools.vic.edu.au"), true);
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
    assert.equal(roster.size, 1);
    assert.deepStrictEqual(roster.get("zabbi@schools.vic.edu.au"), {
      firstName: "Zaynab",
      lastName: "Abbas",
      className: "7J",
    });
  });

  test("loads the real roster from disk", () => {
    const roster = loadRoster(DEFAULT_ROSTER_PATH);
    assert.equal(roster.size, 395);

    // Spot-check the first row of the sheet.
    const entry = roster.get("zabbi@schools.vic.edu.au");
    assert.equal(entry?.className, "7J");
    assert.equal(entry?.firstName, "Zaynab");

    // Every student on the roster must map to a configured class role.
    for (const [email, student] of roster) {
      assert.ok(
        CLASS_ROLE_IDS[student.className],
        `no role configured for class ${student.className}`,
      );
      assert.match(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      assert.match(student.className, /^7[A-R]$/);
    }

    // No duplicate addresses anywhere on the sheet.
    assert.equal(new Set(roster.keys()).size, roster.size);
  });
});

describe("verifyEmail", () => {
  test("resolves a real student to their class role", () => {
    const result = verifyEmail("ZABBI@schools.vic.edu.au");
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.entry.className, "7J");
      assert.equal(result.roleId, "1446218992439267348");
    }
  });

  test("is tolerant of case and stray spaces", () => {
    assert.equal(verifyEmail("  zabbi@schools.vic.edu.au ").status, "ok");
  });

  test("rejects malformed input", () => {
    assert.equal(verifyEmail("not an email").status, "invalid_email");
    assert.equal(verifyEmail("").status, "invalid_email");
  });

  test("rejects emails that are not on the roster", () => {
    assert.equal(verifyEmail("nobody@schools.vic.edu.au").status, "not_found");
    assert.equal(verifyEmail("someone@example.com").status, "not_found");
  });

  test("every class on the roster has a matching role", () => {
    const roster = loadRoster(DEFAULT_ROSTER_PATH);
    const classes = new Set([...roster.values()].map((s) => s.className));
    assert.equal(classes.size, 18);
    for (const className of classes) {
      assert.ok(
        CLASS_ROLE_IDS[className],
        `no role configured for class ${className}`,
      );
      assert.ok(SECTION_ROLE_IDS.has(CLASS_ROLE_IDS[className]));
    }
  });
});
