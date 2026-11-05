import { spawn } from "node:child_process";
import type { ExecutionResult } from "../types/execTool.js";

/** Per-stream cap; once reached, further output is dropped and `truncated` is set. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** How long a signalled process tree gets to exit on SIGTERM before it's SIGKILLed - a tool that
 * traps or ignores SIGTERM must not be able to outlive its own cancel/timeout. */
const KILL_GRACE_MS = 3000;

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
    let childPid: number | undefined;

    // `detached: true` (below) makes every spawned process a new group leader (pgid == pid). A
    // plain controller.abort() only signals the direct child, so `bash -c 'sleep 3600 &'` would
    // strand the backgrounded grandchild holding its stdio pipe open (and its resources live) long
    // after the outer command was cancelled/timed out. Killing the whole group (`kill(-pid)`) with
    // the abort reaches the entire tree. Best-effort: on a platform where process groups aren't
    // supported (Windows) or the group is already gone, the direct child is still aborted via the
    // controller's signal, which is the old behaviour.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalProcessGroup = (sig: NodeJS.Signals) => {
      if (childPid === undefined) return;
      try {
        process.kill(-childPid, sig);
      } catch {
        // Already exited / no such group / unsupported - direct-child abort covers the non-group case.
      }
    };
    // Unref'd and deliberately not cleared on settle: spawn's abort handling settles this promise
    // the moment the abort fires, which says nothing about whether the tree actually died.
    const killProcessGroup = () => {
      signalProcessGroup("SIGTERM");
      if (killTimer) return;
      killTimer = setTimeout(() => signalProcessGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const onExternalAbort = () => {
      cancelledByCaller = true;
      controller.abort();
      killProcessGroup();
    };
    signal?.addEventListener("abort", onExternalAbort);
    // addEventListener never fires for a signal that's already aborted.
    if (signal?.aborted) onExternalAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      killProcessGroup();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onExternalAbort);
    };

    // The live onOutput callback (streamed to the confirming client) is bounded by the same
    // maxOutputBytes cap as the accumulated stdout/stderr, and stops firing entirely once a stream
    // is truncated - previously it fired unconditionally *before* the cap check below, so a tool
    // emitting far more than maxOutputBytes (e.g. a huge ffuf wordlist, `head -c 1e8 /dev/urandom`)
    // streamed unboundedly to the client and kept memory-buffering under res.write() backpressure,
    // even though the final stored result was already correctly capped.
    const appendOutput = (stream: "stdout" | "stderr", text: string) => {
      if (stream === "stdout" ? stdoutTruncated : stderrTruncated) return;
      const current = stream === "stdout" ? stdout : stderr;
      if (Buffer.byteLength(current, "utf-8") + Buffer.byteLength(text, "utf-8") > maxOutputBytes) {
        if (stream === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      if (stream === "stdout") stdout += text;
      else stderr += text;
      onOutput?.({ stream, data: text });
    };

    let child;
    try {
      // detached makes the child a process-group leader so killProcessGroup can reach any
      // processes it spawns. No unref: the parent still waits for the tree to exit (the whole
      // point - a cancelled tool must not linger either).
      child = spawn(executable, args, { cwd, detached: true, signal: controller.signal });
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

    childPid = child.pid;
    // The external signal may have aborted before spawn returned - Node usually fails the spawn
    // outright in that case, but if the process was briefly created, kill its whole group too.
    if (controller.signal.aborted) killProcessGroup();

    // A process that exits without draining stdin makes this write fail with EPIPE - an 'error'
    // event on the stream that, with no listener, is an uncaught exception that takes the whole
    // backend down. The process's own exit status is what reports the failure.
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();

    // setEncoding, not chunk.toString(): a multi-byte character split across two reads would
    // otherwise decode to two U+FFFD replacement characters.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => appendOutput("stderr", chunk));

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
