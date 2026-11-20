import type { MissionStreamEvent } from "../types/missionRun.js";

/**
 * In-process pub/sub for GET /api/missions/:id/events. Has no imports from other services on
 * purpose: missionStore.ts publishes "changed" from its write chokepoint, and everything else
 * imports missionStore.
 */
type Listener = (event: MissionStreamEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeMission(missionId: string, listener: Listener): () => void {
  let set = listeners.get(missionId);
  if (!set) {
    set = new Set();
    listeners.set(missionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(missionId);
  };
}

export function publishMission(missionId: string, event: MissionStreamEvent): void {
  const set = listeners.get(missionId);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(event);
    } catch (err) {
      console.error("[missionEvents] listener failed:", err);
    }
  }
}

/** How long "changed" events for one resource are gathered into one. A tool run that records
 * hundreds of findings writes findings.json hundreds of times; clients only need to re-read once. */
export const CHANGED_DEBOUNCE_MS = 150;

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();

/** Tells subscribers a mission-scoped file was written. `filename` is the store's file name
 * ("work-orders.json"); the event carries it without the extension. */
export function publishChanged(missionId: string, filename: string): void {
  if (!listeners.has(missionId)) return;
  const resource = filename.replace(/\.json$/, "");
  const key = `${missionId}:${resource}`;
  if (pendingChanges.has(key)) return;
  pendingChanges.set(
    key,
    setTimeout(() => {
      pendingChanges.delete(key);
      publishMission(missionId, { type: "changed", resource });
    }, CHANGED_DEBOUNCE_MS),
  );
}
