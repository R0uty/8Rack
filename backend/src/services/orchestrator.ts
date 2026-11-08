import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getAgent } from "./agentManager.js";
import { streamAgentChat } from "./chatService.js";
import { cancelExecution, getExecution, listExecToolsWithStatus, rejectExecution, requestExecution } from "./toolManager.js";
import { getStatus as getRagStatus, search as searchKnowledgeBase } from "./ragIndex.js";
import { listMcpTools } from "./mcpClient.js";
import {
  createAgentFinding,
  getFinding,
  getMissionFindings,
  getTechnologies,
  lookupCvesByKeyword,
  validateFinding,
} from "./findingsManager.js";
import { upsertAsset } from "./assetManager.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { getMission, onMissionDeleted } from "./missionManager.js";
import { AgentNotFoundError, InvalidTaskStateError, RequestCancelledError, TaskNotFoundError } from "./errors.js";
import type { ChatMessage } from "../types/ollama.js";
import type { ExecutionRecord } from "../types/execTool.js";
import type { RagSearchResult } from "../types/rag.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { Finding, FindingCreateInput, FindingSeverity, FindingType } from "../types/finding.js";
import type { Asset, AssetCreateInput, AssetType } from "../types/asset.js";
import type { Mission } from "../types/mission.js";

/** A read-only pseudo-tool, not a registered ExecTool - it's an in-process vector search over the
 * RAG index (see services/ragIndex.ts), not an OS command, so it doesn't go through
 * toolManager.ts/requestExecution and deliberately skips the human-confirmation gate every real
 * ExecTool requires (nothing runs, nothing touches the filesystem beyond the pre-built index). */
const SEARCH_KNOWLEDGE_BASE_TOOL = "search_knowledge_base";

/** A second read-only pseudo-tool, same structural pattern as SEARCH_KNOWLEDGE_BASE_TOOL - lets an
 * agent pull already-known, structured findings for this mission (see services/findingsManager.ts)
 * instead of re-scanning or parsing raw tool output itself. */
const QUERY_FINDINGS_TOOL = "query_findings";

/** A third pseudo-tool, same structural pattern - looks up known CVEs for a technology from the
 * public NVD database (see services/cveLookup.ts). Unlike the other two pseudo-tools this makes a
 * real, rate-limited network request (the only outbound internet call anywhere in 8Rack), so it's
 * genuinely async and can take a few seconds - still bypasses human confirmation since it's a
 * read-only public lookup, not a destructive local action. */
const LOOKUP_CVES_TOOL = "lookup_cves";

/**
 * A real ExecTool (tee), not a pseudo-tool - still goes through the normal requestExecution/
 * confirm flow, human approval and all. Called out separately because its argument *shape* needs
 * translation: the plain-text {"tool", "arguments"} convention every tool speaks has no `stdin`
 * field, but tee's actual content comes from stdin, not argv - `write_file`'s own `usageHint`
 * (tools/exec/builtins.ts) tells the model to reply with `arguments: [path, content]`, and
 * splitWriteFileContent below is what turns that two-element convention into the real
 * ToolRequestBody shape (`arguments: [path], stdin: content`) right before requestExecution is
 * called. See toolManager.ts#requestExecution's resolvedCommand annotation for how the confirming
 * human still gets *some* visibility into a stdin-carrying execution without the content itself
 * being persisted into the (listable) execution history.
 */
const WRITE_FILE_TOOL_ID = "write_file";

function splitWriteFileContent(toolRequest: {
  tool: string;
  arguments: string[];
}): { arguments: string[]; stdin: string | undefined } {
  if (toolRequest.tool !== WRITE_FILE_TOOL_ID) return { arguments: toolRequest.arguments, stdin: undefined };
  const [path, content] = toolRequest.arguments;
  return { arguments: path !== undefined ? [path] : [], stdin: content };
}

/** A fourth pseudo-tool - lets an agent record a structured Finding directly (see
 * services/findingsManager.ts#createAgentFinding) instead of only describing one in plain text,
 * the headline ask behind the Findings & Evidence System task. Same structural pattern as the
 * other three, but genuinely mutates mission state (it's not read-only) - still skips human
 * confirmation, same reasoning as a human being able to log a finding manually via
 * POST /api/missions/:id/findings with no gate: it records data, it doesn't run anything. Always
 * listed (no precondition like the other three, which only appear once there's something to
 * query/look up). */
const CREATE_FINDING_TOOL = "create_finding";

/** A fifth pseudo-tool, same structural pattern as CREATE_FINDING_TOOL - lets an agent register or
 * update an Asset Inventory entry directly (see services/assetManager.ts#upsertAsset) for plain
 * recon with no accompanying finding to log (e.g. "found subdomain api.example.com, nothing
 * interesting there yet"). Findings that *do* correspond to an asset type (domain/subdomain/port/
 * service/technology/api) already mirror into the inventory automatically via
 * findingsManager.ts#mirrorAssetFromFinding - this tool is for the no-finding case only. */
const UPSERT_ASSET_TOOL = "upsert_asset";

/** A sixth pseudo-tool, same structural pattern - the Finding Validation pipeline's terminal step
 * (see services/findingsManager.ts#validateFinding). Lets the Vulnerability Validator agent (or any
 * agent asked to review a finding) record a real verdict - confirmed/false_positive/duplicate - with
 * its reasoning captured as a traceable EvidenceItem, instead of only describing its assessment in
 * plain text. Never automatically applied to an agent's own create_finding output - a human/validator
 * action, matching the factory spec's "do not automatically mark AI-generated claims as confirmed". */
const VALIDATE_FINDING_TOOL = "validate_finding";
const RECORDING_TOOLS = new Set([CREATE_FINDING_TOOL, UPSERT_ASSET_TOOL, VALIDATE_FINDING_TOOL]);

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

export interface ToolRequest {
  tool: string;
  arguments: string[];
}

