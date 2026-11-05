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
  res.json({ executions: listExecutions(missionId) });
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
    res.json({ execution: record });
  } catch (err) {
    next(err);
  }
});

/**
 * Runs a pending execution, streaming NDJSON: {type:"stdout"|"stderr", data} chunks as output
 * arrives, then a final {type:"result", record} line — same convention as POST /api/chat, so the
 * (future) Execution Console can consume this without a backend contract change.
 */
toolsRouter.post("/executions/:id/confirm", async (req, res, next) => {
  const { id } = req.params;

  res.on("close", () => {
    if (!res.writableEnded) {
      try {
        cancelExecution(id);
      } catch {
        // Already finished, rejected, or never started running - nothing to cancel.
      }
    }
  });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const record = await confirmExecution(id, (chunk) => {
      res.write(`${JSON.stringify({ type: chunk.stream, data: chunk.data })}\n`);
    });
    res.write(`${JSON.stringify({ type: "result", record })}\n`);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    res.end();
  }
});

toolsRouter.post("/executions/:id/reject", (req, res, next) => {
  try {
    res.json({ execution: rejectExecution(req.params.id) });
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
