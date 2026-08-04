import { spawn } from "node:child_process";
import type { ExecutionResult } from "../types/execTool.js";

/** Per-stream cap; once reached, further output is dropped and `truncated` is set. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface OutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface RunExecutableOptions {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Piped to the process's stdin, then the stream is closed. */
  stdin?: string;
  maxOutputBytes?: number;
  /** External cancellation — aborting this rejects nothing, it resolves with `cancelled: true`. */
  signal?: AbortSignal;
  /** Called for every chunk as it arrives, in addition to the final accumulated result. */
  onOutput?: (chunk: OutputChunk) => void;
}

/**
 * The generic Tool Executor: runs a local executable via argv (never a shell string, so shell
 * metacharacters in arguments can't be interpreted), captures stdout/stderr/exit code, and
 * resolves — never rejects — with a structured ExecutionResult, including on spawn failure,
 * timeout, or cancellation.
 */
export function runExecutable(options: RunExecutableOptions): Promise<ExecutionResult> {
  const { executable, args, cwd, timeoutMs, stdin, signal, onOutput } = options;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelledByCaller = false;
    let settled = false;

    const controller = new AbortController();
    const onExternalAbort = () => {
      cancelledByCaller = true;
      controller.abort();
    };
    signal?.addEventListener("abort", onExternalAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    };

    const appendOutput = (stream: "stdout" | "stderr", text: string) => {
      onOutput?.({ stream, data: text });
      const current = stream === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf-8") + Buffer.byteLength(text, "utf-8") > maxOutputBytes) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
    };

    let child;
    try {
      child = spawn(executable, args, { cwd, signal: controller.signal });
    } catch (err) {
      cleanup();
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : "Failed to start process",
        exitCode: null,
        executionTimeMs: Date.now() - startedAt,
        success: false,
        timedOut: false,
        cancelled: false,
        truncated: false,
      });
      return;
    }

    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk.toString("utf-8")));

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const isAbort = err.name === "AbortError";
      resolve({
        stdout,
        stderr: isAbort ? stderr : stderr || err.message,
        exitCode: null,
        executionTimeMs: Date.now() - startedAt,
        success: false,
        timedOut,
        cancelled: cancelledByCaller,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode,
        executionTimeMs: Date.now() - startedAt,
        success: !timedOut && !cancelledByCaller && exitCode === 0,
        timedOut,
        cancelled: cancelledByCaller,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });
  });
}
