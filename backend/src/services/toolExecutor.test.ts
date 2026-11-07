import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { runExecutable } from "./toolExecutor.js";
import type { OutputChunk } from "./toolExecutor.js";

/**
 * Real (non-mocked) subprocess tests, using `process.execPath -e "<script>"` (Node itself) instead
 * of relying on `bash`/`echo`/`sleep` being on $PATH — the only external dependency is Node, which
 * is guaranteed to exist since it's what's running the test.
 */
function node(script: string): { executable: string; args: string[] } {
  return { executable: process.execPath, args: ["-e", script] };
}

describe("runExecutable", () => {
  it("captures stdout and reports success on a clean exit", async () => {
    const { executable, args } = node("process.stdout.write('hello')");
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 5000 });

    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("reports failure on a non-zero exit code", async () => {
    const { executable, args } = node("process.exit(3)");
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 5000 });

    expect(result.exitCode).toBe(3);
    expect(result.success).toBe(false);
  });

  it("pipes stdin through to the child process", async () => {
    const { executable, args } = node(
      "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.stdout.write(d));",
    );
    const result = await runExecutable({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 5000,
      stdin: "hello from stdin",
    });

    expect(result.stdout).toBe("hello from stdin");
    expect(result.success).toBe(true);
  });

  it("kills the process and reports timedOut once the timeout elapses", async () => {
    const { executable, args } = node("setTimeout(() => {}, 5000)");
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 150 });

    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it("reports cancelled (not timedOut) when the caller aborts via signal", async () => {
    const { executable, args } = node("setTimeout(() => {}, 5000)");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runExecutable({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.success).toBe(false);
  });

  it("kills backgrounded grandchildren too - cancellation reaches the whole process group", async () => {
    // The parent process spawns a detached grandchild (a node loop, PID captured to a file) and
    // then blocks forever. If only the direct child were signalled, the grandchild would survive
    // the cancellation as an orphan - the process-group kill must take it down with the parent.
    const grandchildPidFile = path.join(tmpdir(), `tool-executor-grandchild-${process.pid}-${Date.now()}.pid`);
    // Anchored as a JSON string so the embedded \n and quotes stay literal in the -e script.
    const pidFileArg = JSON.stringify(grandchildPidFile);
    const { executable, args } = node(`
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 86400000)"], { stdio: "ignore" });
      writeFileSync(${pidFileArg}, String(gc.pid));
      setInterval(() => {}, 86400000);
    `);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    try {
      const result = await runExecutable({
        executable,
        args,
        cwd: process.cwd(),
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      expect(result.cancelled).toBe(true);

      // The grandchild recorded its pid, then died with the group - plant a probe that the pid
      // is no longer live (process.kill with signal 0 throws ESRCH once the process is gone).
      await vi.waitFor(async () => {
        const gcPid = Number(await readFile(grandchildPidFile, "utf-8"));
        expect(() => process.kill(gcPid, 0)).toThrow();
      });
    } finally {
      unlink(grandchildPidFile).catch(() => {});
    }
  });

  it("invokes onOutput for each chunk as it arrives", async () => {
    const { executable, args } = node("process.stdout.write('chunked')");
    const onOutput = vi.fn<(chunk: OutputChunk) => void>();

    await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 5000, onOutput });

    expect(onOutput).toHaveBeenCalledWith({ stream: "stdout", data: "chunked" });
  });

  it("truncates output once maxOutputBytes is exceeded", async () => {
    const { executable, args } = node("process.stdout.write('0123456789')");
    const result = await runExecutable({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 5,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(5);
  });

  it("stops calling onOutput once a stream is truncated, instead of streaming it unboundedly", async () => {
    // Writes in two separate chunks so a naive "call onOutput before checking the cap" bug would
    // fire it for both, even though the second chunk pushes well past maxOutputBytes.
    const { executable, args } = node(
      "process.stdout.write('01234567890123456789'); process.stdout.write('more-after-the-cap');",
    );
    const onOutput = vi.fn<(chunk: OutputChunk) => void>();

    const result = await runExecutable({
      executable,
      args,
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 5,
      onOutput,
    });

    expect(result.truncated).toBe(true);
    // Only the chunks that actually fit under the cap were ever streamed to the client - the
    // over-cap chunk(s) were dropped both from the accumulated result and the live stream.
    const streamedBytes = onOutput.mock.calls.reduce((n, [chunk]) => n + Buffer.byteLength(chunk.data), 0);
    expect(streamedBytes).toBeLessThanOrEqual(5);
  });

  it("resolves (never rejects) with a failure result when the executable doesn't exist", async () => {
    const result = await runExecutable({
      executable: "/definitely/not/a/real/executable-xyz",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});

describe("runExecutable resilience", () => {
  it("survives a child that exits without reading a large stdin (EPIPE)", async () => {
    const { executable, args } = node("process.exit(0)");
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 5000, stdin: "x".repeat(5_000_000) });

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });

  it("doesn't corrupt a multibyte character split across two output chunks", async () => {
    const { executable, args } = node(
      "const b = Buffer.from('€'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 100);",
    );
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 5000 });

    expect(result.stdout).toBe("€");
  });

  it("escalates to SIGKILL when a process ignores SIGTERM", async () => {
    const { executable, args } = node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const startedAt = Date.now();
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 300 });

    expect(result.timedOut).toBe(true);
    expect(result.success).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(6000);
  }, 10_000);

  it("doesn't leave a process running for an already-aborted signal", async () => {
    const { executable, args } = node("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    controller.abort();
    const result = await runExecutable({ executable, args, cwd: process.cwd(), timeoutMs: 60_000, signal: controller.signal });

    expect(result.cancelled).toBe(true);
  }, 10_000);
});
