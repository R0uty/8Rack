import { Router } from "express";
import {
  buildFindingsGraph,
  createFinding,
  deleteFinding,
  listFindings,
  lookupCvesForFinding,
  searchFindings,
  updateFinding,
} from "../services/findingsManager.js";
import type { FindingCreateInput, FindingFilters, FindingPatchInput, FindingSeverity, FindingType } from "../types/finding.js";

const VALID_TYPES: FindingType[] = [
  "port",
  "service",
  "technology",
  "domain",
  "subdomain",
  "directory",
  "endpoint",
  "credential",
  "cookie",
  "api",
  "header",
  "interesting_file",
  "potential_vulnerability",
  "confirmed_vulnerability",
  "information",
  "cve",
];
const VALID_SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];
const VALID_STATUSES = ["potential", "investigating", "confirmed", "false_positive", "reported", "duplicate"];

function parseFiltersFromQuery(query: Record<string, unknown>): FindingFilters {
  const filters: FindingFilters = {};
  if (typeof query.type === "string" && VALID_TYPES.includes(query.type as FindingType)) filters.type = query.type as FindingType;
  if (typeof query.severity === "string" && VALID_SEVERITIES.includes(query.severity as FindingSeverity)) {
    filters.severity = query.severity as FindingSeverity;
  }
  if (typeof query.tool === "string" && query.tool.trim()) filters.tool = query.tool;
  if (typeof query.target === "string" && query.target.trim()) filters.target = query.target;
  if (typeof query.tag === "string" && query.tag.trim()) filters.tag = query.tag;
  if (typeof query.agent === "string" && query.agent.trim()) filters.agent = query.agent;
  if (typeof query.minConfidence === "string" && query.minConfidence.trim()) {
    const parsed = Number(query.minConfidence);
    if (!Number.isNaN(parsed)) filters.minConfidence = parsed;
  }
  return filters;
}

interface CreateFindingBody {
  type?: unknown;
  severity?: unknown;
  title?: unknown;
  description?: unknown;
  target?: unknown;
  value?: unknown;
  tool?: unknown;
  confidence?: unknown;
  parameter?: unknown;
  impact?: unknown;
  reproductionSteps?: unknown;
  metadata?: unknown;
  evidence?: unknown;
  tags?: unknown;
}

function isValidCreateBody(body: CreateFindingBody): body is CreateFindingBody & FindingCreateInput {
  return (
    typeof body.type === "string" &&
    VALID_TYPES.includes(body.type as FindingType) &&
    typeof body.severity === "string" &&
    VALID_SEVERITIES.includes(body.severity as FindingSeverity) &&
    typeof body.title === "string" &&
    body.title.trim().length > 0 &&
    typeof body.description === "string" &&
    typeof body.target === "string" &&
    body.target.trim().length > 0 &&
    typeof body.value === "string" &&
    body.value.trim().length > 0 &&
    (body.tool === undefined || typeof body.tool === "string") &&
    (body.confidence === undefined || typeof body.confidence === "number") &&
    (body.parameter === undefined || typeof body.parameter === "string") &&
    (body.impact === undefined || typeof body.impact === "string") &&
    (body.reproductionSteps === undefined || typeof body.reproductionSteps === "string") &&
    (body.evidence === undefined || typeof body.evidence === "string") &&
    (body.tags === undefined || (Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string")))
  );
}

interface PatchFindingBody {
  severity?: unknown;
  status?: unknown;
  tags?: unknown;
  description?: unknown;
  title?: unknown;
  confidence?: unknown;
  parameter?: unknown;
  impact?: unknown;
  reproductionSteps?: unknown;
}

function isValidPatchBody(body: PatchFindingBody): body is PatchFindingBody & FindingPatchInput {
  return (
    (body.severity === undefined || (typeof body.severity === "string" && VALID_SEVERITIES.includes(body.severity as FindingSeverity))) &&
    (body.status === undefined || (typeof body.status === "string" && VALID_STATUSES.includes(body.status))) &&
    (body.tags === undefined || (Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string"))) &&
    (body.description === undefined || typeof body.description === "string") &&
    (body.title === undefined || typeof body.title === "string") &&
    (body.confidence === undefined || typeof body.confidence === "number") &&
    (body.parameter === undefined || typeof body.parameter === "string") &&
    (body.impact === undefined || typeof body.impact === "string") &&
    (body.reproductionSteps === undefined || typeof body.reproductionSteps === "string")
  );
}

/** Project-scoped findings routes - GET /api/projects/:projectId/findings[...]. MUST be created
 * with { mergeParams: true } or req.params.projectId is undefined once mounted under a parent
 * router's :projectId segment (backend/src/index.ts). */
export const projectFindingsRouter = Router({ mergeParams: true });

function projectIdOf(req: { params: Record<string, string> }): string {
  return req.params.projectId;
}

projectFindingsRouter.get("/", (req, res) => {
  res.json({ findings: listFindings(projectIdOf(req), parseFiltersFromQuery(req.query as Record<string, unknown>)) });
});

projectFindingsRouter.get("/search", (req, res) => {
  const { q } = req.query;
  if (typeof q !== "string" || !q.trim()) {
    res.status(400).json({ error: "q query parameter is required", code: "INVALID_REQUEST" });
    return;
  }
  res.json({ findings: searchFindings(projectIdOf(req), q) });
});

projectFindingsRouter.get("/graph", (req, res) => {
  res.json({ graph: buildFindingsGraph(projectIdOf(req)) });
});

projectFindingsRouter.post("/", async (req, res, next) => {
  const body = req.body as CreateFindingBody;
  if (!isValidCreateBody(body)) {
    res.status(400).json({
      error: "Request must include type, severity, title, description, target, and value",
      code: "INVALID_REQUEST",
    });
    return;
  }
  try {
    const finding = await createFinding(projectIdOf(req), body);
    res.status(201).json({ finding });
  } catch (err) {
    next(err);
  }
});

/** Flat, id-scoped findings routes - GET/PATCH/DELETE /api/findings/:id. */
export const findingsRouter = Router();

findingsRouter.patch("/:id", async (req, res, next) => {
  const body = req.body as PatchFindingBody;
  if (!isValidPatchBody(body)) {
    res.status(400).json({
      error:
        "Invalid patch body - severity/status/tags/description/title/confidence/parameter/impact/reproductionSteps must be well-formed if present",
      code: "INVALID_REQUEST",
    });
    return;
  }
  try {
    const finding = await updateFinding(req.params.id, body);
    res.json({ finding });
  } catch (err) {
    next(err);
  }
});

findingsRouter.delete("/:id", async (req, res, next) => {
  try {
    await deleteFinding(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Queries the public NVD database (see services/cveLookup.ts) for CVEs matching this finding's
 * title, creating a linked "cve" finding for each result. The only route in the app that triggers
 * an outbound internet call - always explicit (a user click or an agent tool call), never automatic. */
findingsRouter.post("/:id/cve-lookup", async (req, res, next) => {
  try {
    const findings = await lookupCvesForFinding(req.params.id);
    res.json({ findings });
  } catch (err) {
    next(err);
  }
});
