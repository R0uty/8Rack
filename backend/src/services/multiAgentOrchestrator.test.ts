import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent } from "./agentManager.js";
import { cancelTask, createTask, provideGuidance, resumeTask } from "./orchestrator.js";
import { InvalidPlanStateError, PlanNotFoundError } from "./errors.js";
import { cancelPlan, createPlan, provideStepGuidance, resumePlan } from "./multiAgentOrchestrator.js";
import type { AgentWithStatus } from "../types/agent.js";
import type { OrchestratorTask, TaskStatus } from "./orchestrator.js";
import type { PlanStep } from "../types/orchestration.js";

vi.mock("./agentManager.js", () => ({ getAgent: vi.fn() }));
vi.mock("./orchestrator.js", () => ({
  createTask: vi.fn(),
  resumeTask: vi.fn(),
  cancelTask: vi.fn(),
  provideGuidance: vi.fn(),
}));
vi.mock("./missionStore.js", () => ({
  listMissionIds: vi.fn(async () => []),
  readMissionJson: vi.fn(async () => []),
  writeMissionJson: vi.fn(async () => undefined),
}));

const mockGetAgent = vi.mocked(getAgent);
const mockCreateTask = vi.mocked(createTask);
const mockResumeTask = vi.mocked(resumeTask);
const mockCancelTask = vi.mocked(cancelTask);
const mockProvideGuidance = vi.mocked(provideGuidance);

function fixtureAgent(id: string, name: string): AgentWithStatus {
  return {
    id,
    name,
    description: "",
    model: "test-model",
    systemPrompt: "",
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 0,
    icon: "",
    color: "",
    enabled: true,
    status: "online",
  };
}

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: randomUUID(),
    missionId: "proj-1",
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

const twoSteps: PlanStep[] = [
  { agentId: "agent-a", objective: "step one objective" },
  { agentId: "agent-b", objective: "step two objective" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockImplementation(async (id: string) =>
    id === "agent-a" ? fixtureAgent("agent-a", "Agent A") : fixtureAgent("agent-b", "Agent B"),
  );
});

describe("createPlan", () => {
  it("runs both steps to completion when neither pauses", async () => {
    const taskA = fixtureTask({ agentId: "agent-a", status: "completed", finalResponse: "output from A" });
    const taskB = fixtureTask({ agentId: "agent-b", status: "completed", finalResponse: "output from B" });
    mockCreateTask.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);

    const plan = await createPlan("proj-1", "a two-step plan", twoSteps);

    expect(plan.status).toBe("completed");
    expect(plan.stepRuns).toHaveLength(2);
    expect(plan.stepRuns[0].finalResponse).toBe("output from A");
    expect(plan.stepRuns[1].finalResponse).toBe("output from B");
    expect(plan.stepRuns[1].objective).toContain("output from A");
    expect(plan.stepRuns[1].objective).toContain("step two objective");
    expect(mockCreateTask).toHaveBeenCalledTimes(2);
  });

  it("labels the prior step's context with the agent's name", async () => {
    const taskA = fixtureTask({ agentId: "agent-a", status: "completed", finalResponse: "recon findings" });
    const taskB = fixtureTask({ agentId: "agent-b", status: "completed" });
    mockCreateTask.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);

    await createPlan("proj-1", "desc", twoSteps);

    const [, secondObjective] = mockCreateTask.mock.calls[1];
    expect(secondObjective).toContain("Agent A");
    expect(secondObjective).toContain("recon findings");
  });

  it("stops at waiting_confirmation without starting the next step", async () => {
    const pending = fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1", finalResponse: undefined });
    mockCreateTask.mockResolvedValueOnce(pending);

    const plan = await createPlan("proj-1", "desc", twoSteps);

    expect(plan.status).toBe("waiting_confirmation");
    expect(plan.stepRuns).toHaveLength(1);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it("stops at waiting_guidance without starting the next step", async () => {
    const pending = fixtureTask({ status: "waiting_guidance", finalResponse: undefined });
    mockCreateTask.mockResolvedValueOnce(pending);

    const plan = await createPlan("proj-1", "desc", twoSteps);

    // Must not be misclassified as a plan failure by the fallback branch.
    expect(plan.status).toBe("waiting_guidance");
    expect(plan.error).toBeUndefined();
    expect(plan.stepRuns).toHaveLength(1);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["max_executions_reached", "failed"],
    ["max_time_reached", "failed"],
  ] as [TaskStatus, string][])("stops the whole plan when a step ends %s", async (taskStatus, planStatus) => {
    const stopped = fixtureTask({ status: taskStatus, error: "something went wrong" });
    mockCreateTask.mockResolvedValueOnce(stopped);

    const plan = await createPlan("proj-1", "desc", twoSteps);

    expect(plan.status).toBe(planStatus);
    expect(plan.error).toBeTruthy();
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });
});

