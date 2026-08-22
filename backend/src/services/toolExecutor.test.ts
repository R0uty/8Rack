import { describe, expect, it, vi } from "vitest";
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
