import { randomUUID } from "node:crypto";
import { listMissionIds, readMissionJson, writeMissionJson } from "./missionStore.js";
import { onMissionDeleted } from "./missionManager.js";
import type { MissionEvent, MissionEventType } from "../types/missionEvent.js";

/**
 * The Mission Activity Timeline - an explicit, append-only named-event log distinct from
 * ActivityFeed.tsx's older client-side merge of executions + orchestrator tasks. Every other
 * mission-scoped service calls logActivity() at the exact point its own real action happens
 * (mission created, asset discovered, work order started, finding validated, scope-blocked
 * execution, ...) - this module only stores and lists, it never decides what's worth logging.
 */

const events = new Map<string, MissionEvent>();
const ACTIVITY_FILE = "activity.json";

function missionEvents(missionId: string): MissionEvent[] {
  return [...events.values()].filter((e) => e.missionId === missionId).sort((a, b) => b.createdAt - a.createdAt);
}

async function persistActivity(missionId: string): Promise<void> {
  await writeMissionJson(missionId, ACTIVITY_FILE, missionEvents(missionId));
}

// See missionManager.ts#onMissionDeleted - a deleted mission's activity log must stop returning
// instead of lingering as ghost records, same purge pattern every other mission-scoped store here
// registers.
onMissionDeleted((missionId) => {
  for (const [id, event] of events) {
    if (event.missionId === missionId) events.delete(id);
  }
});

/** Hydrates in-memory activity from disk - called once at server startup, mirrors every other
 * mission-scoped store's own load function. */
export async function loadActivityFromDisk(): Promise<void> {
  const missionIds = await listMissionIds();
  for (const missionId of missionIds) {
    const onDisk = await readMissionJson<MissionEvent>(missionId, ACTIVITY_FILE);
    for (const event of onDisk) events.set(event.id, event);
  }
}

/**
 * Records one activity event. Deliberately never throws - logging activity is a peripheral concern
 * (same tradeoff as findingsManager.ts#mirrorAssetFromFinding), so a failure here (e.g. a disk
 * write error) must never break the real action that triggered it. Callers can `await` it to be
 * sure the write was attempted, or fire-and-forget with `void` - either is safe.
 */
export async function logActivity(
  missionId: string,
  type: MissionEventType,
  summary: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const event: MissionEvent = { id: randomUUID(), missionId, type, summary, createdAt: Date.now(), meta };
    events.set(event.id, event);
    await persistActivity(missionId);
  } catch (err) {
    console.error(`[activityLog] failed to log "${type}" for mission "${missionId}":`, err);
  }
}

export function listActivity(missionId: string): MissionEvent[] {
  return missionEvents(missionId);
}