export interface OrchestratorTask {
  id: string;
  missionId: string;
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
  /** Further calls from a reply that requested several, run in order before the model is asked
   * again. Dropped when a human rejects one, a run fails or a human steers the task, since those
   * change what the agent should do next. */
  queuedToolCalls?: ToolRequest[];
  pendingExecutionId?: string;
  finalResponse?: string;
  error?: string;
  /** Time spent actually generating, accumulated across every advance() run - what
   * env.maxOrchestratorTaskTimeMs bounds. Wall-clock age would count however long the task sat
   * waiting on a human: a tool approved 11 minutes after it was requested could never continue. */
  activeMs?: number;
  createdAt: number;
  updatedAt: number;
}

const tasks = new Map<string, OrchestratorTask>();
const TASKS_FILE = "orchestrator-tasks.json";

/** Same pattern as toolManager.ts's runningControllers - lets cancelTask abort a same-task
 * advance() loop that's actually in flight right now, independent of the signal the *creating*
 * request happened to pass in (which only ever reaches that one call - a cancel arriving from a
 * different connection, or cancelPlan, previously had no way to reach a running generation at
 * all). See advanceTask below and the "cancelTask doesn't abort in-flight generation" audit finding. */
const runningTaskControllers = new Map<string, AbortController>();
/** When the current advanceTask run started, per task - see OrchestratorTask.activeMs. */
const runStartedAt = new Map<string, number>();

function activeTimeMs(task: OrchestratorTask): number {
  const started = runStartedAt.get(task.id);
  return (task.activeMs ?? 0) + (started === undefined ? 0 : Date.now() - started);
}

