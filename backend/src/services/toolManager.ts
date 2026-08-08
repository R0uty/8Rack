import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { runExecutable } from "./toolExecutor.js";
import type { OutputChunk } from "./toolExecutor.js";
import { listProjectIds, readProjectJson, writeProjectJson } from "./projectStore.js";
import { ingestExecution } from "./findingsManager.js";
import { getProject } from "./projectManager.js";
import { checkScope } from "./scopeMatcher.js";
import {
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutableUnavailableError,
  ExecutionNotFoundError,
  InvalidToolArgumentsError,
  OutOfScopeError,
  PrivilegedCommandError,
} from "./errors.js";
import type {
  ExecTool,
  ExecToolWithStatus,
  ExecutionRecord,
  OutputParserKind,
  ToolRequestBody,
} from "../types/execTool.js";

const tools = new Map<string, ExecTool>();
const executions = new Map<string, ExecutionRecord>();
const runningControllers = new Map<string, AbortController>();
/** stdin content for a pending execution, keyed by execution id — kept out of ExecutionRecord so
 * potentially large/sensitive write_file content doesn't linger in the (listable) history. */
const pendingStdin = new Map<string, string>();

const MAX_HISTORY = 200;
const EXECUTIONS_FILE = "executions.json";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Not project-scoped (tools are global, unlike executions) - one shared file, not under
 * data/projects/, so it doesn't go through projectStore.ts's per-project helpers. */
const TOOL_OVERRIDES_FILE = path.resolve(__dirname, "../../data/tools/overrides.json");

export function registerExecTool(tool: ExecTool): void {
  tools.set(tool.id, tool);
}

export function getExecTool(id: string): ExecTool | undefined {
  return tools.get(id);
}

export function listExecTools(): ExecTool[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Persists every registered tool's current `enabled` value as a flat {toolId: boolean} map -
 * simpler than a sparse diff against the builtin defaults, and the file is tiny either way. */
async function persistToolOverrides(): Promise<void> {
  const overrides: Record<string, boolean> = {};
  for (const tool of tools.values()) overrides[tool.id] = tool.enabled;
  await mkdir(path.dirname(TOOL_OVERRIDES_FILE), { recursive: true });
  await writeFile(TOOL_OVERRIDES_FILE, `${JSON.stringify(overrides, null, 2)}\n`, "utf-8");
}

/** Applies any previously saved enable/disable overrides on top of the just-registered builtin
 * tools. Call once at startup, after every registerExecTool() call. Missing file (nothing toggled
 * yet) or malformed JSON are both treated as "no overrides" rather than a startup failure. */
export async function loadToolOverridesFromDisk(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(TOOL_OVERRIDES_FILE, "utf-8");
  } catch {
    return;
  }
  let overrides: unknown;
  try {
    overrides = JSON.parse(raw);
  } catch {
    console.warn(`[tools] ignoring malformed overrides file at ${TOOL_OVERRIDES_FILE}`);
    return;
  }
  if (!overrides || typeof overrides !== "object") return;
  for (const [id, enabled] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof enabled !== "boolean") continue;
    const tool = tools.get(id);
    if (tool) tool.enabled = enabled;
  }
}

/** Runtime enable/disable toggle for a registered tool - persisted so it survives a restart. */
export async function setToolEnabled(id: string, enabled: boolean): Promise<ExecTool> {
  const tool = tools.get(id);
  if (!tool) throw new ExecToolNotFoundError(id);
  tool.enabled = enabled;
  await persistToolOverrides();
  return tool;
}

/** Every existing binary that `executable` could refer to: an absolute path is just itself; a bare
 * name expands to all its PATH matches (`which -a`) plus a few common user-local bin dirs a Go /
 * ProjectDiscovery install lands in (~/.local/bin, ~/go/bin). Those extras matter because a service
 * launched outside a login shell - e.g. from an IDE - often has a narrower PATH that omits them, so
 * the genuine binary can be installed and working yet invisible to a plain `which`. */
function executableCandidates(executable: string): string[] {
  if (path.isAbsolute(executable)) return existsSync(executable) ? [executable] : [];
  const which = spawnSync("which", ["-a", executable], { encoding: "utf-8" });
  const onPath =
    which.status === 0 ? which.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const userBins = [".local/bin", "go/bin", ".local/go/bin"].map((d) => path.join(homedir(), d, executable));
  return [...new Set([...onPath, ...userBins])].filter((p) => existsSync(p));
}

