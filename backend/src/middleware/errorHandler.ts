import type { NextFunction, Request, Response } from "express";
import {
  AgentDisabledError,
  AgentIdConflictError,
  AgentNotFoundError,
  AgentOfflineError,
  AssetNotFoundError,
  CveLookupError,
  EmbeddingModelUnavailableError,
  ExecutableUnavailableError,
  ExecToolDisabledError,
  ExecToolNotFoundError,
  ExecutionNotFoundError,
  FindingNotFoundError,
  InvalidAgentConfigError,
  InvalidPlanStateError,
  InvalidMissionIdError,
  InvalidTaskStateError,
  InvalidToolArgumentsError,
  OllamaConnectionError,
  OutOfScopeError,
  OllamaModelNotFoundError,
  OllamaRequestError,
  OllamaTimeoutError,
  InvalidScanStateError,
  NoFindingsSelectedError,
  PlanNotFoundError,
  PrivilegedCommandError,
  MissionNotFoundError,
  ReportNotFoundError,
  RequestCancelledError,
  ScanProfileNotFoundError,
  ScanRunNotFoundError,
  InvalidScanTargetError,
  ScanTargetRequiredError,
  TaskNotFoundError,
  TooManyConcurrentExecutionsError,
  UnknownToolError,
  WorkOrderNotFoundError,
  InvalidWorkOrderStateError,
  RagReindexInProgressError,
  RagReindexTimeoutError,
  McpRequestError,
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
  if (err instanceof OllamaTimeoutError) {
    res.status(504).json({ error: err.message, code: "OLLAMA_TIMEOUT" });
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
  if (err instanceof AgentIdConflictError) {
    res.status(409).json({ error: err.message, code: "AGENT_ID_CONFLICT" });
    return;
  }
  if (err instanceof InvalidAgentConfigError) {
    res.status(400).json({ error: err.message, code: "INVALID_AGENT_CONFIG" });
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
  if (err instanceof OutOfScopeError) {
    res.status(403).json({ error: err.message, code: "OUT_OF_SCOPE" });
    return;
  }
  if (err instanceof TooManyConcurrentExecutionsError) {
    res.status(429).json({ error: err.message, code: "TOO_MANY_CONCURRENT_EXECUTIONS" });
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
  if (err instanceof MissionNotFoundError) {
    res.status(404).json({ error: err.message, code: "MISSION_NOT_FOUND" });
    return;
  }
  if (err instanceof InvalidMissionIdError) {
    res.status(400).json({ error: err.message, code: "INVALID_MISSION_ID" });
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
  if (err instanceof PrivilegedCommandError) {
    res.status(400).json({ error: err.message, code: "PRIVILEGED_COMMAND_BLOCKED" });
    return;
  }
  if (err instanceof EmbeddingModelUnavailableError) {
    res.status(503).json({ error: err.message, code: "EMBEDDING_MODEL_UNAVAILABLE" });
    return;
  }
  if (err instanceof RagReindexInProgressError) {
    res.status(409).json({ error: err.message, code: "RAG_REINDEX_IN_PROGRESS" });
    return;
  }
  if (err instanceof RagReindexTimeoutError) {
    res.status(504).json({ error: err.message, code: "RAG_REINDEX_TIMEOUT" });
    return;
  }
  if (err instanceof McpRequestError) {
    res.status(502).json({ error: err.message, code: "MCP_REQUEST_FAILED" });
    return;
  }
  if (err instanceof FindingNotFoundError) {
    res.status(404).json({ error: err.message, code: "FINDING_NOT_FOUND" });
    return;
  }
  if (err instanceof CveLookupError) {
    res.status(502).json({ error: err.message, code: "CVE_LOOKUP_FAILED" });
    return;
  }
  if (err instanceof ScanProfileNotFoundError) {
    res.status(404).json({ error: err.message, code: "SCAN_PROFILE_NOT_FOUND" });
    return;
  }
  if (err instanceof ScanRunNotFoundError) {
    res.status(404).json({ error: err.message, code: "SCAN_NOT_FOUND" });
    return;
  }
  if (err instanceof ScanTargetRequiredError) {
    res.status(400).json({ error: err.message, code: "INVALID_REQUEST" });
    return;
  }
  if (err instanceof InvalidScanTargetError) {
    res.status(400).json({ error: err.message, code: "INVALID_REQUEST" });
    return;
  }
  if (err instanceof InvalidScanStateError) {
    res.status(409).json({ error: err.message, code: "INVALID_SCAN_STATE" });
    return;
  }
  if (err instanceof ReportNotFoundError) {
    res.status(404).json({ error: err.message, code: "REPORT_NOT_FOUND" });
    return;
  }
  if (err instanceof NoFindingsSelectedError) {
    res.status(400).json({ error: err.message, code: "INVALID_REQUEST" });
    return;
  }
  if (err instanceof AssetNotFoundError) {
    res.status(404).json({ error: err.message, code: "ASSET_NOT_FOUND" });
    return;
  }
  if (err instanceof WorkOrderNotFoundError) {
    res.status(404).json({ error: err.message, code: "WORK_ORDER_NOT_FOUND" });
    return;
  }
  if (err instanceof InvalidWorkOrderStateError) {
    res.status(409).json({ error: err.message, code: "INVALID_WORK_ORDER_STATE" });
    return;
  }

  // Body-parser failures (malformed JSON, a body over the size limit) are the client's mistake, and
  // carry their own 4xx status - not a 500 logged as a server fault.
  const { status, expose, message } = (err ?? {}) as { status?: unknown; expose?: unknown; message?: unknown };
  if (typeof status === "number" && status >= 400 && status < 500 && expose === true) {
    res.status(status).json({ error: typeof message === "string" ? message : "Invalid request", code: "INVALID_REQUEST" });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
}
