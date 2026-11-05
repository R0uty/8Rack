import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useWorkOrders } from "./useWorkOrders";
import { cancelWorkOrder, createWorkOrder, fetchWorkOrders, refreshWorkOrder, startWorkOrder } from "../services/workOrdersApi";
import type { WorkOrder } from "../types/workOrder";

vi.mock("../services/workOrdersApi", () => ({
  fetchWorkOrders: vi.fn(),
  createWorkOrder: vi.fn(),
  startWorkOrder: vi.fn(),
  cancelWorkOrder: vi.fn(),
  refreshWorkOrder: vi.fn(),
}));

const mockFetchWorkOrders = vi.mocked(fetchWorkOrders);
const mockCreateWorkOrder = vi.mocked(createWorkOrder);
const mockStartWorkOrder = vi.mocked(startWorkOrder);
const mockCancelWorkOrder = vi.mocked(cancelWorkOrder);
const mockRefreshWorkOrder = vi.mocked(refreshWorkOrder);

function fixtureWorkOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo-1",
    missionId: "m1",
    agentId: "recon-agent",
    objective: "Recon",
    status: "pending",
    priority: 1,
    dependencies: [],
    createdAt: 0,
    relatedAssets: [],
    relatedFindings: [],
    ...overrides,
  };
}

describe("useWorkOrders", () => {
  it("skips fetching and stays empty when missionId is null", async () => {
    const { result } = renderHook(() => useWorkOrders(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.workOrders).toEqual([]);
    expect(mockFetchWorkOrders).not.toHaveBeenCalled();
  });

  it("loads work orders scoped to a missionId", async () => {
    mockFetchWorkOrders.mockResolvedValue([fixtureWorkOrder()]);
    const { result } = renderHook(() => useWorkOrders("m1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchWorkOrders).toHaveBeenCalledWith("m1");
    expect(result.current.workOrders).toEqual([fixtureWorkOrder()]);
  });

  it("create/start/cancel each call their API then refresh", async () => {
    mockFetchWorkOrders.mockResolvedValue([]);
    mockCreateWorkOrder.mockResolvedValue(fixtureWorkOrder());
    mockStartWorkOrder.mockResolvedValue(fixtureWorkOrder({ status: "running" }));
    mockCancelWorkOrder.mockResolvedValue(fixtureWorkOrder({ status: "cancelled" }));
    const { result } = renderHook(() => useWorkOrders("m1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.create({ agentId: "recon-agent", objective: "Recon" });
    });
    expect(mockCreateWorkOrder).toHaveBeenCalledWith("m1", { agentId: "recon-agent", objective: "Recon" });

    await act(async () => {
      await result.current.start("wo-1");
    });
    expect(mockStartWorkOrder).toHaveBeenCalledWith("m1", "wo-1");

    await act(async () => {
      await result.current.cancel("wo-1");
    });
    expect(mockCancelWorkOrder).toHaveBeenCalledWith("m1", "wo-1");

    expect(mockFetchWorkOrders).toHaveBeenCalledTimes(4);
  });

  it("rejects create/start/cancel when no mission is selected", async () => {
    const { result } = renderHook(() => useWorkOrders(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.create({ agentId: "a", objective: "o" })).rejects.toThrow("No mission selected");
  });

  it("refreshOne re-syncs a single work order in place, without refetching the whole list", async () => {
    mockFetchWorkOrders.mockResolvedValue([fixtureWorkOrder({ id: "wo-1", status: "waiting_approval" })]);
    mockRefreshWorkOrder.mockResolvedValue(fixtureWorkOrder({ id: "wo-1", status: "failed" }));
    const { result } = renderHook(() => useWorkOrders("m1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refreshOne("wo-1");
    });

    expect(mockRefreshWorkOrder).toHaveBeenCalledWith("m1", "wo-1");
    expect(result.current.workOrders).toEqual([fixtureWorkOrder({ id: "wo-1", status: "failed" })]);
    expect(mockFetchWorkOrders).toHaveBeenCalledTimes(1);
  });

  it("rejects refreshOne when no mission is selected", async () => {
    const { result } = renderHook(() => useWorkOrders(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.refreshOne("wo-1")).rejects.toThrow("No mission selected");
  });

  it("ignores a slow response for the previous mission after switching", async () => {
    let resolveA: (orders: WorkOrder[]) => void = () => {};
    mockFetchWorkOrders.mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)));
    const { result, rerender } = renderHook(({ id }) => useWorkOrders(id), { initialProps: { id: "m-a" } });

    mockFetchWorkOrders.mockResolvedValueOnce([fixtureWorkOrder({ id: "from-b", missionId: "m-b" })]);
    rerender({ id: "m-b" });
    await waitFor(() => expect(result.current.workOrders.map((w) => w.id)).toEqual(["from-b"]));

    await act(async () => resolveA([fixtureWorkOrder({ id: "from-a", missionId: "m-a" })]));

    expect(result.current.workOrders.map((w) => w.id)).toEqual(["from-b"]);
  });
});
