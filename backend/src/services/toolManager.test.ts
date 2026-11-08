import { symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import {
  abortAllExecutions,
  cancelExecution,
  confirmExecution,
  getExecTool,
  getExecution,
  listExecToolsWithStatus,
  listExecutions,
  loadExecutionsFromDisk,
  loadToolOverridesFromDisk,
  registerExecTool,
  rejectExecution,
  requestExecution,
  setToolEnabled,
} from "./toolManager.js";
import { getMission, onMissionDeleted } from "./missionManager.js";
import { callMcpTool, getMcpTool } from "./mcpClient.js";
import type { McpTool } from "./mcpClient.js";
import { listActivity } from "./activityLog.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
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
import type { ExecTool } from "../types/execTool.js";
import type { Mission } from "../types/mission.js";

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));

vi.mock("./missionManager.js", () => ({ getMission: vi.fn(async () => undefined), onMissionDeleted: vi.fn() }));
const mockGetMission = vi.mocked(getMission);
const mockGetMcpTool = vi.mocked(getMcpTool);
const mockCallMcpTool = vi.mocked(callMcpTool);
const mockOnMissionDeleted = vi.mocked(onMissionDeleted);
/** Captured once, synchronously, right here at module load rather than read lazily inside
 * purgeMission - a future `beforeEach(() => vi.clearAllMocks())` (see orchestrator.test.ts, which
 * needed exactly this) would otherwise wipe mockOnMissionDeleted.mock.calls before any test body
 * runs, since these registrations only ever happen once, at import time. Every module in this
 * test's import graph that calls onMissionDeleted(...) at its own top level (toolManager.ts's own
 * handler, plus findingsManager.ts's transitively) registered here, in whatever order ESM
 * evaluated their imports. */
const registeredPurgeHandlers = mockOnMissionDeleted.mock.calls.map(([handler]) => handler);
/** Replicates exactly what the real (mocked-away) missionManager.ts#deleteMission does: call every
 * registered handler for the given id. */
function purgeMission(missionId: string) {
  for (const handler of registeredPurgeHandlers) handler(missionId);
}

vi.mock("./mcpClient.js", () => ({ getMcpTool: vi.fn(() => undefined), callMcpTool: vi.fn() }));

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
    await expect(requestExecution({ tool: "nope", arguments: [], missionId: "p" })).rejects.toThrow(
      ExecToolNotFoundError,
    );
  });

  it("rejects a disabled tool", async () => {
    await expect(requestExecution({ tool: "disabled-tool", arguments: [], missionId: "p" })).rejects.toThrow(
      ExecToolDisabledError,
    );
  });

  it("rejects malformed arguments", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: [123 as unknown as string], missionId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("rejects a path argument that escapes the workspace root", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["../../etc/passwd"], missionId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("rejects a bare \"..\" argument (no leading path.resolve base to escape into otherwise)", async () => {
    await expect(requestExecution({ tool: "test-tool", arguments: [".."], missionId: "p" })).rejects.toThrow(
      InvalidToolArgumentsError,
    );
  });

  it("rejects a \"~\"-prefixed argument outright rather than resolving it as a literal path", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["~/.ssh/id_rsa"], missionId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  describe("symlink escape", () => {
    const linkPath = path.join(env.workspaceRoot, "toolManager-test-escape-link");

    afterEach(() => {
      try {
        unlinkSync(linkPath);
      } catch {
        // already removed / never created
      }
    });

    it("rejects a path through a symlink planted inside the workspace that points outside it", async () => {
      symlinkSync(path.dirname(env.workspaceRoot), linkPath);

      await expect(
        requestExecution({
          tool: "test-tool",
          arguments: [path.join(linkPath, "some-file")],
          missionId: "p",
        }),
      ).rejects.toThrow(InvalidToolArgumentsError);
    });
  });

  it("rejects an argument that doesn't match allowedArguments", async () => {
    await expect(
      requestExecution({ tool: "restricted-tool", arguments: ["--unsafe"], missionId: "p" }),
    ).rejects.toThrow(InvalidToolArgumentsError);
  });

  it("allows an argument that matches allowedArguments", async () => {
    const record = await requestExecution({ tool: "restricted-tool", arguments: ["--safe"], missionId: "p" });
    expect(record.status).toBe("pending_confirmation");
  });

  it("rejects a tool whose executable can't be resolved", async () => {
    await expect(
      requestExecution({ tool: "unresolvable-tool", arguments: [], missionId: "p" }),
    ).rejects.toThrow(ExecutableUnavailableError);
  });

  it("rejects a command that invokes sudo, since tools run non-interactively with no TTY", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["-c", "sudo pacman -S katana"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });

  it("rejects a command that invokes su/doas/pkexec", async () => {
    await expect(requestExecution({ tool: "test-tool", arguments: ["su", "-c", "whoami"], missionId: "p" })).rejects.toThrow(
      PrivilegedCommandError,
    );
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["doas pacman -S katana"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });

  it("does not false-positive on words that merely contain 'su'", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["supervisorctl status"],
      missionId: "p",
    });
    expect(record.status).toBe("pending_confirmation");
  });

  it("rejects case-variant spellings of the escalation verbs (Sudo/SUDO/PkExec)", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["Sudo", "pacman", "-S", "katana"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["bash", "-c", "SUDO whoami"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["PkExec", "-h"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });

  it("rejects an env-wrapped escalation, but allows a plain env VAR=x command", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["env", "PATH=/tmp/evil", "sudo", "whoami"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["env", "LANG=C", "nmap", "-h"],
      missionId: "p",
    });
    expect(record.status).toBe("pending_confirmation");
  });

  it("rejects setsid, since its child would escape process-group cancellation (A4)", async () => {
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["setsid", "sudo", "whoami"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["setsid", "nc", "-lvp", "4444"], missionId: "p" }),
    ).rejects.toThrow(PrivilegedCommandError);
  });
});

