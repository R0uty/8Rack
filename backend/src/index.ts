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
import { errorHandler } from "./middleware/errorHandler.js";
import { loadAgents } from "./services/agentManager.js";
import { listExecToolsWithStatus, loadExecutionsFromDisk, registerExecTool } from "./services/toolManager.js";
import { loadTasksFromDisk } from "./services/orchestrator.js";
import { loadPlansFromDisk } from "./services/multiAgentOrchestrator.js";
import { loadFindingsFromDisk } from "./services/findingsManager.js";
import { listProjects } from "./services/projectManager.js";
import { getStatus as getRagStatus, loadIndexFromDisk } from "./services/ragIndex.js";
import { builtinExecTools } from "./tools/exec/builtins.js";

for (const tool of builtinExecTools) registerExecTool(tool);

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

app.use(errorHandler);

app.listen(env.port, async () => {
  console.log(`Backend listening on http://localhost:${env.port}`);

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
  console.log(`Loaded ${projects.length} project(s) with persisted execution/task/plan/finding history`);

  await loadIndexFromDisk();
  const ragStatus = getRagStatus();
  console.log(
    ragStatus.indexedAt
      ? `RAG index loaded: ${ragStatus.chunkCount} chunk(s) across ${ragStatus.fileCount} file(s) (${ragStatus.embeddingModel})`
      : "RAG index not built yet - POST /api/rag/reindex once an embedding model is pulled",
  );
});
