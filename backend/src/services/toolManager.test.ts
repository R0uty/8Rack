import { symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import {
  cancelExecution,
  confirmExecution,
  getExecTool,
  getExecution,
  listExecutions,
  loadToolOverridesFromDisk,
  registerExecTool,
  rejectExecution,
  requestExecution,
  setToolEnabled,
} from "./toolManager.js";
import { getMission, onMissionDeleted } from "./missionManager.js";
import { listActivity } from "./activityLog.js";
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