describe("resolvedCommand stdin visibility", () => {
  it("appends a byte-count annotation when stdin is supplied, without leaking the content itself", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["notes.txt"],
      missionId: "p",
      stdin: "hello world",
    });
    expect(record.resolvedCommand).toMatch(/\(stdin: 11 bytes\)$/);
    expect(record.resolvedCommand).not.toContain("hello world");
  });

  it("uses the real UTF-8 byte length, not the JS string length", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["notes.txt"],
      missionId: "p",
      stdin: "héllo", // 5 JS chars, 6 UTF-8 bytes (é is 2 bytes)
    });
    expect(record.resolvedCommand).toMatch(/\(stdin: 6 bytes\)$/);
  });

  it("adds no annotation at all when no stdin is supplied", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: ["notes.txt"], missionId: "p" });
    expect(record.resolvedCommand).not.toContain("stdin");
  });
});

describe("confirm / reject / cancel lifecycle", () => {
  it("parks a confirmation-required request as pending_confirmation without running it", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('hi')"],
      missionId: "proj-park",
    });

    expect(record.status).toBe("pending_confirmation");
    expect(record.result).toBeUndefined();
    expect(record.cwd).toBe(env.workspaceRoot);
  });

  it("carries an agent-driven request's agentId onto the resulting record, undefined for a manual one", async () => {
    const agentDriven = await requestExecution({
      tool: "test-tool",
      arguments: [],
      missionId: "proj-agent",
      agentId: "recon-agent",
    });
    expect(agentDriven.agentId).toBe("recon-agent");

    const manual = await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-agent" });
    expect(manual.agentId).toBeUndefined();
  });

  it("actually runs the tool on confirmExecution and captures real output", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('confirmed-output')"],
      missionId: "proj-confirm",
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
      missionId: "proj-double-confirm",
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
    const record = await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-reject" });

    const rejected = rejectExecution(record.id);
    expect(rejected.status).toBe("rejected");
    expect(() => rejectExecution(record.id)).toThrow(InvalidToolArgumentsError);
  });

  it("refuses to cancel an execution that isn't currently running", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-cancel-idle" });
    expect(() => cancelExecution(record.id)).toThrow(InvalidToolArgumentsError);
  });

  it("cancels a running execution", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["setTimeout(() => {}, 5000)"],
      missionId: "proj-cancel-running",
    });

    const runPromise = confirmExecution(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelExecution(record.id);

    const finished = await runPromise;
    expect(finished.status).toBe("cancelled");
    expect(finished.result?.cancelled).toBe(true);
  });
});

