# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

8Rack is a local, no-cloud AI-powered bug bounty factory built on top of a local
[Ollama](https://ollama.com) instance. An authorized engagement is modeled as a **Mission** (scope,
out-of-scope, rules of engagement) that runs through a factory pipeline - Scope → Recon → Asset
Discovery → Enumeration → Analysis → Vulnerability Discovery → Validation → Evidence → Report →
Human Review - driven by purpose-built agents, real tool execution gated behind human confirmation,
and a Factory Director that reads a mission's scope/assets/findings and advances that pipeline on
its own between approvals. Two main workspaces, no shared root `package.json`: `backend/` (Express +
TypeScript, ESM) and `frontend/` (React + TypeScript + Vite), plus `mcp-servers/rag/` - an optional
Python MCP server for the knowledge base, with its own venv and tests (`.venv/bin/python -m pytest`; see
its README). No accounts, no external database, no cloud storage - everything is local by design.

For the full build history, key architectural decisions (and why), and known gaps, read
`DEVELOPMENT.md` before making non-trivial changes - it has context that isn't obvious from the
code alone, including the "Bug Bounty Factory transformation" and "Nav simplification" sections
covering the most recent large changes. `TODO.md` has the current actionable next-steps list.

## Commands

Run from the relevant workspace directory (`backend/` or `frontend/`), not the repo root - there
is no root `package.json`.

```bash
# One-time setup
cd backend && cp .env.example .env && npm install
cd frontend && npm install

# Run both dev servers together (kills stale instances first, requires Ollama already running)
./start.sh

# Or run them separately
cd backend && npm run dev     # tsx watch src/index.ts   -> http://localhost:3001
cd frontend && npm run dev    # vite                     -> http://localhost:5173 (frontend proxies /api/* to backend)

# Backend
cd backend && npm run typecheck   # tsc --noEmit
cd backend && npm run build       # tsc -> dist/
cd backend && npm start           # node dist/index.js (run build first)

# Frontend
cd frontend && npx tsc -b         # typecheck (no separate `typecheck` script)
cd frontend && npm run lint       # oxlint
cd frontend && npm run build      # tsc -b && vite build
```

Automated tests exist on both sides: `cd backend && npm test` (Vitest, service-level unit tests)
and `cd frontend && npm test` (Vitest + React Testing Library). Verification for a given change is
still routinely rounded out with manual `curl` against the backend and browser automation against
the frontend - see `DEVELOPMENT.md` for what's been verified live vs. by tests alone.

Ollama must be running separately (`ollama serve`, default `http://localhost:11434`) - this
project only wraps it, it doesn't manage its lifecycle.

## Architecture

The frontend never talks to Ollama directly - everything goes through the backend, which just
calls `/api/*` and stays unaware of Ollama's existence. Every route/feature below is fully built
(not a placeholder) unless explicitly marked otherwise; `DEVELOPMENT.md` has a dedicated section
per feature with the full design rationale and what was verified - this section is just the map.

