import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelWorkOrder,
  createWorkOrder,
  dependenciesSatisfied,
  getWorkOrder,
  listWorkOrders,
  loadWorkOrdersFromDisk,
  refreshWorkOrder,
  startWorkOrder,
} from "./workOrderManager.js";
import { cancelTask, createTask, getTask } from "./orchestrator.js";
import { onMissionDeleted } from "./missionManager.js";
import { InvalidWorkOrderStateError, WorkOrderNotFoundError } from "./errors.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
import { listActivity } from "./activityLog.js";
import type { OrchestratorTask } from "./orchestrator.js";
import type { WorkOrder } from "../types/workOrder.js";

vi.mock("./orchestrator.js", () => ({ createTask: vi.fn(), cancelTask: vi.fn(), getTask: vi.fn() }));
const mockCreateTask = vi.mocked(createTask);
const mockCancelTask = vi.mocked(cancelTask);
const mockGetTask = vi.mocked(getTask);

vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));
const mockListMissionIds = vi.mocked(listMissionIds);
const mockReadMissionJson = vi.mocked(readMissionJson);

vi.mock("./missionManager.js", () => ({ onMissionDeleted: vi.fn() }));
const mockOnMissionDeleted = vi.mocked(onMissionDeleted);
const registeredPurgeHandlers = mockOnMissionDeleted.mock.calls.map(([handler]) => handler);
function purgeMission(missionId: string) {
  for (const handler of registeredPurgeHandlers) handler(missionId);
}

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: randomUUID(),
    missionId: "mission-1",
    agentId: "agent-a",
    objective: "do the thing",
    messages: [],
    status: "completed",
    toolExecutionIds: [],
    toolCallCount: 0,
    finalResponse: "done",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createWorkOrder", () => {
  it("creates a pending work order with defaults", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "recon-agent", objective: "enumerate subdomains" });

    expect(wo.id).toBeTruthy();
    expect(wo.missionId).toBe(missionId);
    expect(wo.status).toBe("pending");
    expect(wo.priority).toBe(0);
    expect(wo.dependencies).toEqual([]);
    expect(wo.relatedAssets).toEqual([]);
    expect(wo.relatedFindings).toEqual([]);
    expect(wo.orchestratorTaskId).toBeUndefined();
  });

  it("persists caller-supplied target/priority/dependencies", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, {
      agentId: "recon-agent",
      objective: "scan ports",
      target: "example.com",
      priority: 5,
      dependencies: ["dep-1"],
    });

    expect(wo.target).toBe("example.com");
    expect(wo.priority).toBe(5);
    expect(wo.dependencies).toEqual(["dep-1"]);
  });

  it("logs a work_order_created activity event", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "recon-agent", objective: "enumerate subdomains" });

    const events = listActivity(missionId);
    expect(events.some((e) => e.type === "work_order_created" && e.meta?.workOrderId === wo.id)).toBe(true);
  });
});

describe("dependenciesSatisfied", () => {
  it("is true with no dependencies", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    expect(dependenciesSatisfied(wo)).toBe(true);
  });

  it("is false when a dependency hasn't completed, true once it has", async () => {
    const missionId = randomUUID();
    const dep = await createWorkOrder(missionId, { agentId: "a", objective: "dep" });
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "main", dependencies: [dep.id] });

    expect(dependenciesSatisfied(wo)).toBe(false);

    mockCreateTask.mockResolvedValueOnce(fixtureTask({ status: "completed" }));
    await startWorkOrder(dep.id);

    expect(dependenciesSatisfied(wo)).toBe(true);
  });

  it("fails closed for an unknown/deleted dependency id", async () => {
    const wo = await createWorkOrder(randomUUID(), {
      agentId: "a",
      objective: "main",
      dependencies: [randomUUID()],
    });
    expect(dependenciesSatisfied(wo)).toBe(false);
  });
});

