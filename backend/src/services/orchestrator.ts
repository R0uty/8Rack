import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { cancelExecution, getExecution, listExecTools, requestExecution } from "./toolManager.js";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { AgentNotFoundError, InvalidTaskStateError, RequestCancelledError, TaskNotFoundError } from "./errors.js";
import type { ChatMessage } from "../types/ollama.js";
import type { ExecutionRecord } from "../types/execTool.js";

/** Called with each piece of the agent's reply text as it streams in, for a live "thinking" UX. */
export type ChunkListener = (content: string) => void;

export type TaskStatus =
  | "running"
  | "waiting_confirmation"
  | "completed"
  | "failed"
  | "cancelled"
  | "max_executions_reached"
  | "max_time_reached";

export interface OrchestratorTask {
  id: string;
  projectId: string;
  agentId: string;
  objective: string;
  /** user/assistant/tool turns only — the agent's systemPrompt + tools preamble are injected fresh each call. */
  messages: ChatMessage[];
  status: TaskStatus;
  toolExecutionIds: string[];
  toolCallCount: number;
  pendingExecutionId?: string;
  finalResponse?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, OrchestratorTask>();
const TASKS_FILE = "orchestrator-tasks.json";

function projectTasks(projectId: string): OrchestratorTask[] {
  return [...tasks.values()].filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistTasks(projectId: string): Promise<void> {
  await writeProjectJson(projectId, TASKS_FILE, projectTasks(projectId));
}

/** Hydrates in-memory tasks from disk - called once at server startup so task history survives a
 * restart instead of only being written-through from that point on. */
export async function loadTasksFromDisk(): Promise<void> {
  const projectIds = await listProjectIds();
  for (const projectId of projectIds) {
    const projectTasksOnDisk = await readProjectJson<OrchestratorTask>(projectId, TASKS_FILE);
    for (const task of projectTasksOnDisk) tasks.set(task.id, task);
  }
}

/**
 * Describes the available tools and the exact JSON shape the agent must respond with to request
 * one — distinct from Ollama's native tool_calls convention (used by the streamChatWithTools
 * path): this is a plain-text convention the Orchestrator itself parses out of the agent's reply,
 * matching the task spec's standardized Tool Request format exactly.
 */
function buildToolsPreamble(): string {
  const lines = listExecTools()
    .filter((t) => t.enabled)
    .map((t) => `- ${t.id}: ${t.description}`);

  return [
    "You have access to the following tools. To use one, respond with ONLY a single JSON object",
    'of the exact form {"tool": "<tool id>", "arguments": ["<arg1>", "<arg2>", ...]} and nothing',
    "else - no explanation, no markdown code fences, no extra text before or after it.",
    "Every tool execution requires human approval before it runs, so only request a tool when you",
    "actually need its output to proceed.",
    "If you don't need a tool, respond normally in plain text with your answer - that ends the task.",
    "",
    "Available tools:",
    ...lines,
  ].join("\n");
}

function tryParseCandidate(candidate: string): { tool: string; arguments: string[] } | undefined {
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; arguments?: unknown };
    if (
      typeof parsed.tool === "string" &&
      Array.isArray(parsed.arguments) &&
      parsed.arguments.every((a) => typeof a === "string")
    ) {
      return { tool: parsed.tool, arguments: parsed.arguments as string[] };
    }
  } catch {
    // Not valid JSON, or not a tool-request shape.
  }
  return undefined;
}

/**
 * Despite the preamble instructing "respond with ONLY the JSON object", models often still
 * prepend a sentence ("Sure, here's the call:") even when told not to. Try the strict case first
 * (whole reply, optionally fenced, is the JSON), then fall back to the substring between the
 * first "{" and last "}" in the reply — handles the common one-JSON-object-plus-prose case
 * without trying to be a general-purpose JSON extractor.
 */
export function parseToolRequest(text: string): { tool: string; arguments: string[] } | undefined {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const strict = tryParseCandidate(fence ? fence[1].trim() : trimmed);
  if (strict) return strict;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return tryParseCandidate(trimmed.slice(start, end + 1));
}

