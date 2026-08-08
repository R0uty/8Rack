import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useActivity } from "./useActivity";
import { fetchExecutions } from "../services/toolsApi";
import { fetchTasks } from "../services/orchestratorApi";
import type { ExecutionRecord } from "../types/execTool";
import type { OrchestratorTask } from "../types/orchestrator";

vi.mock("../services/toolsApi", () => ({ fetchExecutions: vi.fn() }));
vi.mock("../services/orchestratorApi", () => ({ fetchTasks: vi.fn() }));

const mockFetchExecutions = vi.mocked(fetchExecutions);
const mockFetchTasks = vi.mocked(fetchTasks);

const fixtureExecution: ExecutionRecord = {
  id: "exec-1",
  toolId: "nmap",
  arguments: [],
  resolvedCommand: "nmap",
  cwd: "/",
  status: "completed",
  createdAt: 0,
};

const fixtureTask: OrchestratorTask = {
  id: "task-1",
  agentId: "recon-agent",
  objective: "scan",
  messages: [],
  status: "completed",
  toolExecutionIds: [],
  toolCallCount: 0,
  createdAt: 0,
  updatedAt: 0,
};

describe("useActivity", () => {
  it("does not fetch and starts empty when projectId is null", async () => {
    const { result } = renderHook(() => useActivity(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.executions).toEqual([]);
    expect(result.current.tasks).toEqual([]);
    expect(mockFetchExecutions).not.toHaveBeenCalled();
    expect(mockFetchTasks).not.toHaveBeenCalled();
  });

  it("fetches and merges executions and tasks for a projectId", async () => {
    mockFetchExecutions.mockResolvedValue([fixtureExecution]);
    mockFetchTasks.mockResolvedValue([fixtureTask]);

    const { result } = renderHook(() => useActivity("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchExecutions).toHaveBeenCalledWith("proj-1");
    expect(mockFetchTasks).toHaveBeenCalledWith("proj-1");
    expect(result.current.executions).toEqual([fixtureExecution]);
    expect(result.current.tasks).toEqual([fixtureTask]);
  });

  it("surfaces a load failure", async () => {
    mockFetchExecutions.mockRejectedValue(new Error("boom"));
    mockFetchTasks.mockResolvedValue([]);

    const { result } = renderHook(() => useActivity("proj-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
  });

  it("re-fetches when projectId changes", async () => {
    mockFetchExecutions.mockResolvedValue([]);
    mockFetchTasks.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ projectId }) => useActivity(projectId), {
      initialProps: { projectId: "proj-1" as string | null },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ projectId: "proj-2" });
    await waitFor(() => expect(mockFetchExecutions).toHaveBeenLastCalledWith("proj-2"));
    expect(mockFetchTasks).toHaveBeenLastCalledWith("proj-2");
  });
});