function missionTasks(missionId: string): OrchestratorTask[] {
  return [...tasks.values()].filter((t) => t.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

// See missionManager.ts#onMissionDeleted - a deleted mission's tasks must stop returning from
// listTasks/getTask, and a still-running one must actually be aborted so it can't resurrect the
// just-deleted directory via a later persistTasks() call.
onMissionDeleted((missionId) => {
  for (const [id, task] of tasks) {
    if (task.missionId !== missionId) continue;
    runningTaskControllers.get(id)?.abort();
    runningTaskControllers.delete(id);
    tasks.delete(id);
  }
});

async function persistTasks(missionId: string): Promise<void> {
  await writeMissionJson(missionId, TASKS_FILE, missionTasks(missionId));
}

/** Hydrates in-memory tasks from disk - called once at server startup so task history survives a
 * restart instead of only being written-through from that point on. */
export async function loadTasksFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const missionTasksOnDisk = await readMissionJson<OrchestratorTask>(missionId, TASKS_FILE);
    for (const task of missionTasksOnDisk) {
      // Whatever was driving a "running" task died with the old process, and nothing else would
      // ever settle it. A task paused on a human stays resumable as-is.
      if (task.status === "running") {
        task.status = "failed";
        task.error = "The backend restarted while this task was running.";
      }
      tasks.set(task.id, task);
    }
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

/** Prepended to the preamble when the mission has any mission fields set (see types/mission.ts) -
 * omitted entirely for a plain mission with none configured, to avoid noise on the common case.
 * Explicitly tells the agent that scope is enforced, not just advisory - see
 * toolManager.ts#requestExecution/scopeMatcher.ts, which is what actually blocks a violation;
 * this text alone is not the enforcement mechanism, just makes the agent aware of it upfront. */
function buildMissionContextLines(mission: Mission | undefined): string[] {
  if (!mission) return [];
  const hasContext =
    !!mission.description || !!mission.status || !!mission.scope?.length || !!mission.outOfScope?.length || !!mission.rules;
  if (!hasContext) return [];

  const lines = [`Mission: ${mission.name}${mission.status ? ` (status: ${mission.status})` : ""}`];
  if (mission.description) lines.push(`Description: ${mission.description}`);
  if (mission.scope?.length) lines.push(`Scope (authorized targets): ${mission.scope.join(", ")}`);
  if (mission.outOfScope?.length) lines.push(`Out of scope (never target these): ${mission.outOfScope.join(", ")}`);
  if (mission.rules) lines.push(`Rules of engagement: ${mission.rules}`);
  lines.push("Tool executions against a target outside this scope are automatically blocked.");
  return lines;
}

async function buildToolsPreamble(agent: AgentWithStatus | undefined, missionId: string): Promise<string> {
  const allowed = agent?.execTools;
  // Only what can really run: a local model offered a tool that isn't installed will pick it, and the
  // failed request pauses the whole task for a human.
  const lines = listExecToolsWithStatus()
    .filter((t) => t.enabled && t.availability === "available")
    .filter((t) => allowed === undefined || allowed.includes(t.id))
    .map((t) => `- ${t.id}: ${t.description}${t.usageHint ? ` ${t.usageHint}` : ""}`);

  // Enabled MCP tools (services/mcpClient.ts) run on a scanning host but go through the exact same
  // request -> approval -> scope-checked execution path as a local tool (toolManager.ts), so they
  // join the same catalog. A discovered tool stays off this list until a human enables it, and the
  // same execTools allowlist gates them - a directed agent must name the "<server>.<tool>" id.
  const mcpLines = listMcpTools()
    .filter((t) => t.enabled)
    .filter((t) => allowed === undefined || allowed.includes(t.id))
    .map(
      (t) =>
        `- ${t.id}: ${t.description} Runs on a scanning host and needs human approval; its target must be in ` +
        `mission scope. arguments is the argv to pass, e.g. {"tool": "${t.id}", "arguments": ["<arg1>", "<arg2>"]}.`,
    );

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
    getMissionFindings(missionId).length > 0
      ? `- ${QUERY_FINDINGS_TOOL}: Query structured findings already discovered for this mission ` +
        "(ports, technologies, domains, vulnerabilities, etc.) instead of re-scanning or parsing raw " +
        'tool output yourself. Arguments: [] for every finding, or a single-element array with a type ' +
        'to filter, e.g. {"tool": "' +
        QUERY_FINDINGS_TOOL +
        '", "arguments": ["port"]}. Read-only and does not require approval - prefer this over rerunning ' +
        "a scan you've already run."
      : undefined;

  const cveLine =
    getTechnologies(missionId).length > 0
      ? `- ${LOOKUP_CVES_TOOL}: Look up known CVEs for a technology/product from the public NVD ` +
        'database - arguments should be a single-element array with the product name, e.g. ' +
        `{"tool": "${LOOKUP_CVES_TOOL}", "arguments": ["nginx"]}. This makes a real network request ` +
        "to nvd.nist.gov and can take a few seconds. Read-only and does not require approval."
      : undefined;

  const createFindingLine =
    `- ${CREATE_FINDING_TOOL}: Record a structured finding for this mission instead of only ` +
    "describing one in your reply. Arguments should be a single-element array containing one JSON " +
    'object encoded as a string, e.g. {"tool": "' +
    CREATE_FINDING_TOOL +
    '", "arguments": ["{\\"type\\":\\"potential_vulnerability\\",\\"severity\\":\\"high\\",' +
    '\\"title\\":\\"Reflected XSS in search\\",\\"description\\":\\"...\\",\\"target\\":\\"example.com\\",' +
    '\\"value\\":\\"/search?q\\",\\"parameter\\":\\"q\\",\\"impact\\":\\"...\\",' +
    '\\"reproductionSteps\\":\\"...\\",\\"evidence\\":\\"...\\"}"]}. Required: type, severity, title, ' +
    `description, target, value. Valid types: ${VALID_FINDING_TYPES.join(", ")}. Valid severities: ` +
    `${VALID_SEVERITIES.join(", ")}. Optional: parameter, impact, reproductionSteps, evidence, ` +
    "confidence (0-1), tags (array of strings). Never use type \"confirmed_vulnerability\" yourself - " +
    'always "potential_vulnerability", a human/validator promotes it. Does not require approval - ' +
    "it records data, it doesn't execute anything.";

  const upsertAssetLine =
    `- ${UPSERT_ASSET_TOOL}: Register or update an entry in the mission's Asset Inventory - use this ` +
    "when you discover a domain/subdomain/URL/IP/port/service/API/technology with no accompanying " +
    "finding to log (plain recon, nothing interesting yet). Arguments should be a single-element " +
    'array containing one JSON object encoded as a string, e.g. {"tool": "' +
    UPSERT_ASSET_TOOL +
    '", "arguments": ["{\\"type\\":\\"subdomain\\",\\"value\\":\\"api.example.com\\"}"]}. Required: ' +
    `type, value. Valid types: ${VALID_ASSET_TYPES.join(", ")} - a path or file on a web server is a ` +
    'url, e.g. "http://example.com/admin". Optional: status ("active"|"inactive"|' +
    '"unverified", defaults to "active"), metadata (object). Re-registering the same (type, value) ' +
    "updates the existing asset instead of duplicating it. Does not require approval - it records " +
    "data, it doesn't execute anything.";

  const validateFindingLine =
    `- ${VALIDATE_FINDING_TOOL}: Record your verdict on a finding you've been asked to review - is it ` +
    "reproducible, is the target actually in scope, is the evidence sufficient, is the impact " +
    "realistic, is it likely a duplicate, and what severity fits. Arguments should be a single-element " +
    'array containing one JSON object encoded as a string, e.g. {"tool": "' +
    VALIDATE_FINDING_TOOL +
    '", "arguments": ["{\\"findingId\\":\\"<id>\\",\\"verdict\\":\\"confirmed\\",\\"severity\\":\\"high\\",' +
    '\\"notes\\":\\"Reproduced against /search?q=<script>...; reflected unescaped in response body.\\"}"]}. ' +
    'Required: findingId, verdict (one of "confirmed", "false_positive", "duplicate"), notes (your ' +
    "reasoning - always required, even for a false_positive/duplicate verdict). Optional: severity " +
    `(one of ${VALID_SEVERITIES.join(", ")}) if your review changes it. Does not require approval - it ` +
    "records data, it doesn't execute anything.";

  let mission: Mission | undefined;
  try {
    mission = await getMission(missionId);
  } catch (err) {
    console.error(`[orchestrator] failed to load mission "${missionId}" for mission context:`, err);
  }
  const missionLines = buildMissionContextLines(mission);

  return [
    ...(missionLines.length ? [...missionLines, ""] : []),
    "You have access to the following tools. To use one, respond with ONLY a single JSON object",
    'of the exact form {"tool": "<tool id>", "arguments": ["<arg1>", "<arg2>", ...]} and nothing',
    "else - no explanation, no markdown code fences, no extra text before or after it.",
    "Results come back to you in the next message - never write a tool's result yourself.",
    "Ports, services and paths a scanner reports are recorded as findings and assets automatically, so",
    "don't record those again - use the recording tools for what you work out yourself.",
    "Every tool execution requires human approval before it runs, so only request a tool when you",
    "actually need its output to proceed.",
    "If you don't need a tool, respond normally in plain text with your answer - that ends the task.",
    "",
    "Available tools:",
    ...lines,
    ...mcpLines,
    ...(knowledgeBaseLine ? [knowledgeBaseLine] : []),
    ...(findingsLine ? [findingsLine] : []),
    ...(cveLine ? [cveLine] : []),
    createFindingLine,
    upsertAssetLine,
    validateFindingLine,
  ].join("\n");
}

/** The fields only a tool's result carries. A model that has seen a few results will sometimes write
 * one itself - that names a tool too, but it's a claim about a run that never happened, not a request. */
function isToolResultShape(parsed: object): boolean {
  return "tool" in parsed && ["success", "exitCode", "stdout"].some((field) => field in parsed);
}

function tryParseCandidate(candidate: string): ToolRequest | undefined {
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; arguments?: unknown };
    if (typeof parsed.tool !== "string" || isToolResultShape(parsed)) return undefined;
    const rawArgs = parsed.arguments ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.some((a) => a === null)) return undefined;
    // Local models routinely send ["-p", 80], or an unencoded object for create_finding's "JSON
    // object encoded as a string" argument. The intent is unambiguous, and not recognizing it would
    // silently turn the tool call into the task's "final answer".
    const args = rawArgs.map((a: unknown) => (typeof a === "string" ? a : typeof a === "object" ? JSON.stringify(a) : String(a)));
    return { tool: parsed.tool, arguments: args };
  } catch {
    // Not valid JSON, or not a tool-request shape.
  }
  return undefined;
}

/** Every top-level balanced {...} span in the text, in order - brace-counting that ignores braces
 * inside JSON strings. Not a JSON parser: tryParseCandidate decides whether a span is actually one. */
function balancedObjectSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (depth > 0 && c === '"') {
      inString = true;
    } else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

/**
 * Despite the preamble instructing "respond with ONLY the JSON object", models often still
 * prepend a sentence ("Sure, here's the call:") even when told not to. Try the strict case first
 * (whole reply, optionally fenced, is the JSON), then fall back to every balanced object in the reply
 * that is a tool request - models also routinely emit several calls at once, and all of them are
 * returned, in order and without exact repeats (see OrchestratorTask.queuedToolCalls).
 */
export function parseToolRequests(text: string): ToolRequest[] {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const strict = tryParseCandidate(fence ? fence[1].trim() : trimmed);
  if (strict) return [strict];

  const requests = new Map<string, ToolRequest>();
  for (const span of balancedObjectSpans(trimmed)) {
    const candidate = tryParseCandidate(span);
    if (candidate) requests.set(JSON.stringify(candidate), candidate);
  }
  return [...requests.values()];
}

export function parseToolRequest(text: string): ToolRequest | undefined {
  return parseToolRequests(text)[0];
}

/** Whether a reply with no tool request in it is the model writing a tool's result itself - never a
 * final answer, even though it would otherwise read as one. */
function claimsToolResult(reply: string): boolean {
  if (reply.includes("<tool_response>")) return true;
  return balancedObjectSpans(reply).some((span) => {
    try {
      const parsed: unknown = JSON.parse(span);
      return typeof parsed === "object" && parsed !== null && isToolResultShape(parsed);
    } catch {
      return false;
    }
  });
}

