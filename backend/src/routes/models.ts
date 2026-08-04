import { Router } from "express";
import { listModels } from "../services/ollama.js";

export const modelsRouter = Router();

modelsRouter.get("/", async (_req, res) => {
  const models = await listModels();
  res.json({ models });
});