describe("global execution concurrency cap", () => {
  it("rejects confirming beyond the cap without consuming the execution, then allows it once a slot frees", async () => {
    const records = await Promise.all(
      Array.from({ length: env.maxConcurrentExecutions }, () =>
        requestExecution({
          tool: "test-tool",
          arguments: ["setTimeout(() => {}, 5000)"],
          missionId: "proj-concurrency-cap",
        }),
      ),
    );
    const runPromises = records.map((r) => confirmExecution(r.id));
    await new Promise((resolve) => setTimeout(resolve, 100)); // let every slot actually spawn

    const overCap = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('finally-ran')"],
      missionId: "proj-concurrency-cap",
    });
    await expect(confirmExecution(overCap.id)).rejects.toThrow(TooManyConcurrentExecutionsError);
    // Rejected before spending anything - still parked exactly as before, retryable.
    expect(overCap.status).toBe("pending_confirmation");

    records.forEach((r) => cancelExecution(r.id));
    await Promise.all(runPromises);

    const finished = await confirmExecution(overCap.id);
    expect(finished.status).toBe("completed");
    expect(finished.result?.stdout).toBe("finally-ran");
  });
});

describe("mission deletion purges executions (ghost-record regression coverage)", () => {
  it("removes a deleted mission's executions from listExecutions", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-purge-a" });
    expect(listExecutions("proj-purge-a")).toContainEqual(expect.objectContaining({ id: record.id }));

    purgeMission("proj-purge-a");

    expect(listExecutions("proj-purge-a")).toEqual([]);
    expect(getExecution(record.id)).toBeUndefined();
  });

  it("does not touch another mission's executions", async () => {
    const untouched = await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-purge-untouched" });
    await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-purge-b" });

    purgeMission("proj-purge-b");

    expect(getExecution(untouched.id)).toBeDefined();
    expect(listExecutions("proj-purge-untouched")).toHaveLength(1);
  });

  it("aborts a still-running execution for the deleted mission instead of leaving it running", async () => {
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["setTimeout(() => {}, 5000)"],
      missionId: "proj-purge-running",
    });
    const runPromise = confirmExecution(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100)); // let it actually spawn

    purgeMission("proj-purge-running");

    const finished = await runPromise;
    expect(finished.status).toBe("cancelled");
    expect(finished.result?.cancelled).toBe(true);
    // Purged from the Map entirely, not just left there marked cancelled.
    expect(getExecution(record.id)).toBeUndefined();
  });

  it("frees the concurrency slot a purged running execution held", async () => {
    const running = await requestExecution({
      tool: "test-tool",
      arguments: ["setTimeout(() => {}, 5000)"],
      missionId: "proj-purge-slot",
    });
    const runPromise = confirmExecution(running.id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    purgeMission("proj-purge-slot");
    await runPromise;

    // With the purged execution's controller cleaned up, a fresh batch up to the cap must not
    // immediately hit TooManyConcurrentExecutionsError because of a leaked slot.
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('ok')"],
      missionId: "proj-purge-slot-2",
    });
    const finished = await confirmExecution(record.id);
    expect(finished.status).toBe("completed");
  });
});

describe("listExecutions", () => {
  it("only returns executions for the requested mission", async () => {
    await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-a" });
    await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-a" });
    await requestExecution({ tool: "test-tool", arguments: [], missionId: "proj-b" });

    expect(listExecutions("proj-a")).toHaveLength(2);
    expect(listExecutions("proj-b")).toHaveLength(1);
    expect(listExecutions("proj-a").every((r) => r.missionId === "proj-a")).toBe(true);
  });
});

