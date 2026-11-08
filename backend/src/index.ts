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
import { mcpRouter } from "./routes/mcp.js";
import { findingsRouter, missionFindingsRouter } from "./routes/findings.js";
import { missionScansRouter, scannersRouter } from "./routes/scanners.js";
import { missionReportsRouter } from "./routes/reports.js";
import { missionAssetsRouter } from "./routes/assets.js";
import { missionWorkOrdersRouter } from "./routes/workOrders.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { hostCheck } from "./middleware/hostCheck.js";
import { originCheck } from "./middleware/originCheck.js";
import { requireMission } from "./middleware/requireMission.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { loadAgents } from "./services/agentManager.js";
import {
  abortAllExecutions,
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
import {
  listServers as listMcpServers,
  loadMcpToolOverridesFromDisk,
  refreshServers as refreshMcpServers,
} from "./services/mcpClient.js";
import { builtinExecTools } from "./tools/exec/builtins.js";
import { registerScanProfile } from "./extensions/scannerRegistry.js";
import { builtinScanProfiles } from "./scanners/builtins.js";

for (const tool of builtinExecTools) registerExecTool(tool);
for (const profile of builtinScanProfiles) registerScanProfile(profile);

const app = express();

app.use(hostCheck);
app.use(securityHeaders);
app.use(originCheck);
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());
// Express 5 leaves req.body undefined when nothing was parsed - every route's validation expects an
// object, and a bodyless POST should get its 400, not a TypeError's 500.
app.use((req, _res, next) => {
  req.body ??= {};
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/models", modelsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/tools/request", requireMission);
app.use("/api/tools", toolsRouter);
app.use("/api/orchestrator/tasks", (req, res, next) => (req.path === "/" ? requireMission(req, res, next) : next()));
app.use("/api/orchestrator", orchestratorRouter);
app.use("/api/missions", missionsRouter);
app.use("/api/missions/:missionId/findings", requireMission, missionFindingsRouter);
app.use("/api/findings", findingsRouter);
app.use("/api/plans", (req, res, next) => (req.path === "/" ? requireMission(req, res, next) : next()));
app.use("/api/plans", plansRouter);
app.use("/api/rag", ragRouter);
app.use("/api/mcp", mcpRouter);
app.use("/api/scanners", scannersRouter);
app.use("/api/missions/:missionId/scans", requireMission, missionScansRouter);
app.use("/api/missions/:missionId/reports", requireMission, missionReportsRouter);
app.use("/api/missions/:missionId/assets", missionAssetsRouter);
app.use("/api/missions/:missionId/workorders", requireMission, missionWorkOrdersRouter);

app.use(errorHandler);

const server = app.listen(env.port, env.host, async (listenError?: Error) => {
  // Express 5 calls this on a failed bind too (e.g. EADDRINUSE) - carrying on would announce a server
  // that isn't listening, hydrate it, and exit silently once there's nothing left to do.
  if (listenError) {
    console.error(`Could not listen on ${env.host}:${env.port}:`, listenError.message);
    process.exit(1);
  }

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

    // Before the first check, so the first registry rebuild already knows which tools a human enabled.
    await loadMcpToolOverridesFromDisk();
    // Not awaited - a slow or unreachable MCP server shouldn't hold up anything else, and the Tools
    // page shows each server as "checking" until this finishes.
    if (listMcpServers().length > 0) {
      void refreshMcpServers().then((servers) =>
        console.log(
          `MCP: ${servers
            .map((s) => (s.state === "online" ? `${s.id} online (${s.tools.length} tool(s))` : `${s.id} ${s.state}: ${s.error}`))
            .join("; ")}`,
        ),
      );
    }
  } catch (err) {
    console.error(
      "Startup hydration failed partway through - some persisted history (agents/tools/executions/" +
        "tasks/plans/findings/scans/reports) or the RAG index may not have loaded. The server is " +
        "still running; fix the underlying issue below and restart to retry.",
      err,
    );
  }
});

// Tools run in their own process groups (see toolExecutor.ts), so a signal to this process doesn't
// reach them - without this, every restart (tsx watch included) leaves running scans behind as
// orphans. Second signal, or a shutdown that hangs on an open stream, exits regardless.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log(`${signal} received - stopping running tools and shutting down`);
  abortAllExecutions();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