describe("resumePlan", () => {
  it("throws PlanNotFoundError for an unknown id", async () => {
    await expect(resumePlan("nope")).rejects.toThrow(PlanNotFoundError);
  });

  it("throws InvalidPlanStateError when the plan isn't waiting on a confirmation", async () => {
    const taskA = fixtureTask({ status: "completed" });
    const taskB = fixtureTask({ status: "completed" });
    mockCreateTask.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    await expect(resumePlan(plan.id)).rejects.toThrow(InvalidPlanStateError);
  });

  it("resumes the paused step and automatically advances into the next one", async () => {
    const pending = fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" });
    mockCreateTask.mockResolvedValueOnce(pending);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    const resolvedStep1 = fixtureTask({ ...pending, status: "completed", finalResponse: "step 1 done" });
    const taskB = fixtureTask({ agentId: "agent-b", status: "completed", finalResponse: "step 2 done" });
    mockResumeTask.mockResolvedValueOnce(resolvedStep1);
    mockCreateTask.mockResolvedValueOnce(taskB);

    const resumed = await resumePlan(plan.id);

    expect(mockResumeTask).toHaveBeenCalledWith(pending.id, undefined, undefined);
    expect(resumed.status).toBe("completed");
    expect(resumed.stepRuns).toHaveLength(2);
    expect(resumed.stepRuns[1].objective).toContain("step 1 done");
  });
});

describe("provideStepGuidance", () => {
  it("throws PlanNotFoundError for an unknown id", async () => {
    await expect(provideStepGuidance("nope")).rejects.toThrow(PlanNotFoundError);
  });

  it("throws InvalidPlanStateError when the plan isn't waiting on guidance", async () => {
    const taskA = fixtureTask({ status: "completed" });
    const taskB = fixtureTask({ status: "completed" });
    mockCreateTask.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    await expect(provideStepGuidance(plan.id)).rejects.toThrow(InvalidPlanStateError);
  });

  it("passes the note through to the step's task and automatically advances into the next step", async () => {
    const pending = fixtureTask({ status: "waiting_guidance" });
    mockCreateTask.mockResolvedValueOnce(pending);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    const resolvedStep1 = fixtureTask({ ...pending, status: "completed", finalResponse: "step 1 done" });
    const taskB = fixtureTask({ agentId: "agent-b", status: "completed", finalResponse: "step 2 done" });
    mockProvideGuidance.mockResolvedValueOnce(resolvedStep1);
    mockCreateTask.mockResolvedValueOnce(taskB);

    const resumed = await provideStepGuidance(plan.id, "try httpx instead");

    expect(mockProvideGuidance).toHaveBeenCalledWith(pending.id, "try httpx instead", undefined, undefined);
    expect(resumed.status).toBe("completed");
    expect(resumed.stepRuns).toHaveLength(2);
    expect(resumed.stepRuns[1].objective).toContain("step 1 done");
  });

  it("can leave the plan paused again if the step's next attempt also needs guidance", async () => {
    const pending = fixtureTask({ status: "waiting_guidance" });
    mockCreateTask.mockResolvedValueOnce(pending);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    mockProvideGuidance.mockResolvedValueOnce(fixtureTask({ ...pending, status: "waiting_guidance" }));

    const resumed = await provideStepGuidance(plan.id);

    expect(resumed.status).toBe("waiting_guidance");
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });
});

describe("cancelPlan", () => {
  it("throws PlanNotFoundError for an unknown id", () => {
    expect(() => cancelPlan("nope")).toThrow(PlanNotFoundError);
  });

  it("cancels the current step's task and marks the plan cancelled", async () => {
    const pending = fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" });
    mockCreateTask.mockResolvedValueOnce(pending);
    const plan = await createPlan("proj-1", "desc", twoSteps);

    const cancelled = cancelPlan(plan.id);

    expect(mockCancelTask).toHaveBeenCalledWith(pending.id);
    expect(cancelled.status).toBe("cancelled");
  });

  it("still marks the plan cancelled if the underlying cancelTask throws", async () => {
    const pending = fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" });
    mockCreateTask.mockResolvedValueOnce(pending);
    const plan = await createPlan("proj-1", "desc", twoSteps);
    mockCancelTask.mockImplementation(() => {
      throw new Error("already finished");
    });

    expect(() => cancelPlan(plan.id)).not.toThrow();
    expect(cancelPlan(plan.id).status).toBe("cancelled");
  });
});
