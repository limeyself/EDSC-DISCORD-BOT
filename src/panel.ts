import type { HealthState } from "./health.ts";
import type { VerifyRecord } from "./store.ts";

/** Data the panel needs beyond the shared health state. */
export interface PanelData {
  /** All verification records, or null when the store could not be read. */
  records: VerifyRecord[] | null;
  recordsError?: string;
}

/** Escapes every HTML-significant character — records come from user input. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The panel is open unless PANEL_TOKEN is set; with a token set, the request
 * must carry a matching `?token=` query parameter or it gets a plain 404.
 */
export function isPanelAllowed(params: URLSearchParams, token?: string): boolean {
  if (!token) return true;
  return params.get("token") === token;
}

/** School-local wall time, e.g. "07 Oct 2026, 14:03". Invalid input → "—". */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function uptimeText(startedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pill(label: string, value: string | undefined): string {
  const ok = value === "ready";
  const detail = escapeHtml(value ?? "unknown");
  return `<span class="pill ${ok ? "ok" : "warn"}" title="${detail}">${label}: ${
    ok ? "ready" : escapeHtml(value ?? "unknown")
  }</span>`;
}

/**
 * Server-rendered admin panel: who has claimed which school email, which class
 * role they received, and when — plus live gateway/Redis health.
 */
export function renderPanel(state: HealthState, data: PanelData): string {
  const records = data.records
    ? [...data.records].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))
    : [];

  const classCounts = new Map<string, number>();
  for (const record of records) {
    classCounts.set(record.className, (classCounts.get(record.className) ?? 0) + 1);
  }
  const classChips = [...classCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([className, count]) =>
        `<span class="chip">${escapeHtml(className)}<b>${count}</b></span>`,
    )
    .join("");

  const rows = records
    .map((record) => {
      const initial = escapeHtml((record.userTag || "?").charAt(0).toUpperCase());
      return `<tr>
        <td><span class="avatar">${initial}</span>${escapeHtml(record.userTag)}</td>
        <td class="mono">${escapeHtml(record.email)}</td>
        <td><span class="badge">${escapeHtml(record.className)}</span></td>
        <td class="when">${formatTimestamp(record.verifiedAt)}</td>
      </tr>`;
    })
    .join("");

  const storeDown = data.records === null;
  const storeError = data.recordsError?.trim() || "the store is unreachable";

  const table = storeDown
    ? `<div class="empty">Records are unavailable while the verification store is
        unreachable — fix the connection and this page will fill in.</div>`
    : records.length > 0
      ? `<table>
          <thead>
            <tr><th>Discord user</th><th>Claimed email</th><th>Class</th><th>Verified</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`
      : `<div class="empty">No claims yet — the registry is empty. The first student to
          run <code>/verify</code> will appear here.</div>`;

  const banner = storeDown
    ? `<div class="banner">⚠ Could not read the verification store: ${escapeHtml(storeError)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Year 7 Verification Panel</title>
<style>
  :root {
    --bg: #0a0f1a;
    --panel: #111a2b;
    --line: #1e2b45;
    --text: #e6edf7;
    --muted: #8aa0c2;
    --accent: #34d399;
    --accent-dim: rgba(52, 211, 153, 0.12);
    --warn: #fbbf24;
    --warn-dim: rgba(251, 191, 36, 0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(1100px 500px at 85% -10%, rgba(52, 211, 153, 0.08), transparent 60%),
      radial-gradient(900px 420px at -10% 110%, rgba(56, 130, 246, 0.07), transparent 60%),
      var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 40px 24px 64px; }
  header { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid transparent; }
  .pill.ok { background: var(--accent-dim); color: var(--accent); border-color: rgba(52, 211, 153, 0.35); }
  .pill.warn { background: var(--warn-dim); color: var(--warn); border-color: rgba(251, 191, 36, 0.35); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; }
  .card .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
  .card .v { font-size: 28px; font-weight: 700; margin-top: 4px; letter-spacing: -0.02em; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .chip b { color: var(--text); font-variant-numeric: tabular-nums; }
  .banner { background: var(--warn-dim); border: 1px solid rgba(251, 191, 36, 0.4); color: var(--warn); padding: 12px 16px; border-radius: 12px; margin-bottom: 20px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: rgba(255, 255, 255, 0.025); }
  .avatar { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 50%; background: var(--accent-dim); color: var(--accent); font-size: 12px; font-weight: 700; margin-right: 10px; vertical-align: middle; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color: #c6d4ea; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: var(--accent-dim); color: var(--accent); font-weight: 700; font-size: 13px; }
  .when { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 14px; padding: 40px 24px; text-align: center; color: var(--muted); }
  .empty code { color: var(--accent); }
  footer { margin-top: 18px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Year 7 <span>Verification Panel</span></h1>
      <div class="sub">Claim registry from Redis · auto-refreshes every 15 s</div>
    </div>
    <div class="pills">
      ${pill("Discord", state.gateway)}
      ${pill("Redis", state.redis)}
    </div>
  </header>

  <div class="cards">
    <div class="card"><div class="k">Verified students</div><div class="v">${records.length}</div></div>
    <div class="card"><div class="k">Classes represented</div><div class="v">${classCounts.size}</div></div>
    <div class="card"><div class="k">Roster entries</div><div class="v">${state.rosterEntries ?? "—"}</div></div>
    <div class="card"><div class="k">Uptime</div><div class="v">${uptimeText(state.startedAt)}</div></div>
  </div>

  ${classChips ? `<div class="chips">${classChips}</div>` : ""}
  ${banner}
  <main>${table}</main>

  <footer>
    <span>Claims are permanent · duplicates are blocked with SET NX</span>
    <span><a href="/">health JSON</a> · ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })}</span>
  </footer>
</div>
<script>setTimeout(() => location.reload(), 15000);</script>
</body>
</html>`;
}