describe("mission scope enforcement", () => {
  function fixtureMission(overrides: Partial<Mission> = {}): Mission {
    return { id: "proj-scope", name: "Scoped Mission", notes: "", createdAt: 0, ...overrides };
  }

  it("allows a request when the mission has no scope configured", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission());
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["evil.com"],
      missionId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toBeUndefined();
  });

  it("allows a request whose extracted target is in scope", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ scope: ["example.com"] }));
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["curl", "https://example.com"],
      missionId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toBeUndefined();
  });

  it("blocks a request whose extracted target is outside scope", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ scope: ["example.com"] }));
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["curl", "https://evil.com"], missionId: "proj-scope" }),
    ).rejects.toThrow(OutOfScopeError);

    const events = listActivity("proj-scope");
    expect(events.some((e) => e.type === "scope_blocked" && (e.meta?.offending as string[])?.includes("evil.com"))).toBe(true);
  });

  it("blocks a request whose target is explicitly out of scope even without a scope allowlist", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ outOfScope: ["evil.com"] }));
    await expect(
      requestExecution({ tool: "test-tool", arguments: ["evil.com"], missionId: "proj-scope" }),
    ).rejects.toThrow(OutOfScopeError);
  });

  it("attaches a scopeWarning (but still parks it) when no target can be found and only outOfScope is configured", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ outOfScope: ["evil.com"] }));
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdout.write('x')"],
      missionId: "proj-scope",
    });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toMatch(/could not identify a target/i);
  });

  it("blocks a request when a strict scope allowlist is configured and no target can be found", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ scope: ["example.com"] }));
    await expect(
      requestExecution({
        tool: "test-tool",
        arguments: ["process.stdout.write('x')"],
        missionId: "proj-scope",
      }),
    ).rejects.toThrow(OutOfScopeError);
  });

  it("does not fail the request when the mission lookup itself throws, but attaches a warning", async () => {
    mockGetMission.mockRejectedValueOnce(new Error("disk error"));
    const record = await requestExecution({ tool: "test-tool", arguments: ["evil.com"], missionId: "proj-scope" });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toMatch(/could not be checked/i);
  });

  it("attaches a warning instead of silently skipping the check when the mission doesn't exist", async () => {
    mockGetMission.mockResolvedValueOnce(undefined);
    const record = await requestExecution({ tool: "test-tool", arguments: ["evil.com"], missionId: "proj-scope" });
    expect(record.status).toBe("pending_confirmation");
    expect(record.scopeWarning).toMatch(/could not be checked/i);
  });

  it("re-checks scope at confirm time and blocks if it's now out of scope", async () => {
    mockGetMission.mockResolvedValueOnce(fixtureMission({ scope: ["example.com"] }));
    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["curl", "https://example.com"],
      missionId: "proj-scope",
    });
    expect(record.scopeWarning).toBeUndefined();

    // The mission's scope was tightened between request and confirm.
    mockGetMission.mockResolvedValueOnce(fixtureMission({ scope: ["other.com"] }));
    await expect(confirmExecution(record.id)).rejects.toThrow(OutOfScopeError);
  });
});

describe("getExecTool", () => {
  it("returns a registered tool by id, undefined otherwise", () => {
    expect(getExecTool("test-tool")?.name).toBe("Test Tool");
    expect(getExecTool("nope")).toBeUndefined();
  });
});

