import { Router } from "express";
import { RequestCancelledError } from "../services/errors.js";
import { createReport, deleteReport, getReport, listReports, updateReportStatus } from "../services/reportManager.js";
import { abortOnClientDisconnect } from "./streamUtils.js";
import type { ReportStatus } from "../types/report.js";

const VALID_STATUSES: ReportStatus[] = ["draft", "ai_generated", "human_review", "ready", "submitted"];

/** Mission-scoped report routes - GET/POST/DELETE /api/missions/:missionId/reports[...]. MUST be
 * created with { mergeParams: true } or req.params.missionId is undefined once mounted under a
 * parent router's :missionId segment (backend/src/index.ts) - see routes/findings.ts/scanners.ts
 * for the same requirement. */
export const missionReportsRouter = Router({ mergeParams: true });

function missionIdOf(req: { params: Record<string, string> }): string {
  return req.params.missionId;
}

interface CreateReportBody {
  title?: unknown;
  findingIds?: unknown;
  agentId?: unknown;
  model?: unknown;
}

function isValidCreateBody(
  body: CreateReportBody,
): body is { title: string; findingIds: string[]; agentId?: string; model?: string } {
  return (
    typeof body.title === "string" &&
    body.title.trim().length > 0 &&
    Array.isArray(body.findingIds) &&
    body.findingIds.length > 0 &&
    body.findingIds.every((id) => typeof id === "string") &&
    (body.agentId === undefined || typeof body.agentId === "string") &&
    (body.model === undefined || typeof body.model === "string")
  );
}

missionReportsRouter.get("/", (req, res) => {
  res.json({ reports: listReports(missionIdOf(req)) });
});

missionReportsRouter.get("/:id", (req, res) => {
  const report = getReport(req.params.id);
  if (!report) {
    res.status(404).json({ error: `Report "${req.params.id}" was not found`, code: "REPORT_NOT_FOUND" });
    return;
  }
  res.json({ report });
});

/**
 * Generates a report and streams NDJSON: {type:"chunk", content} lines as the agent writes it,
 * then a final {type:"report", report} line with the persisted result - mirrors
 * routes/orchestrator.ts's runAndStreamTask (chunk-then-final-object), since this is a single
 * agent generation, not a multi-step process like a scan.
 */
missionReportsRouter.post("/", async (req, res, next) => {
  const body = req.body as CreateReportBody;
  if (!isValidCreateBody(body)) {
    res.status(400).json({
      error: 'Request must be {"title": string, "findingIds": string[1+]}',
      code: "INVALID_REQUEST",
    });
    return;
  }

  const controller = abortOnClientDisconnect(res);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const report = await createReport(
      missionIdOf(req),
      body.title,
      body.findingIds,
      (content) => res.write(`${JSON.stringify({ type: "chunk", content })}\n`),
      controller.signal,
      body.agentId,
      body.model,
    );
    res.write(`${JSON.stringify({ type: "report", report })}\n`);
    res.end();
  } catch (err) {
    if (err instanceof RequestCancelledError) {
      res.end();
      return;
    }
    if (!res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    res.end();
  }
});

missionReportsRouter.patch("/:id", async (req, res, next) => {
  const status = (req.body as { status?: unknown }).status;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status as ReportStatus)) {
    res.status(400).json({
      error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      code: "INVALID_REQUEST",
    });
    return;
  }
  try {
    const report = await updateReportStatus(req.params.id, status as ReportStatus);
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

missionReportsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteReport(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
