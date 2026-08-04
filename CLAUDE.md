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

There are no automated tests yet (see `TODO.md`) — verification has been manual: `curl` against
the backend, browser automation against the frontend.

Ollama must be running separately (`ollama serve`, default `http://localhost:11434`) — this
project only wraps it, it doesn't manage its lifecycle.

## Architecture

The frontend never talks to Ollama directly. Everything goes through the backend, which is the
intended integration seam for future features (tools, RAG, scanners) — the frontend just calls
`/api/*` and stays unaware of Ollama's existence.

```
backend/src/
├── config/env.ts     PORT, OLLAMA_BASE_URL, CORS_ORIGIN (from .env)
├── routes/           models.ts (GET /api/models), chat.ts (POST /api/chat), agents.ts (GET /api/agents)
├── services/         ollama.ts (Ollama REST client), agents.ts (loads data/agents/*.json), errors.ts
├── middleware/        errorHandler.ts — maps domain errors to HTTP status + JSON body
├── types/             Agent, OllamaModel, ChatRequest/ChatResponseChunk, plus extension-point
│                       types (tool.ts, orchestration.ts, rag.ts, scanner.ts, report.ts, plugin.ts)
└── extensions/         toolRegistry, retrievalRegistry, scannerRegistry, pluginRegistry,
                        orchestrator, reportGenerator — placeholder interfaces/registries for
                        future agentic features; not imported by index.ts, not exposed over HTTP

backend/data/agents/*.json   One JSON file per agent (name, model, temperature, systemPrompt,
                              description, optional tools[]). Loaded fresh from disk on every
                              GET /api/agents call — not cached at boot — so editing a file takes
                              effect immediately without restarting the server.

frontend/src/
├── components/        Header, AgentSidebar, AgentList, ModelSelector, ChatArea,
│                       ChatMessageView, Markdown, PromptInput, StatusBar, SettingsPanel
├── hooks/              useModels, useAgents, useChat, useSettings — each owns fetching/state for
│                       its domain; App.tsx composes them and wires cross-cutting behavior
│                       (e.g. selecting an agent sets both model and temperature)
├── services/api.ts     fetch wrapper: fetchModels, fetchAgents, streamChat (NDJSON reader)
└── types/              mirrors of the backend types (ollama.ts, agent.ts, chat.ts, settings.ts)
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

Selecting an agent (`AgentList` -> `App.tsx#handleSelectAgent`) sets the active model, seeds the
temperature setting, and — on the next message — injects the agent's `systemPrompt` as a system
message prepended to the request history. The system prompt is never added to the visible chat
transcript; it's re-injected fresh on every request from the currently selected agent, not stored
as a message. `Agent.tools?: string[]` exists as the intended connection point to the future tool
registry but isn't read anywhere yet.

### Settings vs. session storage

Settings (temperature, top_p, max tokens, context size, keep-alive) persist in `localStorage` —
they're a standing user preference. Chat history persists in `sessionStorage` — intentionally
scoped to the current browser session (cleared on tab close or "Clear Chat"), to keep with the
"no accounts, no database, no cloud" constraint while still surviving an accidental page reload.
`maxTokens: 0` and `contextSize: 0` mean "omit from the request" (use the model's own default),
not "generate zero tokens" (see `frontend/src/App.tsx#handleSubmit`).