/** Resolves a tool to the absolute path of its genuine binary. Without an identitySignature that's
 * simply the first candidate that exists (preserving the old first-on-PATH behaviour); with one, the
 * first candidate whose version output matches - so e.g. ProjectDiscovery httpx in ~/.local/bin is
 * chosen even when python-httpx sits earlier on PATH. Undefined when nothing qualifies. */
function resolveToolExecutable(tool: ExecTool): string | undefined {
  const candidates = executableCandidates(tool.executable);
  if (!tool.identitySignature) return candidates[0];
  return candidates.find((candidate) => matchesIdentity(tool, probeVersionOutput(tool, candidate)));
}

const VERSION_PROBE_TIMEOUT_MS = 3000;

/** Runs `<executable> <tool.versionFlag>` and returns its combined stdout+stderr with ANSI colour
 * codes stripped, or "" when there's no versionFlag / it errors. Best-effort - a nonzero exit or
 * timeout just yields whatever text came back (often still identifying), see ExecTool.versionFlag's
 * doc comment on why some tools (whois, nslookup) never get a flag here at all. */
function probeVersionOutput(tool: ExecTool, resolvedPath: string): string {
  if (!tool.versionFlag) return "";
  const result = spawnSync(resolvedPath, [tool.versionFlag], {
    encoding: "utf-8",
    timeout: VERSION_PROBE_TIMEOUT_MS,
    input: "",
  });
  // eslint-disable-next-line no-control-regex
  return `${result.stdout || ""}\n${result.stderr || ""}`.replace(/\[[0-9;]*m/g, "");
}

/** A human-readable version from a probe: the first semver-ish token if present (so multi-line
 * banners like ProjectDiscovery's collapse to just "v1.10.0"), else the first non-empty line. */
function versionFromProbe(output: string): string | undefined {
  const semver = output.match(/v?\d+\.\d+(?:\.\d+)?[\w.-]*/)?.[0];
  if (semver) return semver;
  return output
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
}

/** True unless the tool declares an identitySignature its resolved binary's version output fails to
 * match - the guard against a same-named unrelated program on PATH (see ExecTool.identitySignature). */
function matchesIdentity(tool: ExecTool, probeOutput: string): boolean {
  if (!tool.identitySignature) return true;
  return new RegExp(tool.identitySignature, "i").test(probeOutput);
}

/** Checks every registered tool's executable against PATH — mirrors agentManager's model-availability
 * check. resolveToolExecutable already applies the identity signature, so a resolved path is by
 * definition the genuine tool; a wrong same-named program (e.g. python-httpx instead of
 * ProjectDiscovery httpx) resolves to nothing and reports unavailable rather than "available but
 * every run fails". */
export function listExecToolsWithStatus(): ExecToolWithStatus[] {
  return listExecTools().map((tool) => {
    const resolvedPath = resolveToolExecutable(tool);
    if (!resolvedPath) {
      return { ...tool, availability: "unavailable", resolvedPath: undefined, version: undefined };
    }
    return { ...tool, availability: "available", resolvedPath, version: versionFromProbe(probeVersionOutput(tool, resolvedPath)) };
  });
}

/** True if `candidate`, resolved against `base`, stays within `base`. */
function isPathContained(base: string, candidate: string): boolean {
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg === "." || arg.startsWith("~");
}

function validateArguments(tool: ExecTool, args: string[]): void {
  if (tool.allowedArguments?.length) {
    const patterns = tool.allowedArguments.map((p) => new RegExp(p));
    for (const arg of args) {
      if (!patterns.some((re) => re.test(arg))) {
        throw new InvalidToolArgumentsError(`Argument "${arg}" is not allowed for tool "${tool.id}"`);
      }
    }
  }

  for (const arg of args) {
    if (looksLikePath(arg) && !isPathContained(env.workspaceRoot, arg)) {
      throw new InvalidToolArgumentsError(
        `Argument "${arg}" resolves outside the workspace root (${env.workspaceRoot})`,
      );
    }
  }
}

function buildResolvedCommand(tool: ExecTool, args: string[]): string {
  return [tool.executable, ...tool.defaultArguments, ...args].join(" ");
}

/** Matches sudo/su/doas/pkexec as a whole word, wherever it appears in the resolved command —
 * covers both a tool whose own executable is one of these and a shell tool (bash -c "...") that
 * invokes one inside its command string. */
const PRIVILEGED_COMMAND_RE = /\b(sudo|doas|pkexec|su)\b/;

/** Every process is spawned via toolExecutor without a TTY or a way to answer a password prompt
 * (see runExecutable in toolExecutor.ts), so a privileged command can never succeed here — it
 * would just hang until its timeout. Rejecting upfront avoids burning that timeout and gives the
 * agent an actionable reason instead of an inscrutable "a terminal is required" stderr it might
 * otherwise retry against. */
function assertNotPrivileged(resolvedCommand: string): void {
  if (PRIVILEGED_COMMAND_RE.test(resolvedCommand)) {
    throw new PrivilegedCommandError(resolvedCommand);
  }
}

/** Caps history per project (not globally) — each project's execution log is independent. */
function trimHistory(projectId: string): void {
  const projectRecords = [...executions.values()].filter((r) => r.projectId === projectId);
  if (projectRecords.length <= MAX_HISTORY) return;
  const oldestFirst = projectRecords.sort((a, b) => a.createdAt - b.createdAt);
  for (const record of oldestFirst.slice(0, projectRecords.length - MAX_HISTORY)) {
    executions.delete(record.id);
  }
}

function projectExecutions(projectId: string): ExecutionRecord[] {
  return [...executions.values()].filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistExecutions(projectId: string): Promise<void> {
  await writeProjectJson(projectId, EXECUTIONS_FILE, projectExecutions(projectId));
}

/** Hydrates the in-memory execution history from disk — called once at server startup so history
 * survives a restart instead of only being written-through from that point on. */
export async function loadExecutionsFromDisk(): Promise<void> {
  const projectIds = await listProjectIds();
  for (const projectId of projectIds) {
    const records = await readProjectJson<ExecutionRecord>(projectId, EXECUTIONS_FILE);
    for (const record of records) executions.set(record.id, record);
  }
}

function applyParser(parser: OutputParserKind, stdout: string): unknown {
  if (parser === "lines") {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (parser === "json") {
    try {
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function runRecord(
  record: ExecutionRecord,
  tool: ExecTool,
  stdin: string | undefined,
  onOutput?: (chunk: OutputChunk) => void,
): Promise<ExecutionRecord> {
  record.status = "running";
  record.startedAt = Date.now();

  const controller = new AbortController();
  runningControllers.set(record.id, controller);

  const result = await runExecutable({
    // Run the identity-resolved absolute path (e.g. ProjectDiscovery httpx in ~/.local/bin), not the
    // bare name the OS would resolve off PATH - which might be a wrong same-named program. Falls back
    // to the bare name only if resolution just failed (requestExecution already validated it).
    executable: resolveToolExecutable(tool) ?? tool.executable,
    args: [...tool.defaultArguments, ...record.arguments],
    cwd: record.cwd,
    timeoutMs: tool.timeout,
    stdin,
    signal: controller.signal,
    onOutput,
  });

  runningControllers.delete(record.id);
  result.parsedOutput = applyParser(tool.parser, result.stdout);

  record.finishedAt = Date.now();
  record.result = result;
  record.status = result.cancelled ? "cancelled" : result.success ? "completed" : "failed";

  console.log(
    `[tools] ${record.status}: ${record.resolvedCommand} (exit ${result.exitCode}, ${result.executionTimeMs}ms)`,
  );

  // Execution -> Parser -> Findings Engine -> Project Findings. A parsing failure must never
  // break the actual tool-execution flow, hence the isolated try/catch (ingestExecution itself
  // already never throws, but this stays defensive against future changes there).
  try {
    await ingestExecution(record);
  } catch (err) {
    console.error(`[tools] findings ingestion failed for execution "${record.id}":`, err);
  }

  await persistExecutions(record.projectId);
  return record;
}

/**
 * Validates and registers a tool request. If the tool doesn't require confirmation it runs
 * immediately; otherwise it's parked as `pending_confirmation` until confirmExecution() is
 * called. Every built-in tool currently requires confirmation, so the immediate-run branch is
 * inactive today — it exists as the "human approval for selected tools" hook for when per-tool
 * confirmation gets loosened later.
 */
export async function requestExecution(body: ToolRequestBody): Promise<ExecutionRecord> {
  const tool = tools.get(body.tool);
  if (!tool) throw new ExecToolNotFoundError(body.tool);
  if (!tool.enabled) throw new ExecToolDisabledError(tool.id);

  if (!Array.isArray(body.arguments) || body.arguments.some((a) => typeof a !== "string")) {
    throw new InvalidToolArgumentsError("arguments must be an array of strings");
  }
  validateArguments(tool, body.arguments);

  // Refuse if the executable is missing, or only resolves to the wrong same-named program (identity
  // mismatch) - running it would just fail on flags it doesn't have, with a confusing error.
  if (!resolveToolExecutable(tool)) {
    throw new ExecutableUnavailableError(tool.id, tool.executable);
  }

  const resolvedCommand = buildResolvedCommand(tool, body.arguments);
  assertNotPrivileged(resolvedCommand);

  // Best-effort mission scope check - a clear violation blocks outright; when nothing
  // target-shaped could be found in the arguments at all, the human sees a warning instead of a
  // silent pass (see scopeMatcher.ts's module doc comment for why argv has no reliable "target").
  let scopeWarning: string | undefined;
  const project = await getProject(body.projectId).catch(() => undefined);
  if (project) {
    const verdict = checkScope(project.scope, project.outOfScope, body.arguments);
    if (verdict.verdict === "out_of_scope") throw new OutOfScopeError(verdict.offending);
    if (verdict.verdict === "unknown") {
      scopeWarning = "Could not identify a target in this command's arguments - mission scope was not checked.";
    }
  }

  const record: ExecutionRecord = {
    id: randomUUID(),
    projectId: body.projectId,
    toolId: tool.id,
    agentId: body.agentId,
    arguments: body.arguments,
    resolvedCommand,
    cwd: env.workspaceRoot,
    status: "pending_confirmation",
    createdAt: Date.now(),
    scopeWarning,
  };
  executions.set(record.id, record);
  trimHistory(record.projectId);
  await persistExecutions(record.projectId);

  console.log(`[tools] requested: ${record.resolvedCommand} (execution ${record.id})`);

  if (!tool.requiresConfirmation) {
    return runRecord(record, tool, body.stdin);
  }
  if (body.stdin !== undefined) pendingStdin.set(record.id, body.stdin);
  return record;
}

export async function confirmExecution(
  id: string,
  onOutput?: (chunk: OutputChunk) => void,
): Promise<ExecutionRecord> {
  const record = executions.get(id);
  if (!record) throw new ExecutionNotFoundError(id);
  if (record.status !== "pending_confirmation") {
    throw new InvalidToolArgumentsError(`Execution "${id}" is not pending confirmation (status: ${record.status})`);
  }
  const tool = tools.get(record.toolId);
  if (!tool) throw new ExecToolNotFoundError(record.toolId);

  const stdin = pendingStdin.get(id);
  pendingStdin.delete(id);
  return runRecord(record, tool, stdin, onOutput);
}

export function rejectExecution(id: string): ExecutionRecord {
  const record = executions.get(id);
  if (!record) throw new ExecutionNotFoundError(id);
  if (record.status !== "pending_confirmation") {
    throw new InvalidToolArgumentsError(`Execution "${id}" is not pending confirmation (status: ${record.status})`);
  }
  pendingStdin.delete(id);
  record.status = "rejected";
  record.finishedAt = Date.now();
  // Fire-and-forget: rejectExecution stays synchronous (its route calls it inline), and a local
  // JSON write lagging by a tick is harmless here - see persistExecutions/DEVELOPMENT.md.
  void persistExecutions(record.projectId).catch((err) => console.error("[tools] persist failed:", err));
  return record;
}

export function cancelExecution(id: string): ExecutionRecord {
  const record = executions.get(id);
  if (!record) throw new ExecutionNotFoundError(id);
  const controller = runningControllers.get(id);
  if (!controller) {
    throw new InvalidToolArgumentsError(`Execution "${id}" is not running (status: ${record.status})`);
  }
  controller.abort();
  return record;
}

export function getExecution(id: string): ExecutionRecord | undefined {
  return executions.get(id);
}

export function listExecutions(projectId: string): ExecutionRecord[] {
  return projectExecutions(projectId);
}
