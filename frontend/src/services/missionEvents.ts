import type { MissionRunState, MissionStreamEvent } from "../types/missionRun";

/**
 * The browser side of GET /api/missions/:id/events. App.tsx opens one stream for the selected
 * mission (useMissionEventStream) and feeds every line through `dispatchMissionEvent`; hooks listen
 * here instead of each opening its own connection. Also keeps what a view mounted later still needs:
 * the last run state, the current work order's model output, and live tool output.
 */
export interface MissionLiveState {
  run: MissionRunState | null;
  /** Model output of the order named by `outputWorkOrderId`, tail only. */
  output: string;
  outputWorkOrderId?: string;
  /** Live stdout+stderr per running execution, tail only. */
  executionOutput: Record<string, string>;
}

type Listener = (missionId: string, event: MissionStreamEvent) => void;

/** Enough to read what an agent or a tool is doing now, without growing without bound. */
export const LIVE_OUTPUT_LIMIT = 20_000;

const EMPTY: MissionLiveState = { run: null, output: "", executionOutput: {} };

const listeners = new Set<Listener>();
const live = new Map<string, MissionLiveState>();
const liveListeners = new Set<() => void>();

function tail(text: string): string {
  return text.length > LIVE_OUTPUT_LIMIT ? text.slice(text.length - LIVE_OUTPUT_LIMIT) : text;
}

function updateLive(missionId: string, update: (prev: MissionLiveState) => MissionLiveState) {
  live.set(missionId, update(live.get(missionId) ?? EMPTY));
  for (const l of liveListeners) l();
}

export function dispatchMissionEvent(missionId: string, event: MissionStreamEvent): void {
  if (event.type === "run_state") {
    updateLive(missionId, (prev) => {
      // A new run starts with a clean output pane.
      const restarted = event.run.status === "running" && prev.run?.status !== "running";
      return { ...prev, run: event.run, ...(restarted ? { output: "", outputWorkOrderId: undefined } : {}) };
    });
  } else if (event.type === "chunk") {
    updateLive(missionId, (prev) =>
      prev.outputWorkOrderId === event.workOrderId
        ? { ...prev, output: tail(prev.output + event.content) }
        : { ...prev, output: tail(event.content), outputWorkOrderId: event.workOrderId },
    );
  } else if (event.type === "execution_output") {
    updateLive(missionId, (prev) => ({
      ...prev,
      executionOutput: {
        ...prev.executionOutput,
        [event.executionId]: tail((prev.executionOutput[event.executionId] ?? "") + event.data),
      },
    }));
  }
  for (const l of [...listeners]) l(missionId, event);
}

export function subscribeMissionEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMissionLive(missionId: string | null): MissionLiveState {
  return (missionId && live.get(missionId)) || EMPTY;
}

export function subscribeMissionLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

/** For tests. */
export function resetMissionEventsForTests(): void {
  listeners.clear();
  live.clear();
  liveListeners.clear();
}
