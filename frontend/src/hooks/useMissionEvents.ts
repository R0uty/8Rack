import { useEffect, useRef, useSyncExternalStore } from "react";
import { streamMissionEvents } from "../services/factoryApi";
import {
  dispatchMissionEvent,
  getMissionLive,
  subscribeMissionEvents,
  subscribeMissionLive,
  type MissionLiveState,
} from "../services/missionEvents";

/** How long to wait before reconnecting a dropped event stream. */
export const RECONNECT_DELAY_MS = 2_000;

/**
 * Keeps one event stream open for the selected mission, reconnecting when it drops (a backend
 * restart, a sleep). Used once, in App.tsx. After a reconnect it tells every hook to re-read
 * everything, since events sent while the stream was down are gone.
 */
export function useMissionEventStream(missionId: string | null): void {
  useEffect(() => {
    if (!missionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedBefore = false;

    const connect = () => {
      void streamMissionEvents(
        missionId,
        (event) => dispatchMissionEvent(missionId, event),
        controller.signal,
        () => {
          if (connectedBefore) dispatchMissionEvent(missionId, { type: "changed", resource: "*" });
          connectedBefore = true;
        },
      )
        .catch(() => {})
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(connect, RECONNECT_DELAY_MS);
        });
    };
    connect();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [missionId]);
}

/**
 * Calls `refresh` whenever the server reports a write to one of `resources` for this mission - how
 * every mission-scoped hook stays current while a run is going, without polling.
 */
export function useRefreshOnChange(missionId: string | null, resources: string[], refresh: () => unknown): void {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const key = resources.join(",");

  useEffect(() => {
    if (!missionId) return;
    const wanted = new Set(key.split(","));
    return subscribeMissionEvents((id, event) => {
      if (id !== missionId || event.type !== "changed") return;
      if (event.resource === "*" || wanted.has(event.resource)) void refreshRef.current();
    });
  }, [missionId, key]);
}

/** The selected mission's run state, current model output and live tool output. */
export function useMissionLive(missionId: string | null): MissionLiveState {
  return useSyncExternalStore(subscribeMissionLive, () => getMissionLive(missionId));
}
