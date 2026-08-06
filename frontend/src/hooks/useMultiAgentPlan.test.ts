import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMultiAgentPlan } from "./useMultiAgentPlan";
import { cancelPlan, createPlan, fetchPlan, provideStepGuidance, resumePlan } from "../services/plansApi";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { MultiAgentPlan } from "../types/multiAgentPlan";
import type { OrchestratorTask } from "../types/orchestrator";

vi.mock("../services/plansApi", () => ({
  createPlan: vi.fn(),
  resumePlan: vi.fn(),
  cancelPlan: vi.fn(),
  fetchPlan: vi.fn(),
  provideStepGuidance: vi.fn(),
}));
vi.mock("../services/toolsApi", () => ({
  confirmExecution: vi.fn(),
  rejectExecution: vi.fn(),
}));

const mockCreatePlan = vi.mocked(createPlan);
const mockResumePlan = vi.mocked(resumePlan);
const mockCancelPlan = vi.mocked(cancelPlan);
const mockFetchPlan = vi.mocked(fetchPlan);
const mockProvideStepGuidance = vi.mocked(provideStepGuidance);
const mockConfirmExecution = vi.mocked(confirmExecution);
const mockRejectExecution = vi.mocked(rejectExecution);

function fixturePlan(overrides: Partial<MultiAgentPlan> = {}): MultiAgentPlan {
  return {
    id: "plan-1",
    projectId: "proj-1",
    description: "recon then report",
    steps: [{ agentId: "recon", objective: "scan" }, { agentId: "planner", objective: "summarize" }],
    stepRuns: [],
    currentStepIndex: 0,
    status: "running",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "task-1",
    agentId: "recon",
    objective: "scan",
    messages: [],
    status: "running",
    toolExecutionIds: [],
    toolCallCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("useMultiAgentPlan", () => {
  it("start() streams chunks then settles into plan + currentStepTask", async () => {
    mockCreatePlan.mockImplementation(async (_projectId, _description, _steps, onChunk) => {
      onChunk("thinking...");
      return { plan: fixturePlan(), currentStepTask: fixtureTask() };
    });

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "recon then report", [{ agentId: "recon", objective: "scan" }]);
    });

    expect(result.current.plan).toEqual(fixturePlan());
    expect(result.current.currentStepTask).toEqual(fixtureTask());
    expect(result.current.streamingText).toBe("");
    expect(result.current.busy).toBe(false);
  });

  it("start() surfaces a non-abort failure", async () => {
    mockCreatePlan.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    expect(result.current.error).toBe("backend down");
    expect(result.current.plan).toBeNull();
  });

  it("start() swallows an AbortError silently", async () => {
    mockCreatePlan.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    expect(result.current.error).toBeNull();
  });

  it("approve() is a no-op without a pending execution on the current step task", async () => {
    mockCreatePlan.mockResolvedValue({ plan: fixturePlan(), currentStepTask: fixtureTask() });
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(mockConfirmExecution).not.toHaveBeenCalled();
  });

  it("approve() confirms the pending execution, then resumes into the next step", async () => {
    mockCreatePlan.mockResolvedValue({
      plan: fixturePlan({ status: "waiting_confirmation" }),
      currentStepTask: fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }),
    });
    mockConfirmExecution.mockImplementation(async (_id, onEvent) => {
      onEvent({ type: "output", stream: "stdout", data: "scanning...\n" });
      return {} as never;
    });
    mockResumePlan.mockResolvedValue({
      plan: fixturePlan({ currentStepIndex: 1, status: "running" }),
      currentStepTask: fixtureTask({ agentId: "planner", status: "running" }),
    });

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(mockConfirmExecution).toHaveBeenCalledWith("exec-1", expect.any(Function), expect.any(Object));
    expect(mockResumePlan).toHaveBeenCalledWith("plan-1", expect.any(Function), expect.any(Object));
    expect(result.current.liveOutput).toEqual([]);
    expect(result.current.plan?.currentStepIndex).toBe(1);
    expect(result.current.currentStepTask?.agentId).toBe("planner");
  });

  it("reject() rejects the execution then resumes", async () => {
    mockCreatePlan.mockResolvedValue({
      plan: fixturePlan({ status: "waiting_confirmation" }),
      currentStepTask: fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }),
    });
    mockRejectExecution.mockResolvedValue({} as never);
    mockResumePlan.mockResolvedValue({ plan: fixturePlan({ status: "completed" }), currentStepTask: undefined });

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    await act(async () => {
      await result.current.reject();
    });

    expect(mockRejectExecution).toHaveBeenCalledWith("exec-1");
    expect(result.current.plan?.status).toBe("completed");
  });

  it("cancel() cancels then refetches so currentStepTask reflects the cancelled step", async () => {
    mockCreatePlan.mockResolvedValue({ plan: fixturePlan(), currentStepTask: fixtureTask() });
    mockCancelPlan.mockResolvedValue(fixturePlan({ status: "cancelled" }));
    mockFetchPlan.mockResolvedValue({
      plan: fixturePlan({ status: "cancelled" }),
      currentStepTask: fixtureTask({ status: "cancelled" }),
    });

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    await act(async () => {
      await result.current.cancel();
    });

    expect(mockCancelPlan).toHaveBeenCalledWith("plan-1");
    expect(mockFetchPlan).toHaveBeenCalledWith("plan-1");
    expect(result.current.plan?.status).toBe("cancelled");
    expect(result.current.currentStepTask?.status).toBe("cancelled");
  });

  it("cancel() is a no-op with no active plan", async () => {
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.cancel();
    });
    expect(mockCancelPlan).not.toHaveBeenCalled();
  });

  it("provideGuidance() is a no-op when the plan isn't waiting on guidance", async () => {
    mockCreatePlan.mockResolvedValue({ plan: fixturePlan({ status: "running" }), currentStepTask: fixtureTask() });
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });

    await act(async () => {
      await result.current.provideGuidance("try httpx instead");
    });

    expect(mockProvideStepGuidance).not.toHaveBeenCalled();
  });

  it("provideGuidance() sends the note and updates plan + current step task", async () => {
    mockCreatePlan.mockResolvedValue({
      plan: fixturePlan({ status: "waiting_guidance" }),
      currentStepTask: fixtureTask({ status: "waiting_guidance" }),
    });
    mockProvideStepGuidance.mockResolvedValue({
      plan: fixturePlan({ status: "waiting_confirmation" }),
      currentStepTask: fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-2" }),
    });

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    await act(async () => {
      await result.current.provideGuidance("try httpx instead");
    });

    expect(mockProvideStepGuidance).toHaveBeenCalledWith("plan-1", "try httpx instead", expect.any(Function), expect.any(Object));
    expect(result.current.plan?.status).toBe("waiting_confirmation");
    expect(result.current.currentStepTask?.pendingExecutionId).toBe("exec-2");
  });

  it("provideGuidance() surfaces a non-abort failure", async () => {
    mockCreatePlan.mockResolvedValue({
      plan: fixturePlan({ status: "waiting_guidance" }),
      currentStepTask: fixtureTask({ status: "waiting_guidance" }),
    });
    mockProvideStepGuidance.mockRejectedValue(new Error("agent unreachable"));

    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    await act(async () => {
      await result.current.provideGuidance();
    });

    expect(result.current.error).toBe("agent unreachable");
  });

  it("reset() clears plan, step task, output, and error", async () => {
    mockCreatePlan.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useMultiAgentPlan());
    await act(async () => {
      await result.current.start("proj-1", "desc", []);
    });
    expect(result.current.error).toBe("backend down");

    act(() => result.current.reset());

    expect(result.current.plan).toBeNull();
    expect(result.current.currentStepTask).toBeUndefined();
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});
