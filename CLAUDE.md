# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

8Rack is a lightweight, modular wrapper around a local [Ollama](https://ollama.com) instance,
built as the foundation for a local multi-agent bug bounty platform. Two workspaces, no shared
root `package.json`: `backend/` (Express + TypeScript, ESM) and `frontend/` (React + TypeScript +
Vite). No accounts, no database, no cloud storage — everything is local by design.

For the full build history, key architectural decisions (and why), and known gaps, read
`DEVELOPMENT.md` before making non-trivial changes — it has context that isn't obvious from the
code alone. `TODO.md` has the current actionable next-steps list.

## Commands

Run from the relevant workspace directory (`backend/` or `frontend/`), not the repo root — there
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
the frontend — see `DEVELOPMENT.md` for what's been verified live vs. by tests alone.

Ollama must be running separately (`ollama serve`, default `http://localhost:11434`) — this
project only wraps it, it doesn't manage its lifecycle.

## Architecture

The frontend never talks to Ollama directly — everything goes through the backend, which just
calls `/api/*` and stays unaware of Ollama's existence. Every route/feature below is fully built
(not a placeholder) unless explicitly marked otherwise; `DEVELOPMENT.md` has a dedicated section
per feature with the full design rationale and what was verified — this section is just the map.

```
backend/src/
├── config/env.ts      PORT, HOST (default 127.0.0.1 - no auth on this app, see below),
│                       OLLAMA_BASE_URL, CORS_ORIGIN, WORKSPACE_ROOT, orchestrator loop-prevention
│                       caps, EMBEDDING_MODEL, NVD_API_KEY (all from .env)
├── routes/             one file per concern: models, chat, agents, tools, orchestrator, projects,
│                       findings, plans (multi-agent), rag, scanners, reports
├── services/           the real logic - see the list below
├── middleware/         errorHandler.ts - maps every domain Error subclass (services/errors.ts) to
│                       an HTTP status + JSON body; every route's catch/next(err) funnels here
├── types/              domain types - Agent, OllamaModel, ChatRequest/ChatResponseChunk, ExecTool,
│                       Finding, Project, ScanProfile/ScanRun, Report, RagSearchResult, plus the two
│                       extension-point types that are still genuinely unbuilt (tool.ts, plugin.ts -
│                       see "Later" in TODO.md)
├── extensions/         toolRegistry.ts (wired into the native Ollama tool-calling path, but zero
│                       tools registered - see "Two tool-calling mechanisms" below) and
│                       scannerRegistry.ts (real - holds the built-in Scan Profiles) are live;
│                       retrievalRegistry.ts/pluginRegistry.ts are confirmed dead code (audited, no
│                       importers anywhere) kept around for the still-unbuilt Plugin system
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
| `agentManager.ts` / `chatService.ts` | Loads `backend/data/agents/*.json` live (not cached), assembles a chat request from an agent's config |
| `toolManager.ts` / `toolExecutor.ts` | Human-confirmation-gated OS process execution, workspace-sandboxed, per-project execution history |
| `orchestrator.ts` / `multiAgentOrchestrator.ts` | The autonomous tool-calling loop - single-agent task, or a chained multi-agent plan |
| `projectManager.ts` / `projectStore.ts` | The project-scoping primitive everything else below is keyed on - see "Projects" below |
| `findingsManager.ts` / `cveLookup.ts` | The Findings Engine (parses tool output into structured, deduplicated, graph-correlated findings) + on-demand NVD CVE correlation |
| `ragIndex.ts` | The knowledge-base indexer/search over `WORKSPACE_ROOT` |
| `scanRunner.ts` | Scan Profiles - deterministic (non-agent) chained tool runs |
| `reportManager.ts` | Report generation - one Report Writer agent call over a set of selected findings |

```
backend/data/
├── agents/*.json          One file per agent (name, model, temperature, systemPrompt, description,
│                           optional tools[]/execTools[]). Loaded fresh from disk on every
│                           GET /api/agents call - not cached at boot - so editing a file takes
│                           effect immediately, no restart needed.
├── projects/<id>/*.json   Per-project history (executions/tasks/plans/findings/scans/reports.json),
│                           write-through on every mutation. Gitignored - may contain sensitive
│                           target/scope info.
└── rag/index.json         The RAG knowledge-base index. Gitignored.
```

```
frontend/src/
├── components/         One top-level component per nav view - ChatView (+ChatSessionPanel/
│                        ChatTaskPanel), OrchestratorWorkbench (+ScannerPanel), MultiAgentPlanner,
│                        FindingsView (+ReportsPanel/FindingDetails/FindingsTable/...). components/
│                        layout/ (AppShell, Sidebar, SessionTabs, CommandPalette) and components/ui/
│                        (GlassPanel, Button, Sheet, StatusPill, ...) are the shared primitives
│                        every view is built from.
├── hooks/               One hook per domain - useModels, useAgents, useChat, useOrchestratorTask,
│                        useTools, useProjects, useFindings, useScans, useReports,
│                        useMultiAgentPlan, useSessions, useRag, useSettings, useTheme,
│                        useBookmarks - each owns its own fetching/state; App.tsx composes them and
│                        wires cross-cutting behavior (e.g. picking an agent seeds model/temperature).
├── services/            One `*Api.ts` file per domain, all built on `services/httpClient.ts`
│                        (`apiFetch`/`readNdjsonStream`/`throwForErrorResponse` - the shared
│                        NDJSON-stream-reading and error-unwrapping logic every domain reuses).
└── types/               Mirrors of the backend types.
```

### Streaming protocol

`POST /api/chat` streams newline-delimited JSON (`application/x-ndjson`), not Server-Sent Events —
SSE's `EventSource` can't send a POST body, and NDJSON is what Ollama's own `/api/chat` speaks, so
the backend mostly forwards lines through. The frontend reads the response body with
`ReadableStream` + `TextDecoder`, splitting on `\n` (see `frontend/src/services/api.ts#streamChat`
and `backend/src/services/ollama.ts#streamChat`).

### Cancellation

Chat request cancellation on the backend must be detected via `res.on('close')`, **not**
`req.on('close')` — `req.on('close')` fires as soon as Express finishes reading the request body
(effectively immediately), not on client disconnect, which silently aborted every request during
development. `res.on('close')` only fires on premature connection termination, which is what
"cancelled" actually means. See `backend/src/routes/chat.ts`.

The frontend additionally has a 5-minute idle-timeout watchdog (`frontend/src/hooks/useChat.ts`,
`IDLE_TIMEOUT_MS`) that resets on every received chunk, guarding against a genuinely hung
connection without interfering with slow-but-alive generation (large local models can take a long
time to load on constrained hardware).

### Agents

Selecting an agent (sidebar or Command Center) opens/focuses a chat session for it (see "Projects"
below - sessions, not one global selection) and seeds that session's model/temperature from the
agent's config; on the next message the backend injects the agent's `systemPrompt` as a system
message prepended to the request history. The system prompt is never added to the visible chat
transcript; it's re-injected fresh on every request, not stored as a message.
`Agent.tools?: string[]` (native Ollama tool-calling) and `Agent.execTools?: string[]` (an
allowlist into the Tool Execution Framework's ExecTools, enforced in `orchestrator.ts` both in the
tools preamble shown to the model and again at request time) are both real and read - see "Two
tool-calling mechanisms" below for why there are two separate fields.

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
   real Tool Execution Framework (`toolManager.ts`'s ~20 ExecTools). This is the path that's
   actually reachable from the UI (Workbench, tool-enabled chat).

`chatService.ts#streamAgentChat` only activates native `tools` when `toolsPreamble` is absent
(the Orchestrator's own tell that a request came from it) - see the comment there for why activating
both on the same request would be actively harmful (the model could reply in whichever format it
prefers instead of the one actually being parsed).

### Projects

Nearly everything project-scoped (tool execution history, Orchestrator tasks, multi-agent plans,
findings, scan runs, reports) is keyed by a `projectId` and persisted to
`backend/data/projects/<id>/*.json` via `services/projectStore.ts`, hydrated back into each
service's in-memory `Map` at startup. `projectStore.ts#projectDir(id)` is the one real chokepoint
every one of those files' paths funnels through - it rejects anything that isn't UUID-shaped before
ever building a path, which is the fix for a real path-traversal finding (see `DEVELOPMENT.md`'s
"Fixed: projectId path-traversal" section) - if you add a new project-scoped store, route it through
`readProjectJson`/`writeProjectJson`, not a hand-rolled path.

Chat sessions dedup per **(agent, project)** pair, not per agent alone - `ChatView.tsx` has its own
page-level "current project" selector (a `ProjectPanel`, same pattern as Workbench/Findings/
Scanners/Reports, not shared globally across views), and picking an agent while a project is
selected opens/resumes that project's own thread with the agent (`hooks/useSessions.ts#openChatSession`'s
optional third `projectId` param). Picking a project - whether via that page-level selector at
creation time, or later via `ChatSessionPanel.tsx`'s own per-session Project dropdown - switches a
chat's body over to `ChatTaskPanel.tsx`: backed by a real project-scoped `OrchestratorTask`, not
plain `useChat`, starting a fresh thread with no memory of any prior plain-chat messages in that
same session (an explicit in-UI notice says so; see `DEVELOPMENT.md`'s Medium-audit-findings
section for why this couldn't be a lossless conversion instead). A chat with **no** project picked
stays exactly the old way - one global `sessionStorage` thread per agent, `useChat.ts`, no backend
persistence (that non-goal didn't change - see `DEVELOPMENT.md`'s "Project-scoped chat" section for
what did and didn't). The frontend's own session concept (`hooks/useSessions.ts` - which agent/task
tabs are open) is a different, unrelated meaning of "session" from the backend's project-scoped
history - don't conflate the two when reading
either codebase.

### Settings vs. session storage

Settings (temperature, top_p, max tokens, context size, keep-alive) persist in `localStorage` —
they're a standing user preference. Chat history persists in `sessionStorage` — intentionally
scoped to the current browser session (cleared on tab close or "Clear Chat"), to keep with the
"no accounts, no database, no cloud" constraint while still surviving an accidental page reload.
`maxTokens: 0` and `contextSize: 0` mean "omit from the request" (use the model's own default),
not "generate zero tokens" (see `frontend/src/App.tsx#handleSubmit`).
