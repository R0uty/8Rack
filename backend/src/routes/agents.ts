import { Router } from "express";
import { getAgent, getEnabledAgents, reloadAgents } from "../services/agentManager.js";
import { streamAgentChat } from "../services/chatService.js";
import { abortOnClientDisconnect, pipeNdjsonStream } from "./streamUtils.js";
import { isValidMessages, isValidToolNames } from "./chatValidation.js";
import type { ChatOptions } from "../types/ollama.js";

export const agentsRouter = Router();

interface AgentChatRequestBody {
  messages?: unknown;
  options?: unknown;
  keepAlive?: unknown;
  tools?: unknown;
}

agentsRouter.get("/", async (_req, res) => {
  res.json({ agents: await getEnabledAgents() });
});

/** Forces a fresh read of every agent config file and re-validates their models against Ollama —
 * lets a newly dropped-in agent file (or a freshly pulled model) take effect without a restart. */
agentsRouter.post("/reload", async (_req, res) => {
  res.json({ agents: await reloadAgents() });
});

agentsRouter.get("/:id", async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: `Agent "${req.params.id}" was not found`, code: "AGENT_NOT_FOUND" });
    return;
  }
  res.json({ agent });
});

agentsRouter.post("/:id/chat", async (req, res, next) => {
  const body = req.body as AgentChatRequestBody;

  if (!isValidMessages(body.messages)) {
    res.status(400).json({ error: "messages must be a non-empty array of {role, content}", code: "INVALID_REQUEST" });
    return;
  }
  if (body.tools !== undefined && !isValidToolNames(body.tools)) {
    res.status(400).json({ error: "tools must be an array of tool names", code: "INVALID_REQUEST" });
    return;
  }

  const controller = abortOnClientDisconnect(res);

  const stream = streamAgentChat(
    {
      agentId: req.params.id,
      messages: body.messages,
      options: body.options as ChatOptions | undefined,
      tools: body.tools,
      keepAlive: typeof body.keepAlive === "string" ? body.keepAlive : undefined,
    },
    controller.signal,
  );

  await pipeNdjsonStream(res, stream, next);
});