describe("startWorkOrder", () => {
  it("creates a real OrchestratorTask via orchestrator.ts#createTask and syncs status from it", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "recon-agent", objective: "enumerate" });
    const task = fixtureTask({ missionId, status: "waiting_confirmation" });
    mockCreateTask.mockResolvedValueOnce(task);

    const started = await startWorkOrder(wo.id);

    expect(mockCreateTask).toHaveBeenCalledWith("recon-agent", expect.stringContaining("enumerate"), missionId, undefined, undefined);
    expect(started.status).toBe("waiting_approval");
    expect(started.orchestratorTaskId).toBe(task.id);
    expect(started.startedAt).toBeTruthy();
  });

  it("appends the target to the objective when the work order has one", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "recon-agent", objective: "scan", target: "example.com" });
    mockCreateTask.mockResolvedValueOnce(fixtureTask({ missionId }));

    await startWorkOrder(wo.id);

    const objectiveArg = mockCreateTask.mock.calls[0][1];
    expect(objectiveArg).toContain("scan");
    expect(objectiveArg).toContain("example.com");
  });

  it("sets completedAt/result when the underlying task completes immediately", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    mockCreateTask.mockResolvedValueOnce(fixtureTask({ missionId, status: "completed", finalResponse: "all done" }));

    const started = await startWorkOrder(wo.id);

    expect(started.status).toBe("completed");
    expect(started.completedAt).toBeTruthy();
    expect(started.result).toBe("all done");

    const events = listActivity(missionId);
    expect(events.some((e) => e.type === "work_order_started" && e.meta?.workOrderId === wo.id)).toBe(true);
    expect(events.some((e) => e.type === "work_order_completed" && e.meta?.workOrderId === wo.id)).toBe(true);
  });

  it("throws InvalidWorkOrderStateError when not pending", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    mockCreateTask.mockResolvedValueOnce(fixtureTask({ missionId, status: "completed" }));
    await startWorkOrder(wo.id);

    await expect(startWorkOrder(wo.id)).rejects.toThrow(InvalidWorkOrderStateError);
  });

  it("throws InvalidWorkOrderStateError when dependencies are unmet", async () => {
    const missionId = randomUUID();
    const dep = await createWorkOrder(missionId, { agentId: "a", objective: "dep" });
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "main", dependencies: [dep.id] });

    await expect(startWorkOrder(wo.id)).rejects.toThrow(InvalidWorkOrderStateError);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it("throws WorkOrderNotFoundError for an unknown id", async () => {
    await expect(startWorkOrder(randomUUID())).rejects.toThrow(WorkOrderNotFoundError);
  });
});

describe("refreshWorkOrder", () => {
  it("re-syncs status from the underlying task's current status", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    const task = fixtureTask({ missionId, status: "waiting_confirmation" });
    mockCreateTask.mockResolvedValueOnce(task);
    await startWorkOrder(wo.id);

    mockGetTask.mockReturnValueOnce({ ...task, status: "completed", finalResponse: "ok" });
    const refreshed = await refreshWorkOrder(wo.id);

    expect(refreshed.status).toBe("completed");
    expect(refreshed.result).toBe("ok");
  });

  it("is a no-op for a work order that was never started", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    const refreshed = await refreshWorkOrder(wo.id);
    expect(refreshed.status).toBe("pending");
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("throws WorkOrderNotFoundError for an unknown id", async () => {
    await expect(refreshWorkOrder(randomUUID())).rejects.toThrow(WorkOrderNotFoundError);
  });
});

describe("cancelWorkOrder", () => {
  it("cancels the underlying task and marks the work order cancelled", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    const task = fixtureTask({ missionId, status: "waiting_confirmation" });
    mockCreateTask.mockResolvedValueOnce(task);
    await startWorkOrder(wo.id);

    const cancelled = cancelWorkOrder(wo.id);

    expect(mockCancelTask).toHaveBeenCalledWith(task.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeTruthy();
  });

  it("still cancels a never-started work order (no task to abort)", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    const cancelled = cancelWorkOrder(wo.id);
    expect(mockCancelTask).not.toHaveBeenCalled();
    expect(cancelled.status).toBe("cancelled");
  });

  it("throws WorkOrderNotFoundError for an unknown id", () => {
    expect(() => cancelWorkOrder(randomUUID())).toThrow(WorkOrderNotFoundError);
  });
});

describe("listWorkOrders / getWorkOrder", () => {
  it("only returns work orders for the requested mission, newest first", async () => {
    vi.useFakeTimers();
    try {
      const missionA = randomUUID();
      const missionB = randomUUID();
      const first = await createWorkOrder(missionA, { agentId: "a", objective: "first" });
      vi.advanceTimersByTime(10);
      await createWorkOrder(missionB, { agentId: "a", objective: "other mission" });
      vi.advanceTimersByTime(10);
      const second = await createWorkOrder(missionA, { agentId: "a", objective: "second" });

      const listed = listWorkOrders(missionA);
      expect(listed.map((w) => w.id)).toEqual([second.id, first.id]);
      expect(getWorkOrder(first.id)?.id).toBe(first.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("onMissionDeleted purge", () => {
  it("removes every work order belonging to the deleted mission", async () => {
    const missionA = randomUUID();
    const missionB = randomUUID();
    await createWorkOrder(missionA, { agentId: "a", objective: "o" });
    await createWorkOrder(missionB, { agentId: "a", objective: "o" });

    purgeMission(missionA);

    expect(listWorkOrders(missionA)).toEqual([]);
    expect(listWorkOrders(missionB)).toHaveLength(1);
  });
});

describe("loadWorkOrdersFromDisk", () => {
  it("hydrates in-memory work orders from every mission's work-orders.json", async () => {
    const missionId = randomUUID();
    const onDisk: WorkOrder = {
      id: randomUUID(),
      missionId,
      agentId: "a",
      objective: "loaded",
      status: "pending",
      priority: 0,
      dependencies: [],
      createdAt: 1,
      relatedAssets: [],
      relatedFindings: [],
    };
    mockListMissionIds.mockResolvedValueOnce([missionId]);
    mockReadMissionJson.mockResolvedValueOnce([onDisk]);

    await loadWorkOrdersFromDisk();

    expect(getWorkOrder(onDisk.id)).toEqual(onDisk);
  });
});
