import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useActivity } from "./useActivity";
import { fetchActivity } from "../services/activityApi";
import type { MissionEvent } from "../types/missionEvent";

vi.mock("../services/activityApi", () => ({ fetchActivity: vi.fn() }));

const mockFetchActivity = vi.mocked(fetchActivity);

const fixtureEvent: MissionEvent = {
  id: "event-1",
  missionId: "proj-1",
  type: "mission_created",
  summary: "Mission created",
  createdAt: 0,
};

describe("useActivity", () => {
  it("does not fetch and starts empty when missionId is null", async () => {
    const { result } = renderHook(() => useActivity(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.events).toEqual([]);
    expect(mockFetchActivity).not.toHaveBeenCalled();
  });

  it("fetches activity for a missionId", async () => {
    mockFetchActivity.mockResolvedValue([fixtureEvent]);

    const { result } = renderHook(() => useActivity("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchActivity).toHaveBeenCalledWith("proj-1");
    expect(result.current.events).toEqual([fixtureEvent]);
  });

  it("surfaces a load failure", async () => {
    mockFetchActivity.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useActivity("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
  });

  it("re-fetches when missionId changes", async () => {
    mockFetchActivity.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ missionId }) => useActivity(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchActivity).toHaveBeenLastCalledWith("proj-2"));
  });

  it("ignores a stale previous-mission response that resolves after a mission switch", async () => {
    let resolveOld!: (events: MissionEvent[]) => void;
    mockFetchActivity.mockImplementation((id: string) =>
      id === "proj-1" ? new Promise<MissionEvent[]>((r) => { resolveOld = r; }) : Promise.resolve([]),
    );

    const { result, rerender } = renderHook(({ missionId }) => useActivity(missionId), {
      initialProps: { missionId: "proj-1" as string | null },
    });
    await waitFor(() => expect(mockFetchActivity).toHaveBeenCalledWith("proj-1"));

    rerender({ missionId: "proj-2" });
    await waitFor(() => expect(mockFetchActivity).toHaveBeenLastCalledWith("proj-2"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      resolveOld([{ ...fixtureEvent, id: "stale-event" }]);
    });

    expect(result.current.events).toEqual([]);
  });
});
