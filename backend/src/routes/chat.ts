import { Router } from "express";
import { resolveOllamaTools, streamChat, streamChatWithTools } from "../services/ollama.js";
import { abortOnClientDisconnect, pipeNdjsonStream } from "./streamUtils.js";
import { isValidMessages, isValidToolNames, sanitizeChatOptions } from "./chatValidation.js";

export const chatRouter = Router();

interface ChatRequestBody {
  model?: unknown;
  messages?: unknown;
  options?: unknown;
  keepAlive?: unknown;
  tools?: unknown;
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
  if (body.tools !== undefined && !isValidToolNames(body.tools)) {
    res.status(400).json({ error: "tools must be an array of tool names", code: "INVALID_REQUEST" });
    return;
  }

  let toolSpecs;
  if (body.tools?.length) {
    const { specs, unknown } = resolveOllamaTools(body.tools);
    if (unknown.length) {
      res.status(400).json({ error: `Unknown tool(s): ${unknown.join(", ")}`, code: "INVALID_REQUEST" });
      return;
    }
    toolSpecs = specs;
  }

  const controller = abortOnClientDisconnect(res);

  const chatRequest = {
    model: body.model,
    messages: body.messages,
    options: sanitizeChatOptions(body.options),
    keep_alive: typeof body.keepAlive === "string" ? body.keepAlive : undefined,
    tools: toolSpecs,
  };
  const stream = toolSpecs
    ? streamChatWithTools(chatRequest, controller.signal)
    : streamChat(chatRequest, controller.signal);

  await pipeNdjsonStream(res, stream, next);
});
