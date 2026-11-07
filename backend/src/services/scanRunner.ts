import { randomUUID } from "node:crypto";
import { getScanProfile } from "../extensions/scannerRegistry.js";
import {
  cancelExecution,
  confirmExecution,
  rejectExecution,
  getExecTool,
  listExecToolsWithStatus,
  requestExecution,
} from "./toolManager.js";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { onMissionDeleted } from "./missionManager.js";
import {
  InvalidScanStateError,
  InvalidScanTargetError,
  ScanProfileNotFoundError,
  ScanRunNotFoundError,
  ScanTargetRequiredError,
} from "./errors.js";
import type { OutputChunk } from "./toolExecutor.js";
import type { ScanPreview, ScanProfile, ScanProfileStep, ScanRun, ScanStepRun } from "../types/scanner.js";

const scans = new Map<string, ScanRun>();
const SCANS_FILE = "scans.json";

/** Scan ids currently flagged for cancellation - checked before each step starts so remaining
 * steps are skipped instead of kicked off, same "best effort, no further steps" contract as
 * orchestrator.ts#cancelTask. */
const cancelledScans = new Set<string>();
/** The ExecutionRecord id currently in flight for a running scan, if any - lets cancelScanRun abort
 * the in-progress step's real subprocess, not just stop scheduling future ones. */
const activeExecutionByScan = new Map<string, string>();

function substituteTarget(args: string[], target: string): string[] {
  return args.map((a) => a.replaceAll("{target}", target));
}

function stepLabel(step: ScanProfileStep): string {
  return step.label ?? getExecTool(step.toolId)?.name ?? step.toolId;
}

function missionScans(missionId: string): ScanRun[] {
  return [...scans.values()].filter((s) => s.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistScans(missionId: string): Promise<void> {
  await writeMissionJson(missionId, SCANS_FILE, missionScans(missionId));
}

// See missionManager.ts#onMissionDeleted. The actual running subprocess for an active step is
// already aborted by toolManager.ts's own purge handler (same missionId, independently
// registered) - this just stops the scan record itself from lingering as a ghost.
onMissionDeleted((missionId) => {
  for (const [id, scan] of scans) {
    if (scan.missionId !== missionId) continue;
    cancelledScans.delete(id);
    activeExecutionByScan.delete(id);
    scans.delete(id);
  }
});

/** Hydrates in-memory scan history from disk - called once at server startup so history survives
 * a restart, same pattern as toolManager.ts#loadExecutionsFromDisk / orchestrator.ts#loadTasksFromDisk. */
export async function loadScansFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const records = await readMissionJson<ScanRun>(missionId, SCANS_FILE);
    for (const record of records) scans.set(record.id, recoverInterruptedScan(record));
  }
}

/** The loop driving a "running" scan died with the old process - left as is, it would read as running
 * forever, and cancelling it would only set a flag nothing checks any more. */
function recoverInterruptedScan(run: ScanRun): ScanRun {
  if (run.status !== "running") return run;
  run.status = "cancelled";
  run.finishedAt = Date.now();
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "running") {
      step.status = "skipped";
      step.error = "The backend restarted during this scan.";
    }
  }
  return run;
}

export function listScans(missionId: string): ScanRun[] {
  return missionScans(missionId);
}

export function getScan(id: string): ScanRun | undefined {
  return scans.get(id);
}

function requireProfile(profileId: string): ScanProfile {
  const profile = getScanProfile(profileId);
  if (!profile) throw new ScanProfileNotFoundError(profileId);
  return profile;
}

function requireTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) throw new ScanTargetRequiredError();
  // Every profile step substitutes the target as a bare positional argv element (see
  // substituteTarget below) - spawn is argv-based, not a shell, so this isn't a command-injection
  // vector, but a target starting with "-" could still be parsed as a flag by some tools' own
  // argument parsers rather than the intended target. Cheap to reject outright.
  if (trimmed.startsWith("-")) throw new InvalidScanTargetError(trimmed);
  return trimmed;
}

/** Read-only, side-effect-free resolution of a profile against a target - the "confirm before you
 * run all steps" view. Never touches toolManager's execution pipeline. */
export function previewScan(profileId: string, targetInput: string): ScanPreview {
  const profile = requireProfile(profileId);
  const target = requireTarget(targetInput);
  const toolsWithStatus = listExecToolsWithStatus();

  return {
    profile: { id: profile.id, name: profile.name, description: profile.description, icon: profile.icon },
    target,
    steps: profile.steps.map((step) => {
      const tool = toolsWithStatus.find((t) => t.id === step.toolId);
      const args = substituteTarget(step.arguments, target);
      const resolvedCommand = tool
        ? [tool.executable, ...tool.defaultArguments, ...args].join(" ")
        : `${step.toolId} (unregistered tool)`;
      return {
        toolId: step.toolId,
        label: stepLabel(step),
        arguments: args,
        resolvedCommand,
        available: tool?.availability === "available",
      };
    }),
  };
}

