# 8Rack — Development Notes

This file is the handoff/reference doc for continuing work on 8Rack. It captures architecture,
key decisions, and what's left — things not obvious from just reading the code. For run
instructions, see `README.md`.

## Status

Built and verified live (browser + curl) against a real local Ollama instance:

1. Project setup — Vite/React/TS frontend, Express/TS backend, separate workspaces
2. Ollama service layer (`backend/src/services/ollama.ts`)
3. Backend REST API (`GET /api/models`, `POST /api/chat`, `GET /api/agents`)
4. Frontend layout skeleton (Header, AgentSidebar, ChatArea, PromptInput, StatusBar)
5. Model management (list, select, refresh)
6. Chat interface (streaming, Markdown + code highlighting, copy, clear)
7. Agent system — now a proper Agent Manager + Chat Service (see below), not just JSON personas
8. Settings panel (temperature, top_p, max tokens, context size, keep-alive; localStorage)
9. Session management (chat history in `sessionStorage`, cleared on tab close or Clear Chat)
10. Error handling pass (see below)
11. Future architecture extension points (`backend/src/types/{tool,orchestration,rag,scanner,report,plugin}.ts`
    + `backend/src/extensions/`) — interfaces and empty registries only, nothing wired into the
    chat flow or exposed via HTTP yet

