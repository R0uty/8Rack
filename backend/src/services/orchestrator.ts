import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { cancelExecution, getExecution, listExecTools, rejectExecution, requestExecution } from "./toolManager.js";
import { getStatus as getRagStatus, search as searchKnowledgeBase } from "./ragIndex.js";
import { getProjectFindings, getTechnologies, lookupCvesByKeyword } from "./findingsManager.js";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { AgentNotFoundError, InvalidTaskStateError, RequestCancelledError, TaskNotFoundError } from "./errors.js";
import type { ChatMessage } from "../types/ollama.js";
import type { ExecutionRecord } from "../types/execTool.js";
import type { RagSearchResult } from "../types/rag.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { Finding, FindingType } from "../types/finding.js";

/** A read-only pseudo-tool, not a registered ExecTool - it's an in-process vector search over the
 * RAG index (see services/ragIndex.ts), not an OS command, so it doesn't go through
 * toolManager.ts/requestExecution and deliberately skips the human-confirmation gate every real
 * ExecTool requires (nothing runs, nothing touches the filesystem beyond the pre-built index). */
const SEARCH_KNOWLEDGE_BASE_TOOL = "search_knowledge_base";

/** A second read-only pseudo-tool, same structural pattern as SEARCH_KNOWLEDGE_BASE_TOOL - lets an
 * agent pull already-known, structured findings for this project (see services/findingsManager.ts)
 * instead of re-scanning or parsing raw tool output itself. */
const QUERY_FINDINGS_TOOL = "query_findings";

/** A third pseudo-tool, same structural pattern - looks up known CVEs for a technology from the
 * public NVD database (see services/cveLookup.ts). Unlike the other two pseudo-tools this makes a
 * real, rate-limited network request (the only outbound internet call anywhere in 8Rack), so it's
 * genuinely async and can take a few seconds - still bypasses human confirmation since it's a
 * read-only public lookup, not a destructive local action. */
const LOOKUP_CVES_TOOL = "lookup_cves";

/** Called with each piece of the agent's reply text as it streams in, for a live "thinking" UX. */
export type ChunkListener = (content: string) => void;

export type TaskStatus =
  | "running"
  | "waiting_confirmation"
  | "waiting_guidance"
  | "completed"
  | "failed"
  | "cancelled"
  | "max_executions_reached"
  | "max_time_reached";

