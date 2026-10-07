import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isPanelAllowed, renderPanel, type PanelData } from "./panel.ts";

export interface HealthState {
  /** True only when the Discord gateway AND Redis are both connected. */
  ok: boolean;
  gateway: string;
  detail?: string;
  redis?: string;
  redisDetail?: string;
  rosterEntries?: number;
  startedAt: number;
}

/**
 * Tiny readiness endpoint on 0.0.0.0:$PORT so the Freebuff preview can tell
 * when the bot is genuinely connected (200) versus still starting or misconfigured (503).
 *
 * Every path except `/panel` answers with the health JSON; `/panel` renders the
 * admin verification panel (gated by the optional PANEL_TOKEN env var).
 */
export function startHealthServer(
  getState: () => HealthState,
  getPanel?: () => Promise<PanelData>,
): Server {
  const port = Number(process.env.PORT ?? 3000);

  const server = createServer((req, res) => {
    void handleRequest(req, res, getState, getPanel);
  });

  server.on("error", (error) => {
    console.error(`[health] could not listen on port ${port}: ${error.message}`);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[health] listening on http://0.0.0.0:${port}`);
  });

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getState: () => HealthState,
  getPanel?: () => Promise<PanelData>,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/panel") {
      await servePanel(url, res, getState, getPanel);
      return;
    }

    const state = getState();
    const body = JSON.stringify({
      ...state,
      uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    });

    res.writeHead(state.ok ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    console.error(
      `[health] request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal server error");
  }
}

async function servePanel(
  url: URL,
  res: ServerResponse,
  getState: () => HealthState,
  getPanel?: () => Promise<PanelData>,
): Promise<void> {
  const token = process.env.PANEL_TOKEN?.trim();
  if (!isPanelAllowed(url.searchParams, token)) {
    // Don't reveal that a panel exists behind the gate.
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  let data: PanelData = {
    records: null,
    recordsError: "Panel data source is not configured.",
  };
  if (getPanel) data = await getPanel();

  const html = renderPanel(getState(), data);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}
