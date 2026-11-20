import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceMission, type FactoryAdvanceResult } from "./factoryDirector.js";
import { getTask, provideGuidance } from "./orchestrator.js";
import { getExecution } from "./toolManager.js";
import { getWorkOrder, listWorkOrders, refreshWorkOrder, startWorkOrder, workOrderNeedsGuidance, dependenciesSatisfied } from "./workOrderManager.js";
import {
  getRunState,
  guideWorkOrderRun,
  resetRunsForTests,
  resumeAfterExecution,
  startRun,
  startWorkOrderRun,
  stopRun,
} from "./missionRunner.js";
import { subscribeMission } from "./missionEvents.js";
import { InvalidWorkOrderStateError, RequestCancelledError, RunInProgressError, WorkOrderNotFoundError } from "./errors.js";
import type { MissionStreamEvent } from "../types/missionRun.js";
import type { Mission } from "../types/mission.js";
import type { WorkOrder } from "../types/workOrder.js";
import type { OrchestratorTask } from "./orchestrator.js";
import type { ExecutionRecord } from "../types/execTool.js";

vi.mock("./factoryDirector.js", () => ({ advanceMission: vi.fn() }));
vi.mock("./orchestrator.js", () => ({ getTask: vi.fn(), provideGuidance: vi.fn() }));
vi.mock("./toolManager.js", () => ({ getExecution: vi.fn() }));
vi.mock("./workOrderManager.js", () => ({
  dependenciesSatisfied: vi.fn(() => true),
  getWorkOrder: vi.fn(),
  listWorkOrders: vi.fn(() => []),
  refreshWorkOrder: vi.fn(),
  startWorkOrder: vi.fn(),
  workOrderNeedsGuidance: vi.fn(() => false),
}));

const mockAdvance = vi.mocked(advanceMission);
const mockGetWorkOrder = vi.mocked(getWorkOrder);
const mockListWorkOrders = vi.mocked(listWorkOrders);
const mockNeedsGuidance = vi.mocked(workOrderNeedsGuidance);
const mockGetTask = vi.mocked(getTask);
const mockGetExecution = vi.mocked(getExecution);

const MISSION = "11111111-1111-4111-8111-111111111111";
const mission = { id: MISSION, name: "M", notes: "", createdAt: 1 } as Mission;

function wo(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: "wo-1",
    missionId: MISSION,
    agentId: "recon-agent",
    objective: "Recon",
    status: "pending",
    priority: 1,
    dependencies: [],
    createdAt: 1,
    relatedAssets: [],
    relatedFindings: [],
    ...overrides,
  };
}

