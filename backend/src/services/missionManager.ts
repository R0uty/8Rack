import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { listMissionIds, missionDir, writeFileAtomic } from "./missionStore.js";
import { MissionNotFoundError } from "./errors.js";
import { migrateMissionStatus, type Mission } from "../types/mission.js";

const MISSION_FILE = "mission.json";

/**
 * Every mission-scoped in-memory store (toolManager's executions, orchestrator's tasks,
 * findingsManager's findings, scanRunner's scans, reportManager's reports,
 * multiAgentOrchestrator's plans) registers a handler here at module load, called by
 * deleteMission() below to purge that store's entries for the deleted mission - a callback
 * registry rather than this module importing each of those services directly, since they already
 * import getMission/etc. from here and a reverse import would be circular. Fixes "ghost records":
 * without this, a deleted mission's records kept returning from every service's in-memory Map
 * (nothing here ever cleared them), and any of those services writing through afterward would
 * recreate the just-deleted directory via writeMissionJson's `mkdir(recursive)`.
 */
type MissionPurgeHandler = (missionId: string) => void;
const purgeHandlers: MissionPurgeHandler[] = [];

export function onMissionDeleted(handler: MissionPurgeHandler): void {
  purgeHandlers.push(handler);
}

async function readMissionMeta(id: string): Promise<Mission | undefined> {
  // missionDir(id) is resolved outside the try/catch below so an InvalidMissionIdError propagates
  // as a real error instead of looking identical to "no mission.json here yet" - see
  // missionStore.ts#readMissionJson for the same reasoning.
  const dir = missionDir(id);
  let raw: string;
  try {
    raw = await readFile(path.join(dir, MISSION_FILE), "utf-8");
  } catch {
    return undefined;
  }
  try {
    const mission = JSON.parse(raw) as Mission;
    return { ...mission, status: migrateMissionStatus(mission.status) };
  } catch (err) {
    // Same distinction as missionStore.ts#readMissionJson - a mission.json that exists but fails
    // to parse means something went wrong, worth a log even though it still resolves to "not
    // found" from here (a mission with no readable metadata isn't usable either way).
    console.warn(`[missionManager] mission.json for "${id}" contains invalid JSON - treating as not found.`, err);
    return undefined;
  }
}

async function writeMissionMeta(mission: Mission): Promise<void> {
  await mkdir(missionDir(mission.id), { recursive: true });
  await writeFileAtomic(path.join(missionDir(mission.id), MISSION_FILE), JSON.stringify(mission, null, 2));
}

/** No read-through cache (unlike agentManager) - missions are mutated via this API, and the
 * mission count will always be small enough that reading fresh each time is cheap. */
export async function listMissions(): Promise<Mission[]> {
  const ids = await listMissionIds();
  const missions = await Promise.all(ids.map(readMissionMeta));
  return missions.filter((p): p is Mission => !!p).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getMission(id: string): Promise<Mission | undefined> {
  return readMissionMeta(id);
}

/** Mission fields, layered onto the required name/notes at creation time - see types/mission.ts. */
export type MissionFields = Pick<Mission, "description" | "scope" | "outOfScope" | "rules" | "startDate" | "status">;

export async function createMission(name: string, notes: string, fields: Partial<MissionFields> = {}): Promise<Mission> {
  const mission: Mission = { id: randomUUID(), name, notes, createdAt: Date.now(), ...fields };
  await writeMissionMeta(mission);
  return mission;
}

export async function updateMission(
  id: string,
  patch: Partial<Omit<Mission, "id" | "createdAt">>,
): Promise<Mission> {
  const existing = await readMissionMeta(id);
  if (!existing) throw new MissionNotFoundError(id);
  const updated: Mission = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
    ...(patch.outOfScope !== undefined ? { outOfScope: patch.outOfScope } : {}),
    ...(patch.rules !== undefined ? { rules: patch.rules } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
  };
  await writeMissionMeta(updated);
  return updated;
}

export async function deleteMission(id: string): Promise<void> {
  const existing = await readMissionMeta(id);
  if (!existing) throw new MissionNotFoundError(id);
  await rm(missionDir(id), { recursive: true, force: true });
  for (const handler of purgeHandlers) {
    try {
      handler(id);
    } catch (err) {
      // A purge handler failing must never surface as the delete itself having failed - the
      // directory is already gone, which is the part a caller can actually observe/retry on. Worth
      // a loud log since a failed purge is exactly how a "ghost record" would reappear.
      console.error(`[missionManager] a purge handler failed while deleting mission "${id}":`, err);
    }
  }
}
