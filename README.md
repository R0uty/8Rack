<p align="center">
  <img src="frontend/public/8Rack.png" width="220" alt="8Rack logo" />
</p>

<h1 align="center">8Rack</h1>

<p align="center">
  A local, no-cloud AI workstation for bug bounty work — built on top of your own
  <a href="https://ollama.com">Ollama</a> models.
</p>

---

8Rack wraps a local Ollama instance with a full AI-agent workstation: purpose-built agents, real
tool execution (nmap, ffuf, nuclei, bash, and more) gated behind human confirmation, an autonomous
tool-calling orchestrator, multi-agent plans, project-scoped history, and a knowledge base over
your own workspace — all running on your machine, with no accounts, no database, and no cloud
storage.

## Features

- **Chat, with or without an agent** — talk directly to any installed Ollama model, or select one
  of 8 purpose-built agents (below) to seed its system prompt, model, and sampling settings.
- **Tool Execution Framework** — ~20 real recon/exec tools (`nmap`, `ffuf`, `nuclei`, `httpx`,
  `subfinder`, `amass`, `bash`, `python`, filesystem ops, and more). **Every tool requires explicit
  human confirmation before it runs**, and filesystem tools are sandboxed to a configurable
  workspace root — an agent can never touch your machine without you approving it first.
- **Orchestrator** — an autonomous tool-calling loop: an agent reasons about an objective, requests
  a tool, pauses for your Approve/Reject, feeds the result back, and repeats until it has an
  answer — with configurable loop-prevention caps. A completed task can be **continued** with a
  follow-up message instead of starting over, and multiple task sessions (even for the same agent,
  e.g. one running `nmap` and another running `ffuf`) can run concurrently.
- **Multi-agent plans** — chain several agents into one ordered plan, where each agent's output
  feeds into the next step's context (e.g. Recon Agent → Report Writer).
- **Projects** — scope tool executions and Orchestrator tasks to a named project (target/program),
  with history that survives a backend restart.
- **Knowledge base (RAG)** — index your own workspace codebase locally via an Ollama embedding
  model; agents can search it as a read-only tool.
- **A premium, keyboard-friendly UI** — dark/light theme, an animated agent network view, live
  streaming responses, and session tabs so you can keep several agents working at once.

Everything runs through the backend — the frontend never talks to Ollama directly.

## Default agents

| Agent | Role |
| --- | --- |
| **Planner** | Breaks large objectives into smaller, actionable tasks. |
| **Recon Agent** | Generates reconnaissance strategies and tool commands for authorized targets. |
| **Web Analyzer** | Analyzes HTTP responses, headers, technologies, and potential attack surfaces. |
| **Code Assistant** | Generates scripts, automation, and proof-of-concept code. |
| **Output Parser** | Converts raw tool output into structured findings. |
| **Vulnerability Validator** | Reviews findings, eliminates false positives, and estimates severity. |
| **Report Writer** | Generates professional bug bounty reports with clear reproduction steps and recommendations. |
| **General Assistant** | Answers general cybersecurity and programming questions. |

Agent configs live in `backend/data/agents/*.json` (one file per agent) and are reloaded live —
edit or add one and hit "Reload" in the sidebar, no restart needed.

## Structure

```
8Rack/
├── backend/    # Express + TypeScript API server wrapping the Ollama REST API
└── frontend/   # React + TypeScript + Vite UI
```

See `CLAUDE.md` for a fuller architecture overview and `DEVELOPMENT.md` for the complete build
history and the reasoning behind every non-obvious decision.

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com) running locally (`ollama serve`), default at `http://localhost:11434`

## Getting started

First-time setup:

```bash
cd backend && cp .env.example .env && npm install && cd ..
cd frontend && npm install && cd ..
```

Then, either run both dev servers with one command:

```bash
./start.sh
```

or start them separately:

```bash
# Terminal 1 — backend
cd backend
npm run dev   # http://localhost:3001

# Terminal 2 — frontend
cd frontend
npm run dev   # http://localhost:5173
```

The frontend dev server proxies `/api/*` requests to the backend.

## Configuration

All backend configuration is via `backend/.env` (see `backend/.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Backend port |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama is running |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin |
| `WORKSPACE_ROOT` | `backend/workspace` | Root that filesystem exec tools and the knowledge base are confined to |
| `MAX_ORCHESTRATOR_TOOL_CALLS` | `10` | Orchestrator loop-prevention cap |
| `MAX_ORCHESTRATOR_TASK_TIME_MS` | `600000` | Orchestrator loop-prevention cap |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model used to embed the knowledge base — pull it first: `ollama pull nomic-embed-text` |

## Testing

```bash
cd backend && npm test     # Vitest, service-level unit tests
cd frontend && npm test    # Vitest + React Testing Library, hooks + components
```

Typecheck and lint:

```bash
cd backend && npm run typecheck
cd frontend && npx tsc -b && npm run lint
```

## Docs

- `CLAUDE.md` — architecture overview and commands, for quick orientation
- `DEVELOPMENT.md` — full build history and the reasoning behind every non-obvious decision
- `TODO.md` — the current actionable next-steps list
