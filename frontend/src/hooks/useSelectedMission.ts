import { useCallback, useState } from "react";
import type { Mission } from "../types/mission";

const STORAGE_KEY = "8rack.selectedMission";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The one mission the whole app is looking at, remembered across reloads. Derived against the live
 * list rather than stored as an object, so a deleted mission falls through to the next one. */
export function useSelectedMission(missions: Mission[]) {
  const [selectedId, setSelectedId] = useState<string | null>(readStored);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private window or blocked storage - the selection just won't survive a reload.
    }
  }, []);

  const mission = missions.find((m) => m.id === selectedId) ?? missions[0] ?? null;
  return { mission, select };
}