async function collectAgentReply(
  agentId: string,
  messages: ChatMessage[],
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<string> {
  let content = "";
  for await (const chunk of streamAgentChat({ agentId, messages, toolsPreamble: buildToolsPreamble() }, signal)) {
    const piece = chunk.message?.content ?? "";
    if (piece) onChunk?.(piece);
    content += piece;
  }
  return content;
}

function touch(task: OrchestratorTask): void {
  task.updatedAt = Date.now();
}

/** Advances a task by exactly one step: one agent call, then either a tool request or a final answer. */
async function advance(task: OrchestratorTask, onChunk?: ChunkListener, signal?: AbortSignal): Promise<OrchestratorTask> {
  if (Date.now() - task.createdAt > env.maxOrchestratorTaskTimeMs) {
    task.status = "max_time_reached";
    touch(task);
    return task;
  }

  let reply: string;
  try {
    reply = await collectAgentReply(task.agentId, task.messages, onChunk, signal);
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      task.status = "cancelled";
      touch(task);
      throw err;
    }
    task.status = "failed";
    task.error = err instanceof Error ? err.message : "Agent call failed";
    touch(task);
    return task;
  }

  task.messages.push({ role: "assistant", content: reply });

  const toolRequest = parseToolRequest(reply);
  if (!toolRequest) {
    task.status = "completed";
    task.finalResponse = reply;
    touch(task);
    return task;
  }

  // Every tool-call attempt counts against the cap, valid or not, so a model that keeps requesting
  // malformed/unknown tools can't loop forever without ever incrementing toward the limit.
  if (task.toolCallCount >= env.maxOrchestratorToolCalls) {
    task.status = "max_executions_reached";
    touch(task);
    return task;
  }
  task.toolCallCount++;

  let record: ExecutionRecord;
  try {
    record = await requestExecution({
      tool: toolRequest.tool,
      arguments: toolRequest.arguments,
      projectId: task.projectId,
    });
  } catch (err) {
    task.messages.push({
      role: "tool",
      content: JSON.stringify({ error: err instanceof Error ? err.message : "Tool request was invalid" }),
    });
    return advance(task, onChunk, signal);
  }

  task.toolExecutionIds.push(record.id);
  task.pendingExecutionId = record.id;
  task.status = "waiting_confirmation";
  touch(task);
  return task;
}

export async function createTask(
  agentId: string,
  objective: string,
  projectId: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const agent = await getAgent(agentId);
  if (!agent) throw new AgentNotFoundError(agentId);

  const task: OrchestratorTask = {
    id: randomUUID(),
    projectId,
    agentId,
    objective,
    messages: [{ role: "user", content: objective }],
    status: "running",
    toolExecutionIds: [],
    toolCallCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  tasks.set(task.id, task);
  try {
    const result = await advance(task, onChunk, signal);
    await persistTasks(task.projectId);
    return result;
  } catch (err) {
    await persistTasks(task.projectId).catch(() => {});
    throw err;
  }
}

/**
 * Call once the pending execution (task.pendingExecutionId) has been confirmed or rejected via
 * the existing POST /api/tools/executions/:id/confirm|reject endpoints. Feeds the outcome back to
 * the agent as a tool-role message and continues the loop.
 */
export async function resumeTask(id: string, onChunk?: ChunkListener, signal?: AbortSignal): Promise<OrchestratorTask> {
  const task = tasks.get(id);
  if (!task) throw new TaskNotFoundError(id);
  if (task.status !== "waiting_confirmation" || !task.pendingExecutionId) {
    throw new InvalidTaskStateError(`Task "${id}" is not waiting on a tool confirmation (status: ${task.status})`);
  }

  const execution = getExecution(task.pendingExecutionId);
  if (!execution) throw new InvalidTaskStateError(`Pending execution "${task.pendingExecutionId}" is missing`);
  if (execution.status === "pending_confirmation" || execution.status === "running") {
    throw new InvalidTaskStateError(
      `Execution "${execution.id}" hasn't been confirmed or rejected yet (status: ${execution.status}) - ` +
        "call POST /api/tools/executions/:id/confirm or /reject first",
    );
  }

  const resultMessage: ChatMessage =
    execution.status === "rejected"
      ? { role: "tool", content: JSON.stringify({ rejected: true, message: "The user rejected this tool execution." }) }
      : {
          role: "tool",
          content: JSON.stringify({
            tool: execution.toolId,
            status: execution.status,
            success: execution.result?.success ?? false,
            exitCode: execution.result?.exitCode ?? null,
            stdout: execution.result?.stdout ?? "",
            stderr: execution.result?.stderr ?? "",
            timedOut: execution.result?.timedOut ?? false,
            cancelled: execution.result?.cancelled ?? false,
            parsedOutput: execution.result?.parsedOutput,
          }),
        };

  task.messages.push(resultMessage);
  task.pendingExecutionId = undefined;
  task.status = "running";
  try {
    const result = await advance(task, onChunk, signal);
    await persistTasks(task.projectId);
    return result;
  } catch (err) {
    await persistTasks(task.projectId).catch(() => {});
    throw err;
  }
}

export function cancelTask(id: string): OrchestratorTask {
  const task = tasks.get(id);
  if (!task) throw new TaskNotFoundError(id);
  if (task.pendingExecutionId) {
    try {
      cancelExecution(task.pendingExecutionId);
    } catch {
      // Already finished, rejected, or never started running - nothing to cancel.
    }
  }
  task.status = "cancelled";
  touch(task);
  // Fire-and-forget: cancelTask stays synchronous (its route calls it inline) - see
  // persistTasks/DEVELOPMENT.md for the same tradeoff made in toolManager.ts.
  void persistTasks(task.projectId).catch((err) => console.error("[orchestrator] persist failed:", err));
  return task;
}

export function getTask(id: string): OrchestratorTask | undefined {
  return tasks.get(id);
}

export function listTasks(projectId: string): OrchestratorTask[] {
  return projectTasks(projectId);
}
