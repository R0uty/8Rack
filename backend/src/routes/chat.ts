import { Router } from "express";
import { streamChat } from "../services/ollama.js";
import { abortOnClientDisconnect, pipeNdjsonStream } from "./streamUtils.js";
import { isValidMessages, sanitizeChatOptions } from "./chatValidation.js";

export const chatRouter = Router();

interface ChatRequestBody {
  model?: unknown;
  messages?: unknown;
  options?: unknown;
  keepAlive?: unknown;
}

chatRouter.post("/", async (req, res, next) => {
  const body = req.body as ChatRequestBody;

  if (typeof body.model !== "string" || !body.model.trim()) {
    res.status(400).json({ error: "model is required", code: "INVALID_REQUEST" });
    return;
  }
  if (!isValidMessages(body.messages)) {
    res.status(400).json({ error: "messages must be a non-empty array of {role, content}", code: "INVALID_REQUEST" });
    return;
  }
  const controller = abortOnClientDisconnect(res);

  const chatRequest = {
    model: body.model,
    messages: body.messages,
    options: sanitizeChatOptions(body.options),
    keep_alive: typeof body.keepAlive === "string" ? body.keepAlive : undefined,
  };
  const stream = streamChat(chatRequest, controller.signal);

  await pipeNdjsonStream(res, stream, next);
});