async function collectAgentReply(
  agentId: string,
  agent: AgentWithStatus | undefined,
  missionId: string,
  messages: ChatMessage[],
  model?: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
): Promise<string> {
  let content = "";
  const toolsPreamble = await buildToolsPreamble(agent, missionId);
  for await (const chunk of streamAgentChat({ agentId, messages, model, toolsPreamble }, signal)) {
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
      message: "The knowledge base hasn't been indexed yet - reindex it from the Tools view first.",
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

const VALID_SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

const VALID_ASSET_TYPES: AssetType[] = ["domain", "subdomain", "url", "ip", "port", "service", "api", "technology"];
const VALID_ASSET_STATUSES: Asset["status"][] = ["active", "inactive", "unverified"];

/** Parses a pseudo-tool's single JSON-string argument. `JSON.parse("null")`/`"[]"` succeed but aren't
 * the object every caller destructures - null would throw out of the tool-result error path. */
function parseJsonObjectArg(toolId: string, raw: string | undefined): { obj: Record<string, unknown> } | { error: string } {
  if (!raw) return { error: `${toolId} requires a single-element array containing a JSON object string.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `${toolId}'s argument is not valid JSON.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: `${toolId}'s argument must be a JSON object.` };
  }
  return { obj: parsed as Record<string, unknown> };
}

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
function runFindingsQuery(missionId: string, args: string[]): string {
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
    ? getMissionFindings(missionId).filter((f) => f.type === typeFilter)
    : getMissionFindings(missionId);

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

/** Parses/validates the create_finding pseudo-tool's single JSON-string argument into a
 * FindingCreateInput, or returns an error string explaining exactly what's wrong - fed back to the
 * agent as a tool result, same recover-and-retry loop as an invalid ExecTool argument. */
function parseCreateFindingArgs(args: string[]): { input: FindingCreateInput } | { error: string } {
  const parsedArg = parseJsonObjectArg(CREATE_FINDING_TOOL, args[0]);
  if ("error" in parsedArg) return parsedArg;
  const { obj } = parsedArg;

  const { type, severity, title, description, target, value, parameter, impact, reproductionSteps, evidence, confidence, tags } =
    obj;

  if (typeof type !== "string" || !VALID_FINDING_TYPES.includes(type as FindingType)) {
    return { error: `"type" must be one of: ${VALID_FINDING_TYPES.join(", ")}.` };
  }
  if (type === "confirmed_vulnerability") {
    return {
      error:
        'type "confirmed_vulnerability" cannot be set directly - use "potential_vulnerability"; a human/validator promotes it.',
    };
  }
  if (typeof severity !== "string" || !VALID_SEVERITIES.includes(severity as FindingSeverity)) {
    return { error: `"severity" must be one of: ${VALID_SEVERITIES.join(", ")}.` };
  }
  if (typeof title !== "string" || !title.trim()) return { error: '"title" is required.' };
  if (typeof description !== "string") return { error: '"description" is required.' };
  if (typeof target !== "string" || !target.trim()) return { error: '"target" is required.' };
  if (typeof value !== "string" || !value.trim()) return { error: '"value" is required.' };
  if (parameter !== undefined && typeof parameter !== "string") return { error: '"parameter" must be a string.' };
  if (impact !== undefined && typeof impact !== "string") return { error: '"impact" must be a string.' };
  if (reproductionSteps !== undefined && typeof reproductionSteps !== "string") {
    return { error: '"reproductionSteps" must be a string.' };
  }
  if (evidence !== undefined && typeof evidence !== "string") return { error: '"evidence" must be a string.' };
  if (confidence !== undefined && typeof confidence !== "number") return { error: '"confidence" must be a number.' };
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
    return { error: '"tags" must be an array of strings.' };
  }

  return {
    input: {
      type: type as FindingType,
      severity: severity as FindingSeverity,
      title,
      description,
      target,
      value,
      parameter: parameter as string | undefined,
      impact: impact as string | undefined,
      reproductionSteps: reproductionSteps as string | undefined,
      evidence: evidence as string | undefined,
      confidence: confidence as number | undefined,
      tags: tags as string[] | undefined,
    },
  };
}

/**
 * Runs the create_finding pseudo-tool - parses/validates the agent's JSON payload and records a
 * real Finding via findingsManager.ts#createAgentFinding, same tool-result envelope shape as every
 * other pseudo-tool.
 */
async function runCreateFinding(missionId: string, agentId: string, args: string[]): Promise<string> {
  const parsed = parseCreateFindingArgs(args);
  if ("error" in parsed) {
    return JSON.stringify({ tool: CREATE_FINDING_TOOL, status: "failed", success: false, message: parsed.error });
  }

  try {
    const finding = await createAgentFinding(missionId, agentId, parsed.input);
    return JSON.stringify({
      tool: CREATE_FINDING_TOOL,
      status: "completed",
      success: true,
      exitCode: 0,
      stdout: `Finding recorded: [${finding.severity}] ${finding.title} (id: ${finding.id})`,
      stderr: "",
      parsedOutput: finding,
    });
  } catch (err) {
    return JSON.stringify({
      tool: CREATE_FINDING_TOOL,
      status: "failed",
      success: false,
      message: err instanceof Error ? err.message : "Failed to create finding",
    });
  }
}

/** Parses/validates the upsert_asset pseudo-tool's single JSON-string argument, mirroring
 * parseCreateFindingArgs's shape/error-reporting convention exactly. */
function parseUpsertAssetArgs(args: string[]): { input: AssetCreateInput } | { error: string } {
  const parsedArg = parseJsonObjectArg(UPSERT_ASSET_TOOL, args[0]);
  if ("error" in parsedArg) return parsedArg;
  const { obj } = parsedArg;

  const { type, value, status, metadata } = obj;

  if (typeof type !== "string" || !VALID_ASSET_TYPES.includes(type as AssetType)) {
    return {
      error:
        `"type" must be one of: ${VALID_ASSET_TYPES.join(", ")}. A path or file on a web server is a url with its full ` +
        "address as the value - and paths a scanner found are already recorded, so they don't need this call.",
    };
  }
  // Models routinely send a port as a bare number - the same unambiguous intent tryParseCandidate accepts.
  const assetValue = typeof value === "number" ? String(value) : value;
  if (typeof assetValue !== "string" || !assetValue.trim()) return { error: '"value" is required.' };
  if (status !== undefined && !VALID_ASSET_STATUSES.includes(status as Asset["status"])) {
    return { error: `"status" must be one of: ${VALID_ASSET_STATUSES.join(", ")}.` };
  }
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
    return { error: '"metadata" must be an object.' };
  }

  return {
    input: {
      type: type as AssetType,
      value: assetValue,
      status: status as Asset["status"] | undefined,
      metadata: metadata as Record<string, unknown> | undefined,
    },
  };
}

/**
 * Runs the upsert_asset pseudo-tool - parses/validates the agent's JSON payload and records a real
 * Asset via assetManager.ts#upsertAsset, same tool-result envelope shape as every other pseudo-tool.
 */
async function runUpsertAsset(missionId: string, agentId: string, args: string[]): Promise<string> {
  const parsed = parseUpsertAssetArgs(args);
  if ("error" in parsed) {
    return JSON.stringify({ tool: UPSERT_ASSET_TOOL, status: "failed", success: false, message: parsed.error });
  }

  try {
    const asset = await upsertAsset(missionId, { ...parsed.input, discoveredBy: agentId, source: "agent" });
    return JSON.stringify({
      tool: UPSERT_ASSET_TOOL,
      status: "completed",
      success: true,
      exitCode: 0,
      stdout: `Asset recorded: [${asset.type}] ${asset.value} (id: ${asset.id})`,
      stderr: "",
      parsedOutput: asset,
    });
  } catch (err) {
    return JSON.stringify({
      tool: UPSERT_ASSET_TOOL,
      status: "failed",
      success: false,
      message: err instanceof Error ? err.message : "Failed to upsert asset",
    });
  }
}

const VALID_VALIDATION_VERDICTS = ["confirmed", "false_positive", "duplicate"] as const;
type ValidationVerdict = (typeof VALID_VALIDATION_VERDICTS)[number];

interface ValidateFindingInput {
  findingId: string;
  verdict: ValidationVerdict;
  severity?: FindingSeverity;
  notes: string;
}

/** Parses/validates the validate_finding pseudo-tool's single JSON-string argument, mirroring
 * parseCreateFindingArgs/parseUpsertAssetArgs's shape/error-reporting convention exactly. */
function parseValidateFindingArgs(args: string[]): { input: ValidateFindingInput } | { error: string } {
  const parsedArg = parseJsonObjectArg(VALIDATE_FINDING_TOOL, args[0]);
  if ("error" in parsedArg) return parsedArg;
  const { obj } = parsedArg;

  const { findingId, verdict, severity, notes } = obj;

  if (typeof findingId !== "string" || !findingId.trim()) return { error: '"findingId" is required.' };
  if (typeof verdict !== "string" || !VALID_VALIDATION_VERDICTS.includes(verdict as ValidationVerdict)) {
    return { error: `"verdict" must be one of: ${VALID_VALIDATION_VERDICTS.join(", ")}.` };
  }
  if (severity !== undefined && (typeof severity !== "string" || !VALID_SEVERITIES.includes(severity as FindingSeverity))) {
    return { error: `"severity" must be one of: ${VALID_SEVERITIES.join(", ")}.` };
  }
  if (typeof notes !== "string" || !notes.trim()) return { error: '"notes" is required - explain your reasoning.' };

  return {
    input: {
      findingId,
      verdict: verdict as ValidationVerdict,
      severity: severity as FindingSeverity | undefined,
      notes,
    },
  };
}

/**
 * Runs the validate_finding pseudo-tool - parses/validates the agent's JSON payload, confirms the
 * finding actually belongs to this mission (an agent can't validate a finding it just guessed the id
 * of from another mission), and records the verdict via findingsManager.ts#validateFinding, same
 * tool-result envelope shape as every other pseudo-tool.
 */
async function runValidateFinding(missionId: string, agentId: string, args: string[]): Promise<string> {
  const parsed = parseValidateFindingArgs(args);
  if ("error" in parsed) {
    return JSON.stringify({ tool: VALIDATE_FINDING_TOOL, status: "failed", success: false, message: parsed.error });
  }

  const existing = getFinding(parsed.input.findingId);
  if (!existing || existing.missionId !== missionId) {
    return JSON.stringify({
      tool: VALIDATE_FINDING_TOOL,
      status: "failed",
      success: false,
      message: `No finding "${parsed.input.findingId}" was found for this mission.`,
    });
  }
  // create_finding stamps the creating agent as `tool` - an agent grading its own claim is exactly
  // the "AI marks its own output confirmed" the validation pipeline exists to prevent, and a
  // prompt-injected agent could otherwise log and confirm a finding in two steps.
  if (existing.source === "agent" && existing.tool === agentId) {
    return JSON.stringify({
      tool: VALIDATE_FINDING_TOOL,
      status: "failed",
      success: false,
      message: "An agent can't validate a finding it created itself - leave it for the validator or a human.",
    });
  }

  try {
    const finding = await validateFinding(
      parsed.input.findingId,
      agentId,
      parsed.input.verdict,
      parsed.input.notes,
      parsed.input.severity,
    );
    return JSON.stringify({
      tool: VALIDATE_FINDING_TOOL,
      status: "completed",
      success: true,
      exitCode: 0,
      stdout: `Finding ${finding.id} marked "${finding.status}" by ${agentId}`,
      stderr: "",
      parsedOutput: finding,
    });
  } catch (err) {
    return JSON.stringify({
      tool: VALIDATE_FINDING_TOOL,
      status: "failed",
      success: false,
      message: err instanceof Error ? err.message : "Failed to validate finding",
    });
  }
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
async function runLookupCves(missionId: string, args: string[]): Promise<string> {
  const keyword = args[0]?.trim();
  if (!keyword) {
    return JSON.stringify({
      tool: LOOKUP_CVES_TOOL,
      status: "failed",
      success: false,
      message: `${LOOKUP_CVES_TOOL} requires a product name in arguments, e.g. ["nginx"].`,
    });
  }

  const match = getTechnologies(missionId).find((f) => f.title.toLowerCase() === keyword.toLowerCase());
  const target = match?.target ?? "unknown";

  try {
    const results = await lookupCvesByKeyword(missionId, keyword, target);
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
/**
 * Entry point for every top-level advance() call (createTask/resumeTask/provideGuidance/
 * continueTask - not the internal pseudo-tool recursion inside advance() itself, which already
 * has the combined signal from its own outer call). Registers a per-task AbortController that
 * cancelTask can abort independently of callerSignal (the creating request's own disconnect
 * signal), combining the two via AbortSignal.any so either one stops the loop.
 */
async function advanceTask(task: OrchestratorTask, onChunk?: ChunkListener, callerSignal?: AbortSignal): Promise<OrchestratorTask> {
  const controller = new AbortController();
  runningTaskControllers.set(task.id, controller);
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  runStartedAt.set(task.id, Date.now());
  try {
    return await advance(task, onChunk, signal);
  } catch (err) {
    if (err instanceof RequestCancelledError) throw err;
    // Anything advance() didn't anticipate must still settle the task - left at "running" it would
    // read as in progress forever, with nothing driving it.
    task.status = "failed";
    task.error = err instanceof Error ? err.message : "Task step failed";
    touch(task);
    return task;
  } finally {
    task.activeMs = activeTimeMs(task);
    runStartedAt.delete(task.id);
    runningTaskControllers.delete(task.id);
  }
}

/**
 * Local models often answer a successful create_finding/upsert_asset/validate_finding by sending the
 * identical call again, instead of a closing message - left alone that runs to the tool-call cap and
 * fails a work order whose work is already done, re-recording the same thing each time. Re-running
 * these can't produce anything new, so a reply made only of calls already recorded since the last
 * real tool means the agent is finished. Returns the last such call's result to close on, or undefined
 * when this isn't such a repeat. Real tools aren't covered: running one twice can be deliberate, and it
 * stays behind its own confirmation.
 */
function repeatOfRecordedCalls(messages: OrchestratorTask["messages"], requests: ToolRequest[]): string | undefined {
  if (!requests.every((request) => RECORDING_TOOLS.has(request.tool))) return undefined;

  // [..., assistant call, its tool result, ..., assistant call, its tool result, this reply]
  const recorded = new Map<string, string>();
  for (let i = messages.length - 2; i > 0 && messages[i].role === "tool" && messages[i - 1].role === "assistant"; i -= 2) {
    const call = parseToolRequest(messages[i - 1].content);
    if (!call || !RECORDING_TOOLS.has(call.tool)) break;
    try {
      const result = JSON.parse(messages[i].content) as { success?: unknown; stdout?: unknown };
      if (result.success === true && typeof result.stdout === "string") recorded.set(JSON.stringify(call), result.stdout);
    } catch {
      // Not a result this could close on - the call just doesn't count as recorded.
    }
  }

  const results = requests.map((request) => recorded.get(JSON.stringify({ tool: request.tool, arguments: request.arguments })));
  return results.every((result) => result !== undefined) ? results.at(-1) : undefined;
}

/** How many times to let a model resend a recording call that keeps failing before ending the task. */
const MAX_FAILED_RECORDING_REPEATS = 2;

/**
 * The failure to close on when a model is stuck resending a recording call the tool has already refused
 * with the same arguments - it won't get a different answer, and left alone that burns the rest of the
 * tool-call cap and fails an order whose real work is already done. Undefined when it isn't stuck.
 */
function stuckRecordingFailure(messages: OrchestratorTask["messages"], request: ToolRequest): string | undefined {
  if (!RECORDING_TOOLS.has(request.tool)) return undefined;

  const key = JSON.stringify({ tool: request.tool, arguments: request.arguments });
  let failures = 0;
  let lastFailure = "";
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role !== "tool" || messages[i - 1].role !== "assistant") continue;
    const call = parseToolRequest(messages[i - 1].content);
    if (!call || JSON.stringify(call) !== key) continue;
    try {
      const result = JSON.parse(messages[i].content) as { success?: unknown; message?: unknown };
      if (result.success !== false) continue;
      failures++;
      lastFailure = typeof result.message === "string" ? result.message : "";
    } catch {
      // Not a result this could read - doesn't count as a failure.
    }
  }
  return failures >= MAX_FAILED_RECORDING_REPEATS ? lastFailure : undefined;
}

/** Every tool-call attempt counts against the cap, valid or not, so a model that keeps requesting
 * malformed/unknown tools can't loop forever without ever incrementing toward the limit. */
function spendToolCall(task: OrchestratorTask): boolean {
  if (task.toolCallCount >= env.maxOrchestratorToolCalls) {
    task.status = "max_executions_reached";
    task.error = `Stopped after ${env.maxOrchestratorToolCalls} tool calls (MAX_ORCHESTRATOR_TOOL_CALLS).`;
    touch(task);
    return false;
  }
  task.toolCallCount++;
  return true;
}

async function advance(task: OrchestratorTask, onChunk?: ChunkListener, signal?: AbortSignal): Promise<OrchestratorTask> {
  if (activeTimeMs(task) > env.maxOrchestratorTaskTimeMs) {
    task.status = "max_time_reached";
    task.error = `Stopped after ${Math.round(env.maxOrchestratorTaskTimeMs / 60_000)} minutes of agent time (MAX_ORCHESTRATOR_TASK_TIME_MS).`;
    touch(task);
    return task;
  }

  const agent = await getAgent(task.agentId);

  let toolRequest: ToolRequest;
  if (task.queuedToolCalls?.length) {
    if (signal?.aborted) {
      task.status = "cancelled";
      touch(task);
      return task;
    }
    // Written out as its own assistant turn so each result in the transcript directly follows the
    // call it answers, the same shape a one-call-per-reply model produces.
    toolRequest = task.queuedToolCalls.shift()!;
    task.messages.push({ role: "assistant", content: JSON.stringify(toolRequest) });
  } else {
    let reply: string;
    try {
      reply = await collectAgentReply(task.agentId, agent, task.missionId, task.messages, task.model, onChunk, signal);
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

    // A cancel that landed right as the stream finished: nothing threw, but the task is already
    // terminal and must not be overwritten as "completed" below.
    if (signal?.aborted) {
      task.status = "cancelled";
      touch(task);
      return task;
    }

    if (!reply.trim()) {
      task.status = "failed";
      task.error = "The model returned an empty response.";
      touch(task);
      return task;
    }

    task.messages.push({ role: "assistant", content: reply });

    const requests = parseToolRequests(reply);
    if (requests.length === 0) {
      if (claimsToolResult(reply)) {
        if (!spendToolCall(task)) return task;
        task.messages.push({
          role: "tool",
          content: JSON.stringify({
            error: "That was a tool result you wrote yourself - nothing ran. Request a tool to run it, or answer in plain text if you're finished.",
          }),
        });
        return advance(task, onChunk, signal);
      }
      task.status = "completed";
      task.finalResponse = reply;
      touch(task);
      return task;
    }

    const recorded = repeatOfRecordedCalls(task.messages, requests);
    if (recorded !== undefined) {
      task.status = "completed";
      task.finalResponse = recorded;
      touch(task);
      return task;
    }

    toolRequest = requests[0];
    task.queuedToolCalls = requests.slice(1);
  }

  const stuckOn = stuckRecordingFailure(task.messages, toolRequest);
  if (stuckOn !== undefined) {
    task.status = "completed";
    task.finalResponse = `Stopped after repeated failed ${toolRequest.tool} calls: ${stuckOn} Anything recorded before this still stands.`;
    touch(task);
    return task;
  }

  if (!spendToolCall(task)) return task;

  if (toolRequest.tool === SEARCH_KNOWLEDGE_BASE_TOOL) {
    task.messages.push({ role: "tool", content: await runKnowledgeBaseSearch(toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === QUERY_FINDINGS_TOOL) {
    task.messages.push({ role: "tool", content: runFindingsQuery(task.missionId, toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === LOOKUP_CVES_TOOL) {
    task.messages.push({ role: "tool", content: await runLookupCves(task.missionId, toolRequest.arguments) });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === CREATE_FINDING_TOOL) {
    task.messages.push({
      role: "tool",
      content: await runCreateFinding(task.missionId, task.agentId, toolRequest.arguments),
    });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === UPSERT_ASSET_TOOL) {
    task.messages.push({
      role: "tool",
      content: await runUpsertAsset(task.missionId, task.agentId, toolRequest.arguments),
    });
    return advance(task, onChunk, signal);
  }

  if (toolRequest.tool === VALIDATE_FINDING_TOOL) {
    task.messages.push({
      role: "tool",
      content: await runValidateFinding(task.missionId, task.agentId, toolRequest.arguments),
    });
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

  // Checked here, right before creating a real execution, rather than trusting the caller-facing
  // functions alone: a cancel that raced this exact tool-call decision (arrived after the reply
  // above but before this point) must not spawn a new pending execution for a task that's already
  // terminal. See the "cancelTask doesn't abort in-flight generation" audit finding.
  if (signal?.aborted) {
    task.status = "cancelled";
    touch(task);
    return task;
  }

  const { arguments: execArguments, stdin } = splitWriteFileContent(toolRequest);

  let record: ExecutionRecord;
  try {
    record = await requestExecution({
      tool: toolRequest.tool,
      arguments: execArguments,
      missionId: task.missionId,
      agentId: task.agentId,
      stdin,
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

  // Re-checked here too, not just before the call above: a cancel could have arrived while
  // requestExecution() itself was awaiting (getMission()/persistExecutions() in toolManager.ts) - a
  // narrower version of the same race the pre-call check closes. Without this, the code below would
  // overwrite the "cancelled" status cancelTask() just set, resurrecting the task into
  // waiting_confirmation with a pending execution the user never approved. Nothing has run yet, so
  // reject it - the same terminal state cancelTask itself would have put it in had
  // pendingExecutionId already been set at the time of the cancel.
  if (signal?.aborted) {
    try {
      rejectExecution(record.id);
    } catch {
      // Already handled elsewhere between the check above and here - nothing left to do.
    }
    task.status = "cancelled";
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
  missionId: string,
  onChunk?: ChunkListener,
  signal?: AbortSignal,
  model?: string,
  /** Called with the task as soon as it exists, before the first generation - this function only
   * resolves once that generation settles, too late for a caller that needs to be able to cancel it. */
  onCreated?: (task: OrchestratorTask) => void,
): Promise<OrchestratorTask> {
  const agent = await getAgent(agentId);
  if (!agent) throw new AgentNotFoundError(agentId);

  const task: OrchestratorTask = {
    id: randomUUID(),
    missionId,
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
  onCreated?.(task);
  try {
    const result = await advanceTask(task, onChunk, signal);
    await persistTasks(task.missionId);
    return result;
  } catch (err) {
    await persistTasks(task.missionId).catch(() => {});
    throw err;
  }
}

/**
 * Bounds how much of a single tool result lands in the (unboundedly-resent, persisted-forever)
 * task transcript - a completely different concern from toolExecutor.ts's own
 * DEFAULT_MAX_OUTPUT_BYTES (1MB per stream), which only bounds one execution's own memory/streamed
 * output. Every past tool result gets resent to the model on every subsequent advance() call, and
 * orchestrator-tasks.json persists the whole thing verbatim - a handful of large-output tool calls
 * (nmap, ffuf, a big directory listing) could otherwise make a single task's transcript multiple
 * megabytes. `env.maxOrchestratorToolCalls` already caps how many such results one task can ever
 * accumulate, so bounding *each* one is what actually bounds the total.
 */
const MAX_TRANSCRIPT_FIELD_BYTES = 4000;

/** Truncates on a UTF-8 byte boundary (not just a character count) so a multi-byte character
 * straddling the cut point can't corrupt the output - Buffer's own decoding replaces a partial
 * trailing sequence with U+FFFD rather than throwing, which is an acceptable cosmetic artifact
 * right at a truncation boundary that already says "truncated" a few characters later. */
function truncateForTranscript(text: string, maxBytes = MAX_TRANSCRIPT_FIELD_BYTES): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= maxBytes) return text;
  return `${buf.subarray(0, maxBytes).toString("utf-8")}\n...[truncated, showing ${maxBytes} of ${buf.byteLength} bytes]`;
}

/** Same bound, shape-aware: an array (the "lines" parser's output - subfinder/httpx/etc, easily
 * thousands of entries) is capped by item count rather than serialized bytes, since a list of short
 * lines needs a very different cap than a blob of text does. A string is truncated the same way as
 * stdout/stderr. Any other JSON-serializable shape (an object, from the "json" parser) falls back
 * to a byte-capped serialized form if it's actually over the limit - changes its shape from object
 * to string on truncation, which is fine since this only ever feeds back into an already-stringified
 * ChatMessage.content, never re-parsed as structured data downstream. */
const MAX_TRANSCRIPT_ARRAY_ITEMS = 200;

function truncateParsedOutputForTranscript(parsedOutput: unknown): unknown {
  if (Array.isArray(parsedOutput)) {
    if (parsedOutput.length <= MAX_TRANSCRIPT_ARRAY_ITEMS) return parsedOutput;
    return [
      ...parsedOutput.slice(0, MAX_TRANSCRIPT_ARRAY_ITEMS),
      `...[truncated, showing ${MAX_TRANSCRIPT_ARRAY_ITEMS} of ${parsedOutput.length} items]`,
    ];
  }
  if (typeof parsedOutput === "string") return truncateForTranscript(parsedOutput);
  if (parsedOutput !== null && typeof parsedOutput === "object") {
    const serialized = JSON.stringify(parsedOutput);
    return Buffer.byteLength(serialized, "utf-8") <= MAX_TRANSCRIPT_FIELD_BYTES
      ? parsedOutput
      : truncateForTranscript(serialized);
  }
  return parsedOutput; // number/boolean/undefined/null - never large
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
            stdout: truncateForTranscript(execution.result?.stdout ?? ""),
            stderr: truncateForTranscript(execution.result?.stderr ?? ""),
            timedOut: execution.result?.timedOut ?? false,
            cancelled: execution.result?.cancelled ?? false,
            parsedOutput: truncateParsedOutputForTranscript(execution.result?.parsedOutput),
          }),
        };

  task.messages.push(resultMessage);
  if (execution.status !== "completed") task.queuedToolCalls = undefined;

  // A failed or forcibly-cancelled execution pauses for human guidance instead of letting the
  // agent guess what to do next on its own - see provideGuidance below. A successful run or an
  // explicit reject (already a deliberate human decision, not a failure to react to) both continue
  // automatically exactly as before - no added friction on the common path.
  if (execution.status === "failed" || execution.status === "cancelled") {
    task.status = "waiting_guidance";
    touch(task);
    void persistTasks(task.missionId).catch((err) => console.error("[orchestrator] persist failed:", err));
    return task;
  }

  task.pendingExecutionId = undefined;
  task.status = "running";
  try {
    const result = await advanceTask(task, onChunk, signal);
    await persistTasks(task.missionId);
    return result;
  } catch (err) {
    await persistTasks(task.missionId).catch(() => {});
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
  task.queuedToolCalls = undefined;
  task.pendingExecutionId = undefined;
  task.status = "running";
  try {
    const result = await advanceTask(task, onChunk, signal);
    await persistTasks(task.missionId);
    return result;
  } catch (err) {
    await persistTasks(task.missionId).catch(() => {});
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
    const result = await advanceTask(task, onChunk, signal);
    await persistTasks(task.missionId);
    return result;
  } catch (err) {
    await persistTasks(task.missionId).catch(() => {});
    throw err;
  }
}

export function cancelTask(id: string): OrchestratorTask {
  const task = tasks.get(id);
  if (!task) throw new TaskNotFoundError(id);
  if (!["running", "waiting_confirmation", "waiting_guidance"].includes(task.status)) {
    throw new InvalidTaskStateError(`Task "${id}" has already finished (status: ${task.status})`);
  }
  // Abort a same-task advance() loop that's actually running right now - e.g. this cancel arrived
  // from a different connection than the one that created/resumed the task, or in the window
  // between the agent's generation finishing and that request's own disconnect being observed.
  // Without this, cancelTask only ever flipped the in-memory status below; the still-running loop
  // had no way to find out and could keep going - pushing the assistant message, requesting a new
  // execution, and resurrecting a task the user already cancelled. See advanceTask above.
  runningTaskControllers.get(id)?.abort();
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
  void persistTasks(task.missionId).catch((err) => console.error("[orchestrator] persist failed:", err));
  return task;
}

export function getTask(id: string): OrchestratorTask | undefined {
  return tasks.get(id);
}

export function listTasks(missionId: string): OrchestratorTask[] {
  return missionTasks(missionId);
}
