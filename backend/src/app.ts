import express, { type Express } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { modelsRouter } from "./routes/models.js";
import { setupRouter } from "./routes/setup.js";
import { chatRouter } from "./routes/chat.js";
import { agentsRouter } from "./routes/agents.js";
import { toolsRouter } from "./routes/tools.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { missionsRouter } from "./routes/missions.js";
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

/**
 * The whole HTTP surface - middleware, routers, error handler - without listening or loading
 * anything from disk. index.ts listens; the route tests (src/routes/*.routes.test.ts) call this
 * so they go through the same guards and mount paths as the real server.
 */
export function createApp(): Express {
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
  app.use("/api/setup", setupRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/tools/request", requireMission);
  app.use("/api/tools", toolsRouter);
  app.use("/api/orchestrator", orchestratorRouter);
  app.use("/api/missions", missionsRouter);
  app.use("/api/missions/:missionId/findings", requireMission, missionFindingsRouter);
  app.use("/api/findings", findingsRouter);
  app.use("/api/rag", ragRouter);
  app.use("/api/mcp", mcpRouter);
  app.use("/api/scanners", scannersRouter);
  app.use("/api/missions/:missionId/scans", requireMission, missionScansRouter);
  app.use("/api/missions/:missionId/reports", requireMission, missionReportsRouter);
  app.use("/api/missions/:missionId/assets", requireMission, missionAssetsRouter);
  app.use("/api/missions/:missionId/workorders", requireMission, missionWorkOrdersRouter);

  app.use(errorHandler);

  return app;
}
