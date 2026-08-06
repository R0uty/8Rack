import { useCallback, useRef, useState } from "react";
import { cancelPlan, createPlan, fetchPlan, provideStepGuidance, resumePlan } from "../services/plansApi";
import { confirmExecution, rejectExecution } from "../services/toolsApi";
import type { LiveOutputChunk } from "./useOrchestratorTask";
import type { OrchestratorTask } from "../types/orchestrator";
import type { MultiAgentPlan, PlanStep } from "../types/multiAgentPlan";

/**
 * Drives a multi-agent plan end to end — mirrors hooks/useOrchestratorTask.ts one level up: start
 * a plan, and whenever its current step lands on waiting_confirmation, approve or reject the
 * pending tool execution exactly like a standalone task, then resume the plan so it continues
 * (possibly straight into the next step, if this one settles without pausing again).
 */
export function useMultiAgentPlan() {
  const [plan, setPlan] = useState<MultiAgentPlan | null>(null);
  const [currentStepTask, setCurrentStepTask] = useState<OrchestratorTask | undefined>(undefined);
  const [liveOutput, setLiveOutput] = useState<LiveOutputChunk[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (projectId: string, description: string, steps: PlanStep[]) => {
    setBusy(true);
    setError(null);
    setLiveOutput([]);
    setStreamingText("");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await createPlan(
        projectId,
        description,
        steps,
        (chunk) => setStreamingText((prev) => prev + chunk),
        controller.signal,
      );
      setPlan(result.plan);
      setCurrentStepTask(result.currentStepTask);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to start plan");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, []);

  const approve = useCallback(async () => {
    if (!plan || !currentStepTask?.pendingExecutionId) return;
    setBusy(true);
    setError(null);
    setLiveOutput([]);

    const execController = new AbortController();
    abortRef.current = execController;
    try {
      await confirmExecution(
        currentStepTask.pendingExecutionId,
        (event) => {
          if (event.type === "output") {
            setLiveOutput((prev) => [...prev, { stream: event.stream, data: event.data }]);
          }
        },
        execController.signal,
      );
      setLiveOutput([]);

      const resumeController = new AbortController();
      abortRef.current = resumeController;
      const result = await resumePlan(
        plan.id,
        (chunk) => setStreamingText((prev) => prev + chunk),
        resumeController.signal,
      );
      setPlan(result.plan);
      setCurrentStepTask(result.currentStepTask);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to run the tool");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, [plan, currentStepTask]);

  const reject = useCallback(async () => {
    if (!plan || !currentStepTask?.pendingExecutionId) return;
    setBusy(true);
    setError(null);
    setLiveOutput([]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await rejectExecution(currentStepTask.pendingExecutionId);
      const result = await resumePlan(plan.id, (chunk) => setStreamingText((prev) => prev + chunk), controller.signal);
      setPlan(result.plan);
      setCurrentStepTask(result.currentStepTask);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Failed to reject the tool");
      }
    } finally {
      abortRef.current = null;
      setStreamingText("");
      setBusy(false);
    }
  }, [plan, currentStepTask]);

  /** Resumes the current step's task from "waiting_guidance" (a failed tool request/execution) -
   * see useOrchestratorTask.ts#provideGuidance, one level up. */
  const provideGuidance = useCallback(
    async (note?: string) => {
      if (!plan || plan.status !== "waiting_guidance") return;
      setBusy(true);
      setError(null);
      setLiveOutput([]);
      setStreamingText("");

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await provideStepGuidance(
          plan.id,
          note,
          (chunk) => setStreamingText((prev) => prev + chunk),
          controller.signal,
        );
        setPlan(result.plan);
        setCurrentStepTask(result.currentStepTask);
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
    [plan],
  );

  const cancel = useCallback(async () => {
    if (!plan) return;
    abortRef.current?.abort();
    setBusy(true);
    setError(null);
    try {
      await cancelPlan(plan.id);
      // cancelPlan's own response is just {plan} - refetch so currentStepTask reflects the
      // now-cancelled underlying step task too, not a stale waiting_confirmation snapshot.
      const result = await fetchPlan(plan.id);
      setPlan(result.plan);
      setCurrentStepTask(result.currentStepTask);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel the plan");
    } finally {
      setBusy(false);
    }
  }, [plan]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPlan(null);
    setCurrentStepTask(undefined);
    setLiveOutput([]);
    setStreamingText("");
    setError(null);
    setBusy(false);
  }, []);

  return {
    plan,
    currentStepTask,
    liveOutput,
    streamingText,
    busy,
    error,
    start,
    approve,
    reject,
    provideGuidance,
    cancel,
    reset,
  };
}
