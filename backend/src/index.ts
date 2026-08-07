import { mkdir } from "node:fs/promises";
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { modelsRouter } from "./routes/models.js";
import { chatRouter } from "./routes/chat.js";
import { agentsRouter } from "./routes/agents.js";
import { toolsRouter } from "./routes/tools.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { projectsRouter } from "./routes/projects.js";
import { plansRouter } from "./routes/plans.js";
import { ragRouter } from "./routes/rag.js";
import { findingsRouter, projectFindingsRouter } from "./routes/findings.js";
import { projectScansRouter, scannersRouter } from "./routes/scanners.js";
import { projectReportsRouter } from "./routes/reports.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { loadAgents } from "./services/agentManager.js";
import { listExecToolsWithStatus, loadExecutionsFromDisk, registerExecTool } from "./services/toolManager.js";
import { loadTasksFromDisk } from "./services/orchestrator.js";
import { loadPlansFromDisk } from "./services/multiAgentOrchestrator.js";
import { loadFindingsFromDisk } from "./services/findingsManager.js";
import { loadScansFromDisk } from "./services/scanRunner.js";
import { loadReportsFromDisk } from "./services/reportManager.js";
import { listProjects } from "./services/projectManager.js";
import { getStatus as getRagStatus, loadIndexFromDisk } from "./services/ragIndex.js";
import { builtinExecTools } from "./tools/exec/builtins.js";
import { registerScanProfile } from "./extensions/scannerRegistry.js";
import { builtinScanProfiles } from "./scanners/builtins.js";

for (const tool of builtinExecTools) registerExecTool(tool);
for (const profile of builtinScanProfiles) registerScanProfile(profile);

const app = express();

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
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:projectId/findings", projectFindingsRouter);
app.use("/api/findings", findingsRouter);
app.use("/api/plans", plansRouter);
app.use("/api/rag", ragRouter);
app.use("/api/scanners", scannersRouter);
app.use("/api/projects/:projectId/scans", projectScansRouter);
app.use("/api/projects/:projectId/reports", projectReportsRouter);

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
    const tools = listExecToolsWithStatus();
    const available = tools.filter((t) => t.availability === "available").length;
    console.log(
      `Loaded ${tools.length} tool(s): ${available} available, ${tools.length - available} unavailable ` +
        `(workspace: ${env.workspaceRoot})`,
    );

    const projects = await listProjects();
    await loadExecutionsFromDisk();
    await loadTasksFromDisk();
    await loadPlansFromDisk();
    await loadFindingsFromDisk();
    await loadScansFromDisk();
    await loadReportsFromDisk();
    console.log(
      `Loaded ${projects.length} project(s) with persisted execution/task/plan/finding/scan/report history`,
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
