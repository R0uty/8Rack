import { Router } from "express";
import { listServers, refreshServers } from "../services/mcpClient.js";

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
