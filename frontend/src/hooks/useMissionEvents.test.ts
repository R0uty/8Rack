import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMissionEventStream, useMissionLive, useRefreshOnChange } from "./useMissionEvents";
import { dispatchMissionEvent, LIVE_OUTPUT_LIMIT, resetMissionEventsForTests } from "../services/missionEvents";
import { streamMissionEvents } from "../services/factoryApi";

vi.mock("../services/factoryApi", () => ({ streamMissionEvents: vi.fn() }));
const mockStream = vi.mocked(streamMissionEvents);

beforeEach(() => {
  resetMissionEventsForTests();
  vi.clearAllMocks();
});

describe("useRefreshOnChange", () => {
  it("refreshes on a change to its own resources for its own mission, and after a reconnect", () => {
    const refresh = vi.fn();
    renderHook(() => useRefreshOnChange("m1", ["work-orders"], refresh));

    dispatchMissionEvent("m1", { type: "changed", resource: "findings" });
    dispatchMissionEvent("m2", { type: "changed", resource: "work-orders" });
    expect(refresh).not.toHaveBeenCalled();

    dispatchMissionEvent("m1", { type: "changed", resource: "work-orders" });
    dispatchMissionEvent("m1", { type: "changed", resource: "*" });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("useMissionLive", () => {
  it("keeps the run state and one order's output, starting over for the next order", () => {
    const { result } = renderHook(() => useMissionLive("m1"));
    act(() => {
      dispatchMissionEvent("m1", { type: "run_state", run: { missionId: "m1", status: "running", updatedAt: 1 } });
      dispatchMissionEvent("m1", { type: "chunk", workOrderId: "w1", content: "a" });
      dispatchMissionEvent("m1", { type: "chunk", workOrderId: "w1", content: "b" });
    });
    expect(result.current).toMatchObject({ run: { status: "running" }, output: "ab", outputWorkOrderId: "w1" });

    act(() => dispatchMissionEvent("m1", { type: "chunk", workOrderId: "w2", content: "c" }));
    expect(result.current).toMatchObject({ output: "c", outputWorkOrderId: "w2" });
  });

  it("keeps only the tail of a long tool output", () => {
    const { result } = renderHook(() => useMissionLive("m1"));
    act(() => {
      dispatchMissionEvent("m1", { type: "execution_output", executionId: "e1", stream: "stdout", data: "x".repeat(LIVE_OUTPUT_LIMIT) });
      dispatchMissionEvent("m1", { type: "execution_output", executionId: "e1", stream: "stdout", data: "END" });
    });
    expect(result.current.executionOutput.e1).toHaveLength(LIVE_OUTPUT_LIMIT);
    expect(result.current.executionOutput.e1.endsWith("END")).toBe(true);
  });
});

describe("useMissionEventStream", () => {
  it("feeds the stream's events into the store, and stops reading on unmount", async () => {
    let signal: AbortSignal | undefined;
    mockStream.mockImplementation(async (_id, onEvent, s, onOpen) => {
      signal = s;
      onOpen?.();
      onEvent({ type: "run_state", run: { missionId: "m1", status: "blocked", reason: "no scope", updatedAt: 1 } });
      await new Promise((resolve) => s.addEventListener("abort", resolve));
    });

    const live = renderHook(() => useMissionLive("m1"));
    const { unmount } = renderHook(() => useMissionEventStream("m1"));

    await waitFor(() => expect(live.result.current.run?.reason).toBe("no scope"));
    expect(mockStream).toHaveBeenCalledWith("m1", expect.any(Function), expect.any(AbortSignal), expect.any(Function));
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
