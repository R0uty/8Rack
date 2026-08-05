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
  *(Backend service-level tests added — see "Automated tests" near the end of this document.
  Frontend hooks and HTTP route tests are still manual-only, deliberately deferred.)*
- ~~The dev-mode "backend is down" error path returns a generic message~~ — done. Turns out Vite's
  proxy actually responds with an *empty-bodied* `502` (confirmed via curl), not literal HTML as
  guessed here originally — either way `res.json()` on it throws, so
  `httpClient.ts#throwForErrorResponse`'s `status >= 500` fallback was already the right detection,
  it just needed a better message: it now says "Could not reach the backend server. Is it running?
  Start it with `./start.sh` (or `cd backend && npm run dev`)." — as actionable as the Ollama-down
  message it was being compared against.
- ~~`backend/data/agents/*.json` has no schema validation beyond the minimal shape check~~ — the
  shape check itself is unchanged (still minimal, still just structural), but bad files are no
  longer silent: see "Agent Manager & Chat Service" below for `getAgentConfigWarnings()`.

## Extension points (Task 11)

Interfaces + empty registries for the six future areas, all under `backend/src/`:

- **Tool execution** — `types/tool.ts` (`Tool`, `ToolDefinition`, `ToolResult`) +
  `extensions/toolRegistry.ts` (`registerTool`, `getTool`, `listTools`)
- ~~**Multi-agent orchestration**~~ — implemented for real; `extensions/orchestrator.ts` is deleted
  (its call-and-return signature couldn't express pausing mid-plan for a tool confirmation) and
  `types/orchestration.ts` was rewritten in place rather than superseded elsewhere. See "Multi-Agent
  Orchestration" near the end of this document.
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

Skipped files stop being silent as of this pass: `readAgentConfigs` now returns `{agents,
warnings}` instead of just `agents`, where each warning is `{file, reason}` (`"Invalid JSON"` /
`"Missing or malformed required fields"` / `` `Duplicate agent id "<id>"` ``) — `console.warn` stays
too, this is additive. `reloadAgents()` stashes the latest batch in a module-level
`warningsCache`, read back via the new `getAgentConfigWarnings()`; since `loadAgents()` delegates to
`reloadAgents()` on a cache miss, the very first load populates it too, not just explicit reloads.
Both `GET /api/agents` and `POST /api/agents/reload` (`routes/agents.ts`) now include `warnings` in
their response alongside `agents`. Frontend: `AgentList.tsx` renders a small amber box above the
agent list whenever `warnings.length > 0`, naming each bad file and why — gone again once the file
is fixed and reloaded. Verified live by dropping in an invalid-JSON file and a duplicate-id file
side by side, confirming both showed with the right reasons, then fixing them and confirming the
banner cleared on reload; also covered in `agentManager.test.ts` (one case per warning reason, plus
a stale-warnings-clear-on-next-reload case).

**`backend/src/services/chatService.ts`** — the reusable Chat Service. `streamAgentChat(request,
signal)` takes an agent ID and a message history, loads the agent via the Agent Manager, throws a
typed error if it's missing/disabled/offline (`AgentNotFoundError` / `AgentDisabledError` /
`AgentOfflineError`, mapped to 404/403/503 in `middleware/errorHandler.ts`), prepends the agent's
`systemPrompt` as a system message, layers the agent's temperature/topP/maxTokens under any
request-level `options` override, and delegates to `services/ollama.ts#streamChat` or
`streamChatWithTools` exactly like the plain chat path. It's a plain async generator with no HTTP
dependency — both `services/orchestrator.ts` (single-agent tool loop) and, transitively,
`services/multiAgentOrchestrator.ts` (see "Multi-Agent Orchestration" near the end of this
document) call it directly instead of going through `POST /api/agents/:id/chat`.

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
- ~~No automated tests cover the Agent Manager / Chat Service~~ — done, see "Automated tests" near
  the end of this document.
- ~~Multi-agent orchestration~~ — done, see "Multi-Agent Orchestration" near the end of this
  document. (It ended up calling into `services/orchestrator.ts` per step rather than
  `chatService.ts#streamAgentChat` directly, so a step gets tool-use + confirmation, not just a bare
  chat completion — see that section for why.)

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