describe("listExecToolsWithStatus caching", () => {
  it("returns the cached list on a second call within the TTL window (no re-probe)", () => {
    const first = listExecToolsWithStatus();
    expect(listExecToolsWithStatus()).toBe(first);
  });

  it("recomputes after a tool is registered, reflecting the new tool immediately", () => {
    registerExecTool({ ...baseTool, id: "fresh-cached-tool" });
    expect(listExecToolsWithStatus().some((t) => t.id === "fresh-cached-tool")).toBe(true);
  });

  it("recomputes after setToolEnabled, reflecting the toggle immediately instead of serving a stale value", async () => {
    registerExecTool({ ...baseTool, id: "toggle-cached-tool" });
    await setToolEnabled("toggle-cached-tool", false);
    expect(listExecToolsWithStatus().find((t) => t.id === "toggle-cached-tool")?.enabled).toBe(false);
    await setToolEnabled("toggle-cached-tool", true);
    expect(listExecToolsWithStatus().find((t) => t.id === "toggle-cached-tool")?.enabled).toBe(true);
  });

  it("loadToolOverridesFromDisk invalidates the cache too", async () => {
    registerExecTool({ ...baseTool, id: "override-cached-tool" });
    await setToolEnabled("override-cached-tool", false);
    registerExecTool({ ...baseTool, id: "override-cached-tool" }); // fresh builtin, enabled=true again

    await loadToolOverridesFromDisk();
    expect(listExecToolsWithStatus().find((t) => t.id === "override-cached-tool")?.enabled).toBe(false);
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
    await expect(requestExecution({ tool: "toggle-tool", arguments: [], missionId: "p" })).rejects.toThrow(
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

describe("confirmation races", () => {
  it("runs the tool once when confirm is sent twice", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: ["process.stdout.write('once')"], missionId: "proj-double" });

    const results = await Promise.allSettled([confirmExecution(record.id), confirmExecution(record.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(getExecution(record.id)?.result?.stdout).toBe("once");
  });

  it("doesn't run a tool rejected while its confirm is still awaiting", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: ["process.stdout.write('ran')"], missionId: "proj-race" });

    const confirming = confirmExecution(record.id).catch(() => undefined);
    rejectExecution(record.id);
    await confirming;

    expect(getExecution(record.id)?.status).toBe("rejected");
    expect(getExecution(record.id)?.result).toBeUndefined();
  });
});

describe("stdin across a concurrency-cap refusal", () => {
  it("still has its stdin when the refused confirm is retried", async () => {
    const blockers = await Promise.all(
      Array.from({ length: env.maxConcurrentExecutions }, () =>
        requestExecution({ tool: "test-tool", arguments: ["setTimeout(() => {}, 5000)"], missionId: "proj-stdin-cap" }),
      ),
    );
    const running = blockers.map((r) => confirmExecution(r.id));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const record = await requestExecution({
      tool: "test-tool",
      arguments: ["process.stdin.pipe(process.stdout)"],
      missionId: "proj-stdin-cap",
      stdin: "keep me",
    });
    await expect(confirmExecution(record.id)).rejects.toThrow(TooManyConcurrentExecutionsError);

    blockers.forEach((r) => cancelExecution(r.id));
    await Promise.all(running);

    const finished = await confirmExecution(record.id);
    expect(finished.result?.stdout).toBe("keep me");
  });
});

describe("local-only tools and scope", () => {
  it("doesn't scope-check a filesystem tool's path as if it were a network target", async () => {
    registerExecTool({ ...baseTool, id: "read_file" });
    mockGetMission.mockResolvedValueOnce({ id: "proj-local", name: "m", notes: "", createdAt: 0, scope: ["example.com"] });
    const record = await requestExecution({ tool: "read_file", arguments: ["notes.io"], missionId: "proj-local" });
    expect(record.status).toBe("pending_confirmation");
  });
});

describe("privileged command matching", () => {
  it("doesn't mistake a hostname containing a privileged verb for that verb", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: ["curl", "https://su.example.com"], missionId: "proj-su" });
    expect(record.status).toBe("pending_confirmation");
  });

  it("still blocks the bare verb", async () => {
    await expect(requestExecution({ tool: "test-tool", arguments: ["su", "root"], missionId: "proj-su" })).rejects.toThrow(
      PrivilegedCommandError,
    );
  });
});

