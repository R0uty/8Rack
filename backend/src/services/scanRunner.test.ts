import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerScanProfile } from "../extensions/scannerRegistry.js";
import { registerExecTool } from "./toolManager.js";
import { cancelScanRun, createScanRun, getScan, listScans, loadScansFromDisk, previewScan } from "./scanRunner.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
import {
  InvalidScanStateError,
  InvalidScanTargetError,
  ScanProfileNotFoundError,
  ScanRunNotFoundError,
  ScanTargetRequiredError,
} from "./errors.js";
import type { ExecTool } from "../types/execTool.js";
import type { ScanEvent } from "./scanRunner.js";

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));

const echoTool: ExecTool = {
  id: "scan-echo-tool",
  name: "Scan Echo Tool",
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

const failTool: ExecTool = { ...echoTool, id: "scan-fail-tool" };
const slowTool: ExecTool = { ...echoTool, id: "scan-slow-tool" };

beforeAll(() => {
  registerExecTool(echoTool);
  registerExecTool(failTool);
  registerExecTool(slowTool);

  registerScanProfile({
    id: "test-profile",
    name: "Test Profile",
    description: "A two-step test profile.",
    icon: "🧪",
    steps: [
      { toolId: echoTool.id, arguments: ["process.stdout.write('scanning {target}')"] },
      { toolId: echoTool.id, arguments: ["process.stdout.write('step two on {target}')"], label: "Step Two" },
    ],
  });

  registerScanProfile({
    id: "partial-fail-profile",
    name: "Partial Fail Profile",
    description: "First step fails, second still runs.",
    icon: "🧪",
    steps: [
      { toolId: failTool.id, arguments: ["process.exit(1)"] },
      { toolId: echoTool.id, arguments: ["process.stdout.write('still ran')"] },
    ],
  });

  registerScanProfile({
    id: "slow-profile",
    name: "Slow Profile",
    description: "A long-running first step, cancellable.",
    icon: "🧪",
    steps: [
      { toolId: slowTool.id, arguments: ["setTimeout(() => {}, 5000)"] },
      { toolId: echoTool.id, arguments: ["process.stdout.write('never reached')"] },
    ],
  });
});

describe("previewScan", () => {
  it("resolves each step's command with {target} substituted, without running anything", () => {
    const preview = previewScan("test-profile", "example.com");
    expect(preview.target).toBe("example.com");
    expect(preview.steps).toHaveLength(2);
    expect(preview.steps[0].resolvedCommand).toContain("scanning example.com");
    expect(preview.steps[1].label).toBe("Step Two");
    expect(preview.steps.every((s) => s.available)).toBe(true);
  });

  it("throws for an unknown profile", () => {
    expect(() => previewScan("nope", "example.com")).toThrow(ScanProfileNotFoundError);
  });

  it("throws for a blank target", () => {
    expect(() => previewScan("test-profile", "   ")).toThrow(ScanTargetRequiredError);
  });

  it("throws for a target that looks like a flag", () => {
    expect(() => previewScan("test-profile", "-oG=/tmp/x")).toThrow(InvalidScanTargetError);
    expect(() => previewScan("test-profile", "--evil")).toThrow(InvalidScanTargetError);
  });
});

describe("createScanRun", () => {
  it("runs every step sequentially and auto-confirms without a per-step approval", async () => {
    const events: ScanEvent[] = [];
    const run = await createScanRun("proj-scan-a", "test-profile", "example.com", (e) => events.push(e));

    expect(run.status).toBe("completed");
    expect(run.steps.map((s) => s.status)).toEqual(["completed", "completed"]);
    expect(run.steps[0].executionId).toBeDefined();

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes[0]).toBe("scan");
    expect(eventTypes.at(-1)).toBe("scan");
    expect(eventTypes.filter((t) => t === "step")).toHaveLength(4); // running + completed, x2 steps
  });

  it("lets a later step run even after an earlier one fails", async () => {
    const run = await createScanRun("proj-scan-b", "partial-fail-profile", "example.com");
    expect(run.status).toBe("completed");
    expect(run.steps[0].status).toBe("failed");
    expect(run.steps[0].error).toBeDefined();
    expect(run.steps[1].status).toBe("completed");
  });

  it("throws for an unknown profile without creating a run", async () => {
    await expect(createScanRun("proj-scan-c", "nope", "example.com")).rejects.toThrow(ScanProfileNotFoundError);
  });

  it("throws for a blank target", async () => {
    await expect(createScanRun("proj-scan-d", "test-profile", "  ")).rejects.toThrow(ScanTargetRequiredError);
  });

  it("throws for a target that looks like a flag, without creating a run", async () => {
    await expect(createScanRun("proj-scan-flag", "test-profile", "-oG=/tmp/x")).rejects.toThrow(
      InvalidScanTargetError,
    );
    expect(listScans("proj-scan-flag")).toHaveLength(0);
  });
});

describe("cancelScanRun", () => {
  it("aborts the in-progress step and skips remaining ones", async () => {
    let scanId: string | undefined;
    const runPromise = createScanRun("proj-scan-cancel", "slow-profile", "example.com", (e) => {
      if (e.type === "scan") scanId = e.scan.id;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scanId).toBeDefined();
    cancelScanRun(scanId as string);

    const run = await runPromise;
    expect(run.status).toBe("cancelled");
    expect(run.steps[0].status).toBe("skipped");
    expect(run.steps[1].status).toBe("skipped");
  });

  it("throws cancelling an unknown scan", () => {
    expect(() => cancelScanRun("nope")).toThrow(ScanRunNotFoundError);
  });

  it("throws cancelling a scan that isn't running", async () => {
    const run = await createScanRun("proj-scan-done", "test-profile", "example.com");
    expect(() => cancelScanRun(run.id)).toThrow(InvalidScanStateError);
  });
});

describe("listScans / getScan", () => {
  it("only returns scans for the requested mission, and getScan finds by id across missions", async () => {
    await createScanRun("proj-list-a", "test-profile", "example.com");
    await createScanRun("proj-list-a", "test-profile", "example.com");
    const runB = await createScanRun("proj-list-b", "test-profile", "example.com");

    expect(listScans("proj-list-a")).toHaveLength(2);
    expect(listScans("proj-list-b")).toHaveLength(1);
    expect(getScan(runB.id)?.missionId).toBe("proj-list-b");
    expect(getScan("nope")).toBeUndefined();
  });
});

describe("loadScansFromDisk", () => {
  it("settles a scan left running by a previous process", async () => {
    vi.mocked(listMissionIds).mockResolvedValueOnce(["proj-scan-hydrate"]);
    vi.mocked(readMissionJson).mockResolvedValueOnce([
      {
        id: "scan-hydrate",
        missionId: "proj-scan-hydrate",
        status: "running",
        steps: [
          { toolId: "a", status: "completed" },
          { toolId: "b", status: "running" },
          { toolId: "c", status: "pending" },
        ],
      },
    ]);

    await loadScansFromDisk();

    const run = getScan("scan-hydrate");
    expect(run?.status).toBe("cancelled");
    expect(run?.finishedAt).toBeTruthy();
    expect(run?.steps.map((s) => s.status)).toEqual(["completed", "skipped", "skipped"]);
  });
});
