import { createServer, type Server } from "node:http";

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
 */
export function startHealthServer(getState: () => HealthState): Server {
  const port = Number(process.env.PORT ?? 3000);

  const server = createServer((req, res) => {
    void req;
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
  });

  server.on("error", (error) => {
    console.error(`[health] could not listen on port ${port}: ${error.message}`);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[health] listening on http://0.0.0.0:${port}`);
  });

  return server;
}
