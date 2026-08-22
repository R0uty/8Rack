import { mkdir } from "node:fs/promises";
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { modelsRouter } from "./routes/models.js";
import { chatRouter } from "./routes/chat.js";
import { agentsRouter } from "./routes/agents.js";
import { toolsRouter } from "./routes/tools.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { missionsRouter } from "./routes/missions.js";
import { plansRouter } from "./routes/plans.js";
import { ragRouter } from "./routes/rag.js";
import { findingsRouter, missionFindingsRouter } from "./routes/findings.js";
import { missionScansRouter, scannersRouter } from "./routes/scanners.js";
import { missionReportsRouter } from "./routes/reports.js";
import { missionAssetsRouter } from "./routes/assets.js";
import { missionWorkOrdersRouter } from "./routes/workOrders.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { hostCheck } from "./middleware/hostCheck.js";
import { loadAgents } from "./services/agentManager.js";
import {
  listExecToolsWithStatus,
  loadExecutionsFromDisk,
  loadToolOverridesFromDisk,
  registerExecTool,
} from "./services/toolManager.js";
import { loadTasksFromDisk } from "./services/orchestrator.js";
import { loadPlansFromDisk } from "./services/multiAgentOrchestrator.js";
import { loadFindingsFromDisk } from "./services/findingsManager.js";
import { loadAssetsFromDisk } from "./services/assetManager.js";
import { loadWorkOrdersFromDisk } from "./services/workOrderManager.js";
import { loadScansFromDisk } from "./services/scanRunner.js";
import { loadReportsFromDisk } from "./services/reportManager.js";
import { loadActivityFromDisk } from "./services/activityLog.js";
import { listMissions } from "./services/missionManager.js";
import { getStatus as getRagStatus, loadIndexFromDisk } from "./services/ragIndex.js";
import { builtinExecTools } from "./tools/exec/builtins.js";
import { registerScanProfile } from "./extensions/scannerRegistry.js";
import { builtinScanProfiles } from "./scanners/builtins.js";

for (const tool of builtinExecTools) registerExecTool(tool);
for (const profile of builtinScanProfiles) registerScanProfile(profile);

const app = express();

app.use(hostCheck);
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/models", modelsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/tools", toolsRouter);
app.use("/api/orchestrator", orchestratorRouter);
app.use("/api/missions", missionsRouter);
app.use("/api/missions/:missionId/findings", missionFindingsRouter);
app.use("/api/findings", findingsRouter);
app.use("/api/plans", plansRouter);
app.use("/api/rag", ragRouter);
app.use("/api/scanners", scannersRouter);
app.use("/api/missions/:missionId/scans", missionScansRouter);
app.use("/api/missions/:missionId/reports", missionReportsRouter);
app.use("/api/missions/:missionId/assets", missionAssetsRouter);
app.use("/api/missions/:missionId/workorders", missionWorkOrdersRouter);

app.use(errorHandler);

app.listen(env.port, env.host, async () => {
  console.log(`Backend listening on http://${env.host}:${env.port}`);

  // The server is already accepting connections by the time this runs - none of the routes above
  // depend on this hydration to function (they read straight from each service's in-memory state,
  // which just starts empty until this fills it in), so a failure here shouldn't take the process
  // down. But left unguarded, one bad step throwing was an unhandled rejection that silently
  // aborted everything after it with zero indication why (e.g. the RAG index quietly never
  // loading). Log clearly instead so the actual problem is visible and the server stays usable in
  // the meantime - restarting after fixing the underlying issue re-runs this from the top.
  try {
    const agents = await loadAgents();
    const online = agents.filter((a) => a.status === "online").length;
    console.log(`Loaded ${agents.length} agent(s): ${online} online, ${agents.length - online} offline`);

    await mkdir(env.workspaceRoot, { recursive: true });
    await loadToolOverridesFromDisk();
    const tools = listExecToolsWithStatus();
    const available = tools.filter((t) => t.availability === "available").length;
    console.log(
      `Loaded ${tools.length} tool(s): ${available} available, ${tools.length - available} unavailable ` +
        `(workspace: ${env.workspaceRoot})`,
    );

    const missions = await listMissions();
    await loadExecutionsFromDisk();
    await loadTasksFromDisk();
    await loadPlansFromDisk();
    await loadFindingsFromDisk();
    await loadAssetsFromDisk();
    await loadWorkOrdersFromDisk();
    await loadScansFromDisk();
    await loadReportsFromDisk();
    await loadActivityFromDisk();
    console.log(
      `Loaded ${missions.length} mission(s) with persisted execution/task/plan/finding/asset/work-order/scan/report/activity history`,
    );

    await loadIndexFromDisk();
    const ragStatus = getRagStatus();
    console.log(
      ragStatus.indexedAt
        ? `RAG index loaded: ${ragStatus.chunkCount} chunk(s) across ${ragStatus.fileCount} file(s) (${ragStatus.embeddingModel})`
        : "RAG index not built yet - POST /api/rag/reindex once an embedding model is pulled",
    );
  } catch (err) {
    console.error(
      "Startup hydration failed partway through - some persisted history (agents/tools/executions/" +
        "tasks/plans/findings/scans/reports) or the RAG index may not have loaded. The server is " +
        "still running; fix the underlying issue below and restart to retry.",
      err,
    );
  }
});
