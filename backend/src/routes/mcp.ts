import { Router } from "express";
import { listServers, refreshServers, setMcpToolEnabled } from "../services/mcpClient.js";

export const mcpRouter = Router();

mcpRouter.get("/servers", (_req, res) => {
  res.json({ servers: listServers() });
});

/** Blocking - connects to every configured server and lists its tools, bounded per request by
 * MCP_REQUEST_TIMEOUT_MS. */
mcpRouter.post("/servers/refresh", async (_req, res, next) => {
  try {
    res.json({ servers: await refreshServers() });
  } catch (err) {
    next(err);
  }
});

/** The enable switch - a discovered MCP tool starts disabled and no agent sees it until a human turns
 * it on here. Persisted. `:id` is the "<server>.<tool>" catalog id. Returns the updated server list. */
mcpRouter.patch("/tools/:id", async (req, res, next) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: 'Request must be {"enabled": boolean}', code: "INVALID_REQUEST" });
    return;
  }
  try {
    await setMcpToolEnabled(req.params.id, enabled);
    res.json({ servers: listServers() });
  } catch (err) {
    next(err);
  }
});
