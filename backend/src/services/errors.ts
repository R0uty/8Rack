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

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project "${projectId}" was not found`);
    this.name = "ProjectNotFoundError";
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
