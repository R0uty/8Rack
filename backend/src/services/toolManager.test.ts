import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import {
  cancelExecution,
  confirmExecution,
  getExecTool,
  listExecutions,
  loadToolOverridesFromDisk,
  registerExecTool,
  rejectExecution,
  requestExecution,
  setToolEnabled,
} from "./toolManager.js";
import { getProject } from "./projectManager.js";
import {
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutableUnavailableError,
  ExecutionNotFoundError,
  InvalidToolArgumentsError,
  OutOfScopeError,
  PrivilegedCommandError,
} from "./errors.js";
import type { ExecTool } from "../types/execTool.js";
import type { Project } from "../types/project.js";

vi.mock("./projectStore.js", () => ({
  listProjectIds: vi.fn(async () => []),
  readProjectJson: vi.fn(async () => []),
  writeProjectJson: vi.fn(async () => undefined),
}));

vi.mock("./projectManager.js", () => ({ getProject: vi.fn(async () => undefined) }));
const mockGetProject = vi.mocked(getProject);

const fsState = { files: new Map<string, string>() };
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsState.files.set(path, content);
  }),
}));

const baseTool: ExecTool = {
  id: "test-tool",
  name: "Test Tool",
  description: "Runs a Node script for testing.",
  category: "os",
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

  it("carries an agent-driven request's agentId onto the resulting record, undefined for a manual one", async () => {
    const agentDriven = await requestExecution({
      tool: "test-tool",
      arguments: [],
      projectId: "proj-agent",
      agentId: "recon-agent",
    });
    expect(agentDriven.agentId).toBe("recon-agent");

    const manual = await requestExecution({ tool: "test-tool", arguments: [], projectId: "proj-agent" });
    expect(manual.agentId).toBeUndefined();
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

describe("mission scope enforcement", () => {
  function fixtureProject(overrides: Partial<Project> = {}): Project {
    return { id: "proj-scope", name: "Scoped Mission", notes: "", createdAt: 0, ...overrides };
  }

  it("allows a request when the project has no scope configured", async () => {
    mockGetProject.mockResolvedValueOnce(fixtureProject());
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["evil.com"],
      projectId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toBeUndefined();
  });

  it("allows a request whose extracted target is in scope", async () => {
    mockGetProject.mockResolvedValueOnce(fixtureProject({ scope: ["example.com"] }));
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["curl", "https://example.com"],
      projectId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toBeUndefined();
  });

  it("blocks a request whose extracted target is outside scope", async () => {
    mockGetProject.mockResolvedValueOnce(fixtureProject({ scope: ["example.com"] }));
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["curl", "https://evil.com"], projectId: "proj-scope" }),
    ).rejects.toThrow(OutOfScopeError);
  });

  it("blocks a request whose target is explicitly out of scope even without a scope allowlist", async () => {
    mockGetProject.mockResolvedValueOnce(fixtureProject({ outOfScope: ["evil.com"] }));
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["evil.com"], projectId: "proj-scope" }),
    ).rejects.toThrow(OutOfScopeError);
  });

  it("attaches a scopeWarning (but still parks it) when scope is configured and no target can be found", async () => {
    mockGetProject.mockResolvedValueOnce(fixtureProject({ scope: ["example.com"] }));
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('x')"],
      projectId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toMatch(/could not identify a target/i);
  });

  it("does not fail the request when the project lookup itself throws", async () => {
    mockGetProject.mockRejectedValueOnce(new Error("disk error"));
    const record = await requestExecution({ tool: "test-tool", arguments: ["evil.com"], projectId: "proj-scope" });
    expect(record.status).toBe("pending_confirmation");
  });
});

describe("getExecTool", () => {
  it("returns a registered tool by id, undefined otherwise", () => {
    expect(getExecTool("test-tool")?.name).toBe("Test Tool");
    expect(getExecTool("nope")).toBeUndefined();
  });
});

describe("setToolEnabled / loadToolOverridesFromDisk", () => {
  it("throws for an unknown tool id", async () => {
    await expect(setToolEnabled("nope", false)).rejects.toThrow(ExecToolNotFoundError);
  });

  it("flips a tool's enabled flag and persists it", async () => {
    registerExecTool({ ...baseTool, id: "toggle-tool" });

    await setToolEnabled("toggle-tool", false);
    expect(getExecTool("toggle-tool")?.enabled).toBe(false);
    await expect(requestExecution({ tool: "toggle-tool", arguments: [], projectId: "p" })).rejects.toThrow(
      ExecToolDisabledError,
    );

    await setToolEnabled("toggle-tool", true);
    expect(getExecTool("toggle-tool")?.enabled).toBe(true);
  });

  it("re-applies a persisted override on top of a freshly registered tool", async () => {
    registerExecTool({ ...baseTool, id: "restart-tool" });
    await setToolEnabled("restart-tool", false);

    // Simulate the tool being re-registered from its (still-enabled) builtin config on a restart,
    // then the saved override file being re-applied on top of it.
    registerExecTool({ ...baseTool, id: "restart-tool" });
    expect(getExecTool("restart-tool")?.enabled).toBe(true);

    await loadToolOverridesFromDisk();
    expect(getExecTool("restart-tool")?.enabled).toBe(false);
  });

  it("loadToolOverridesFromDisk is a no-op when no overrides file exists yet", async () => {
    fsState.files.clear();
    await expect(loadToolOverridesFromDisk()).resolves.toBeUndefined();
  });

  it("loadToolOverridesFromDisk ignores malformed JSON instead of throwing", async () => {
    registerExecTool({ ...baseTool, id: "malformed-guard-tool" });
    await setToolEnabled("malformed-guard-tool", false);
    for (const path of fsState.files.keys()) fsState.files.set(path, "{not json");

    await expect(loadToolOverridesFromDisk()).resolves.toBeUndefined();
    expect(getExecTool("malformed-guard-tool")?.enabled).toBe(false);
  });
});