```
backend/src/
├── config/env.ts      PORT, HOST (default 127.0.0.1 - no auth on this app, see below),
│                       OLLAMA_BASE_URL, CORS_ORIGIN, WORKSPACE_ROOT, orchestrator loop-prevention
│                       caps, EMBEDDING_MODEL, OLLAMA_NUM_CTX, NVD_API_KEY, MCP_SERVERS, MCP_RAG_SERVER (all from
│                       .env; each MCP server's token comes from its own MCP_TOKEN_<ID>)
├── routes/             one file per concern: models, chat, agents, tools, orchestrator, missions,
│                       assets, workOrders, findings, plans (multi-agent), rag, scanners, reports, mcp
├── services/           the real logic - see the list below
├── middleware/         errorHandler.ts - maps every domain Error subclass (services/errors.ts) to
│                       an HTTP status + JSON body; every route's catch/next(err) funnels here.
│                       hostCheck/originCheck block DNS rebinding and cross-site POSTs (no auth on
│                       this app); requireMission 404s writes to a mission that doesn't exist
├── types/              domain types - Agent, OllamaModel, ChatRequest/ChatResponseChunk, ExecTool,
│                       Finding, Mission, Asset, WorkOrder, MissionEvent, ScanProfile/ScanRun,
│                       Report, RagSearchResult, plus the one extension-point type that is still
│                       genuinely unbuilt (tool.ts - see "Later" in TODO.md)
├── extensions/         toolRegistry.ts (wired into the native Ollama tool-calling path, but zero
│                       tools registered - see "Two tool-calling mechanisms" below) and
│                       scannerRegistry.ts (real - holds the built-in Scan Profiles) are live;
│                       the still-unbuilt Plugin system's retrievalRegistry.ts/pluginRegistry.ts/
│                       types/plugin.ts were deleted (commit a65fb26) rather than kept around dead
├── tools/exec/builtins.ts   the ~20 built-in ExecTools (nmap, ffuf, nuclei, httpx, bash, python,
│                       filesystem ops, ...) - every one requires human confirmation before running
├── scanners/builtins.ts     the 4 built-in Scan Profiles (fixed chains of ExecTool steps - Quick
│                       Recon, Subdomain Discovery, Web App Scan, Full Port Scan)
└── parsers/            one parser per recon tool (nmap/httpx/ffuf/katana/nuclei/subfinder/dig/
                        whois), turning raw tool output into structured Findings
```

Key files under `backend/src/services/`:

