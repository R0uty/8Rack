import { Router } from "express";
import { refreshStatus, reindex } from "../services/knowledgeBase.js";

export const ragRouter = Router();

/** Asks the RAG MCP server when MCP_RAG_SERVER is set - a server that's down is a 502, not a stale
 * answer. */
ragRouter.get("/status", async (_req, res, next) => {
  try {
    res.json({ status: await refreshStatus() });
  } catch (err) {
    next(err);
  }
});

/** Blocking - walks + chunks + embeds the whole workspace before responding (locally or on the RAG
 * server). A bounded review folder, not a monorepo, so this stays synchronous rather than a
 * progress-streaming endpoint. */
ragRouter.post("/reindex", async (_req, res, next) => {
  try {
    res.json({ status: await reindex() });
  } catch (err) {
    next(err);
  }
});