/** A promise the test resolves by hand, to hold a run open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collect(): MissionStreamEvent[] {
  const events: MissionStreamEvent[] = [];
  subscribeMission(MISSION, (e) => events.push(e));
  return events;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetRunsForTests();
  mockListWorkOrders.mockReturnValue([]);
  mockNeedsGuidance.mockReturnValue(false);
  vi.mocked(dependenciesSatisfied).mockReturnValue(true);
});

describe("missionRunner", () => {
  it("starts a run that returns at once and goes idle when nothing is left", async () => {
    const events = collect();
    mockAdvance.mockResolvedValue({ mission });

    expect(startRun(MISSION).status).toBe("running");
    await settle();

    expect(getRunState(MISSION).status).toBe("idle");
    expect(events.filter((e) => e.type === "run_state").map((e) => (e.type === "run_state" ? e.run.status : ""))).toEqual(["running", "idle"]);
  });

  it("refuses a second run while one is going", async () => {
    const hold = deferred<FactoryAdvanceResult>();
    mockAdvance.mockReturnValue(hold.promise);

    startRun(MISSION);
    expect(() => startRun(MISSION)).toThrow(RunInProgressError);

    hold.resolve({ mission });
    await settle();
    expect(() => startRun(MISSION)).not.toThrow();
  });

  it("tags model output with the work order generating it", async () => {
    const events = collect();
    mockAdvance.mockImplementation(async (_id, onChunk, _signal, onWorkOrder) => {
      onWorkOrder?.("wo-7");
      onChunk?.("hello");
      return { mission };
    });

    startRun(MISSION);
    await settle();

    expect(events).toContainEqual({ type: "chunk", workOrderId: "wo-7", content: "hello" });
  });

  it("stops on a pending approval, and keeps the reason a run was blocked", async () => {
    mockAdvance.mockResolvedValueOnce({ mission, workOrder: wo({ status: "waiting_approval" }) });
    startRun(MISSION);
    await settle();
    expect(getRunState(MISSION)).toMatchObject({ status: "waiting_approval", workOrderId: "wo-1" });

    mockAdvance.mockResolvedValueOnce({ mission, blockedReason: "no scope" });
    startRun(MISSION);
    await settle();
    expect(getRunState(MISSION)).toMatchObject({ status: "blocked", reason: "no scope" });
  });

  it("reports an order that needs a note as waiting_guidance", async () => {
    mockNeedsGuidance.mockReturnValue(true);
    mockAdvance.mockResolvedValue({ mission, workOrder: wo({ status: "waiting_approval" }), blockedReason: "needs a note" });
    startRun(MISSION);
    await settle();
    expect(getRunState(MISSION)).toMatchObject({ status: "waiting_guidance", workOrderId: "wo-1", reason: "needs a note" });
  });

  it("stops a run by aborting its generation", async () => {
    mockAdvance.mockImplementation(
      (_id, _onChunk, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new RequestCancelledError()))),
    );

    startRun(MISSION);
    stopRun(MISSION);
    await settle();

    expect(getRunState(MISSION)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/Stopped/) });
  });

  it("reports a failed run's error as the reason it stopped", async () => {
    mockAdvance.mockRejectedValue(new Error("Ollama is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    startRun(MISSION);
    await settle();
    expect(getRunState(MISSION)).toMatchObject({ status: "blocked", reason: "Ollama is down" });
  });
});

describe("missionRunner resume after a tool run settles", () => {
  function waitingOn(executionId: string) {
    mockGetExecution.mockReturnValue({ id: executionId, missionId: MISSION } as ExecutionRecord);
    mockListWorkOrders.mockReturnValue([wo({ status: "waiting_approval", orchestratorTaskId: "task-1" })]);
    mockGetTask.mockReturnValue({ id: "task-1", pendingExecutionId: executionId } as OrchestratorTask);
  }

  it("starts a run when a work order was waiting on that execution", async () => {
    waitingOn("exec-1");
    mockAdvance.mockResolvedValue({ mission });

    resumeAfterExecution("exec-1");
    await settle();

    expect(mockAdvance).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an execution no work order is waiting on", () => {
    waitingOn("exec-1");
    resumeAfterExecution("exec-other");
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("makes a run already going advance once more instead of starting a second one", async () => {
    const hold = deferred<FactoryAdvanceResult>();
    mockAdvance.mockReturnValueOnce(hold.promise).mockResolvedValueOnce({ mission });
    startRun(MISSION);

    waitingOn("exec-1");
    resumeAfterExecution("exec-1");
    mockListWorkOrders.mockReturnValue([]); // the second advance resumed it
    hold.resolve({ mission });
    await settle();

    expect(mockAdvance).toHaveBeenCalledTimes(2);
    expect(getRunState(MISSION).status).toBe("idle");
  });
});

describe("missionRunner work order runs", () => {
  it("starts one pending order and then lets the Director carry on", async () => {
    mockGetWorkOrder.mockReturnValue(wo());
    mockAdvance.mockResolvedValue({ mission });

    startWorkOrderRun(MISSION, "wo-1");
    await settle();

    expect(startWorkOrder).toHaveBeenCalledWith("wo-1", expect.any(Function), expect.any(AbortSignal));
    expect(mockAdvance).toHaveBeenCalled();
  });

  it("refuses an order of another mission, or one that isn't pending", () => {
    mockGetWorkOrder.mockReturnValue(wo({ missionId: "other" }));
    expect(() => startWorkOrderRun(MISSION, "wo-1")).toThrow(WorkOrderNotFoundError);
    mockGetWorkOrder.mockReturnValue(wo({ status: "running" }));
    expect(() => startWorkOrderRun(MISSION, "wo-1")).toThrow(InvalidWorkOrderStateError);
  });

  it("sends guidance to the order's task, re-syncs the order, then advances", async () => {
    mockGetWorkOrder.mockReturnValue(wo({ status: "waiting_approval", orchestratorTaskId: "task-1" }));
    mockNeedsGuidance.mockReturnValue(true);
    mockAdvance.mockResolvedValue({ mission });

    guideWorkOrderRun(MISSION, "wo-1", "use dig");
    await settle();

    expect(provideGuidance).toHaveBeenCalledWith("task-1", "use dig", expect.any(Function), expect.any(AbortSignal));
    expect(refreshWorkOrder).toHaveBeenCalledWith("wo-1");
    expect(mockAdvance).toHaveBeenCalled();
  });

  it("refuses guidance for an order that isn't waiting on any", () => {
    mockGetWorkOrder.mockReturnValue(wo({ status: "waiting_approval", orchestratorTaskId: "task-1" }));
    expect(() => guideWorkOrderRun(MISSION, "wo-1")).toThrow(InvalidWorkOrderStateError);
  });
});