| File | Owns |
| --- | --- |
| `ollama.ts` | The only place that talks to Ollama's REST API - chat streaming, embeddings, native tool-calling (`streamChatWithTools`) |
| `agentManager.ts` / `chatService.ts` | Loads `backend/data/agents/*.json`, assembles a chat request from an agent's config. `agentManager.ts` caches the list after first load - a direct file edit needs `POST /api/agents/reload` (or a create/update/delete through the API) to take effect, it is *not* re-read on every request |
| `toolManager.ts` / `toolExecutor.ts` | Human-confirmation-gated OS process execution, workspace-sandboxed, per-mission execution history |
| `orchestrator.ts` / `multiAgentOrchestrator.ts` | The autonomous tool-calling loop - single-agent task, or a chained multi-agent plan. Both still real and load-bearing: every Work Order runs on `orchestrator.ts` underneath, and `factoryDirector.ts` follows the same reuse pattern `multiAgentOrchestrator.ts` established one level down |
| `missionManager.ts` / `missionStore.ts` | The mission-scoping primitive everything else below is keyed on - see "Missions" below |
| `assetManager.ts` | The Asset Inventory - a real, deduplicated store (`upsertAsset`) of everything discovered about a mission, with a parent/child relationship tree |
| `workOrderManager.ts` | Security Work Orders - a trackable unit of agent work backed 1:1 by a real `OrchestratorTask` |
| `factoryDirector.ts` | The Factory Director - reads a mission's scope/assets/findings/work orders and deterministically seeds/starts Work Orders, auto-chaining through everything that doesn't need human approval. Also resumes paused orders whose execution a human has settled. Request-driven (`POST /api/missions/:id/factory/advance`), not a background timer |
| `activityLog.ts` | The Mission Activity Timeline - an explicit, named-event append-only log (`logActivity`), not derived from executions/tasks |
| `findingsManager.ts` / `cveLookup.ts` | The Findings Engine (parses tool output into structured, deduplicated findings) + on-demand NVD CVE correlation. Also owns the `validate_finding`-driven Finding Validation transition (`validateFinding`) |
| `knowledgeBase.ts` | The one entry point for the knowledge base (Orchestrator's `search_knowledge_base`, `/api/rag/*`, startup) - routes to the RAG MCP server named by `MCP_RAG_SERVER`, or to `ragIndex.ts` when unset. No fallback to the local index when the server is down |
| `ragIndex.ts` | The built-in knowledge-base indexer/search over `WORKSPACE_ROOT` - only reached through `knowledgeBase.ts` |
| `mcpClient.ts` | 8Rack as an MCP client - connects to the servers in `MCP_SERVERS`, lists their tools (Tools → MCP servers), and `callTool` (used only by `knowledgeBase.ts` so far; agents can't call MCP tools by name yet). See "Planned: MCP servers as the tool and RAG providers" and "RAG server (step 2)" in `DEVELOPMENT.md` |
| `scanRunner.ts` | Scan Profiles - deterministic (non-agent) chained tool runs |
| `reportManager.ts` / `reportEvidence.ts` | Report generation - one Report Writer agent call over a set of selected findings, tracked through a `status` field (`draft/ai_generated/human_review/ready/submitted`). The agent writes only the summary, impact and remediation; evidence and reproduction are built from recorded executions, and anything else on a finding is labelled unverified |

```
backend/data/
├── agents/*.json          One file per agent (name, model, temperature, systemPrompt, description,
│                           optional tools[]/execTools[]).
├── missions/<id>/*.json   Per-mission history (mission.json, executions/tasks/plans/findings/scans/
│                           reports/assets/workorders/activity.json), write-through on every
│                           mutation. Gitignored - may contain sensitive target/scope info.
└── rag/index.json         The RAG knowledge-base index. Gitignored.
```

```
frontend/src/
├── components/         One top-level component per nav view - FactoryDashboard (+FactoryPipeline/
│                        ApprovalQueue), AssetsView, WorkOrdersView, FindingsView (+FindingDetails/
│                        FindingsTable), ReportsView, AgentsView, ToolsView (tabs: ScannerPanel/
│                        ExecutionHistoryPanel/ToolRegistry/KnowledgeBasePanel). MissionSwitcher +
│                        MissionEditor are the only mission picker/editor. components/layout/
│                        (AppShell, Sidebar, TopBar) and components/ui/ (GlassPanel, Button, Sheet,
│                        StatusPill, ...) are the shared primitives every view is built from. See
│                        "UI cleanup" in DEVELOPMENT.md for what was cut and why. There is no Chat/
│                        Workbench/Plans surface any more - see "Nav simplification" in
│                        DEVELOPMENT.md for why (Work Orders replaced Workbench's freestanding
│                        agent-run-a-tool UI, the Factory Director replaced hand-authored Plans,
│                        and plain no-mission Chat never fit the mission model).
├── hooks/               One hook per domain - useModels, useAgents, useTools, useMissions,
│                        useAssets, useWorkOrders, useFindings, useScans, useReports, useActivity,
│                        useRag, useTheme - each owns its own fetching/state; App.tsx composes
│                        them. Plus useSelectedMission (the one current mission, in localStorage)
│                        and useRefreshOnActivate (re-fetch when a kept-mounted view is shown again).
├── services/            One `*Api.ts` file per domain, all built on `services/httpClient.ts`
│                        (`apiFetch`/`readNdjsonStream`/`throwForErrorResponse` - the shared
│                        NDJSON-stream-reading and error-unwrapping logic every domain reuses).
│                        `orchestratorApi.ts` is trimmed to just `fetchTask` - the one read-only
│                        task lookup WorkOrdersView's "Inspect" still needs; task creation/resume/
│                        cancel/guidance only happen server-side now.
└── types/               Mirrors of the backend types.
```

### Streaming protocol

`POST /api/chat` streams newline-delimited JSON (`application/x-ndjson`), not Server-Sent Events -
SSE's `EventSource` can't send a POST body, and NDJSON is what Ollama's own `/api/chat` speaks, so
the backend mostly forwards lines through. The frontend reads the response body with
`ReadableStream` + `TextDecoder`, splitting on `\n`. Every other long-running route in this app
(orchestrator tasks, multi-agent plans, scan runs, report generation, the Factory Director's
`/factory/advance`) follows the same NDJSON convention - see `backend/src/routes/streamUtils.ts`
and `frontend/src/services/httpClient.ts#readNdjsonStream`, reused rather than reinvented per route.

### Cancellation

Chat/task request cancellation on the backend must be detected via `res.on('close')`, **not**
`req.on('close')` - `req.on('close')` fires as soon as Express finishes reading the request body
(effectively immediately), not on client disconnect, which silently aborted every request during
development. `res.on('close')` only fires on premature connection termination, which is what
"cancelled" actually means. See `backend/src/routes/streamUtils.ts#abortOnClientDisconnect`.

### Agents

Agent configs live in `backend/data/agents/*.json` (one file per agent - name, model, temperature,
systemPrompt, description, optional `tools[]`/`execTools[]`). Editing a file directly does **not**
take effect until `POST /api/agents/reload` is hit (or the file is saved through
`AgentEditor.tsx`, which calls create/update, both of which reload internally) - `agentManager.ts`
caches the loaded list after first read, it is not re-read fresh on every request.
`Agent.tools?: string[]` (native Ollama tool-calling) and `Agent.execTools?: string[]` (an
allowlist into the Tool Execution Framework's ExecTools, enforced in `orchestrator.ts` both in the
tools preamble shown to the model and again at request time) are both real and read - see "Two
tool-calling mechanisms" below for why there are two separate fields. Agents are created and edited from
the Agents view - there is no chat-session concept any more for an agent selection to open instead.

### Two tool-calling mechanisms - don't conflate them

There are genuinely two independent tool-calling paths in this codebase, and they don't talk to
each other:

1. **Native Ollama tool-calling** (`services/ollama.ts#streamChatWithTools`, `extensions/
   toolRegistry.ts`, `Agent.tools`) - Ollama's own `tool_calls` wire format. `toolRegistry.ts` is
   wired into this path but has **zero tools registered**, so it's functionally inert right now -
   the plumbing exists for whenever something gets registered.
2. **The Orchestrator's plain-text tool-request convention** (`services/orchestrator.ts#buildToolsPreamble`/
   `parseToolRequest`, `Agent.execTools`) - a separate JSON-in-plain-text convention the Orchestrator
   itself parses out of the model's reply (`{"tool": "...", "arguments": [...]}`), used to drive the
   real Tool Execution Framework (`toolManager.ts`'s ~20 ExecTools) *and* three pseudo-tools that
   record structured data instead of executing anything (`create_finding`, `upsert_asset`,
   `validate_finding` - each requires no human confirmation for exactly that reason). This is the
   path every Work Order and every orchestrator task actually reaches. A reply with several calls runs
   them in order (`OrchestratorTask.queuedToolCalls`), each real tool behind its own approval.

`chatService.ts#streamAgentChat` only activates native `tools` when `toolsPreamble` is absent
(the Orchestrator's own tell that a request came from it) - see the comment there for why activating
both on the same request would be actively harmful (the model could reply in whichever format it
prefers instead of the one actually being parsed).

### Missions

Nearly everything mission-scoped (tool execution history, Orchestrator tasks, multi-agent plans,
findings, scan runs, reports, assets, work orders, activity events) is keyed by a `missionId` and
persisted to `backend/data/missions/<id>/*.json` via `services/missionStore.ts`, hydrated back into
each service's in-memory `Map` at startup. `missionStore.ts#missionDir(id)` is the one real
chokepoint every one of those files' paths funnels through - it rejects anything that isn't
UUID-shaped before ever building a path (the fix for a real path-traversal finding, see
`DEVELOPMENT.md`'s "Fixed: projectId path-traversal" section - the finding predates the rename but
the fix and its reasoning are unchanged) - if you add a new mission-scoped store, route it through
`readMissionJson`/`writeMissionJson`, not a hand-rolled path.

There is one current mission, owned by `App.tsx` (`useSelectedMission`, remembered in `localStorage`)
and picked in the sidebar's `MissionSwitcher`; every mission-scoped view receives it as a `mission`
prop. This reverses the earlier per-view `MissionPanel` pattern - see "UI cleanup" in
`DEVELOPMENT.md` for why. The switcher locks while the Factory is advancing, since that view's live
output belongs to the selected mission.

### Settings

`SettingsPanel.tsx` (temperature/top_p/max tokens/context size/keep-alive, persisted in
`localStorage` via `useSettings.ts`) previously configured manual (no-agent) Chat requests. Once
Chat was removed (see "Nav simplification" in DEVELOPMENT.md), nothing in the app read those values
any more - every agent's own sampling settings come from its own `backend/data/agents/*.json`
config. **Removed outright (POLISH.md Phase B, 2026-09-20)** - `SettingsPanel.tsx`,
`useSettings.ts`, `types/settings.ts`, the App wiring, the TopBar gear button, and the Command
Palette's settings command. There is no settings surface any more.