*(Resolved in the "Projects" section near the end of this document — tool execution history and
Orchestrator tasks are now project-scoped and persisted; chat intentionally stayed out of scope.)*

### What's next (as of the Phase 1 write-up above)

- ~~The Orchestrator~~ — done, see "Orchestrator" below.
- **Tool Registry UI** and **Execution Console UI** — both explicitly deferred; the backend is
  already shaped for them (`GET /api/tools`'s availability data, the confirm route's streamed
  NDJSON), so this should mostly be frontend work now that the Orchestrator is actually producing
  executions to display.
- **Project awareness** (see "Known limitation" above) — needs actual project selection UI plus
  per-project persisted execution history before "make previous results available to agents as
  context" means anything.
- ~~No automated tests cover `toolExecutor.ts`/`toolManager.ts`~~ — done, see "Automated tests" near
  the end of this document.

## Orchestrator

The single-agent tool-calling loop: an agent's replies get scanned for a tool request, the
wrapper executes it (through the exact same confirm/reject flow described above — nothing about
tool execution changed), the result goes back into the conversation, and this repeats until the
agent gives a final plain-text answer or a limit trips. This is what turns the previously
curl-only-drivable execution engine into something an agent can actually use to complete a task.

**Not to be confused with `services/multiAgentOrchestrator.ts`** — that's the *multi-agent*
orchestrator (running several agents across a plan of steps, each step being a full instance of
*this* single-agent loop), documented in "Multi-Agent Orchestration" near the end of this document.
This section is about the single-agent tool loop itself, implemented in `services/orchestrator.ts`.

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
- ~~No automated tests cover `orchestrator.ts`~~ — done, see "Automated tests" near the end of this
  document.

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

- ~~Streaming the agent's own text token-by-token during a task~~ — done, see "Token-level
  streaming" under "Orchestrator" above.
- Task history list in the Workbench (currently only the active task is shown; past tasks are
  reachable via `GET /api/orchestrator/tasks?projectId=` but nothing in the UI lists them).
- No automated tests cover the new hooks/components — the backend pieces they drive now do (see
  "Automated tests" near the end of this document), but frontend tests are still a deliberately
  deferred gap, not yet started.
- ~~Project awareness~~ — done, see "Projects" below.

## Projects

Tool execution history and Orchestrator tasks were single global in-memory lists (capped, lost on
restart) with no concept of separate targets/engagements — flagged as a real gap since the Tool
Execution Framework section above. A **project** now scopes both.

**Deliberately narrow scope**: a project has just `name` + free-text `notes` (no structured
target/scope fields), and only scopes tool execution history + Orchestrator tasks — **chat is
untouched**, still one global `sessionStorage` thread (see "Settings vs. session storage" above for
why that split exists in the first place). `env.workspaceRoot` (the filesystem sandbox for exec
tools) also stays a single global directory. Both are intentional non-goals, not oversights — see
`TODO.md`'s "Project-scoped chat" entry for the natural follow-up if/when that's wanted.

**Storage** (`services/projectStore.ts` + `services/projectManager.ts`): each project is a
directory, `backend/data/projects/<id>/`, containing `project.json` (metadata) and — written by
`toolManager.ts`/`orchestrator.ts`, not `projectManager.ts` itself — `executions.json` and
`orchestrator-tasks.json`. `projectStore.ts` is intentionally generic (`listProjectIds`/
`readProjectJson<T>`/`writeProjectJson<T>`) so all three call sites share one place that owns the
on-disk layout. Unlike `agentManager.ts`, `projectManager.ts` has no read-through cache — projects
are mutated via `POST/PATCH/DELETE /api/projects/:id`, and the project count will always be small
enough that reading fresh from disk each time is simpler than a cache-invalidation dance.
`backend/data/projects/*` is gitignored (with `.gitkeep`), unlike the shipped
`backend/data/agents/*.json` — this is user-created runtime data, and a project's free-text `notes`
could plausibly contain real target/scope information worth keeping out of git.

**Scoping existing history**: `ExecutionRecord`/`OrchestratorTask` both gained a required
`projectId`. `toolManager.ts`'s `MAX_HISTORY` cap and `orchestrator.ts`'s task list are now filtered
per-project instead of globally. Every relevant route requires `projectId` (400 if missing):
`POST /api/tools/request`, `GET /api/tools/executions?projectId=`, `POST /api/orchestrator/tasks`,
`GET /api/orchestrator/tasks?projectId=`. Confirm/reject/cancel endpoints stay id-only — no
cross-project validation needed, since execution/task ids are unguessable UUIDs and this is a
single-local-user tool.

