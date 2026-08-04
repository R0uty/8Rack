import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { runExecutable } from "./toolExecutor.js";
import type { OutputChunk } from "./toolExecutor.js";
import {
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutableUnavailableError,
  ExecutionNotFoundError,
  InvalidToolArgumentsError,
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

export function registerExecTool(tool: ExecTool): void {
  tools.set(tool.id, tool);
}

export function getExecTool(id: string): ExecTool | undefined {
  return tools.get(id);
}

export function listExecTools(): ExecTool[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function resolveExecutablePath(executable: string): string | undefined {
  if (path.isAbsolute(executable)) return existsSync(executable) ? executable : undefined;
  const result = spawnSync("which", [executable], { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Checks every registered tool's executable against PATH — mirrors agentManager's model-availability check. */
export function listExecToolsWithStatus(): ExecToolWithStatus[] {
  return listExecTools().map((tool) => {
    const resolvedPath = resolveExecutablePath(tool.executable);
    return { ...tool, availability: resolvedPath ? "available" : "unavailable", resolvedPath };
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

function trimHistory(): void {
  if (executions.size <= MAX_HISTORY) return;
  const oldestFirst = [...executions.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const record of oldestFirst.slice(0, executions.size - MAX_HISTORY)) {
    executions.delete(record.id);
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
    executable: tool.executable,
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

  if (!resolveExecutablePath(tool.executable)) {
    throw new ExecutableUnavailableError(tool.id, tool.executable);
  }

  const record: ExecutionRecord = {
    id: randomUUID(),
    toolId: tool.id,
    arguments: body.arguments,
    resolvedCommand: buildResolvedCommand(tool, body.arguments),
    cwd: env.workspaceRoot,
    status: "pending_confirmation",
    createdAt: Date.now(),
  };
  executions.set(record.id, record);
  trimHistory();

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

export function listExecutions(): ExecutionRecord[] {
  return [...executions.values()].sort((a, b) => b.createdAt - a.createdAt);
}
