export class OllamaConnectionError extends Error {
  constructor(cause?: unknown) {
    super("Could not reach Ollama. Is it running? (ollama serve)");
    this.name = "OllamaConnectionError";
    this.cause = cause;
  }
}

export class OllamaModelNotFoundError extends Error {
  constructor(model: string) {
    super(`Model "${model}" was not found locally. Pull it with: ollama pull ${model}`);
    this.name = "OllamaModelNotFoundError";
  }
}

export class OllamaRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OllamaRequestError";
    this.status = status;
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super("Request was cancelled");
    this.name = "RequestCancelledError";
  }
}

/** Distinct from OllamaConnectionError: the connection was made fine, but Ollama went silent for
 * longer than the configured bound (env.ollamaRequestTimeoutMs/ollamaChatIdleTimeoutMs) - a wedged
 * model load or a hung generation, not "isn't running". See services/ollama.ts#ollamaFetch. */
export class OllamaTimeoutError extends Error {
  constructor(cause?: unknown) {
    super("Ollama did not respond in time - it may be wedged (e.g. mid model-load) or overloaded.");
    this.name = "OllamaTimeoutError";
    this.cause = cause;
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" was not found`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentDisabledError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" is disabled`);
    this.name = "AgentDisabledError";
  }
}

export class AgentOfflineError extends Error {
  constructor(agentId: string, model: string) {
    super(`Agent "${agentId}" is offline: model "${model}" is not available locally. Pull it with: ollama pull ${model}`);
    this.name = "AgentOfflineError";
  }
}

export class AgentIdConflictError extends Error {
  constructor(agentId: string) {
    super(`Agent "${agentId}" already exists`);
    this.name = "AgentIdConflictError";
  }
}

export class InvalidAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentConfigError";
  }
}

export class UnknownToolError extends Error {
  constructor(toolNames: string[]) {
    super(`Unknown tool(s): ${toolNames.join(", ")}`);
    this.name = "UnknownToolError";
  }
}

export class ExecToolNotFoundError extends Error {
  constructor(toolId: string) {
    super(`Tool "${toolId}" was not found`);
    this.name = "ExecToolNotFoundError";
  }
}

export class ExecToolDisabledError extends Error {
  constructor(toolId: string) {
    super(`Tool "${toolId}" is disabled`);
    this.name = "ExecToolDisabledError";
  }
}

export class InvalidToolArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolArgumentsError";
  }
}

export class ExecutionNotFoundError extends Error {
  constructor(executionId: string) {
    super(`Execution "${executionId}" was not found`);
    this.name = "ExecutionNotFoundError";
  }
}

export class ExecutableUnavailableError extends Error {
  constructor(toolId: string, executable: string) {
    super(`Tool "${toolId}" is unavailable: "${executable}" was not found on PATH`);
    this.name = "ExecutableUnavailableError";
  }
}

export class PrivilegedCommandError extends Error {
  constructor(command: string) {
    super(
      `Command "${command}" invokes a privilege-escalation tool (sudo/su/doas/pkexec). Tools run ` +
        "non-interactively with no TTY, so a password prompt cannot be answered and this would only " +
        "hang until it times out. Ask the user to run the privileged command themselves in their own " +
        "terminal, or find an approach that doesn't require root.",
    );
    this.name = "PrivilegedCommandError";
  }
}

export class OutOfScopeError extends Error {
  constructor(offendingTargets: string[]) {
    super(
      `Execution blocked: target(s) outside this mission's configured scope: ${offendingTargets.join(", ")}`,
    );
    this.name = "OutOfScopeError";
  }
}

/** Global cap on concurrently-running real OS processes (env.maxConcurrentExecutions) - see
 * services/toolManager.ts#runRecord. The execution stays at pending_confirmation, not consumed -
 * confirming again once a slot frees up runs it normally. */
export class TooManyConcurrentExecutionsError extends Error {
  constructor(limit: number) {
    super(
      `Too many tools are running at once (limit: ${limit}). Wait for one to finish and confirm again.`,
    );
    this.name = "TooManyConcurrentExecutionsError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task "${taskId}" was not found`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskStateError";
  }
}

export class MissionNotFoundError extends Error {
  constructor(missionId: string) {
    super(`Mission "${missionId}" was not found`);
    this.name = "MissionNotFoundError";
  }
}

export class InvalidMissionIdError extends Error {
  constructor(missionId: string) {
    super(`"${missionId}" is not a valid mission id`);
    this.name = "InvalidMissionIdError";
  }
}

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Plan "${planId}" was not found`);
    this.name = "PlanNotFoundError";
  }
}

export class InvalidPlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanStateError";
  }
}

export class FindingNotFoundError extends Error {
  constructor(findingId: string) {
    super(`Finding "${findingId}" was not found`);
    this.name = "FindingNotFoundError";
  }
}

export class CveLookupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CveLookupError";
    this.cause = cause;
  }
}

export class ReportNotFoundError extends Error {
  constructor(reportId: string) {
    super(`Report "${reportId}" was not found`);
    this.name = "ReportNotFoundError";
  }
}

export class NoFindingsSelectedError extends Error {
  constructor() {
    super("Select at least one finding to generate a report from");
    this.name = "NoFindingsSelectedError";
  }
}

export class ScanProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`Scan profile "${profileId}" was not found`);
    this.name = "ScanProfileNotFoundError";
  }
}

export class ScanRunNotFoundError extends Error {
  constructor(scanId: string) {
    super(`Scan "${scanId}" was not found`);
    this.name = "ScanRunNotFoundError";
  }
}

export class ScanTargetRequiredError extends Error {
  constructor() {
    super("target is required");
    this.name = "ScanTargetRequiredError";
  }
}

export class InvalidScanTargetError extends Error {
  constructor(target: string) {
    super(
      `Target "${target}" isn't valid - it can't start with "-", since a scan tool's own argument ` +
        "parser could interpret it as a flag instead of the intended target.",
    );
    this.name = "InvalidScanTargetError";
  }
}

export class InvalidScanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScanStateError";
  }
}

export class AssetNotFoundError extends Error {
  constructor(assetId: string) {
    super(`Asset "${assetId}" was not found`);
    this.name = "AssetNotFoundError";
  }
}

export class WorkOrderNotFoundError extends Error {
  constructor(workOrderId: string) {
    super(`Work order "${workOrderId}" was not found`);
    this.name = "WorkOrderNotFoundError";
  }
}

export class InvalidWorkOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkOrderStateError";
  }
}

export class EmbeddingModelUnavailableError extends Error {
  constructor(model: string, cause?: unknown) {
    super(
      `Embedding model "${model}" isn't available. Pull a model with embedding support, e.g.: ` +
        `ollama pull ${model}`,
    );
    this.name = "EmbeddingModelUnavailableError";
    this.cause = cause;
  }
}
