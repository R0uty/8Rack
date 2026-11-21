import { mkdir } from "node:fs/promises";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { loadAgents } from "./services/agentManager.js";
import {
  abortAllExecutions,
  listExecToolsWithStatus,
  loadExecutionsFromDisk,
  loadToolOverridesFromDisk,
  registerExecTool,
} from "./services/toolManager.js";
import { loadTasksFromDisk } from "./services/orchestrator.js";
import { loadFindingsFromDisk } from "./services/findingsManager.js";
import { loadAssetsFromDisk } from "./services/assetManager.js";
import { loadWorkOrdersFromDisk } from "./services/workOrderManager.js";
import { loadScansFromDisk } from "./services/scanRunner.js";
import { loadReportsFromDisk } from "./services/reportManager.js";
import { loadActivityFromDisk } from "./services/activityLog.js";
import { listMissions } from "./services/missionManager.js";
import { getStatus as getRagStatus, loadIndexFromDisk } from "./services/ragIndex.js";
import { refreshStatus as refreshKnowledgeBaseStatus } from "./services/knowledgeBase.js";
import { listServers as listMcpServers, refreshServers as refreshMcpServers } from "./services/mcpClient.js";
import { builtinExecTools } from "./tools/exec/builtins.js";
import { registerScanProfile } from "./extensions/scannerRegistry.js";
import { builtinScanProfiles } from "./scanners/builtins.js";

for (const tool of builtinExecTools) registerExecTool(tool);
for (const profile of builtinScanProfiles) registerScanProfile(profile);

const app = createApp();


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
    await loadFindingsFromDisk();
    await loadAssetsFromDisk();
    await loadWorkOrdersFromDisk();
    await loadScansFromDisk();
    await loadReportsFromDisk();
    await loadActivityFromDisk();
    console.log(
      `Loaded ${missions.length} mission(s) with persisted execution/task/finding/asset/work-order/scan/report/activity history`,
    );

    if (env.mcpRagServer) {
      // Not awaited, like the MCP check below. Until it answers, agents aren't offered the knowledge base.
      const server = env.mcpRagServer;
      void refreshKnowledgeBaseStatus().then(
        (s) => console.log(`Knowledge base: MCP server "${server}", ${s.chunkCount} chunk(s) across ${s.fileCount} file(s)`),
        (err: unknown) => console.warn(`Knowledge base: ${err instanceof Error ? err.message : String(err)}`),
      );
    } else {
      await loadIndexFromDisk();
      const ragStatus = getRagStatus();
      console.log(
        ragStatus.indexedAt
          ? `RAG index loaded: ${ragStatus.chunkCount} chunk(s) across ${ragStatus.fileCount} file(s) (${ragStatus.embeddingModel})`
          : "RAG index not built yet - POST /api/rag/reindex once an embedding model is pulled",
      );
    }

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
        "tasks/findings/scans/reports) or the RAG index may not have loaded. The server is " +
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