All 11 original tasks are complete. The project's completion criteria (query Ollama from the UI,
switch models dynamically, stream responses, select agents, configure settings, be ready for
future bug bounty modules) are met. Three follow-on features have since been built end-to-end:
native tool-calling (see "Tool-calling round trip" below), the Agent Manager / Chat Service
framework ("Agent Manager & Chat Service"), and the OS-level Tool Execution Framework ("Tool
Execution Framework" — Phase 1: the execution engine + confirmation gating, backend-only so far).

## Architecture

```
8Rack/
├── backend/                 Express + TypeScript, ESM, tsx for dev
│   ├── data/agents/*.json   Agent definitions (id, name, description, model, systemPrompt,
│   │                        temperature, topP, maxTokens, icon, color, enabled)
│   ├── workspace/           Sandbox root exec tools are confined to (gitignored contents)
│   └── src/
│       ├── config/env.ts    PORT, OLLAMA_BASE_URL, CORS_ORIGIN, WORKSPACE_ROOT
│       ├── routes/          models.ts, chat.ts, agents.ts, tools.ts, streamUtils.ts (shared
│       │                    NDJSON piping), chatValidation.ts (shared request-body checks)
│       ├── services/        ollama.ts (Ollama REST client + tool-calling loop),
│       │                    agentManager.ts (loads/validates/caches agents, computes
│       │                    online/offline status), chatService.ts (agent-aware chat
│       │                    completion), toolExecutor.ts (generic OS-process runner),
│       │                    toolManager.ts (exec-tool registry/validation/execution
│       │                    lifecycle), errors.ts
│       ├── tools/exec/      builtins.ts — the ~20 built-in ExecTool definitions
│       ├── middleware/      errorHandler.ts (maps domain errors -> HTTP status + JSON)
│       ├── types/           Agent/AgentWithStatus, OllamaModel, ChatRequest/ChatResponseChunk,
│       │                    execTool.ts (ExecTool/ExecutionRecord — the OS-command framework),
│       │                    tool.ts (unrelated in-process Ollama function-calling tool type),
│       │                    orchestration.ts, rag.ts, scanner.ts, report.ts, plugin.ts
│       └── extensions/      toolRegistry, retrievalRegistry, scannerRegistry, pluginRegistry,
│                            orchestrator, reportGenerator — placeholders, not wired into any route
└── frontend/                React + TypeScript + Vite
    └── src/
        ├── components/      Header, AgentSidebar, AgentList, ModelSelector, ChatArea,
        │                    ChatMessageView, Markdown, PromptInput, StatusBar, SettingsPanel
        ├── hooks/            useModels, useAgents, useChat, useSettings
        ├── services/api.ts   fetch wrapper: fetchModels, fetchAgents, reloadAgents, streamChat
        │                     (routes to /api/chat or /api/agents/:id/chat depending on payload)
        └── types/            mirrors of backend types (ollama.ts, agent.ts, chat.ts, settings.ts)
```

The frontend never talks to Ollama directly — everything goes through the backend, which is the
seam where future features (tool execution, RAG, scanners) will plug in without touching the UI.

## Key decisions (the "why", not visible from the code alone)

- **NDJSON over the wire, not SSE.** `POST /api/chat` streams newline-delimited JSON
  (`application/x-ndjson`) rather than Server-Sent Events. SSE's `EventSource` can't send a POST
  body, and NDJSON is what Ollama itself speaks, so the backend just forwards lines through with
  minimal transformation.

- **Cancellation must use `res.on('close')`, not `req.on('close')`.** This bit us during
  development: `req.on('close')` fires as soon as Express finishes reading the request body — not
  on client disconnect — which aborted every chat request instantly. `res.on('close')` only fires
  on premature connection termination, which is what "cancel" actually means. See
  `backend/src/routes/chat.ts`.

- **Agents are now cached in memory, with an explicit reload — this reverses an earlier decision.**
  The original agent system re-read `backend/data/agents/*.json` on every `GET /api/agents` call
  specifically so editing a file took effect without a restart. The Agent Manager rewrite
  (`agentManager.ts`) needed a real distinction between "load" and "reload" (the task spec asks for
  both as separate capabilities, and reload also needs to re-check every agent's model against
  Ollama, which isn't free), so it now caches the validated list after first load and only
  re-reads on `POST /api/agents/reload`. The frontend's agent-list refresh button calls that
  endpoint, so editing a JSON file still takes effect without a server restart — it just needs an
  explicit reload (button click) instead of happening automatically on next page load.

- **Agent `enabled` (config) and agent "online"/"offline" (computed) are deliberately different
  concepts.** `enabled: true/false` in the JSON file is an author-level toggle — `GET /api/agents`
  only returns `enabled: true` agents at all (`getEnabledAgents`). Online/offline is computed at
  read time by checking `model` against `GET /api/models` from Ollama; an enabled agent whose model
  isn't pulled locally still shows up, just as `offline`, per the "display unavailable agents as
  offline instead of throwing errors" requirement. If Ollama itself is unreachable, every agent is
  reported offline rather than the request failing (`agentManager.ts#withStatus`).

- **Agent selection sets model + temperature + topP + maxTokens, but the system prompt is never
  added to the visible transcript.** When an agent is active, the frontend sends chat requests
  through `POST /api/agents/:id/chat` instead of `POST /api/chat`; the backend's Chat Service
  (`chatService.ts`) loads the agent, injects its `systemPrompt` as the first message, and applies
  its temperature/topP/maxTokens as defaults (still overridable by the Settings panel — see
  `App.tsx#handleSubmit`). The system prompt itself never appears as a message bubble in either
  path. Selecting an agent also locks the model dropdown to the agent's own model (clicking the
  active agent again deselects it and unlocks the dropdown) — since the backend chat-service path
  is authoritative about which model runs, silently ignoring a manually-picked model would be
  more confusing than disabling the control.

- **Chat history lives in `sessionStorage`, settings live in `localStorage`.** Intentional
  distinction: chat history should not outlive the browser session (mirrors "no accounts, no
  database, no cloud" from the spec), while settings are a standing preference. Both are strictly
  local — neither is a database or cloud service.

- **A 5-minute idle-timeout watchdog guards chat requests** (`useChat.ts`, `IDLE_TIMEOUT_MS`). It
  resets on every received chunk, so it only fires on a genuinely hung connection — not during
  normal (possibly slow) generation. Kept deliberately long because large local models can take a
  long time to load into memory on constrained hardware (observed: `qwen3:32b` failed with a
  ROCm/VRAM OOM on this dev machine — that error round-tripped cleanly through the whole stack and
  rendered as a normal chat error, which is good evidence the error path is solid).

- **`maxTokens: 0` and `contextSize: 0` mean "omit from the request"** (i.e. let Ollama use the
  model's own defaults), not "generate zero tokens." See `App.tsx#handleSubmit`.

- **`start.sh` kills stale dev-server processes before launching.** Its first pkill pattern
  matched `"tsx src/index.ts"`, but `npm run dev`'s actual command is `tsx watch src/index.ts` —
  the pattern silently never matched, so backend processes accumulated across every restart
  instead of being replaced. Fixed by anchoring the pattern to the actual binary path
  (`$ROOT_DIR/backend/node_modules/.bin/tsx`) instead of guessing the command line. If you ever
  see multiple backend/frontend processes piling up, check `start.sh`'s pkill patterns still match
  reality — `ps aux | grep tsx` is the fastest way to check.

  A second, related issue surfaced later: `tsx watch` itself spawns a *grandchild* process
  (`node --require tsx/dist/preflight.cjs ... src/index.ts`) that actually binds the port — its
  command line no longer contains `.bin/tsx`, so the pkill pattern above doesn't match it either.
  If the parent watcher gets killed (or the terminal session is closed) without that grandchild
  dying too, it's orphaned and keeps squatting on the port across every future `start.sh` run,
  silently serving stale code while the "new" instance fails to bind and idles doing nothing. This
  is exactly what caused a "the frontend loads but shows no models" report — the process
  answering `:3001` was hours-stale and, worse, sometimes left in a *stopped* (`T`) state (e.g. a
  closed terminal tab), where the kernel still completes the TCP handshake and queues the
  connection but the stopped process never calls `accept()` — so requests hang forever instead of
  failing fast. `start.sh` now also kills `tsx/dist/preflight.cjs` explicitly. If backend requests
  ever hang without erroring, check `ps aux | grep 8Rack` for processes in `T` state before
  anything else.

## Known gaps / things to check on the next session

- No automated tests exist yet (verification so far has been manual: curl for the backend, browser
  automation for the frontend). Worth adding before the project grows much further.
- The dev-mode "backend is down" error path returns a generic message because Vite's proxy
  returns an HTML 502 page rather than JSON; the frontend detects `status >= 500` and shows a
  reasonable fallback ("Could not reach the backend server"), but it's not as precise as the
  Ollama-down case (which the backend detects and reports specifically).
- `backend/data/agents/*.json` has no schema validation beyond the minimal shape check in
  `services/agentManager.ts` — a malformed file (or one with a duplicate `id`) is skipped with a
  `console.warn`, not surfaced to the UI.

## Extension points (Task 11)

Interfaces + empty registries for the six future areas, all under `backend/src/`:

- **Tool execution** — `types/tool.ts` (`Tool`, `ToolDefinition`, `ToolResult`) +
  `extensions/toolRegistry.ts` (`registerTool`, `getTool`, `listTools`)
- **Multi-agent orchestration** — `types/orchestration.ts` (`OrchestrationPlan`/`Result`) +
  `extensions/orchestrator.ts` (`runOrchestration` — throws "not implemented")
- **RAG** — `types/rag.ts` (`RetrievalSource`, `RetrievedDocument`) +
  `extensions/retrievalRegistry.ts` (`registerRetrievalSource`, `retrieve` — returns `[]`)
- **Security scanners** — `types/scanner.ts` (`Scanner`, `ScanFinding`, `ScanResult`) +
  `extensions/scannerRegistry.ts` (`registerScanner`, `getScanner`, `listScanners`)
- **Report generation** — `types/report.ts` (`Report`, `ReportInput`) +
  `extensions/reportGenerator.ts` (`generateReport` — throws "not implemented")
- **Plugin system** — `types/plugin.ts` (`Plugin`, `PluginContext`) +
  `extensions/pluginRegistry.ts` (`loadPlugin`, `listPlugins`) — a plugin's `register()` gets a
  `PluginContext` that can call into the tool/scanner/RAG registries above, so one plugin can add
  several capabilities at once

RAG, security scanners, report generation, and the plugin system are still untouched placeholders
— none of that is imported by `index.ts` or exposed over HTTP. Tool execution (below) is now wired
in as the first proof that the shape works end-to-end.

The generic (LLM/provider-agnostic) shape was chosen deliberately over mirroring Ollama's native
tool-calling API, since this is meant to be a durable foundation rather than coupled to Ollama's
current API. The Ollama-specific conversion now lives in `services/ollama.ts#resolveOllamaTools`,
not in `toolRegistry.ts`, to keep that boundary intact.

`Agent.tools?: string[]` (backend and frontend `types/agent.ts`) is still unread — selecting an
agent only sets model + temperature + system prompt. Wiring agent tool lists into `POST /api/chat`
is the natural next step now that the tool-calling plumbing exists.

### Tool-calling round trip (first extension point wired end-to-end)

`POST /api/chat` now accepts an optional `tools?: string[]` — names of tools registered in
`toolRegistry`. When present, `chat.ts` resolves them to Ollama's native function-calling schema
via `resolveOllamaTools` and routes through `streamChatWithTools` (`services/ollama.ts`) instead of
plain `streamChat`. That function loops (capped at `MAX_TOOL_ROUNDS`): stream a completion, check
for `message.tool_calls`, execute matching tools from `toolRegistry`, append the assistant + tool
messages, and stream a follow-up completion — repeating until the model answers without calling a
tool. Tool-call and tool-result messages are yielded as synthetic NDJSON chunks (`done: false`) so
a client can render them, same protocol as regular chunks.

**Update:** the original proof-of-concept tool, `calculator` (a hand-written recursive-descent
arithmetic evaluator — deliberately not `eval()`/`Function()`, since its input was model-generated
tool-call arguments), was removed at the user's request once the Tool Execution Framework/
Orchestrator existed and made it redundant. `toolRegistry` currently has zero tools registered, so
this round-trip (`resolveOllamaTools`/`streamChatWithTools`/`UnknownToolError` on any `tools: [...]`
request) is live infrastructure with nothing plugged into it — the rest of this section is kept as
a record of what was learned building and proving it out, since the mechanics and the local-model
gap below still apply to whatever gets registered next.

**Local-model gap discovered while proving this out:** Ollama only populates `message.tool_calls`
if the model wraps its call in `<tool_call></tool_call>` tags, per the model's own chat template
(`ollama show <model> --template`). Every small/quantized coder model installed on this dev machine
(`qwen2.5-coder:0.5b/1.5b/3b/7b`) reliably produces the correct `{name, arguments}` JSON but skips
the wrapper tags — confirmed by calling Ollama's `/api/chat` directly, bypassing this backend
entirely, so it's a model/template limitation, not a bug here. `qwen3:32b` and `qwen3.6` (which
might be better tag-compliant) OOM on this GPU, so they couldn't be verified either way.
`streamChatWithTools` therefore has a fallback: if `tool_calls` comes back empty but the assistant
content is a bare or fenced JSON object matching `{name, arguments}` for a tool that was offered,
it's parsed as a synthetic tool call (`tryParseFallbackToolCall`). Without this, tool-calling would
not function with any model currently installed locally. If a model that *does* emit proper
`<tool_call>` tags gets pulled later, this fallback simply never triggers for it — it's pure
belt-and-suspenders, not a replacement for native parsing.

The frontend surfaced this too via a "Calculator tool" checkbox in `PromptInput`, since removed
along with the tool itself — `sendMessage`'s `tools` option and the `ChatMessageView` rendering
below are still there, just currently unreachable from the UI with nothing registered to enable.
`frontend/src/services/api.ts#streamChat` was reworked from a `(content, done)` callback to a
structured `ChatStreamEvent` (`{role, content, toolCalls, done}`)
so `useChat.ts` can branch on it; `useChat.ts` tracks a `currentAssistantId` that gets set to
`null` when a tool-calls event arrives (finalizing that bubble with its `toolCalls`) and only
recreated once real content resumes — this ordering matters: creating the next assistant bubble
*before* the tool-result event would put the transcript in the wrong order (tool-call, answer,
result), since the tool-result message is always appended to the end of the current message list.
`ChatMessageView.tsx` renders `role: "tool"` messages as a distinct green result block and
assistant messages with `toolCalls` as an italicized "called toolName(args)" line instead of
running their (often raw-JSON) content through the Markdown renderer.

Verified live in-browser (not just curl): `qwen2.5-coder:7b` completed cleanly in one round;
`qwen2.5-coder:0.5b`, given the same kind of prompt, kept mis-reading the arithmetic expression and
re-calling the tool until it hit `MAX_TOOL_ROUNDS` (4) — a good real-world confirmation that the
safety cap actually stops a model that won't converge, rather than looping forever.

## Agent Manager & Chat Service

The agent system (originally just "load JSON files, let the frontend inject the system prompt")
was rebuilt into a proper framework per an explicit task spec, as the foundation for a future
local multi-agent bug bounty workstation.

**`backend/src/services/agentManager.ts`** — the Agent Manager. Reads every `*.json` file in
`backend/data/agents/`, validates the full required field set (`id, name, description, model,
systemPrompt, temperature, topP, maxTokens, icon, color, enabled` — `tools?: string[]` remains
optional, carried over from the earlier tool-calling work), skips invalid files or duplicate `id`s
with a `console.warn`, and caches the result. Exposes `loadAgents` (cached), `reloadAgents` (forces
a fresh disk read + re-validates every model against Ollama), `getAgent(id)`, and
`getEnabledAgents()`. Model validation and the enabled-vs-online/offline distinction are covered
under "Key decisions" above.

**`backend/src/services/chatService.ts`** — the reusable Chat Service. `streamAgentChat(request,
signal)` takes an agent ID and a message history, loads the agent via the Agent Manager, throws a
typed error if it's missing/disabled/offline (`AgentNotFoundError` / `AgentDisabledError` /
`AgentOfflineError`, mapped to 404/403/503 in `middleware/errorHandler.ts`), prepends the agent's
`systemPrompt` as a system message, layers the agent's temperature/topP/maxTokens under any
request-level `options` override, and delegates to `services/ollama.ts#streamChat` or
`streamChatWithTools` exactly like the plain chat path. It's a plain async generator with no HTTP
dependency, so future multi-agent orchestration (sequential/parallel runs) can call it directly
instead of going through `POST /api/agents/:id/chat`.

**Routes** (`backend/src/routes/agents.ts`):
- `GET /api/agents` — enabled agents with computed status
- `GET /api/agents/:id` — single agent, 404 if not found
- `POST /api/agents/reload` — forces a full agent-manager reload, returns *all* agents (including
  disabled ones) so the caller can see the complete picture, not just what's currently offered
- `POST /api/agents/:id/chat` — the Chat Service over HTTP, same NDJSON streaming contract as
  `POST /api/chat` (shares `routes/streamUtils.ts` and `routes/chatValidation.ts` with it, so the
  write-loop/error-handling/validation logic isn't duplicated between the two routes)

**Frontend wiring**: `frontend/src/services/api.ts#streamChat` takes an optional `agentId` — when
set, it posts to `/api/agents/:id/chat` with just `{messages, options, tools, keepAlive}` (no
`model`/`systemPrompt`, since the backend owns those); otherwise it behaves exactly as before.
`AgentList.tsx` renders each agent's icon, description, model, and an online/offline status dot
(green/red), with the currently active agent highlighted via a CSS custom property
(`--agent-color`) sourced from the agent's own `color` field. `useAgents.ts`'s `refresh()` now
calls the reload endpoint (not just a plain re-fetch), so the sidebar's refresh button actually
re-validates models, not just re-reads the cache.

**The 8 default agents** (`backend/data/agents/*.json`) match the task spec exactly: Planner,
Recon Agent, Web Analyzer, Code Assistant, Output Parser, Vulnerability Validator, Report Writer,
General Assistant. All currently point at `qwen2.5-coder:7b` (the model that's worked reliably
through both the tool-calling and agent-chat testing on this machine) with per-role
temperature/topP/maxTokens and a distinct icon/color for the sidebar.

**Verified**: full curl sweep of every route including error paths (offline agent → 503, disabled
agent → 403, unknown agent → 404, empty messages → 400, reload correctly excludes disabled agents
from the enabled-only list but includes them in the full reload response) — see conversation
history for the exact commands. Confirmed live in-browser: selecting an agent locks the model
dropdown and seeds temperature/topP/maxTokens, sending a message through an agent streams a
correctly-scoped response (verified the Planner agent actually produces a task breakdown, not a
generic reply), and deselecting (re-clicking the active agent) unlocks manual model choice again.

### What's next

- Read `Agent.tools?: string[]` when building the agent-chat request, so selecting an agent
  activates its own tools automatically instead of the current manual per-message checkbox that's
  shared across all agents.
- Add a second real tool now that both the backend loop and frontend rendering are proven — the
  current UI is a single checkbox, which will need to become a multi-select once there's more than
  one tool to offer.
- No automated tests cover the Agent Manager / Chat Service yet (see "Known gaps" above) —
  `agentManager.ts`'s validation/caching/status logic and `chatService.ts`'s error paths are prime
  candidates for the first real test suite, since they were exercised manually via curl this
  session but nothing pins that behavior down against regressions.
- Multi-agent orchestration (`types/orchestration.ts`, `extensions/orchestrator.ts`) is the natural
  next extension point now that `chatService.ts` exists as a clean, HTTP-independent entry point
  for "run this agent with this input" — an orchestrator could call `streamAgentChat` directly for
  each step of a sequential or parallel plan.

## Tool Execution Framework (Phase 1: engine + confirmation gating, no orchestrator/UI yet)

8Rack is being extended from a chat app into an AI workstation that can run real local
tools (recon scanners, filesystem ops, bash/python) on the user's behalf. Because this lets an
agent request OS-level execution — `nmap`, `ffuf`, `nuclei`, `bash`, `python`, arbitrary file
writes — against the user's real machine, the safety defaults were confirmed with the user before
writing any code (see the plan at implementation time): **every tool requires explicit human
confirmation before it runs**, and **filesystem tools are confined to a workspace root**
(`env.workspaceRoot`, `backend/workspace/` by default, `WORKSPACE_ROOT` env var to override).
Given those two constraints, this phase deliberately stops at a fully working, directly-testable
execution engine — the autonomous Orchestrator loop (AI decides to call a tool, gets the result,
decides the next step) and both UI surfaces (Tool Registry, Execution Console) are substantial
enough to deserve their own passes and are **not built yet**.

**This is a separate system from `types/tool.ts`/`extensions/toolRegistry.ts`** (the in-process
Ollama-native function-calling mechanism — an arbitrary JS function, no OS process; see the
"Tool-calling round trip" section above). The new system is named `ExecTool`/`toolManager.ts`
throughout specifically to avoid colliding with that one. Unifying them is a natural future step
once the Orchestrator exists that actually needs to dispatch between "call this JS function" and
"run this OS command" — not
attempted here.

- **`types/execTool.ts`** — `ExecTool` (id, name, description, category, executable,
  defaultArguments, allowedArguments, timeout, enabled, requiresConfirmation, parser, icon, per
  the task spec exactly), `ExecToolWithStatus` (adds computed `availability`), `ToolRequestBody`
  (the standardized `{tool, arguments, stdin?}` request shape), `ExecutionResult`,
  `ExecutionRecord` (the full lifecycle record: pending_confirmation → running → completed/
  rejected/cancelled/failed).

- **`services/toolExecutor.ts`** — the generic executor. `runExecutable()` uses
  `node:child_process.spawn` with an **argv array, never a shell string** — arguments can't be
  interpreted as shell syntax regardless of content, so classic shell-metacharacter injection
  isn't a risk here (the risk this framework actually manages is *which* command/arguments get
  approved, not injection into one). Cancellation and timeout both go through an internal
  `AbortController` — same convention as `ollama.ts`/`chat.ts` elsewhere in this codebase, not
  Node's separate `timeout` spawn option — so a caller-provided `signal` and an internal
  timeout-triggered abort both funnel through one code path. Streams stdout/stderr through
  `onOutput` as it arrives (the "streaming output when supported" requirement) and truncates each
  stream independently at 1 MB, resolving — never rejecting — with a structured
  `ExecutionResult` even on spawn failure.

- **`services/toolManager.ts`** — the Tool Manager. Holds the tool registry and the (in-memory,
  capped at 200) execution history. `requestExecution()` validates the tool exists/is enabled,
  validates every argument (against `allowedArguments` if the tool has any — none of the built-ins
  do yet, see below — and against workspace-root containment for anything that looks like a path:
  contains `/`, is `.`, or starts with `~`), resolves the executable via `which` (rejecting if it's
  not actually on PATH), and creates a `pending_confirmation` record. `confirmExecution()` is the
  only thing that actually runs a process; `rejectExecution()`/`cancelExecution()` handle the other
  two paths a human can take. **Every built-in tool has `requiresConfirmation: true`**, but the
  manager still supports a tool with `requiresConfirmation: false` running immediately on
  request — a currently-inactive code path that *is* the "human approval for selected tools"
  future-compatibility item the task spec calls out, implemented now rather than retrofitted once
  something actually needs it loosened.

  `allowedArguments` (regex-string allowlist per tool) exists on the type and is checked when
  present, but **no built-in tool sets it in this phase** — with confirmation required on every
  execution, the human reviewing the fully resolved command before approving is the primary
  safety control right now. Workspace-path containment is the one argument-level check that's
  always active regardless of `allowedArguments`.

- **`tools/exec/builtins.ts`** — all ~20 tools from the spec, registered at startup via
  `registerExecTool()` calls from `index.ts`: `read_file`/`write_file`
  (`cat`/`tee` — `write_file` is the one tool that uses the request's optional `stdin` field to
  carry content), `list_directory` (`ls`), `search_files` (`find`), `grep` (`rg`), `git`, `bash`,
  `python` (`python3` — both take raw flags, e.g. `["-c", "..."]`, no hidden default arguments),
  `curl`, `http_request` (curl with safer defaults: `-s -i --max-time 15`), `nmap`, `httpx`,
  `ffuf`, `katana`, `nuclei`, `subfinder`, `amass`, `whois`, `dig`, `nslookup`. On this dev
  machine, `nuclei`/`subfinder`/`amass`/`katana` aren't installed — they're still registered
  (`enabled: true`) and show up in `GET /api/tools` as `availability: "unavailable"`, exactly
  mirroring the enabled-vs-online/offline pattern already established for agents.

- **Routes** (`routes/tools.ts`): `GET /api/tools` (list with computed availability),
  `GET /api/tools/executions` / `GET /api/tools/executions/:id`, `POST /api/tools/request` (the
  spec's exact `{tool, arguments}` shape), `POST /api/tools/executions/:id/confirm`
  (**NDJSON-streamed** — `{type:"stdout"|"stderr", data}` lines as output arrives, then a final
  `{type:"result", record}` — same convention as `POST /api/chat`, so a future Execution Console
  can consume this without a backend contract change), `POST .../reject`, `POST .../cancel`. The
  confirm route's own `res.on('close')` also calls `cancelExecution` if the client disconnects
  mid-stream, reusing the exact same abort path a manual `/cancel` call uses.

- **Errors** (`services/errors.ts`, mapped in `middleware/errorHandler.ts`):
  `ExecToolNotFoundError` (404), `ExecToolDisabledError` (403), `InvalidToolArgumentsError` (400,
  covers both bad-shape requests and workspace-escape attempts), `ExecutionNotFoundError` (404),
  `ExecutableUnavailableError` (503, e.g. requesting `nuclei` when it isn't installed).

**Verified via curl**: full tool list with correct availability per tool; `list_directory`
request → confirm → real streamed `ls -la` output ending in a `success: true` result;
`write_file`/`read_file` round-trip inside the workspace; a `read_file ../../etc/passwd` request
rejected before anything ran; a `bash -c "sleep 30"` against a short timeout showing
`timedOut: true`; cancelling a long-running confirm mid-stream showing `cancelled: true`; existing
chat/agent endpoints unaffected.

### Known limitation this phase doesn't address

There is **no "project" concept anywhere in this app** — one global chat session, no project
selection UI, no per-project anything. The task spec's "every tool execution belongs to the
currently selected project" / "store execution history under the project" requirements assume
projects already exist as a concept; they don't, so execution history here is a single global
in-memory list (capped, lost on restart), not project-scoped or persisted. Building "projects" is
itself a real feature, not a detail to fold into the next tool-framework pass.

### What's next (as of the Phase 1 write-up above)

- ~~The Orchestrator~~ — done, see "Orchestrator" below.
- **Tool Registry UI** and **Execution Console UI** — both explicitly deferred; the backend is
  already shaped for them (`GET /api/tools`'s availability data, the confirm route's streamed
  NDJSON), so this should mostly be frontend work now that the Orchestrator is actually producing
  executions to display.
- **Project awareness** (see "Known limitation" above) — needs actual project selection UI plus
  per-project persisted execution history before "make previous results available to agents as
  context" means anything.
- No automated tests cover `toolExecutor.ts`/`toolManager.ts` yet — timeout/cancellation/
  path-containment logic is exactly the kind of thing that silently regresses without a test
  pinning it down, and it was only exercised manually via curl this session.

## Orchestrator

The single-agent tool-calling loop: an agent's replies get scanned for a tool request, the
wrapper executes it (through the exact same confirm/reject flow described above — nothing about
tool execution changed), the result goes back into the conversation, and this repeats until the
agent gives a final plain-text answer or a limit trips. This is what turns the previously
curl-only-drivable execution engine into something an agent can actually use to complete a task.

**Not to be confused with `extensions/orchestrator.ts`/`types/orchestration.ts`** — that's an
unrelated, still-unimplemented placeholder for future *multi-agent* orchestration (running several
agents across a plan of steps). This section is about the single-agent tool loop, implemented in
`services/orchestrator.ts`.

**Why it's a pause/resume state machine, not a single call.** Every tool requires human
confirmation (see "Tool Execution Framework" above), so the loop cannot run start-to-finish inside
one HTTP request — it has to stop and wait for a human to act on a separate request. `createTask`
and `resumeTask` each advance a task by exactly one step and return its current state; the caller
(today: curl or any HTTP client — no UI yet) is responsible for calling the existing
`POST /api/tools/executions/:id/confirm` (or `/reject`) on the task's `pendingExecutionId`, then
calling `POST /api/orchestrator/tasks/:id/resume` to continue. This reuses 100% of the existing
tool-execution machinery — the Orchestrator only adds the "detect a request in agent text, track
task state, and continue after confirmation" bookkeeping around it.

**Task states**: `running` → (agent replies with a tool request) → `waiting_confirmation` → (human
confirms/rejects via the existing tools API, caller calls `/resume`) → `running` → ... →
`completed` (agent gave a final plain-text answer) / `failed` (the agent call itself errored) /
`cancelled` / `max_executions_reached` / `max_time_reached`.

**How a tool request is detected**: this does *not* reuse Ollama's native `tool_calls` mechanism
(the `streamChatWithTools` path) — it's a separate, simpler plain-text convention the
Orchestrator itself parses. `buildToolsPreamble()` lists every enabled tool and instructs the
model to reply with *only* `{"tool": "<id>", "arguments": [...]}` (matching the task spec's exact
Tool Request format) when it wants to use one, or plain text otherwise. This preamble is passed
through `chatService.ts`'s new `toolsPreamble` param, appended after the agent's own
`systemPrompt` in a single system message (not a second system message — some model chat
templates only honor one). `parseToolRequest()` strips optional markdown code fences and attempts
`JSON.parse`; anything that doesn't parse into `{tool: string, arguments: string[]}` is treated as
the final answer, not an error.

**Loop prevention**: `env.maxOrchestratorToolCalls` (default 10, `MAX_ORCHESTRATOR_TOOL_CALLS`) and
`env.maxOrchestratorTaskTimeMs` (default 10 minutes, `MAX_ORCHESTRATOR_TASK_TIME_MS`) — both
env-configurable specifically so the caps could be verified live without editing code. The
tool-call counter increments on *every* attempted request, including ones that fail validation
(unknown tool, bad arguments) — otherwise a model that keeps requesting garbage could retry
forever without ever counting toward the limit, since a failed `requestExecution` never reaches
`waiting_confirmation` to be paced by human approval.

**Routes** (`routes/orchestrator.ts`): `POST /api/orchestrator/tasks` (`{agentId, objective}`),
`GET /api/orchestrator/tasks` / `GET .../tasks/:id`, `POST .../tasks/:id/resume`,
`POST .../tasks/:id/cancel` (also cancels the pending/running tool execution, if any, via the
existing `toolManager.cancelExecution`). `GET`s and `/cancel` return plain JSON; `POST /tasks` and
`.../resume` — the two that make an agent call — stream NDJSON instead (see "Token-level streaming"
below).

### Token-level streaming (`onChunk`/`AbortSignal` through the advance loop)

`createTask`/`resumeTask`/`advance`/`collectAgentReply` all take an optional `onChunk: (content:
string) => void` and `AbortSignal`, threaded straight through to `streamAgentChat`'s existing
per-chunk generator — no new streaming mechanism, just wiring the loop's internal per-token chunks
out to a caller instead of only accumulating them into `reply`. `routes/orchestrator.ts`'s
`runAndStreamTask` helper (shared by `POST /tasks` and `POST .../resume`) mirrors the
confirm-execution NDJSON stream in `routes/tools.ts`: headers aren't flushed until the first
`res.write`, so an error raised before any agent output (e.g. `AgentNotFoundError`) still reaches
the error middleware as normal JSON instead of a malformed stream. Lines are
`{type:"chunk",content}` per piece of text, then one terminal `{type:"task",task}` once the step
settles (tool request, final answer, or a terminal status) — or `{type:"error",error}` if something
broke after streaming had already started. Client disconnect during a chunked response reuses
`abortOnClientDisconnect`/`RequestCancelledError` exactly like `/api/chat`: `advance` catches it,
marks the task `cancelled`, and rethrows so the route ends the response without writing a `task`
line for a client that's already gone.

Frontend: `services/orchestratorApi.ts#streamTask` reads the NDJSON (via the existing
`readNdjsonStream` helper), `hooks/useOrchestratorTask.ts` exposes the accumulating text as
`streamingText` (cleared whenever a step settles), and `OrchestratorWorkbench.tsx` renders it with
a blinking-cursor style. One real gap surfaced by browser-testing, not by typecheck/lint: the first
version only rendered `streamingText` inside the `task && ...` block, so the *first* call
(`createTask`, before any `OrchestratorTask` object exists yet) showed a static "Starting…" button
with no visible output for however long the model took to answer — on a long generation this looked
frozen. Fixed by also rendering `streamingText` in the pre-task "New Task" view whenever `busy` is
true. Verified via curl (raw NDJSON lines land incrementally) and in-browser (visibly growing text
mid-generation, including through a markdown code block; the tool-call → confirm → resume path
streams correctly too; both settle cleanly into `task.messages` with no duplicated or leftover
streaming text).

**Verified via curl**: a task against a tool-savvy prompt correctly reaches `waiting_confirmation`
with a real parsed tool request; confirming the execution and calling `/resume` correctly feeds
the result back and the agent produces a final answer referencing the actual tool output;
cancelling a task with a pending execution cancels both; temporarily lowering
`MAX_ORCHESTRATOR_TOOL_CALLS` confirmed `max_executions_reached` trips correctly instead of looping
forever.

### What's next (pre-UI)

- ~~Tool Registry UI + Execution Console UI~~ — done, see "Workbench UI" below.
- ~~Streaming the agent's own text token-by-token during a task~~ — done, see "Token-level
  streaming" above.
- No automated tests cover `orchestrator.ts` — the state machine transitions, the loop-prevention
  counting-failed-attempts behavior, and `parseToolRequest`'s fence-stripping are all exactly the
  kind of logic that benefits from a pinned-down test rather than only manual verification.

## Workbench UI (Tool Registry + Execution Console + interactive Orchestrator)

The Orchestrator and Tool Execution Framework were backend-only (curl-driven) until this pass. A
new "Workbench" view — a nav tab in the Header alongside "Chat" (`App.tsx`'s `activeView` state) —
makes the whole thing interactive, reusing the same agent selection already in the sidebar rather
than duplicating an agent picker.

- **`frontend/src/services/httpClient.ts`** — extracted `ApiError`, `apiFetch`,
  `throwForErrorResponse`, and a new `readNdjsonStream` helper out of `api.ts` so the new
  `toolsApi.ts`/`orchestratorApi.ts` don't duplicate them; `api.ts#streamChat` was simplified to
  use `readNdjsonStream` too as a side benefit.
- **`services/toolsApi.ts`** — `fetchTools`, `fetchExecutions`, `requestToolExecution`,
  `confirmExecution` (consumes the backend's `{type:"stdout"|"stderr"|"result", ...}` NDJSON
  stream), `rejectExecution`, `cancelExecution`.
- **`services/orchestratorApi.ts`** — `createTask`, `fetchTasks`/`fetchTask`, `resumeTask`,
  `cancelTask`.
- **`hooks/useTools.ts`** — tools + execution history + refresh, mirrors `useAgents.ts`.
- **`hooks/useOrchestratorTask.ts`** — owns one active task's full lifecycle: `start`, `approve`
  (streams live output into `liveOutput` state, then automatically calls `resumeTask` so the human
  doesn't have to make two separate clicks), `reject` (also auto-resumes), `cancel`, `reset`.
- **`components/ToolRegistry.tsx`** — table of every tool (icon, category, executable, computed
  availability, enabled, and "last run" status derived client-side by matching `executions` against
  each tool's id — no backend change needed for that).
- **`components/ExecutionConsole.tsx`** — reusable single-execution display (resolved command,
  status badge, live or historical stdout/stderr, exit code/time/success). Used both inline in the
  Workbench's confirmation step and could be reused standalone later.
- **`components/OrchestratorWorkbench.tsx`** — the task creation form, the message transcript
  (reuses `Markdown` for plain-text assistant replies, detects and nicely renders tool-request JSON
  and tool-result JSON instead of showing raw text), and the inline Approve/Reject card that
  appears whenever `task.status === "waiting_confirmation"`.

**Three real bugs surfaced during in-browser verification** (all now fixed) — a good example of why
"verified via curl" and "verified in the browser" aren't the same claim:
1. The objective textarea was never cleared after starting a task or clicking "New Task", so
   leftover text from the previous objective silently got appended to on the next one.
2. The confirm card failed to appear for a *newly* pending execution because the effect that
   refreshes `executions` (`useTools`) was keyed on `task.status` alone — and a task can land back
   on the *same* `"waiting_confirmation"` string (e.g. after a rejected tool, or after the
   Orchestrator's internal retry-on-invalid-tool-request loop) with a different
   `pendingExecutionId` that the effect never re-ran for. Fixed by keying on `task.updatedAt`
   instead, which changes on every state transition regardless of whether the status string does.
3. `liveOutput` (the streamed output from the *previous* confirmed execution) wasn't cleared after
   a successful resume, so a fresh pending confirmation could briefly show the prior tool's output
   inside its `ExecutionConsole` before the user had even clicked Approve.

**Verified live in-browser** (not just curl): selecting the Recon Agent and starting a task ("look
up the DNS A record for example.com using dig") correctly showed the resolved `dig` command
awaiting approval; approving streamed real output and auto-resumed to a final answer that
correctly listed the actual resolved IPs. Separately, rejecting a `whois` request and observing the
agent retry through `subfinder` (unavailable → fed back automatically, no confirmation needed for
the failure) → `amass` (also unavailable, same automatic retry) → `dig` (available, correctly
paused for confirmation) validated the Orchestrator's internal-retry-on-invalid-request behavior
end-to-end, which is exactly what surfaced bug #2 above.

### What's next

- Streaming the agent's own text token-by-token during a task (still not built).
- Task history list in the Workbench (currently only the active task is shown; past tasks are
  reachable via `GET /api/orchestrator/tasks` but nothing in the UI lists them).
- No automated tests cover the new hooks/components — same gap as the backend pieces they drive.
- Project awareness is still the biggest structural gap (see the Tool Execution Framework section
  above) — nothing built this pass changes that.
