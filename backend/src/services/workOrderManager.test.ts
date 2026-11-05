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
  resumeWorkOrderIfReady,
  startWorkOrder,
  workOrderNeedsGuidance,
} from "./workOrderManager.js";
import { cancelTask, createTask, getTask, resumeTask } from "./orchestrator.js";
import { getExecution } from "./toolManager.js";
import { onMissionDeleted } from "./missionManager.js";
import { InvalidTaskStateError, InvalidWorkOrderStateError, RequestCancelledError, WorkOrderNotFoundError } from "./errors.js";
import { listMissionIds, readMissionJson } from "./missionStore.js";
import { listActivity } from "./activityLog.js";
import type { OrchestratorTask } from "./orchestrator.js";
import type { WorkOrder } from "../types/workOrder.js";

vi.mock("./orchestrator.js", () => ({ createTask: vi.fn(), cancelTask: vi.fn(), getTask: vi.fn(), resumeTask: vi.fn() }));
vi.mock("./toolManager.js", () => ({ getExecution: vi.fn() }));
const mockResumeTask = vi.mocked(resumeTask);
const mockGetExecution = vi.mocked(getExecution);
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

    expect(mockCreateTask).toHaveBeenCalledWith(
      "recon-agent",
      expect.stringContaining("enumerate"),
      missionId,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
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

describe("work order lifecycle races", () => {
  async function startedAwaitingApproval(executionId = "exec-1") {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    const task = fixtureTask({ missionId, status: "waiting_confirmation", pendingExecutionId: executionId });
    mockCreateTask.mockResolvedValueOnce(task);
    await startWorkOrder(wo.id);
    mockGetTask.mockReturnValue(task);
    return { wo, task };
  }

  it("claims the order before the first await, so a second start is refused", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    mockCreateTask.mockResolvedValueOnce(fixtureTask());

    const first = startWorkOrder(wo.id);
    expect(getWorkOrder(wo.id)?.status).toBe("running");
    await expect(startWorkOrder(wo.id)).rejects.toThrow(InvalidWorkOrderStateError);
    await first;

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it("lets a cancel reach a task that's still generating its first reply", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    let finish: (task: OrchestratorTask) => void = () => {};
    const inFlight = fixtureTask({ status: "running" });
    mockCreateTask.mockImplementationOnce((...args) => {
      args[6]?.(inFlight);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });

    const run = startWorkOrder(wo.id);
    await vi.waitFor(() => expect(mockCreateTask).toHaveBeenCalled());
    cancelWorkOrder(wo.id);

    expect(mockCancelTask).toHaveBeenCalledWith(inFlight.id);
    finish({ ...inFlight, status: "cancelled" });
    await run;
    expect(getWorkOrder(wo.id)?.status).toBe("cancelled");
  });

  it("refuses to cancel an order that already finished", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    mockCreateTask.mockResolvedValueOnce(fixtureTask({ status: "completed" }));
    await startWorkOrder(wo.id);

    expect(() => cancelWorkOrder(wo.id)).toThrow(InvalidWorkOrderStateError);
    expect(getWorkOrder(wo.id)?.status).toBe("completed");
  });

  it("returns the order to pending when the client disconnects mid-generation", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    mockCreateTask.mockRejectedValueOnce(new RequestCancelledError());

    await expect(startWorkOrder(wo.id)).rejects.toThrow(RequestCancelledError);

    expect(getWorkOrder(wo.id)?.status).toBe("pending");
  });

  it("fails the order on any other start error", async () => {
    const wo = await createWorkOrder(randomUUID(), { agentId: "a", objective: "o" });
    mockCreateTask.mockRejectedValueOnce(new Error("agent is gone"));

    await expect(startWorkOrder(wo.id)).rejects.toThrow("agent is gone");

    expect(getWorkOrder(wo.id)?.status).toBe("failed");
    expect(getWorkOrder(wo.id)?.result).toBe("agent is gone");
  });

  it("doesn't resume while the human hasn't decided", async () => {
    const { wo } = await startedAwaitingApproval();
    mockGetExecution.mockReturnValue({ status: "pending_confirmation" } as never);

    const result = await resumeWorkOrderIfReady(wo.id);

    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(result.status).toBe("waiting_approval");
  });

  it("resumes the task once the execution settled, and syncs the outcome", async () => {
    const { wo, task } = await startedAwaitingApproval();
    mockGetExecution.mockReturnValue({ status: "completed" } as never);
    mockResumeTask.mockImplementationOnce(async () => {
      task.status = "completed";
      task.finalResponse = "finished after approval";
      return task;
    });

    const result = await resumeWorkOrderIfReady(wo.id);

    expect(mockResumeTask).toHaveBeenCalledWith(task.id, undefined, undefined);
    expect(result.status).toBe("completed");
    expect(result.result).toBe("finished after approval");
  });

  it("settles the order when its task can never continue", async () => {
    const { wo } = await startedAwaitingApproval();
    mockGetExecution.mockReturnValue(undefined);
    mockResumeTask.mockRejectedValueOnce(new InvalidTaskStateError("its execution record is gone"));

    const result = await resumeWorkOrderIfReady(wo.id);

    expect(result.status).toBe("failed");
  });

  it("doesn't strand the order at running on an unexpected resume error", async () => {
    const { wo } = await startedAwaitingApproval();
    mockGetExecution.mockReturnValue({ status: "completed" } as never);
    mockResumeTask.mockRejectedValueOnce(new Error("disk full"));

    await expect(resumeWorkOrderIfReady(wo.id)).rejects.toThrow("disk full");

    expect(getWorkOrder(wo.id)?.status).toBe("failed");
  });

  it("repairs an order left running by a previous process when loading from disk", async () => {
    const missionId = randomUUID();
    const id = randomUUID();
    mockListMissionIds.mockResolvedValueOnce([missionId]);
    mockReadMissionJson.mockResolvedValueOnce([
      { id, missionId, agentId: "a", objective: "o", status: "running", priority: 0, dependencies: [], createdAt: 1, relatedAssets: [], relatedFindings: [] },
    ]);

    await loadWorkOrdersFromDisk();

    expect(getWorkOrder(id)?.status).not.toBe("running");
  });
});

describe("workOrderNeedsGuidance", () => {
  it("is true only for a paused order whose task wants a note", async () => {
    const missionId = randomUUID();
    const wo = await createWorkOrder(missionId, { agentId: "a", objective: "o" });
    const task = fixtureTask({ missionId, status: "waiting_guidance" });
    mockCreateTask.mockResolvedValueOnce(task);
    await startWorkOrder(wo.id);
    mockGetTask.mockReturnValue(task);

    expect(workOrderNeedsGuidance(wo)).toBe(true);

    task.status = "waiting_confirmation";
    expect(workOrderNeedsGuidance(wo)).toBe(false);
  });
});

