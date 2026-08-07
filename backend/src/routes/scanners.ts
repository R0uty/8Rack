import { Router } from "express";
import { listScanProfiles } from "../extensions/scannerRegistry.js";
import { abortOnClientDisconnect } from "./streamUtils.js";
import { cancelScanRun, createScanRun, getScan, listScans, previewScan } from "../services/scanRunner.js";
import type { ScanEvent } from "../services/scanRunner.js";

/** Flat, unscoped route - the profile roster isn't per-project. GET /api/scanners. */
export const scannersRouter = Router();

scannersRouter.get("/", (_req, res) => {
  res.json({ profiles: listScanProfiles() });
});

/** Project-scoped scan routes - GET/POST /api/projects/:projectId/scans[...]. MUST be created with
 * { mergeParams: true } or req.params.projectId is undefined once mounted under a parent router's
 * :projectId segment (backend/src/index.ts) - see routes/findings.ts for the same requirement. */
export const projectScansRouter = Router({ mergeParams: true });

function projectIdOf(req: { params: Record<string, string> }): string {
  return req.params.projectId;
}

interface ScanRequestBody {
  profileId?: unknown;
  target?: unknown;
}

function isValidScanRequest(body: ScanRequestBody): body is { profileId: string; target: string } {
  return (
    typeof body.profileId === "string" &&
    body.profileId.trim().length > 0 &&
    typeof body.target === "string" &&
    body.target.trim().length > 0
  );
}

projectScansRouter.get("/", (req, res) => {
  res.json({ scans: listScans(projectIdOf(req)) });
});

projectScansRouter.get("/:id", (req, res) => {
  const scan = getScan(req.params.id);
  if (!scan) {
    res.status(404).json({ error: `Scan "${req.params.id}" was not found`, code: "SCAN_NOT_FOUND" });
    return;
  }
  res.json({ scan });
});

projectScansRouter.post("/preview", (req, res, next) => {
  const body = req.body as ScanRequestBody;
  if (!isValidScanRequest(body)) {
    res
      .status(400)
      .json({ error: 'Request must be {"profileId": string, "target": string}', code: "INVALID_REQUEST" });
    return;
  }
  try {
    res.json({ preview: previewScan(body.profileId, body.target) });
  } catch (err) {
    next(err);
  }
});

/**
 * Starts a scan run and streams NDJSON progress ({type:"scan"|"step"|"output"}) as each chained
 * step executes, one request for the whole profile - mirrors routes/orchestrator.ts's
 * runAndStreamTask/routes/tools.ts's confirm-execution stream. A client disconnect cancels the
 * scan the same way it cancels a single tool execution or an orchestrator task.
 */
projectScansRouter.post("/", async (req, res, next) => {
  const body = req.body as ScanRequestBody;
  if (!isValidScanRequest(body)) {
    res
      .status(400)
      .json({ error: 'Request must be {"profileId": string, "target": string}', code: "INVALID_REQUEST" });
    return;
  }

  let scanId: string | undefined;
  const controller = abortOnClientDisconnect(res);
  controller.signal.addEventListener("abort", () => {
    if (!scanId) return;
    try {
      cancelScanRun(scanId);
    } catch {
      // Already finished before the disconnect was noticed.
    }
  });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  try {
    const scan = await createScanRun(projectIdOf(req), body.profileId, body.target, (event: ScanEvent) => {
      if (event.type === "scan") scanId = event.scan.id;
      res.write(`${JSON.stringify(event)}\n`);
    });
    res.write(`${JSON.stringify({ type: "done", scan })}\n`);
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

projectScansRouter.post("/:id/cancel", (req, res, next) => {
  try {
    res.json({ scan: cancelScanRun(req.params.id) });
  } catch (err) {
    next(err);
  }
});