describe("abortAllExecutions", () => {
  it("stops every running tool", async () => {
    const record = await requestExecution({ tool: "test-tool", arguments: ["setTimeout(() => {}, 5000)"], missionId: "proj-abort-all" });
    const running = confirmExecution(record.id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    abortAllExecutions();

    expect((await running).status).toBe("cancelled");
  });
});

describe("loadExecutionsFromDisk recovery", () => {
  function onDisk(id: string, status: string, resolvedCommand = "tool") {
    return { id, missionId: "proj-hydrate", toolId: "test-tool", status, resolvedCommand, arguments: [], createdAt: 0 };
  }

  it("fails what can't survive a restart and leaves the rest alone", async () => {
    vi.mocked(listMissionIds).mockResolvedValueOnce(["proj-hydrate"]);
    vi.mocked(readMissionJson).mockResolvedValueOnce([
      onDisk("hyd-running", "running"),
      onDisk("hyd-stdin", "pending_confirmation", "tee x (stdin: 11 bytes)"),
      onDisk("hyd-pending", "pending_confirmation"),
    ]);

    await loadExecutionsFromDisk();

    expect(getExecution("hyd-running")?.status).toBe("failed");
    expect(getExecution("hyd-stdin")?.status).toBe("failed");
    expect(getExecution("hyd-pending")?.status).toBe("pending_confirmation");
  });
});

describe("MCP tool executions", () => {
  const mcpTool = (overrides: Partial<McpTool> = {}): McpTool => ({
    id: "tools.nmap",
    serverId: "tools",
    toolName: "nmap",
    description: "Network scanner on the scanning host.",
    enabled: true,
    ...overrides,
  });

  const callOk = { success: true, stdout: "22/tcp open ssh", stderr: "", exitCode: 0, timedOut: false, truncated: false };

  afterEach(() => {
    mockGetMcpTool.mockReturnValue(undefined);
    mockCallMcpTool.mockReset();
  });

  it("parks an enabled MCP tool as pending confirmation with an mcp marker - nothing runs yet", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    mockGetMission.mockResolvedValueOnce({ id: "proj-mcp", name: "M", notes: "", createdAt: 0 });

    const record = await requestExecution({ tool: "tools.nmap", arguments: ["127.0.0.2"], missionId: "proj-mcp" });

    expect(record.status).toBe("pending_confirmation");
    expect(record.mcp).toEqual({ serverId: "tools", toolName: "nmap" });
    expect(record.toolId).toBe("tools.nmap");
    expect(record.resolvedCommand).toBe("[mcp:tools] nmap 127.0.0.2");
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it("refuses a disabled MCP tool", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool({ enabled: false }));
    await expect(
      requestExecution({ tool: "tools.nmap", arguments: ["127.0.0.2"], missionId: "proj-mcp" }),
    ).rejects.toThrow(ExecToolDisabledError);
  });

  it("runs the tool on the server at confirm time and records the raw result", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    mockGetMission.mockResolvedValue({ id: "proj-mcp", name: "M", notes: "", createdAt: 0 });
    mockCallMcpTool.mockResolvedValue(callOk);

    const pending = await requestExecution({ tool: "tools.nmap", arguments: ["127.0.0.2"], missionId: "proj-mcp" });
    const done = await confirmExecution(pending.id);

    expect(mockCallMcpTool).toHaveBeenCalledWith("tools", "nmap", ["127.0.0.2"], expect.any(AbortSignal));
    expect(done.status).toBe("completed");
    expect(done.result?.stdout).toBe("22/tcp open ssh");
    expect(done.result?.success).toBe(true);
  });

  it("settles as failed when the server call throws", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    mockGetMission.mockResolvedValue({ id: "proj-mcp", name: "M", notes: "", createdAt: 0 });
    mockCallMcpTool.mockRejectedValue(new Error("Can't reach the scanning host (ECONNREFUSED)"));

    const pending = await requestExecution({ tool: "tools.nmap", arguments: ["127.0.0.2"], missionId: "proj-mcp" });
    const done = await confirmExecution(pending.id);

    expect(done.status).toBe("failed");
    expect(done.result?.stderr).toContain("ECONNREFUSED");
  });

  it("enforces mission scope on an MCP tool - an out-of-scope target blocks the request", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    mockGetMission.mockResolvedValueOnce({ id: "proj-mcp", name: "M", notes: "", createdAt: 0, scope: ["example.com"] });

    await expect(
      requestExecution({ tool: "tools.nmap", arguments: ["https://evil.com"], missionId: "proj-mcp" }),
    ).rejects.toThrow(OutOfScopeError);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });

  it("blocks an MCP tool with no identifiable target under a strict scope allowlist (never local-only)", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    mockGetMission.mockResolvedValueOnce({ id: "proj-mcp", name: "M", notes: "", createdAt: 0, scope: ["example.com"] });

    await expect(
      requestExecution({ tool: "tools.nmap", arguments: ["--version"], missionId: "proj-mcp" }),
    ).rejects.toThrow(OutOfScopeError);
  });

  it("re-checks scope at confirm time - a now-out-of-scope target throws instead of calling the server", async () => {
    mockGetMcpTool.mockReturnValue(mcpTool());
    // In scope at request time, then the mission's scope changes before confirm.
    mockGetMission.mockResolvedValueOnce({ id: "proj-mcp", name: "M", notes: "", createdAt: 0, scope: ["127.0.0.2"] });
    const pending = await requestExecution({ tool: "tools.nmap", arguments: ["127.0.0.2"], missionId: "proj-mcp" });

    mockGetMission.mockResolvedValueOnce({ id: "proj-mcp", name: "M", notes: "", createdAt: 0, scope: ["example.com"] });
    await expect(confirmExecution(pending.id)).rejects.toThrow(OutOfScopeError);
    expect(mockCallMcpTool).not.toHaveBeenCalled();
  });
});
