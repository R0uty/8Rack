import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { runExecutable } from "./toolExecutor.js";
import type { OutputChunk } from "./toolExecutor.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { ingestExecution } from "./findingsManager.js";
import { getMission, onMissionDeleted } from "./missionManager.js";
import { checkScope } from "./scopeMatcher.js";
import { logActivity } from "./activityLog.js";
import {
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutableUnavailableError,
  ExecutionNotFoundError,
  InvalidToolArgumentsError,
  OutOfScopeError,
  PrivilegedCommandError,
  TooManyConcurrentExecutionsError,
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

// A deleted mission's executions must stop returning from listExecutions/getExecution, and a
// still-running one must actually be aborted - otherwise its eventual persistExecutions() call
// would recreate the directory deleteMission() just removed. See missionManager.ts#onMissionDeleted.
onMissionDeleted((missionId) => {
  for (const [id, record] of executions) {
    if (record.missionId !== missionId) continue;
    runningControllers.get(id)?.abort();
    runningControllers.delete(id);
    pendingStdin.delete(id);
    executions.delete(id);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Not mission-scoped (tools are global, unlike executions) - one shared file, not under
 * data/missions/, so it doesn't go through missionStore.ts's per-mission helpers. */
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
 * MissionDiscovery install lands in (~/.local/bin, ~/go/bin). Those extras matter because a service
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
 * first candidate whose version output matches - so e.g. MissionDiscovery httpx in ~/.local/bin is
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
 * banners like MissionDiscovery's collapse to just "v1.10.0"), else the first non-empty line. */
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
 * MissionDiscovery httpx) resolves to nothing and reports unavailable rather than "available but
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

/** Resolves `p` to its real (symlink-free) absolute path. `p` itself may not exist yet (e.g. a
 * write_file target that hasn't been created) - falls back to the nearest existing ancestor's
 * real path plus the remaining, not-yet-created suffix, so a symlinked ancestor directory is still
 * followed even though the leaf itself can't be realpath'd directly. */
function realOrNearestPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p; // reached the filesystem root without finding anything real
    return path.join(realOrNearestPath(parent), path.basename(p));
  }
}

/** True if `candidate`, resolved against `base` with every symlink on both sides followed, stays
 * within `base`'s own real location. Following symlinks (not just a lexical path.resolve) closes
 * the bypass where a symlink planted inside the workspace points outside it - read_file/grep/find
 * would otherwise happily follow it to wherever it really points. `realBase` is the caller's
 * already-resolved `realOrNearestPath(base)` - `base` is always env.workspaceRoot, a constant
 * across a whole validateArguments call, so resolving it once there (not per argument here) avoids
 * repeating the same realpathSync ancestor walk for every path-like argument. */
function isPathContained(base: string, realBase: string, candidate: string): boolean {
  const resolved = path.resolve(base, candidate);
  const realResolved = realOrNearestPath(resolved);
  const relative = path.relative(realBase, realResolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ".." is deliberately included even though it contains no "/" - `ls ..` (a bare ".." argv
// element) previously slipped past this check entirely and listed the workspace's parent
// directory. isPathContained correctly rejects it once looksLikePath actually flags it. A leading
// "~" is deliberately NOT included here - validateArguments rejects it outright before this is
// ever called, so a "~" branch here would be dead code at its only call site.
function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg === "." || arg === "..";
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

  // Resolved once per call, not once per argument - base (env.workspaceRoot) never changes within
  // a single validateArguments call, so repeating the realpathSync ancestor walk per argument was
  // wasted I/O for tools invoked with several path-like arguments.
  const realBase = realOrNearestPath(env.workspaceRoot);

  for (const arg of args) {
    // "~" is never expanded by this check (path.resolve treats it as a literal directory name,
    // not shell tilde-expansion), so evaluating it for containment would be actively misleading -
    // it would resolve to a harmless-looking path *inside* the workspace while a tool that does
    // its own shell expansion (bash -c "cat ~/...", git) reads the real home directory instead.
    // Reject outright rather than pretend to have checked it.
    if (arg.startsWith("~")) {
      throw new InvalidToolArgumentsError(
        `Argument "${arg}" starts with "~" - this isn't expanded by the workspace containment ` +
          "check, and may be expanded differently (or not at all) by the tool itself. Use an " +
          "absolute or workspace-relative path instead.",
      );
    }
    if (looksLikePath(arg) && !isPathContained(env.workspaceRoot, realBase, arg)) {
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

/** Caps history per mission (not globally) — each mission's execution log is independent. */
function trimHistory(missionId: string): void {
  const missionRecords = [...executions.values()].filter((r) => r.missionId === missionId);
  if (missionRecords.length <= MAX_HISTORY) return;
  const oldestFirst = missionRecords.sort((a, b) => a.createdAt - b.createdAt);
  for (const record of oldestFirst.slice(0, missionRecords.length - MAX_HISTORY)) {
    executions.delete(record.id);
  }
}

function missionExecutions(missionId: string): ExecutionRecord[] {
  return [...executions.values()].filter((r) => r.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistExecutions(missionId: string): Promise<void> {
  await writeMissionJson(missionId, EXECUTIONS_FILE, missionExecutions(missionId));
}

/** Hydrates the in-memory execution history from disk — called once at server startup so history
 * survives a restart instead of only being written-through from that point on. */
export async function loadExecutionsFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const records = await readMissionJson<ExecutionRecord>(missionId, EXECUTIONS_FILE);
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
  // Global cap on real OS processes spawned at once, shared across every caller (manual requests,
  // Orchestrator tasks, Scan Profiles) since they all reach this one chokepoint - runningControllers
  // already tracks exactly "processes currently spawned", so it doubles as the live count with no
  // separate counter needed. Not a queue: the record is left untouched at pending_confirmation
  // (nothing was spent) so the human can just confirm again once a slot frees up.
  if (runningControllers.size >= env.maxConcurrentExecutions) {
    throw new TooManyConcurrentExecutionsError(env.maxConcurrentExecutions);
  }

  record.status = "running";
  record.startedAt = Date.now();

  const controller = new AbortController();
  runningControllers.set(record.id, controller);

  const result = await runExecutable({
    // Run the identity-resolved absolute path (e.g. MissionDiscovery httpx in ~/.local/bin), not the
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

  // Execution -> Parser -> Findings Engine -> Mission Findings. A parsing failure must never
  // break the actual tool-execution flow, hence the isolated try/catch (ingestExecution itself
  // already never throws, but this stays defensive against future changes there).
  try {
    await ingestExecution(record);
  } catch (err) {
    console.error(`[tools] findings ingestion failed for execution "${record.id}":`, err);
  }

  await persistExecutions(record.missionId);
  return record;
}

/**
 * Best-effort mission scope check (see scopeMatcher.ts's module doc comment for why argv has no
 * reliable "target"). Three outcomes for the confirming human: a clear violation blocks outright
 * (thrown); nothing target-shaped found in the arguments is only a silent pass when no *strict*
 * (non-empty) `scope` allowlist is configured - under a strict allowlist, "we can't tell what this
 * targets" is exactly the case that allowlist exists to catch, so it blocks too; anything else
 * returns a human-readable warning string (or undefined for a clean, checked, in-scope target) to
 * attach to the execution record. A mission that can't be resolved (deleted, malformed id, or
 * simply doesn't exist yet) can't have its scope checked at all - previously this failed silently
 * with no trace; now it always surfaces as a warning rather than looking identical to "no scope
 * configured".
 */
async function checkExecutionScope(missionId: string, args: string[]): Promise<string | undefined> {
  let mission;
  try {
    mission = await getMission(missionId);
  } catch (err) {
    console.warn(`[tools] could not load mission "${missionId}" for scope check:`, err);
  }
  if (!mission) {
    return "Mission scope could not be checked - the mission record could not be loaded.";
  }

  const verdict = checkScope(mission.scope, mission.outOfScope, args);
  if (verdict.verdict === "out_of_scope") {
    await logActivity(missionId, "scope_blocked", `Execution blocked - target(s) outside scope: ${verdict.offending.join(", ")}`, {
      offending: verdict.offending,
    });
    throw new OutOfScopeError(verdict.offending);
  }
  if (verdict.verdict === "unknown") {
    if (mission.scope?.length) {
      await logActivity(
        missionId,
        "scope_blocked",
        "Execution blocked - no identifiable target found and a strict scope allowlist is configured",
      );
      throw new OutOfScopeError(["(no identifiable target found in this command's arguments)"]);
    }
    return "Could not identify a target in this command's arguments - mission scope was not checked.";
  }
  return undefined;
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

  // stdin content itself is deliberately never persisted into the record (see pendingStdin's own
  // doc comment above) - but a confirming human should still see *that* content is about to be
  // piped in and roughly how much, rather than a resolved command that looks identical to a
  // no-content run. A byte count is a reasonable middle ground: enough for the human to sanity
  // check ("that's way more than I expected") without the potentially large/sensitive content
  // itself ever landing in the (listable, persisted) execution history.
  const resolvedCommand =
    buildResolvedCommand(tool, body.arguments) +
    (body.stdin !== undefined ? ` (stdin: ${Buffer.byteLength(body.stdin, "utf-8")} bytes)` : "");
  assertNotPrivileged(resolvedCommand);

  const scopeWarning = await checkExecutionScope(body.missionId, body.arguments);

  const record: ExecutionRecord = {
    id: randomUUID(),
    missionId: body.missionId,
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
  trimHistory(record.missionId);
  await persistExecutions(record.missionId);

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

  // Re-check mission scope at confirm time too - the mission's scope could have been edited (or
  // the mission deleted) in the window between request and confirm, and this is the last point
  // before the command actually runs. A now-out-of-scope target throws and leaves the execution
  // parked at pending_confirmation for the human to explicitly reject.
  record.scopeWarning = await checkExecutionScope(record.missionId, record.arguments);

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
  void persistExecutions(record.missionId).catch((err) => console.error("[tools] persist failed:", err));
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

export function listExecutions(missionId: string): ExecutionRecord[] {
  return missionExecutions(missionId);
}
