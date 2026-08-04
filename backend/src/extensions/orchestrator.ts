/**
 * Placeholder for future *multi-agent* orchestration (running several agents across a plan of
 * steps) — unrelated to services/orchestrator.ts, which is the implemented *single-agent*
 * tool-calling loop (an agent requesting exec tools one at a time, each gated on human
 * confirmation). Still not implemented.
 */
import type { OrchestrationPlan, OrchestrationResult } from "../types/orchestration.js";

export async function runOrchestration(_plan: OrchestrationPlan): Promise<OrchestrationResult> {
  throw new Error("Multi-agent orchestration is not implemented yet.");
}