export type ScanEvent =
  | { type: "scan"; scan: ScanRun }
  | { type: "step"; scanId: string; step: ScanStepRun }
  | { type: "output"; scanId: string; toolId: string; stream: "stdout" | "stderr"; data: string };

/**
 * Runs every step of a profile against a target, sequentially, through the existing
 * requestExecution/confirmExecution pipeline - so workspace path containment, executable
 * availability checks, and Execution -> Parser -> Findings ingestion all apply exactly as they do
 * for a manually-run tool. Each step is auto-confirmed the instant it's requested: the
 * human already confirmed the whole chain by starting this scan (see the "Confirm & Run All" UX),
 * unlike the Orchestrator where an LLM picks tools/arguments at runtime and each one needs its own
 * approval. A step that fails doesn't abort the scan - later steps still run, since a real recon
 * pass often has some tools unavailable/erroring while others still add value; only an explicit
 * cancel skips the remaining steps.
 */
export async function createScanRun(
  missionId: string,
  profileId: string,
  targetInput: string,
  onEvent?: (event: ScanEvent) => void,
): Promise<ScanRun> {
  const profile = requireProfile(profileId);
  const target = requireTarget(targetInput);

  const run: ScanRun = {
    id: randomUUID(),
    missionId,
    profileId: profile.id,
    profileName: profile.name,
    target,
    status: "running",
    steps: profile.steps.map((step) => ({
      toolId: step.toolId,
      label: stepLabel(step),
      arguments: substituteTarget(step.arguments, target),
      status: "pending",
    })),
    createdAt: Date.now(),
    startedAt: Date.now(),
  };
  scans.set(run.id, run);
  await persistScans(missionId);
  onEvent?.({ type: "scan", scan: run });

  for (const step of run.steps) {
    if (cancelledScans.has(run.id)) {
      step.status = "skipped";
      onEvent?.({ type: "step", scanId: run.id, step });
      continue;
    }

    step.status = "running";
    step.startedAt = Date.now();
    onEvent?.({ type: "step", scanId: run.id, step });

    try {
      const record = await requestExecution({ missionId, tool: step.toolId, arguments: step.arguments });
      step.resolvedCommand = record.resolvedCommand;

      if (record.status === "pending_confirmation") {
        // A cancel can land while requestExecution is awaiting - this step must not start after it.
        if (cancelledScans.has(run.id)) {
          rejectExecution(record.id);
          step.executionId = record.id;
          step.status = "skipped";
          step.finishedAt = Date.now();
          onEvent?.({ type: "step", scanId: run.id, step });
          continue;
        }
        activeExecutionByScan.set(run.id, record.id);
        let finished;
        try {
          finished = await confirmExecution(record.id, (chunk: OutputChunk) => {
            onEvent?.({ type: "output", scanId: run.id, toolId: step.toolId, stream: chunk.stream, data: chunk.data });
          });
        } catch (err) {
          // Refused before it ran (e.g. the concurrency cap) - a scan has no human to retry it, so
          // don't leave it sitting in the mission's Approval Queue.
          rejectExecution(record.id);
          throw err;
        } finally {
          activeExecutionByScan.delete(run.id);
        }
        step.executionId = finished.id;
        step.status =
          finished.status === "completed" ? "completed" : finished.status === "cancelled" ? "skipped" : "failed";
        if (finished.status === "failed") {
          step.error = `Exited with code ${finished.result?.exitCode ?? "unknown"}`;
        }
      } else {
        // No built-in tool currently skips confirmation, but stay symmetric with toolManager's own
        // requestExecution contract in case that ever changes.
        step.executionId = record.id;
        step.status = record.status === "completed" ? "completed" : "failed";
      }
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : "Step failed";
    }

    step.finishedAt = Date.now();
    onEvent?.({ type: "step", scanId: run.id, step });
    await persistScans(missionId);
  }

  run.status = cancelledScans.has(run.id) ? "cancelled" : "completed";
  run.finishedAt = Date.now();
  cancelledScans.delete(run.id);
  activeExecutionByScan.delete(run.id);
  await persistScans(missionId);
  onEvent?.({ type: "scan", scan: run });
  return run;
}

/** Flags a running scan to stop scheduling further steps and aborts whichever step is currently
 * in flight. */
export function cancelScanRun(id: string): ScanRun {
  const run = scans.get(id);
  if (!run) throw new ScanRunNotFoundError(id);
  if (run.status !== "running") {
    throw new InvalidScanStateError(`Scan "${id}" is not running (status: ${run.status})`);
  }
  cancelledScans.add(id);
  const executionId = activeExecutionByScan.get(id);
  if (executionId) {
    try {
      cancelExecution(executionId);
    } catch {
      // Already finished between the read above and this call - nothing to cancel.
    }
  }
  return run;
}
