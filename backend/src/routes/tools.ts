import { Router } from "express";
import {
  cancelExecution,
  confirmExecution,
  getExecution,
  listExecToolsWithStatus,
  listExecutions,
  rejectExecution,
  requestExecution,
  setToolEnabled,
} from "../services/toolManager.js";
import type { ToolRequestBody } from "../types/execTool.js";
import { publishMission } from "../services/missionEvents.js";
import { resumeAfterExecution } from "../services/missionRunner.js";

export const toolsRouter = Router();

interface ToolRequestBodyRaw {
  tool?: unknown;
  arguments?: unknown;
  missionId?: unknown;
  stdin?: unknown;
  agentId?: unknown;
}

function isValidToolRequest(body: ToolRequestBodyRaw): body is ToolRequestBody {
  return (
    typeof body.tool === "string" &&
    body.tool.trim().length > 0 &&
    Array.isArray(body.arguments) &&
    body.arguments.every((a) => typeof a === "string") &&
    typeof body.missionId === "string" &&
    body.missionId.trim().length > 0 &&
    (body.stdin === undefined || typeof body.stdin === "string") &&
    (body.agentId === undefined || typeof body.agentId === "string")
  );
}

toolsRouter.get("/", (_req, res) => {
  res.json({ tools: listExecToolsWithStatus() });
});

/** Runtime enable/disable toggle - distinct from `availability` (whether the executable actually
 * resolves), matching ExecTool.enabled's doc comment. */
toolsRouter.patch("/:id", async (req, res, next) => {
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: 'Request must be {"enabled": boolean}', code: "INVALID_REQUEST" });
    return;
  }
  try {
    await setToolEnabled(req.params.id, enabled);
    const tool = listExecToolsWithStatus().find((t) => t.id === req.params.id);
    res.json({ tool });
  } catch (err) {
    next(err);
  }
});

toolsRouter.get("/executions", (req, res) => {
  const { missionId } = req.query;
  if (typeof missionId !== "string" || !missionId.trim()) {
    res.status(400).json({ error: "missionId query parameter is required", code: "INVALID_REQUEST" });
    return;
  }
  // ?status=pending_confirmation,running lets the dashboard's Approval Queue fetch only what it shows,
  // rather than up to 200 records carrying their full output.
  const { status } = req.query;
  const wanted = typeof status === "string" && status ? new Set(status.split(",").map((s) => s.trim())) : undefined;
  const executions = listExecutions(missionId);
  res.json({ executions: wanted ? executions.filter((e) => wanted.has(e.status)) : executions });
});

toolsRouter.get("/executions/:id", (req, res) => {
  const record = getExecution(req.params.id);
  if (!record) {
    res.status(404).json({ error: `Execution "${req.params.id}" was not found`, code: "EXECUTION_NOT_FOUND" });
    return;
  }
  res.json({ execution: record });
});

/** The standardized Tool Request format: {"tool": "nmap", "arguments": ["-sV", ...]}. */
toolsRouter.post("/request", async (req, res, next) => {
  const body = req.body as ToolRequestBodyRaw;
  if (!isValidToolRequest(body)) {
    res.status(400).json({
      error: 'Request must be {"tool": string, "arguments": string[], "missionId": string, "stdin"?: string}',
      code: "INVALID_REQUEST",
    });
    return;
  }
  try {
    const record = await requestExecution(body);
    res.status(201).json({ execution: record });
  } catch (err) {
    next(err);
  }
});

/**
 * Runs a pending execution. Answers as soon as the process has started ({execution}) and lets it
 * finish in the background: the run belongs to the server, not to this request, so closing the tab
 * no longer kills an approved scan. Live output goes out as `execution_output` events on
 * GET /api/missions/:id/events; cancelling is the explicit /cancel route. When the run settles, a
 * work order waiting on it is resumed (missionRunner.ts#resumeAfterExecution).
 */
toolsRouter.post("/executions/:id/confirm", (req, res, next) => {
  const { id } = req.params;
  const missionId = getExecution(id)?.missionId;
  let answered = false;
  confirmExecution(
    id,
    (chunk) => {
      if (missionId) publishMission(missionId, { type: "execution_output", executionId: id, stream: chunk.stream, data: chunk.data });
    },
    (record) => {
      answered = true;
      res.json({ execution: record });
    },
  ).then(
    (record) => resumeAfterExecution(record.id),
    (err: unknown) => {
      if (!answered) next(err);
      else console.error(`[tools] execution "${id}" failed after it started:`, err);
    },
  );
});

toolsRouter.post("/executions/:id/reject", (req, res, next) => {
  try {
    const execution = rejectExecution(req.params.id);
    resumeAfterExecution(execution.id);
    res.json({ execution });
  } catch (err) {
    next(err);
  }
});

toolsRouter.post("/executions/:id/cancel", (req, res, next) => {
  try {
    res.json({ execution: cancelExecution(req.params.id) });
  } catch (err) {
    next(err);
  }
});
