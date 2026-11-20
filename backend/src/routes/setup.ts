import { Router } from "express";
import { getSetupStatus } from "../services/setupCheck.js";

export const setupRouter = Router();

/** The first-run checklist: Ollama, agent and embedding models, recon tools. */
setupRouter.get("/", async (_req, res) => {
  res.json({ setup: await getSetupStatus() });
});
