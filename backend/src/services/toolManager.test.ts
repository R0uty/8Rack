import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import {
  cancelExecution,
  confirmExecution,
  getExecTool,
  listExecutions,
  registerExecTool,
  rejectExecution,
  requestExecution,
} from "./toolManager.js";
import {
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutableUnavailableError,
  ExecutionNotFoundError,
  InvalidToolArgumentsError,
  PrivilegedCommandError,
} from "./errors.js";
import type { ExecTool } from "../types/execTool.js";

vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));

const baseTool: ExecTool = {
  id: "test-tool",
  name: "Test Tool",
  description: "Runs a Node script for testing.",
  category: "exec",
  executable: process.execPath,
  defaultArguments: ["-e"],
  timeout: 5000,
  enabled: true,
  requiresConfirmation: true,
  parser: "text",
  icon: "🧪",
};

beforeAll(() => {
  registerExecTool(baseTool);
  registerExecTool({ ...baseTool, id: "disabled-tool", enabled: false });
  registerExecTool({ ...baseTool, id: "restricted-tool", allowedArguments: ["^--safe$"] });
  registerExecTool({ ...baseTool, id: "unresolvable-tool", executable: "/definitely/not/a/real/executable-xyz" });
});

describe("requestExecution validation", () => {
  it("rejects an unknown tool", async () => {
    await expect(requestExecution({ tool: "nope", arguments: [], projectId: "p" })).rejects.toThrow(
      ExecToolNotFoundError,
    );
  });

  it("rejects a disabled tool", async () => {
    await expect(requestExecution({ tool: "disabled-tool", arguments: [], projectId: "p" })).rejects.toThrow(
      ExecToolDisabledError,
    );
  });

  it("rejects malformed arguments", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: [123 as unknown as string], projectId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("rejects a path argument that escapes the workspace root", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["../../etc/passwd"], projectId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("rejects an argument that doesn't match allowedArguments", async () => {
    await expect(
      requestExecution({ tool: "restricted-tool", arguments: ["--unsafe"], projectId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("allows an argument that matches allowedArguments", async () => {
    const record = await requestExecution({ tool: "restricted-tool", arguments: ["--safe"], projectId: "p" });
    expect(record.status).toBe("pending_confirmation");
  });

  it("rejects a tool whose executable can't be resolved", async () => {
    await expect(
      requestExecution({ tool: "unresolvable-tool", arguments: [], projectId: "p" }),
    ).rejects.toThrow(ExecutableUnavailableError);
  });

  it("rejects a command that invokes sudo, since tools run non-interactively with no TTY", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["-c", "sudo pacman -S katana"], projectId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });

  it("rejects a command that invokes su/doas/pkexec", async () => {
    await expect(requestExecution({ tool: "test-tool", arguments: ["su", "-c", "whoami"], projectId: "p" })).rejects.toThrow(
      PrivilegedCommandError,
    );
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["doas pacman -S katana"], projectId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });

  it("does not false-positive on words that merely contain 'su'", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["supervisorctl status"],
      projectId: "p",
    });
    expect(record.status).toBe("pending_confirmation");
  });
});

describe("confirm / reject / cancel lifecycle", () => {
  it("parks a confirmation-required request as pending_confirmation without running it", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('hi')"],
      projectId: "proj-park",
    });

    expect(record.status).toBe("pending_confirmation");
    expect(record.result).toBeUndefined();
    expect(record.cwd).toBe(env.workspaceRoot);
  });

  it("actually runs the tool on confirmExecution and captures real output", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('confirmed-output')"],
      projectId: "proj-confirm",
    });

    const onOutput = vi.fn();
    const finished = await confirmExecution(record.id, onOutput);

    expect(finished.status).toBe("completed");
    expect(finished.result?.stdout).toBe("confirmed-output");
    expect(finished.result?.success).toBe(true);
    expect(onOutput).toHaveBeenCalledWith({ stream: "stdout", data: "confirmed-output" });
  });

  it("throws confirming an execution that isn't pending anymore", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('x')"],
      projectId: "proj-double-confirm",
    });
    await confirmExecution(record.id);

    await expect(confirmExecution(record.id)).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("throws confirming/rejecting/cancelling an unknown execution id", async () => {
    await expect(confirmExecution("nope")).rejects.toThrow(ExecutionNotFoundError);
    expect(() => rejectExecution("nope")).toThrow(ExecutionNotFoundError);
    expect(() => cancelExecution("nope")).toThrow(ExecutionNotFoundError);
  });

  it("rejects a pending execution and refuses a second reject", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-reject" });

    const rejected = rejectExecution(record.id);
    expect(rejected.status).toBe("rejected");
    expect(() => rejectExecution(record.id)).toThrow(InvalidToolArgumentsError);
  });

  it("refuses to cancel an execution that isn't currently running", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-cancel-idle" });
    expect(() => cancelExecution(record.id)).toThrow(InvalidToolArgumentsError);
  });

  it("cancels a running execution", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["setTimeout(() => {}, 5000)"],
      projectId: "proj-cancel-running",
    });

    const runPromise = confirmExecution(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelExecution(record.id);

    const finished = await runPromise;
    expect(finished.status).toBe("cancelled");
    expect(finished.result?.cancelled).toBe(true);
  });
});

describe("listExecutions", () => {
  it("only returns executions for the requested project", async () => {
    await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-a" });
    await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-a" });
    await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-b" });

    expect(listExecutions("proj-a")).toHaveLength(2);
    expect(listExecutions("proj-b")).toHaveLength(1);
    expect(listExecutions("proj-a").every((r) => r.projectId === "proj-a")).toBe(true);
  });
});

describe("getExecTool", () => {
  it("returns a registered tool by id, undefined otherwise", () => {
    expect(getExecTool("test-tool")?.name).toBe("Test Tool");
    expect(getExecTool("nope")).toBeUndefined();
  });
});
