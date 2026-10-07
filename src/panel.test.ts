import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatTimestamp,
  isPanelAllowed,
  renderPanel,
} from "./panel.ts";
import type { PanelData } from "./panel.ts";
import type { HealthState } from "./health.ts";
import type { VerifyRecord } from "./store.ts";

const baseState: HealthState = {
  ok: false,
  gateway: "stopped",
  detail: "DISCORD_BOT_TOKEN is not set",
  redis: "error",
  redisDetail: "getaddrinfo ENOTFOUND",
  rosterEntries: 395,
  startedAt: Date.now(),
};

function record(overrides: Partial<VerifyRecord> = {}): VerifyRecord {
  return {
    userId: "100000000000000001",
    userTag: "alex#0001",
    email: "aboor0@schools.vic.edu.au",
    className: "7A",
    verifiedAt: "2026-10-07T03:04:05.000Z",
    ...overrides,
  };
}

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='alert(1)'> & more`),
    "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; more",
  );
});

test("panel is open when no token is configured", () => {
  assert.equal(isPanelAllowed(new URLSearchParams(), undefined), true);
  assert.equal(isPanelAllowed(new URLSearchParams(), ""), true);
});

test("panel requires a matching ?token= when PANEL_TOKEN is set", () => {
  assert.equal(isPanelAllowed(new URLSearchParams({ token: "s3cret" }), "s3cret"), true);
  assert.equal(isPanelAllowed(new URLSearchParams({ token: "wrong" }), "s3cret"), false);
  assert.equal(isPanelAllowed(new URLSearchParams(), "s3cret"), false);
});

test("formatTimestamp renders school-local time and rejects invalid input", () => {
  assert.equal(formatTimestamp("not-a-date"), "—");
  const rendered = formatTimestamp("2026-10-07T03:04:05.000Z");
  assert.match(rendered, /2026/);
  assert.match(rendered, /^07 Oct 2026, \d{2}:\d{2}$/);
});

test("renderPanel lists records newest first with class, email and count", () => {
  const data: PanelData = {
    records: [
      record({ userTag: "older#0002", verifiedAt: "2026-10-01T00:00:00.000Z" }),
      record({ userTag: "newer#0003", className: "7B", verifiedAt: "2026-10-07T00:00:00.000Z" }),
      record({ userTag: "also#0004", verifiedAt: "2026-10-03T00:00:00.000Z" }),
    ],
  };

  const html = renderPanel(baseState, data);

  assert.ok(html.includes("newer#0003"));
  assert.ok(html.includes("aboor0@schools.vic.edu.au"));
  assert.ok(html.includes(">7B<"));
  assert.ok(html.indexOf("newer#0003") < html.indexOf("also#0004"));
  assert.ok(html.indexOf("also#0004") < html.indexOf("older#0002"));
  assert.match(html, /Verified students<\/div><div class="v">3</);
  // Two classes represented: 7A and 7B chips.
  assert.ok(html.includes("7A<"));
  assert.ok(html.includes("7B<"));
});

test("renderPanel escapes hostile values from stored records", () => {
  const html = renderPanel(baseState, {
    records: [record({ userTag: "<script>alert(1)</script>", email: "a&b<c>" })],
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("a&amp;b&lt;c&gt;"));
});

test("renderPanel shows an error banner when the store cannot be read", () => {
  const html = renderPanel(baseState, {
    records: null,
    recordsError: "getaddrinfo ENOTFOUND red-db2m8kvavr4c73ejq3g0",
  });
  assert.ok(html.includes("Could not read the verification store"));
  assert.ok(html.includes("getaddrinfo ENOTFOUND red-db2m8kvavr4c73ejq3g0"));
  assert.ok(html.includes("banner"));
  // An unreachable store must not claim the registry is empty.
  assert.ok(!html.includes("No claims yet"));
});

test("renderPanel falls back to a readable message when recordsError is blank", () => {
  const html = renderPanel(baseState, { records: null, recordsError: "   " });
  assert.ok(html.includes("Could not read the verification store: the store is unreachable"));
  assert.ok(!html.includes("No claims yet"));
});

test("renderPanel shows an empty state when nobody has verified", () => {
  const html = renderPanel(baseState, { records: [] });
  assert.ok(html.includes("No claims yet"));
  assert.ok(html.includes("/verify"));
  assert.match(html, /Verified students<\/div><div class="v">0</);
});

test("renderPanel surfaces gateway and redis health pills", () => {
  const html = renderPanel({ ...baseState, gateway: "ready", redis: "ready" }, {
    records: [],
  });
  assert.ok(html.includes("Discord: ready"));
  assert.ok(html.includes("Redis: ready"));
});
