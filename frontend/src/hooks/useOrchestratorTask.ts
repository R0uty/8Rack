import { useCallback, useRef, useState } from "react";
import {
  cancelTask,
  continueTask as continueTaskApi,
  createTask,
  provideGuidance as provideGuidanceApi,
  resumeTask,
} from "../services/orchestratorApi";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { OrchestratorTask } from "../types/orchestrator";

export interface LiveOutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

/**
 * Drives a single Orchestrator task end to end: start it, and whenever it lands on
 * waiting_confirmation, approve or reject the pending tool execution — approving streams live
 * output, then automatically calls resume so the agent continues reasoning over the result.
 * Every agent-call step (start/resume) streams the agent's reply text as it's generated into
 * `streamingText`, so the caller can show it live before it settles into `task.messages`.
 */
export function useOrchestratorTask() {
  const [task, setTask] = useState<OrchestratorTask | null>(null);
  const [liveOutput, setLiveOutput] = useState<LiveOutputChunk[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (agentId: string, objective: string, projectId: string, model?: string) => {
    setBusy(true);
    setError(null);
    setLiveOutput([]);
    setStreamingText("");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setTask(
        await createTask(
          agentId,
          objective,
          projectId,
          (chunk) => setStreamingText((prev) => prev + chunk),
          controller.signal,
          model,
        ),
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to start task");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!task?.pendingExecutionId) return;
    setBusy(true);
    setError(null);
    setLiveOutput([]);

    const execController = new AbortController();
    abortRef.current = execController;
    try {
      await confirmExecution(
        task.pendingExecutionId,
        (event) => {
          if (event.type === "output") {
            setLiveOutput((prev) => [...prev, { stream: event.stream, data: event.data }]);
          }
        },
        execController.signal,
      );
      // The just-finished execution's output stays around only until the loop advances — the
      // next pending confirmation (if any) starts its own ExecutionConsole from a clean slate
      // rather than briefly showing the previous tool's output.
      setLiveOutput([]);

      const resumeController = new AbortController();
      abortRef.current = resumeController;
      setTask(
        await resumeTask(task.id, (chunk) => setStreamingText((prev) => prev + chunk), resumeController.signal),
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to run the tool");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, [task]);

  const reject = useCallback(async () => {
    if (!task?.pendingExecutionId) return;
    setBusy(true);
    setError(null);
    setLiveOutput([]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await rejectExecution(task.pendingExecutionId);
      setTask(await resumeTask(task.id, (chunk) => setStreamingText((prev) => prev + chunk), controller.signal));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to reject the tool");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, [task]);

  /** Sends a follow-up message into the current (completed) task instead of starting a new one -
   * see backend/src/services/orchestrator.ts#continueTask. */
  const continueTask = useCallback(
    async (message: string) => {
      if (!task || task.status !== "completed") return;
      setBusy(true);
      setError(null);
      setStreamingText("");

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        setTask(await continueTaskApi(task.id, message, (chunk) => setStreamingText((prev) => prev + chunk), controller.signal));
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Failed to continue the task");
        }
      } finally {
        abortRef.current = null;
        setStreamingText("");
        setBusy(false);
      }
    },
    [task],
  );

  /** Resumes a task paused at "waiting_guidance" (a failed tool request/execution) - an optional
   * note steers the agent's next attempt. See backend/src/services/orchestrator.ts#provideGuidance. */
  const provideGuidance = useCallback(
    async (note?: string) => {
      if (!task || task.status !== "waiting_guidance") return;
      setBusy(true);
      setError(null);
      setLiveOutput([]);
      setStreamingText("");

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        setTask(
          await provideGuidanceApi(task.id, note, (chunk) => setStreamingText((prev) => prev + chunk), controller.signal),
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : "Failed to send guidance");
        }
      } finally {
        abortRef.current = null;
        setStreamingText("");
        setBusy(false);
      }
    },
    [task],
  );

  const cancel = useCallback(async () => {
    if (!task) return;
    abortRef.current?.abort();
    setBusy(true);
    setError(null);
    try {
      setTask(await cancelTask(task.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel the task");
    } finally {
      setBusy(false);
    }
  }, [task]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTask(null);
    setLiveOutput([]);
    setStreamingText("");
    setError(null);
    setBusy(false);
  }, []);

  return {
    task,
    liveOutput,
    streamingText,
    busy,
    error,
    start,
    approve,
    reject,
    continueTask,
    provideGuidance,
    cancel,
    reset,
  };
}
