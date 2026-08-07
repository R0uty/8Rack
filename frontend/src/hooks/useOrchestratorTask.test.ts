import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOrchestratorTask } from "./useOrchestratorTask";
import { cancelTask, continueTask, createTask, provideGuidance, resumeTask } from "../services/orchestratorApi";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { OrchestratorTask } from "../types/orchestrator";

vi.mock("../services/orchestratorApi", () => ({
  createTask: vi.fn(),
  resumeTask: vi.fn(),
  cancelTask: vi.fn(),
  continueTask: vi.fn(),
  provideGuidance: vi.fn(),
}));
vi.mock("../services/toolsApi", () => ({
  confirmExecution: vi.fn(),
  rejectExecution: vi.fn(),
}));

const mockCreateTask = vi.mocked(createTask);
const mockResumeTask = vi.mocked(resumeTask);
const mockCancelTask = vi.mocked(cancelTask);
const mockContinueTask = vi.mocked(continueTask);
const mockProvideGuidance = vi.mocked(provideGuidance);
const mockConfirmExecution = vi.mocked(confirmExecution);
const mockRejectExecution = vi.mocked(rejectExecution);

function fixtureTask(overrides: Partial<OrchestratorTask> = {}): OrchestratorTask {
  return {
    id: "task-1",
    agentId: "recon",
    objective: "scan the target",
    messages: [],
    status: "running",
    toolExecutionIds: [],
    toolCallCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useOrchestratorTask", () => {
  it("aborts an in-flight start() when the hook unmounts", async () => {
    let capturedSignal: AbortSignal | undefined;
    const pending = deferred<OrchestratorTask>();
    mockCreateTask.mockImplementation(async (_agentId, _objective, _projectId, _onChunk, signal) => {
      capturedSignal = signal;
      return pending.promise;
    });

    // start() isn't awaited here on purpose - the assertion is about the in-flight request, not
    // its eventual settlement (which pending.resolve() below lets happen harmlessly afterward).
    const { result, unmount } = renderHook(() => useOrchestratorTask());
    act(() => {
      void result.current.start("recon", "scan", "proj-1");
    });

    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    pending.resolve(fixtureTask());
  });

  it("start() streams chunks into streamingText while in flight, then settles into task", async () => {
    let onChunkRef!: (c: string) => void;
    mockCreateTask.mockImplementation(async (_agentId, _objective, _projectId, onChunk) => {
      onChunkRef = onChunk;
      onChunk("thinking...");
      return fixtureTask();
    });

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan the target", "proj-1");
    });

    expect(result.current.task).toEqual(fixtureTask());
    expect(result.current.streamingText).toBe("");
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onChunkRef).toBeDefined();
  });

  it("start() passes an optional model override through", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask());
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1", "override-model");
    });
    expect(mockCreateTask).toHaveBeenCalledWith(
      "recon",
      "scan",
      "proj-1",
      expect.any(Function),
      expect.any(Object),
      "override-model",
    );
  });

  it("start() surfaces a non-abort failure", async () => {
    mockCreateTask.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    expect(result.current.error).toBe("backend down");
    expect(result.current.task).toBeNull();
  });

  it("start() swallows an AbortError without setting an error", async () => {
    mockCreateTask.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    expect(result.current.error).toBeNull();
  });

  it("approve() is a no-op without a pendingExecutionId", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask());
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });

    await act(async () => {
      await result.current.approve();
    });

    expect(mockConfirmExecution).not.toHaveBeenCalled();
  });

  it("approve() streams live output, clears it, then resumes into the settled task", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }));
    mockConfirmExecution.mockImplementation(async (_id, onEvent) => {
      onEvent({ type: "output", stream: "stdout", data: "scanning...\n" });
      return {} as never;
    });
    mockResumeTask.mockResolvedValue(fixtureTask({ status: "completed", finalResponse: "done" }));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    expect(result.current.task?.pendingExecutionId).toBe("exec-1");

    await act(async () => {
      await result.current.approve();
    });

    expect(mockConfirmExecution).toHaveBeenCalledWith("exec-1", expect.any(Function), expect.any(Object));
    expect(mockResumeTask).toHaveBeenCalledWith("task-1", expect.any(Function), expect.any(Object));
    expect(result.current.liveOutput).toEqual([]);
    expect(result.current.task?.status).toBe("completed");
  });

  it("approve() surfaces a failure from confirmExecution", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }));
    mockConfirmExecution.mockRejectedValue(new Error("tool crashed"));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.approve();
    });

    expect(result.current.error).toBe("tool crashed");
    expect(mockResumeTask).not.toHaveBeenCalled();
  });

  it("reject() rejects the execution then resumes", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }));
    mockRejectExecution.mockResolvedValue({} as never);
    mockResumeTask.mockResolvedValue(fixtureTask({ status: "completed" }));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.reject();
    });

    expect(mockRejectExecution).toHaveBeenCalledWith("exec-1");
    expect(mockResumeTask).toHaveBeenCalledWith("task-1", expect.any(Function), expect.any(Object));
    expect(result.current.task?.status).toBe("completed");
  });

  it("cancel() calls cancelTask and updates the task", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask());
    mockCancelTask.mockResolvedValue(fixtureTask({ status: "cancelled" }));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.cancel();
    });

    expect(mockCancelTask).toHaveBeenCalledWith("task-1");
    expect(result.current.task?.status).toBe("cancelled");
  });

  it("cancel() is a no-op with no active task", async () => {
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.cancel();
    });
    expect(mockCancelTask).not.toHaveBeenCalled();
  });

  it("continueTask() is a no-op when the task hasn't completed", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }));
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });

    await act(async () => {
      await result.current.continueTask("what about the other host?");
    });

    expect(mockContinueTask).not.toHaveBeenCalled();
  });

  it("continueTask() is a no-op with no active task", async () => {
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.continueTask("hello");
    });
    expect(mockContinueTask).not.toHaveBeenCalled();
  });

  it("continueTask() sends the follow-up into the same task id and streams into streamingText", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "completed", finalResponse: "First answer." }));
    let onChunkRef!: (c: string) => void;
    mockContinueTask.mockImplementation(async (_id, _message, onChunk) => {
      onChunkRef = onChunk;
      onChunk("thinking again...");
      return fixtureTask({ status: "completed", finalResponse: "Second answer." });
    });

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });

    await act(async () => {
      await result.current.continueTask("what about the other host?");
    });

    expect(mockContinueTask).toHaveBeenCalledWith("task-1", "what about the other host?", expect.any(Function), expect.any(Object));
    expect(result.current.task?.finalResponse).toBe("Second answer.");
    expect(result.current.streamingText).toBe("");
    expect(result.current.busy).toBe(false);
    expect(onChunkRef).toBeDefined();
  });

  it("continueTask() surfaces a non-abort failure", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "completed" }));
    mockContinueTask.mockRejectedValue(new Error("agent unreachable"));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.continueTask("keep going");
    });

    expect(result.current.error).toBe("agent unreachable");
  });

  it("provideGuidance() is a no-op when the task isn't waiting on guidance", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-1" }));
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });

    await act(async () => {
      await result.current.provideGuidance("try httpx instead");
    });

    expect(mockProvideGuidance).not.toHaveBeenCalled();
  });

  it("provideGuidance() is a no-op with no active task", async () => {
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.provideGuidance("hello");
    });
    expect(mockProvideGuidance).not.toHaveBeenCalled();
  });

  it("provideGuidance() sends the note and updates the task from the response", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_guidance" }));
    let onChunkRef!: (c: string) => void;
    mockProvideGuidance.mockImplementation(async (_id, _note, onChunk) => {
      onChunkRef = onChunk;
      onChunk("trying httpx...");
      return fixtureTask({ status: "waiting_confirmation", pendingExecutionId: "exec-2" });
    });

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.provideGuidance("try httpx instead");
    });

    expect(mockProvideGuidance).toHaveBeenCalledWith("task-1", "try httpx instead", expect.any(Function), expect.any(Object));
    expect(result.current.task?.status).toBe("waiting_confirmation");
    expect(result.current.streamingText).toBe("");
    expect(result.current.busy).toBe(false);
    expect(onChunkRef).toBeDefined();
  });

  it("provideGuidance() works with no note at all", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_guidance" }));
    mockProvideGuidance.mockResolvedValue(fixtureTask({ status: "completed", finalResponse: "done" }));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.provideGuidance();
    });

    expect(mockProvideGuidance).toHaveBeenCalledWith("task-1", undefined, expect.any(Function), expect.any(Object));
    expect(result.current.task?.status).toBe("completed");
  });

  it("provideGuidance() surfaces a non-abort failure", async () => {
    mockCreateTask.mockResolvedValue(fixtureTask({ status: "waiting_guidance" }));
    mockProvideGuidance.mockRejectedValue(new Error("agent unreachable"));

    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    await act(async () => {
      await result.current.provideGuidance("keep going");
    });

    expect(result.current.error).toBe("agent unreachable");
  });

  it("reset() clears task, output, streaming text, and error", async () => {
    mockCreateTask.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useOrchestratorTask());
    await act(async () => {
      await result.current.start("recon", "scan", "proj-1");
    });
    expect(result.current.error).toBe("backend down");

    act(() => result.current.reset());

    expect(result.current.task).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.liveOutput).toEqual([]);
    expect(result.current.streamingText).toBe("");
    expect(result.current.busy).toBe(false);
  });
});