**Persistence tradeoff**: `persistExecutions`/`persistTasks` write a project's full filtered record
list to disk on every mutation. Both are `await`ed inside functions that were already `async`
(`requestExecution`, `runRecord`, and `createTask`/`resumeTask`'s wrapper around `advance`), but
fire-and-forget (`void persist(...).catch(console.error)`) inside `rejectExecution`/
`cancelExecution`/`cancelTask`, which are synchronous today and called synchronously from their
routes — forcing them `async` for a local-disk write that's fine to lag by a tick wasn't worth the
ripple through their call sites. At server startup, `loadExecutionsFromDisk()`/`loadTasksFromDisk()`
(called once from `index.ts`, alongside the existing `loadAgents()`) hydrate the in-memory `Map`s
from every project's persisted files, so history is available immediately rather than only being
written-through from that point on.

**Frontend**: `ProjectPanel` (create/select/delete) sits at the top of the Workbench, above "New
Task" — mirrors `AgentList`'s list-item styling. Delete uses an inline two-step confirm (click →
"Delete X? [Delete] [Cancel]" row) instead of a native `confirm()`, so it stays scriptable by
browser automation instead of blocking on a modal. `useTools(projectId)` skips the executions fetch
entirely when `projectId` is `null` (the tools list itself still loads — it isn't project-scoped).
Starting a task now requires both an agent *and* a project; the `ProjectPanel` locks (all buttons
disabled) while a task is active/non-terminal, because switching projects mid-task would silently
swap `executions` out from under the active task's `pendingExecutionId` lookup and hide the
confirm/reject UI without the task's own status ever changing.

**Verified via curl**: two projects' tool executions and Orchestrator tasks stay fully isolated
from each other; omitting `projectId` on any scoped endpoint 400s; killing and restarting the
backend process, then re-`GET`ting both endpoints for the same project, returns the same records
(proves on-disk persistence, not just in-memory scoping); deleting a project removes its directory
(and, confirmed separately, a 404 on all its formerly-existing endpoints afterward via `getProject`
returning `undefined`). **Verified live in-browser**: created two projects, ran a full
tool-request → confirm → resume task inside one, confirmed the Tool Registry's execution history
switched cleanly between projects with no cross-contamination, and confirmed the two-step delete UI
removes a project without disturbing a different, currently-active one.

## Automated tests

First pass at automated tests, **backend service-level unit tests only** — no frontend hook tests,
no HTTP route/`supertest` tests, both deliberately deferred (see "Non-goals" below). Targets exactly
the gaps this document had been flagging piece by piece: `orchestrator.ts`, `toolExecutor.ts`/
`toolManager.ts`, `agentManager.ts`/`chatService.ts`, `projectManager.ts`/`projectStore.ts`. 81
tests across 6 files, `cd backend && npm test` (or `npm run test:watch`).

**Tooling**: [Vitest](https://vitest.dev), added as a backend devDependency — ESM + `NodeNext` +
TypeScript with no config friction (esbuild-transpiled, understands this codebase's `.js`-suffixed
relative imports natively). `backend/vitest.config.ts` is minimal (`environment: "node"`,
`include: ["src/**/*.test.ts"]`). Test files are co-located next to the source they test
(`orchestrator.ts` → `orchestrator.test.ts`), the standard Vitest convention, and stay under
`tsconfig.json`'s existing `include: ["src"]` so `npm run typecheck` type-checks them too — no
tsconfig changes were needed. One small non-test source change: `orchestrator.ts`'s
`parseToolRequest` gained `export` (no behavior change) since it's exactly the fence-stripping/
JSON-extraction logic worth pinning down directly.

**Shared test infrastructure** (`backend/src/test-utils/fakeFs.ts`): a small in-memory double for
the five `node:fs/promises` functions `agentManager.ts`/`projectManager.ts`/`projectStore.ts`
actually use (`mkdir`/`readFile`/`writeFile`/`readdir`/`rm`), backed by a `Map<path, content>`.
`readdir` supports both the plain-string-array form (`agentManager.ts`'s usage) and
`{ withFileTypes: true }` (`projectStore.ts`'s usage), inferring "file" vs "directory" entries from
whether more path segments follow a given prefix. Chosen over a new dependency (`memfs`) or
refactoring `AGENTS_DIR`/`PROJECTS_DIR` to be injectable — both are fine to leave resolved from
`import.meta.url` at module load time.

**A real hoisting gotcha worth remembering**: `vi.mock("node:fs/promises", factory)` calls are
hoisted by Vitest above every other top-level statement in the file — including plain `import`
statements. A factory that closes over an outer `let fakeFs` variable (`let fakeFs; vi.mock(...,
() => { fakeFs = createFakeFs(); return fakeFs; })`) throws `Cannot access 'fakeFs' before
initialization`, because the factory runs before that `let` is reachable. The fix used throughout
(`agentManager.test.ts`, `projectManager.test.ts`): make the factory `async` and `await
import("../test-utils/fakeFs.js")` *inside* it (dynamic imports are always safe regardless of
hoisting order), then recover the same instance afterward via a normal `import * as fakeFsModule
from "node:fs/promises"` — since that import resolves to whatever the mock factory returned, no
outer variable or `vi.hoisted()` juggling needed.

**Why the module-level `tools`/`executions`/`tasks` Maps in `toolManager.ts`/`orchestrator.ts`
didn't need per-test isolation**: every created entity (execution, task) gets a fresh `randomUUID()`
id, and tests only ever operate on the specific id/project they just created — so state
accumulating across tests within one file (no `vi.resetModules()`) never causes cross-test
interference. `agentManager.ts`'s module-level `cache` is the one genuine exception; every test
calls `reloadAgents()` (which always re-reads) rather than `loadAgents()`, sidestepping it entirely
rather than needing a module reset dance.

**Notable per-file choices**:
- `toolExecutor.test.ts` uses **real subprocesses**, no mocking — `process.execPath -e "<script>"`
  (Node itself) instead of `bash`/`echo`/`sleep`, so the only external dependency is Node. Covers
  timeout, external-`AbortSignal` cancellation, stdin piping, output truncation, and a nonexistent
  executable resolving (never rejecting) with a failure result.
- `toolManager.test.ts` registers a real `ExecTool` pointing at `process.execPath` and runs it for
  real through `confirmExecution` — including a genuine cancel-mid-run test (start `confirmExecution`
  without awaiting, cancel ~100ms later, then await and assert `cancelled: true`).
- `orchestrator.test.ts` is the largest file — the full state-machine (agent replies, tool
  requests, the internal invalid-tool-request retry loop, both loop-prevention caps, resume/cancel,
  `RequestCancelledError` handling) with `./chatService.js`/`./agentManager.js`/`./toolManager.js`/
  `./projectStore.js` all mocked. The `max_time_reached` cap is tricky to trigger because
  `createTask` sets `createdAt` and checks the time-cap synchronously in the same tick — there's no
  gap to advance a fake clock in between. Worked around by creating a task that lands on
  `waiting_confirmation` first, advancing `vi.useFakeTimers()`/`vi.setSystemTime()` past
  `env.maxOrchestratorTaskTimeMs`, then calling `resumeTask` — its `advance()` call re-checks the
  (unchanged) original `createdAt` against the now-fast-forwarded clock.
- Tests read `env.maxOrchestratorToolCalls`/`env.maxOrchestratorTaskTimeMs` directly rather than
  hardcoding the default (10 / 10 minutes), so they stay correct regardless of what a real
  `backend/.env` happens to set.

**Sanity-checked, not just written**: temporarily broke `toolExecutor.ts`'s timeout flag
(`timedOut = true` → `timedOut = false`) and `orchestrator.ts`'s tool-call cap comparison (`>=` →
`>`), confirmed the matching test failed both times with the exact expected/received mismatch, then
reverted. Proves the suite is wired to real behavior, not vacuously passing.

### Non-goals (this pass)

- Frontend hook tests (`useSettings`, `useTools`, etc.) — deliberately deferred, not forgotten.
- HTTP route-level tests (`supertest` against the Express app) — same.
- `agentManager.ts`/`toolManager.ts`'s exact cache/`MAX_HISTORY` internals weren't exported just to
  make a cache-hit or cap-trimming test possible — not worth widening either module's public
  surface for it.

## Multi-Agent Orchestration

`extensions/orchestrator.ts` + `types/orchestration.ts` had been an empty placeholder since Task 11
("multi-agent orchestration — running several agents across a plan of steps"). Implemented as
agreed: each **step** is a full single-agent Orchestrator task (agent can request tools and pause
for the exact same Approve/Reject confirmation a standalone task uses, not a bare chat completion),
the **plan is user-authored** in the UI (not auto-generated by the Planner agent), and steps run
**sequentially** with each step's final answer feeding into the next step's objective as context.

**Why the placeholder got deleted rather than filled in**: `runOrchestration(plan):
Promise<OrchestrationResult>` was a call-and-return shape — it can't express "pause mid-plan, wait
for a human to confirm a tool, then continue," which is a hard requirement once a step can request
tools. The real implementation lives in `services/multiAgentOrchestrator.ts` (matching where the
single-agent Orchestrator already lives) and `types/orchestration.ts` was rewritten in place to the
real shape rather than left behind as dead code next to a working replacement elsewhere.

**`backend/src/types/orchestration.ts`**: `PlanStep {agentId, objective}` is the fixed, authored
plan. `PlanStepRun` is what actually happened for one step — `orchestratorTaskId` plus a
`status`/`finalResponse` **snapshot** captured each time the plan advances, deliberately not
live-polled (only the *current* step's task is fetched live, and that's done by the route layer,
not stored on the plan itself — see below). `MultiAgentPlan` ties it together: `steps` (fixed),
`stepRuns` (grows as steps execute), `currentStepIndex`, and its own `status` (`running` /
`waiting_confirmation` / `completed` / `failed` / `cancelled`).

**`backend/src/services/multiAgentOrchestrator.ts`** mirrors `services/orchestrator.ts`'s
pause/resume/persist shape one level up:
- `createPlan`/`resumePlan` call `orchestrator.js#createTask`/`resumeTask` for the current step,
  then hand off to an internal `continueAfterStepTask`, which **recurses** exactly like
  `orchestrator.ts#advance` does internally: a step that completes without pausing chains straight
  into starting the next one (via `buildStepObjective` — every prior step's `finalResponse`,
  labeled by agent name, prepended to the next step's own authored objective), so a plan with no
  tool calls can run start-to-finish in one HTTP request just like a no-tool single-agent task can.
  Landing on `waiting_confirmation` stops the recursion and returns; any other terminal status
  (`failed`/`cancelled`/a cap reached) stops the *whole plan*, not just the step.
- `cancelPlan` cancels the current step's task via `orchestrator.js#cancelTask` and marks the plan
  cancelled — same synchronous, no-status-guard signature/tradeoff as `orchestrator.ts#cancelTask`
  itself (calling cancel on an already-terminal plan will stomp its last step's task status the same
  way the single-agent primitive already does; not fixed here since it's pre-existing behavior of
  the reused primitive, and the UI only offers Cancel on non-terminal state anyway).
- Persistence mirrors `orchestrator.ts#loadTasksFromDisk`/`persistTasks` exactly: per-project
  `multi-agent-plans.json` via the existing generic `services/projectStore.ts` helpers (no changes
  needed there), hydrated once at server startup (`index.ts`'s `loadPlansFromDisk()` call).

**`backend/src/routes/plans.ts`**: `POST /` and `POST /:id/resume` stream NDJSON exactly like
`routes/orchestrator.ts`'s `runAndStreamTask` (`{type:"chunk",content}` per token, terminal
`{type:"result", plan, currentStepTask}`) — the route joins in the current step's live
`OrchestratorTask` via `orchestrator.js#getTask` server-side, so the client never needs a second
fetch to render the in-progress step. `POST /` validates `steps.length >= 2` (a 1-step "plan" is
just the existing single-agent Workbench) and checks every `agentId` resolves via
`agentManager.js#getAgent` *before* calling `createPlan`, so a typo'd agent id fails fast instead of
after earlier steps already did real work.

**Frontend**: `components/OrchestratorTaskView.tsx` is a new extraction out of
`OrchestratorWorkbench.tsx` — the entire message-transcript/confirm-card rendering (previously
inline: `UserCard`/`AssistantCard`/`ToolResultCard`/the collapse-toggle tool-result logic/the
task-header-with-Cancel-or-New-Task-button wrapper) is now a standalone `OrchestratorTaskView`
component, parameterized via props (`task`, `headerLabel`, `onCancel?`, `onReset?`, ...) so both
`OrchestratorWorkbench` (single-agent) and the new `MultiAgentPlanner` (multi-agent, rendering just
the *current* step this way) share it — real reuse, confirmed by there now being two call sites,
not a speculative abstraction. `hooks/useMultiAgentPlan.ts` mirrors `useOrchestratorTask.ts` one
level up (`start`/`approve`/`reject`/`cancel`/`reset`, plus `currentStepTask` alongside `plan`).
`components/MultiAgentPlanner.tsx` is the new "Plans" nav tab: a step builder (agent picker +
objective per step, minimum 2, add/remove rows) when no plan is running, and a run view once one
is — completed steps as collapsible summary cards, the live current step rendered via
`OrchestratorTaskView`, and not-yet-reached steps as muted "not started" placeholder cards so the
whole plan's shape stays visible throughout the run.

**Verified via curl**: a 2-step chat-only plan chaining correctly (step 2's objective demonstrably
contained step 1's exact output, and step 2 correctly answered a question that could only be
answered from that chained context); a step requesting a real tool mid-plan, reaching
`waiting_confirmation` at the *plan* level, rejecting it via the existing
`/api/tools/executions/:id/reject`, then `POST /api/plans/:id/resume` correctly resuming that step
and auto-advancing into and completing step 2; project isolation between two projects; a backend
restart preserving full plan history. **Verified live in-browser**: built a real Recon Agent →
General Assistant plan, approved a live `bash` tool call mid-plan, watched it chain automatically
into step 2 which correctly summarized step 1's actual tool output (not a hallucination — it named
the exact string echoed in step 1); expand/collapse on a completed step's summary card; and
re-verified the single-agent Workbench tab behaves byte-for-byte identically to before the
`OrchestratorTaskView` extraction. One non-obvious debugging note from that session: driving the
plan builder's `<select>` elements via raw `element.value = x; dispatchEvent(new
Event('change'))` in the browser-automation tool did *not* reliably propagate to React's
controlled-component state (the DOM visually showed the right selection, but React's own state
stayed stale) — the fix was using the automation tool's dedicated form-input helper instead, which
goes through React's tracked native-setter path correctly. Not an application bug, but worth
remembering next time an automated test is driving a controlled `<select>`.

13 new backend tests (`multiAgentOrchestrator.test.ts`, mirroring `orchestrator.test.ts`'s mocking
approach: `./orchestrator.js`'s `createTask`/`resumeTask`/`cancelTask` mocked, `./agentManager.js`
mocked for step-context agent-name lookups, `./projectStore.js` mocked as no-ops).

### Deliberate non-goals

- The plan is authored by the user, not generated by the Planner agent from a single objective —
  the natural follow-up if/when that's wanted, but it needs its own JSON-request-and-parse contract
  (like `orchestrator.ts#parseToolRequest`) and gives up direct control over what actually runs.
- Steps run sequentially only — no parallel/branching plan shapes. Nothing in the current
  `MultiAgentPlan` shape rules this out later, but it wasn't needed for a first real implementation.
- No plan-deletion endpoint — plans accumulate in project history the same way tool executions and
  Orchestrator tasks already do; deleting one project's whole history (via the existing project
  delete) is the only way to clear it, consistent with how the rest of project-scoped history works.

## Premium UI/UX Redesign

The frontend was rebuilt end-to-end from a plain flat-`App.css` dashboard (BEM classes, 3 CSS
variables, native `<select>`/`<table>` elements, emoji icons) into a "AI operating system"-style
desktop app (Cursor/Linear/Warp/Arc/Raycast-inspired: dark charcoal + emerald, glass panels, glow
borders, large spacing, motion) per an explicit design spec. **This was a visual/UX reskin only —
no backend route, business-logic, or `hooks`/`services`/`types` change.** Every view keeps the
exact same data flow it had before; only `components/`, `App.tsx`, and the CSS/build layer changed.

Two things the spec asked for were deliberately **not** built, to keep the UI honest about what's
real: dashboard widgets with no backend data source (Risk Score, Coverage %, Attack Surface Graph,
Asset Map, Risk Heatmap — nothing in this app computes any of those), and Reports/Plugins nav
entries (`extensions/reportGenerator.ts` still throws "not implemented", the plugin registry is
still an empty placeholder — a nav item leading to an empty screen would be worse than no nav item).

**New dependencies** (`frontend/package.json`): `tailwindcss` + `@tailwindcss/vite` (v4, CSS-first
config, no `tailwind.config.js`), `@tailwindcss/typography` (for `Markdown.tsx`'s prose styling),
`lucide-react`, `framer-motion`, `clsx`, `@fontsource-variable/inter` (self-hosted, keeps the app
fully offline-capable per the "no cloud" constraint). `vite.config.ts` gained the
`@tailwindcss/vite` plugin.

**Design tokens** (`frontend/src/index.css`): `@theme` block maps the spec's exact palette
(`#0B0F14` bg / `#131A22` surface / `#1B2430` card / `#00E676` primary / `#00C2FF` info / `#FFC400`
warning / `#FF5252` critical, 16px panel radius) to Tailwind color/radius utilities
(`bg-surface`, `text-muted`, `rounded-panel`, ...). Dark is the default and the only
fully-hand-tuned theme; a `data-theme="light"` override block exists and is wired to a real
toggle (`hooks/useTheme.ts`, localStorage-persisted, stamps `data-theme` on `<html>`) so the
spec's top-bar "theme switch" isn't decorative — it's just a lighter-touch pass than dark.

**`frontend/src/lib/icons.ts`** — a frontend-only emoji→`lucide-react` lookup table covering every
icon currently shipped in `backend/data/agents/*.json` and `backend/src/tools/exec/builtins.ts`,
falling back to a generic `Bot`/`Wrench` icon for anything unmapped. This exists specifically so
the "Lucide icons only, no emojis" visual language could be honored **without touching backend
data** — `agent.icon`/`tool.icon` are still plain emoji strings on disk; the mapping is presentation
only, in `iconFor(emoji, fallback?)`.

**`components/ui/`** — a small primitive set that also cleans up duplication the redesign's
research pass flagged in the old code (three different ad hoc status-pill renderings, two
duplicated collapse/expand `useState` implementations, two separate CSS blink-cursor rules):
`GlassPanel` (the frosted-glass card used everywhere), `StatusPill`/`StatusDot` (semantic
`Tone` = primary/info/warning/critical/neutral), `Button`/`IconButton`, `Collapsible`
(framer-motion height animation), `Sheet` (right-docked modal, replaces `SettingsPanel`'s bespoke
backdrop markup), `ProgressRing` (indeterminate spinner only — deliberately no numeric `value`
prop, since nothing in this app tracks real progress percentages), `StreamingCursor`,
`SectionHeading`.

**`components/layout/`** — the new 3-column shell, replacing `Header.tsx`/`StatusBar.tsx`/
`AgentSidebar.tsx` (all three deleted):
- `AppShell` — fixed 280px left sidebar, flexible center, optional ~340px right panel.
- `Sidebar` — logo, view nav (same `Chat`/`Workbench`/`Plans` `AppView` union, now living here
  instead of a header bar), then the existing `ModelSelector`/`AgentList` (restyled in place, same
  props/behavior), pinned bottom Ollama status.
- `TopBar` — view label, agent/model badge, theme toggle, settings gear, and a command-palette
  trigger.
- `RightPanel` — **Chat-view only**: a real agent-detail card (description/model/temperature/topP/
  maxTokens/status) when an agent is selected, else a manual-model card, plus a real session
  message count. Workbench/Plans keep their own internal main+aside split (the existing
  `ToolRegistry` sidebar slot, just restyled as cards) rather than lifting `useProjects`/`useTools`
  state up to the shell — those hooks are already correctly scoped per-view, and hoisting them would
  have been a real architecture change disguised as a reskin.
- `CommandPalette` — a real Cmd/Ctrl+K palette (fuzzy substring match), not a decorative search box:
  actions are "switch view", "select agent", "select model", "open settings", "toggle theme", all
  wired straight to `App.tsx`'s existing setters. No fake "AI command" input.

**Chat view** (`ChatArea`/`ChatMessageView`/`PromptInput`/`Markdown`): the empty state (previously
"No messages yet" placeholder text) is now `components/chat/AgentNetwork.tsx`, a radial node graph
of the real configured agents — icon, live online/offline status, model — with decorative
SVG connector lines from a center "8R" hub. Clicking a node calls the exact same
`handleSelectAgent` used by the sidebar (including the toggle-deselect-on-reclick behavior). This
is the spec's "Interactive AI Agent Network" built entirely from real `AgentWithStatus[]` data, not
fabricated telemetry — no fake progress rings, token counts, or "current task" per node, since none
of that exists as idle-state agent data in this app.

**Workbench/Plans**: `ProjectPanel` → card tiles (same inline-create-form and two-step
delete-confirm UX, just restyled); `ExecutionConsole` → a Warp-style terminal card (resolved
command, live/final output, status pill, exit code/time/flags) that gained real **Copy** and
**Export** (download the visible output as `.txt` via a `Blob`, pure client-side) buttons — Search
and Bookmark across execution history from the spec's Terminal section were deliberately **not**
built, since they'd need real state design (indexing/persisting across runs) disproportionate to a
visual pass; `ToolRegistry` → card list instead of a `<table>`; `OrchestratorTaskView`'s message
cards restyled onto the shared glass-card look, its collapse/expand moved onto `Collapsible`;
`MultiAgentPlanner`'s step cards gained a numbered connector rail (real steps/statuses only, no
fabricated progress numbers).

**Settings**: `SettingsPanel` now renders on the new `Sheet` primitive — same fields, same
`onChange`/`onReset` contract, just the backdrop+panel markup replaced.

**A real, non-obvious finding from browser-testing this**: framer-motion mount animations
(`initial`/`animate` on `motion.*` components) never progress in this project's browser-automation
tool — inspecting a stuck node confirmed `document.visibilityState === "hidden"` /
`document.hasFocus() === false` for the automated tab, and `requestAnimationFrame` (which
framer-motion's animation engine depends on) simply doesn't fire for backgrounded/unfocused tabs in
Chrome. Elements get their `initial` style applied once and then sit frozen (e.g. `opacity: 0`)
until something (a real click, a navigation) briefly grants the tab a paint). **Not an application
bug** — confirmed by forcibly setting the `animate`-target styles via a JS eval, which rendered the
intended layout exactly as designed (radial agent network, glowing connector lines, agent-color
node accents all correct). Worth remembering for any future browser-automation verification of
animated UI in this app: judge animated components by their DOM/computed-style end-state and by
interaction correctness, not by whether a screenshot mid-animation looks populated. A related
artifact: screenshots taken of a backgrounded tab can show a **stale compositor frame** even after a
DOM/CSSOM change that's already correct (confirmed via `getComputedStyle`) — e.g. the theme toggle's
`data-theme` attribute and CSS variables flipped correctly on click, but the next screenshot still
showed the old theme until a real click gave the tab a fresh paint. Same non-bug, same fix
(verify via computed styles/DOM, not screenshot timing, when the tab may be backgrounded).

**Verified live in-browser** (real Ollama + real tools, not just typecheck): agent selection
(sidebar and network node) correctly locks the model dropdown and populates the right panel's
agent-detail card; sending a chat message end-to-end with `qwen2.5-coder`; a full Workbench task
(Recon Agent, `dig A example.com`) through New Task → waiting-confirmation → Approve →
streamed real `dig` output → completed, with the final assistant answer correctly citing the real
resolved IPs; the Plans step-builder UI; the Settings sheet opening with the active agent's real
temperature/topP/maxTokens/keepAlive; the theme toggle. `cd frontend && npx tsc -b` and
`npm run lint` both clean (the only lint output is 3 pre-existing `only-export-components` fast-refresh
warnings on `OrchestratorTaskView.tsx`, unchanged by this pass — that file exported constants
alongside its component before the redesign too).

### What's next

- Frontend hook/component tests still don't exist (see "Non-goals" under Automated Tests above) —
  unaffected by this pass either way.
- If the app ever gains real per-agent runtime telemetry (current task, token usage, ETA), the
  `AgentNetwork` nodes and `RightPanel`'s agent-detail card are the natural place to surface it —
  deliberately left out now since no such data exists yet.
- Command palette actions are static (view/agent/model/settings/theme); if action count grows,
  revisit `components/layout/CommandPalette.tsx`'s scoring (currently a plain substring filter).
