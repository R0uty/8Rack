import type { NextFunction, Request, Response } from "express";
import {
  AgentDisabledError,
  AgentNotFoundError,
  AgentOfflineError,
  ExecutableUnavailableError,
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutionNotFoundError,
  InvalidPlanStateError,
  InvalidTaskStateError,
  InvalidToolArgumentsError,
  OllamaConnectionError,
  OllamaModelNotFoundError,
  OllamaRequestError,
  PlanNotFoundError,
  ProjectNotFoundError,
  RequestCancelledError,
  TaskNotFoundError,
  UnknownToolError,
} from "../services/errors.js";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) {
    // Streaming response already started; just end it.
    res.end();
    return;
  }

  if (err instanceof RequestCancelledError) {
    res.status(499).json({ error: err.message, code: "REQUEST_CANCELLED" });
    return;
  }
  if (err instanceof OllamaConnectionError) {
    res.status(503).json({ error: err.message, code: "OLLAMA_UNAVAILABLE" });
    return;
  }
  if (err instanceof OllamaModelNotFoundError) {
    res.status(404).json({ error: err.message, code: "MODEL_NOT_FOUND" });
    return;
  }
  if (err instanceof OllamaRequestError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message,
      code: "OLLAMA_REQUEST_ERROR",
    });
    return;
  }
  if (err instanceof AgentNotFoundError) {
    res.status(404).json({ error: err.message, code: "AGENT_NOT_FOUND" });
    return;
  }
  if (err instanceof AgentDisabledError) {
    res.status(403).json({ error: err.message, code: "AGENT_DISABLED" });
    return;
  }
  if (err instanceof AgentOfflineError) {
    res.status(503).json({ error: err.message, code: "AGENT_OFFLINE" });
    return;
  }
  if (err instanceof UnknownToolError) {
    res.status(400).json({ error: err.message, code: "INVALID_REQUEST" });
    return;
  }
  if (err instanceof ExecToolNotFoundError) {
    res.status(404).json({ error: err.message, code: "TOOL_NOT_FOUND" });
    return;
  }
  if (err instanceof ExecToolDisabledError) {
    res.status(403).json({ error: err.message, code: "TOOL_DISABLED" });
    return;
  }
  if (err instanceof InvalidToolArgumentsError) {
    res.status(400).json({ error: err.message, code: "INVALID_TOOL_ARGUMENTS" });
    return;
  }
  if (err instanceof ExecutionNotFoundError) {
    res.status(404).json({ error: err.message, code: "EXECUTION_NOT_FOUND" });
    return;
  }
  if (err instanceof ExecutableUnavailableError) {
    res.status(503).json({ error: err.message, code: "TOOL_UNAVAILABLE" });
    return;
  }
  if (err instanceof TaskNotFoundError) {
    res.status(404).json({ error: err.message, code: "TASK_NOT_FOUND" });
    return;
  }
  if (err instanceof InvalidTaskStateError) {
    res.status(409).json({ error: err.message, code: "INVALID_TASK_STATE" });
    return;
  }
  if (err instanceof ProjectNotFoundError) {
    res.status(404).json({ error: err.message, code: "PROJECT_NOT_FOUND" });
    return;
  }
  if (err instanceof PlanNotFoundError) {
    res.status(404).json({ error: err.message, code: "PLAN_NOT_FOUND" });
    return;
  }
  if (err instanceof InvalidPlanStateError) {
    res.status(409).json({ error: err.message, code: "INVALID_PLAN_STATE" });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
}
