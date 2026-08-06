import { Router } from "express";
import { getStatus, reindex } from "../services/ragIndex.js";

export const ragRouter = Router();

ragRouter.get("/status", (_req, res) => {
  res.json({ status: getStatus() });
});

/** Blocking - walks + chunks + embeds the whole workspace before responding. A bounded review
 * folder, not a monorepo, so this stays synchronous rather than a progress-streaming endpoint. */
ragRouter.post("/reindex", async (_req, res, next) => {
  try {
    res.json({ status: await reindex() });
  } catch (err) {
    next(err);
  }
});