export interface OrchestratorTask {
  id: string;
  projectId: string;
  agentId: string;
  /** Overrides the agent's configured model for every step of this task - the agent's own model
   * stays its default; this is a per-task choice made at creation time. */
  model?: string;
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
 *
 * When `agent.execTools` is set, only those exec tools are listed — an undirected agent (the
 * field omitted) still sees every enabled tool, matching the pre-allowlist behavior.
 */
function buildToolsPreamble(agent: AgentWithStatus | undefined, projectId: string): string {
  const allowed = agent?.execTools;
  const lines = listExecTools()
    .filter((t) => t.enabled)
    .filter((t) => allowed === undefined || allowed.includes(t.id))
    .map((t) => `- ${t.id}: ${t.description}`);

  const ragStatus = getRagStatus();
  const knowledgeBaseLine =
    ragStatus.chunkCount > 0
      ? `- ${SEARCH_KNOWLEDGE_BASE_TOOL}: Semantic search over the indexed workspace codebase - ` +
        'arguments should be a single-element array containing your search query, e.g. ' +
        `{"tool": "${SEARCH_KNOWLEDGE_BASE_TOOL}", "arguments": ["how is authentication handled"]}. ` +
        "Returns the most relevant code snippets. Read-only and does not require approval - prefer " +
        "this over grep/read_file when you're not sure which file to look in."
      : undefined;

  const findingsLine =
    getProjectFindings(projectId).length > 0
      ? `- ${QUERY_FINDINGS_TOOL}: Query structured findings already discovered for this project ` +
        "(ports, technologies, domains, vulnerabilities, etc.) instead of re-scanning or parsing raw " +
        'tool output yourself. Arguments: [] for every finding, or a single-element array with a type ' +
        'to filter, e.g. {"tool": "' +
        QUERY_FINDINGS_TOOL +
        '", "arguments": ["port"]}. Read-only and does not require approval - prefer this over rerunning ' +
        "a scan you've already run."
      : undefined;

  const cveLine =
    getTechnologies(projectId).length > 0
      ? `- ${LOOKUP_CVES_TOOL}: Look up known CVEs for a technology/product from the public NVD ` +
        'database - arguments should be a single-element array with the product name, e.g. ' +
        `{"tool": "${LOOKUP_CVES_TOOL}", "arguments": ["nginx"]}. This makes a real network request ` +
        "to nvd.nist.gov and can take a few seconds. Read-only and does not require approval."
      : undefined;

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
    ...(knowledgeBaseLine ? [knowledgeBaseLine] : []),
    ...(findingsLine ? [findingsLine] : []),
    ...(cveLine ? [cveLine] : []),
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
  agent: AgentWithStatus | undefined,
  projectId: string,
  messages: ChatMessage[],
  model?: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<string> {
  let content = "";
  for await (const chunk of streamAgentChat(
    { agentId, messages, model, toolsPreamble: buildToolsPreamble(agent, projectId) },
    signal,
  )) {
    const piece = chunk.message?.content ?? "";
    if (piece) onChunk?.(piece);
    content += piece;
  }
  return content;
}

function touch(task: OrchestratorTask): void {
  task.updatedAt = Date.now();
}

function formatKnowledgeBaseResults(results: RagSearchResult[]): string {
  if (results.length === 0) return "(no relevant chunks found)";
  return results
    .map((r) => `${r.filePath}:${r.startLine}-${r.endLine} (score ${r.score.toFixed(3)})\n${r.text}`)
    .join("\n\n---\n\n");
}

/**
 * Runs the search_knowledge_base pseudo-tool and returns a tool-result message body shaped like
 * every other tool result (see resumeTask below) - {tool, status, success, exitCode, stdout,
 * parsedOutput} - purely so OrchestratorTaskView's existing generic tool-result rendering handles
 * it with zero frontend changes, even though there's no real exit code/stdout involved.
 */
async function runKnowledgeBaseSearch(args: string[]): Promise<string> {
  const query = args.join(" ").trim();

  if (getRagStatus().chunkCount === 0) {
    return JSON.stringify({
      tool: SEARCH_KNOWLEDGE_BASE_TOOL,
      status: "failed",
      success: false,
      message: "The knowledge base hasn't been indexed yet - reindex it from the Workbench first.",
    });
  }
  if (!query) {
    return JSON.stringify({
      tool: SEARCH_KNOWLEDGE_BASE_TOOL,
      status: "failed",
      success: false,
      message: "search_knowledge_base requires a non-empty query in arguments.",
    });
  }

  try {
    const results = await searchKnowledgeBase(query);
    return JSON.stringify({
      tool: SEARCH_KNOWLEDGE_BASE_TOOL,
      status: "completed",
      success: true,
      exitCode: 0,
      stdout: formatKnowledgeBaseResults(results),
      stderr: "",
      parsedOutput: results,
    });
  } catch (err) {
    return JSON.stringify({
      tool: SEARCH_KNOWLEDGE_BASE_TOOL,
      status: "failed",
      success: false,
      message: err instanceof Error ? err.message : "Knowledge base search failed",
    });
  }
}

const VALID_FINDING_TYPES: FindingType[] = [
  "port",
  "service",
  "technology",
  "domain",
  "subdomain",
  "directory",
  "endpoint",
  "credential",
  "cookie",
  "api",
  "header",
  "interesting_file",
  "potential_vulnerability",
  "confirmed_vulnerability",
  "information",
  "cve",
];

function formatFindingsResults(results: Finding[]): string {
  if (results.length === 0) return "(no findings recorded yet)";
  return results
    .map((f) => `[${f.severity}] ${f.type} — ${f.title} (target: ${f.target}, confidence: ${f.confidence})`)
    .join("\n");
}

/**
 * Runs the query_findings pseudo-tool, same shape/rationale as runKnowledgeBaseSearch above -
 * returns a tool-result message body shaped like every other tool result so the existing
 * generic tool-result UI renders it with zero frontend changes.
 */
function runFindingsQuery(projectId: string, args: string[]): string {
  const typeFilter = args[0];
  if (typeFilter && !VALID_FINDING_TYPES.includes(typeFilter as FindingType)) {
    return JSON.stringify({
      tool: QUERY_FINDINGS_TOOL,
      status: "failed",
      success: false,
      message: `"${typeFilter}" isn't a known finding type. Valid types: ${VALID_FINDING_TYPES.join(", ")}.`,
    });
  }

  const results = typeFilter
    ? getProjectFindings(projectId).filter((f) => f.type === typeFilter)
    : getProjectFindings(projectId);

  return JSON.stringify({
    tool: QUERY_FINDINGS_TOOL,
    status: "completed",
    success: true,
    exitCode: 0,
    stdout: formatFindingsResults(results),
    stderr: "",
    parsedOutput: results,
  });
}

function formatCveResults(results: Finding[]): string {
  if (results.length === 0) return "(no CVEs found)";
  return results
    .map((f) => {
      const score = f.metadata?.cvssScore;
      return `${f.value} [${f.severity}${typeof score === "number" ? `, CVSS ${score}` : ""}] - ${f.description}`;
    })
    .join("\n");
}

/**
 * Runs the lookup_cves pseudo-tool - unlike runKnowledgeBaseSearch/runFindingsQuery this makes a
 * real network request (see services/cveLookup.ts) and is genuinely async, but is otherwise the
 * same shape/rationale: a tool-result message body the existing generic tool-result UI renders
 * with zero frontend changes. Best-effort links the lookup to an existing technology finding
 * sharing the same product name (case-insensitively) so the resulting CVE findings get a real
 * target instead of "unknown".
 */
async function runLookupCves(projectId: string, args: string[]): Promise<string> {
  const keyword = args[0]?.trim();
  if (!keyword) {
    return JSON.stringify({
      tool: LOOKUP_CVES_TOOL,
      status: "failed",
      success: false,
      message: `${LOOKUP_CVES_TOOL} requires a product name in arguments, e.g. ["nginx"].`,
    });
  }

  const match = getTechnologies(projectId).find((f) => f.title.toLowerCase() === keyword.toLowerCase());
  const target = match?.target ?? "unknown";

  try {
    const results = await lookupCvesByKeyword(projectId, keyword, target);
    return JSON.stringify({
      tool: LOOKUP_CVES_TOOL,
      status: "completed",
      success: true,
      exitCode: 0,
      stdout: formatCveResults(results),
      stderr: "",
      parsedOutput: results,
    });
  } catch (err) {
    return JSON.stringify({
      tool: LOOKUP_CVES_TOOL,
      status: "failed",
      success: false,
      message: err instanceof Error ? err.message : "CVE lookup failed",
    });
  }
}

/** Advances a task by exactly one step: one agent call, then either a tool request or a final answer. */
async function advance(task: OrchestratorTask, onChunk?: ChunkListener, signal?: AbortSignal): Promise<OrchestratorTask> {
  if (Date.now() - task.createdAt > env.maxOrchestratorTaskTimeMs) {
    task.status = "max_time_reached";
    touch(task);
    return task;
  }

  const agent = await getAgent(task.agentId);

  let reply: string;
  try {
    reply = await collectAgentReply(task.agentId, agent, task.projectId, task.messages, task.model, onChunk, signal);
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

  if (toolRequest.tool === SEARCH_KNOWLEDGE_BASE_TOOL) {
    task.messages.push({ role: "tool", content: await runKnowledgeBaseSearch(toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === QUERY_FINDINGS_TOOL) {
    task.messages.push({ role: "tool", content: runFindingsQuery(task.projectId, toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === LOOKUP_CVES_TOOL) {
    task.messages.push({ role: "tool", content: await runLookupCves(task.projectId, toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  // Enforced here too, not just by omitting the tool from the preamble - a model can still guess
  // or recall a tool id it isn't supposed to have, and the preamble alone is only a suggestion.
  if (agent?.execTools && !agent.execTools.includes(toolRequest.tool)) {
    task.messages.push({
      role: "tool",
      content: JSON.stringify({
        error: `Agent "${task.agentId}" is not permitted to use tool "${toolRequest.tool}"`,
      }),
    });
    task.status = "waiting_guidance";
    touch(task);
    return task;
  }

  let record: ExecutionRecord;
  try {
    record = await requestExecution({
      tool: toolRequest.tool,
      arguments: toolRequest.arguments,
      projectId: task.projectId,
    });
  } catch (err) {
    // Previously this fed the error straight back and recursed immediately - the agent would
    // silently retry (or give up) with zero human visibility into *why*, e.g. "that tool isn't
    // installed" or "that argument isn't allowed". Pausing here (same as a failed execution below)
    // gives the human a chance to steer it - "try httpx instead" - before another guess gets spent
    // against the tool-call cap.
    task.messages.push({
      role: "tool",
      content: JSON.stringify({ error: err instanceof Error ? err.message : "Tool request was invalid" }),
    });
    task.status = "waiting_guidance";
    touch(task);
    return task;
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
  model?: string,
): Promise<OrchestratorTask> {
  const agent = await getAgent(agentId);
  if (!agent) throw new AgentNotFoundError(agentId);

  const task: OrchestratorTask = {
    id: randomUUID(),
    projectId,
    agentId,
    model,
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

  // A failed or forcibly-cancelled execution pauses for human guidance instead of letting the
  // agent guess what to do next on its own - see provideGuidance below. A successful run or an
  // explicit reject (already a deliberate human decision, not a failure to react to) both continue
  // automatically exactly as before - no added friction on the common path.
  if (execution.status === "failed" || execution.status === "cancelled") {
    task.status = "waiting_guidance";
    touch(task);
    void persistTasks(task.projectId).catch((err) => console.error("[orchestrator] persist failed:", err));
    return task;
  }

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

/**
 * Resumes a task paused at "waiting_guidance" - either a tool request that failed outright (no
 * execution was ever created, see advance()'s requestExecution catch) or a confirmed execution
 * that came back failed/cancelled (see resumeTask above). An optional human note - e.g. "that tool
 * isn't installed, try httpx instead" or "the path doesn't exist, try /var/www" - is appended as a
 * fresh user message before the agent reasons about what to do next; omitting it just lets the
 * agent try again on its own with only what's already in the transcript.
 */
export async function provideGuidance(
  id: string,
  note?: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const task = tasks.get(id);
  if (!task) throw new TaskNotFoundError(id);
  if (task.status !== "waiting_guidance") {
    throw new InvalidTaskStateError(`Task "${id}" is not waiting on guidance (status: ${task.status})`);
  }

  if (note?.trim()) task.messages.push({ role: "user", content: note.trim() });
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

/**
 * Sends a follow-up message into an already-completed task, continuing the same conversation
 * (full message history, same toolExecutionIds/toolCallCount) instead of starting a fresh task
 * with no memory of what came before. Only valid from "completed" - the other terminal statuses
 * (failed/cancelled/max_executions_reached/max_time_reached) each represent a state the caps or an
 * explicit cancel decided the loop shouldn't continue from, and "waiting_confirmation" already has
 * its own continuation path (resumeTask, above).
 */
export async function continueTask(
  id: string,
  message: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<OrchestratorTask> {
  const task = tasks.get(id);
  if (!task) throw new TaskNotFoundError(id);
  if (task.status !== "completed") {
    throw new InvalidTaskStateError(`Task "${id}" can only be continued from "completed" (status: ${task.status})`);
  }

  task.messages.push({ role: "user", content: message });
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
    // cancelExecution only works on an execution that's actually running (has a registered
    // AbortController) - one still sitting at pending_confirmation (the common case: the task was
    // cancelled before the user ever approved the tool) has no process to abort, so cancelExecution
    // would throw and, uncaught, leave the ExecutionRecord stuck at pending_confirmation forever
    // even though the task itself now shows cancelled. rejectExecution is the correct terminal
    // state for that case - "this tool call never happened" - same as an explicit user rejection.
    const execution = getExecution(task.pendingExecutionId);
    try {
      if (execution?.status === "pending_confirmation") rejectExecution(task.pendingExecutionId);
      else cancelExecution(task.pendingExecutionId);
    } catch {
      // Already finished, rejected, or cancelled elsewhere between the read above and this call -
      // nothing left to do.
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
