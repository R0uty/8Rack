import { Router } from "express";
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentConfigWarnings,
  getEnabledAgents,
  reloadAgents,
  updateAgent,
} from "../services/agentManager.js";
import { streamAgentChat } from "../services/chatService.js";
import { abortOnClientDisconnect, pipeNdjsonStream } from "./streamUtils.js";
import { isValidMessages, isValidToolNames } from "./chatValidation.js";
import type { ChatOptions } from "../types/ollama.js";
import type { Agent } from "../types/agent.js";

export const agentsRouter = Router();

interface AgentChatRequestBody {
  messages?: unknown;
  options?: unknown;
  keepAlive?: unknown;
  tools?: unknown;
  model?: unknown;
}

/** Shallow shape check only - createAgent/updateAgent run the real field-by-field validation
 * (agentManager.ts#assertValidAgentConfig) and report a precise 400 via InvalidAgentConfigError. */
function isPlausibleAgentBody(body: unknown): body is Agent {
  return !!body && typeof body === "object" && typeof (body as Partial<Agent>).id === "string";
}

agentsRouter.get("/", async (_req, res) => {
  res.json({ agents: await getEnabledAgents(), warnings: getAgentConfigWarnings() });
});

agentsRouter.post("/", async (req, res, next) => {
  if (!isPlausibleAgentBody(req.body)) {
    res.status(400).json({ error: "Request body must be an agent config with at least an id", code: "INVALID_REQUEST" });
    return;
  }
  try {
    const agent = await createAgent(req.body);
    res.status(201).json({ agent });
  } catch (err) {
    next(err);
  }
});

/** Forces a fresh read of every agent config file and re-validates their models against Ollama —
 * lets a newly dropped-in agent file (or a freshly pulled model) take effect without a restart. */
agentsRouter.post("/reload", async (_req, res) => {
  const agents = await reloadAgents();
  res.json({ agents, warnings: getAgentConfigWarnings() });
});

agentsRouter.get("/:id", async (req, res) => {
  const agent = await getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: `Agent "${req.params.id}" was not found`, code: "AGENT_NOT_FOUND" });
    return;
  }
  res.json({ agent });
});

agentsRouter.put("/:id", async (req, res, next) => {
  if (!isPlausibleAgentBody(req.body)) {
    res.status(400).json({ error: "Request body must be an agent config with at least an id", code: "INVALID_REQUEST" });
    return;
  }
  try {
    const agent = await updateAgent(req.params.id, req.body);
    res.json({ agent });
  } catch (err) {
    next(err);
  }
});

agentsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteAgent(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
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
  if (body.model !== undefined && typeof body.model !== "string") {
    res.status(400).json({ error: "model must be a string", code: "INVALID_REQUEST" });
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
      model: body.model as string | undefined,
    },
    controller.signal,
  );

  await pipeNdjsonStream(res, stream, next);
});
