# 8Rack — Development Notes

This file is the handoff/reference doc for continuing work on 8Rack. It captures architecture,
key decisions, and what's left — things not obvious from just reading the code. For run
instructions, see `README.md`.

## Stabilization pass (make-it-work audit)

A full end-to-end verification pass against the live stack (backend + real Ollama), walking every
critical path rather than trusting the unit suites alone. All five functional flows were confirmed
working live: agent chat, tool execution + human confirmation, single-agent orchestration, and a
two-step multi-agent plan (verified via curl and browser). Fixes made during the pass:

- **Nested-`<button>` hydration error (`ProjectPanel.tsx`)** — the project card was a
  `GlassPanel as="button"` containing the Edit/Delete `<button>`s, which is invalid DOM and threw a
  React hydration error on every render of Workbench/Plans/Findings. Changed the card to a
  `role="button"` div with an `onKeyDown` (Enter/Space) handler so the inner buttons are valid while
  keyboard activation is preserved.
- **Empty target mind map (`findingsManager.ts#GRAPHABLE_TYPES`)** — the graph builder excluded
  `domain`/`information`/`header`/`cookie`/`interesting_file`, so a whois/DNS-only recon pass
  produced real findings but a blank graph, even though `FindingsGraphView.tsx#NODE_TONE` already
  had colours for all 16 finding types. Extended `GRAPHABLE_TYPES` to all 16 so the mind map
  actually reflects discovered findings (verified live: showpad's 11 whois findings now render).
- **Dead code removed** — `extensions/pluginRegistry.ts`, `extensions/retrievalRegistry.ts`, and
  `types/plugin.ts` were a self-contained island with zero live importers (leftover scaffolding for
  the never-built Plugin system). `toolRegistry.ts`/`types/tool.ts` were kept (still wired into the
  native tool-calling path).
- **E2E smoke test added** (`backend/scripts/smoke-test.mjs`, `npm run smoke`) — drives the real
  running stack over HTTP through all seven critical stages (health → agents → chat → tool exec →
  confirmation → orchestration → 2-step plan), reporting PASS/FAIL per stage and naming the failing
  one. Requires the backend + a live Ollama with a pulled model.
- **Workbench task stuck on "Starting…" (`useOrchestratorTask.ts`)** — a StrictMode double-mount
  bug: `useOrchestratorTask`'s unmount cleanup aborted the in-flight request synchronously, so in
  dev StrictMode's mount→unmount→remount cycle cancelled the task started on first mount (the
  backend saw the client disconnect and marked it `cancelled`), and `TaskSessionPanel`'s start-once
  guard (`session.started`) then blocked a restart — leaving `task` null and the panel frozen on
  "Starting…" forever (the abort also being swallowed as a benign `AbortError`, so no error showed).
  Every UI-started Workbench/`ChatTaskPanel` task was affected; it went unnoticed because the smoke
  test and earlier orchestration checks drove the API directly, never the task-start UI path. Fix:
  defer the abort a macrotask and guard it with a `mountedRef`, so StrictMode's immediate remount
  cancels it while a genuine tab-close unmount still aborts. Verified live: a fresh Recon Agent task
  now streams, reaches the confirmation gate, and chains tools (whois → dig) through the UI. New
  regression test in `useOrchestratorTask.test.ts` covers the StrictMode-remount case.

Known non-blocking item (unreachable via the normal UI): the orchestrator/plans routes validate
that `projectId` is a non-empty string but not that it's UUID-shaped, so a malformed id runs the
agent before failing at persist time (`InvalidProjectIdError`, correctly surfaced — not swallowed).
Worth a fast up-front reject if that path ever becomes reachable.

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

- ~~Frontend hook tests~~ — done, see "Frontend hook/component tests" near the end of this
  document.
- HTTP route-level tests (`supertest` against the Express app) — still deliberately deferred.
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

### Polish pass (closing gaps against the original design plan)

The redesign's approved plan promised loading skeletons and animated view-switch transitions that
didn't actually get built in the first pass — closed in a follow-up, along with a general
rough-edges sweep:

- **`components/ui/Skeleton.tsx`** (`Skeleton`/`SkeletonRow`/`SkeletonRows`) — a pulsing placeholder
  shown whenever a list is loading for the first time with no data yet (`loading && list.length ===
  0`), so there's no blank gap between the "loading" and eventual content/empty state. Wired into
  `ModelSelector`, `AgentList`, `ToolRegistry`, `ProjectPanel`.
- **View-switch transitions** — `App.tsx`'s `center` content is now wrapped in framer-motion
  `AnimatePresence`/`motion.div` keyed by `activeView`, a short (120ms) fade+slide instead of an
  abrupt swap. Initially built with `mode="wait"` (sequential exit-then-enter), but that makes the
  new view's *mount* depend on the old view's exit animation completing — verified via
  browser-automation testing that when the exit never completes (see the framer-motion/backgrounded-
  tab finding above), navigation appears completely stuck on the old view. Switched to
  `mode="popLayout"` (new view mounts immediately in normal flow; the exiting view is popped out of
  layout and animates on top) specifically so real navigation never depends on an animation
  finishing — `AppShell`'s `<main>` gained `relative` positioning to contain the popped-out exiting
  element. Verified via DOM inspection (not just screenshot) that after this fix, the new view's
  actual interactive content is present in the DOM immediately on click, independent of animation
  state.
- **Keyboard focus rings** — `Button`/`IconButton` gained a shared `FOCUS_RING` export
  (`focus-visible:ring-2 focus-visible:ring-primary/60`, `:focus-visible` only, so it doesn't add a
  ring on mouse clicks) applied consistently across every interactive primitive and hand-rolled
  button (`GlassPanel[interactive]`, sidebar nav items, the agent list rows, project tiles and their
  delete button, the model `<select>`, `Collapsible`'s trigger, the plan-builder's remove-step
  button, every text input/textarea/select across `ProjectPanel`/`SettingsPanel`/
  `OrchestratorWorkbench`/`MultiAgentPlanner`). Verified via a real Tab keypress (not a scripted
  `.focus()` call, which Chromium doesn't reliably treat as `:focus-visible`-triggering) that
  `:focus-visible` matches and the computed `box-shadow` includes the expected emerald ring layer.
- **Empty-state gap** — `ToolRegistry` had no message for a legitimately empty (not loading, not
  errored) tool list; added one, matching the pattern every other list view already had.

`npx tsc -b` and `npm run lint` stayed clean throughout (same 3 pre-existing `OrchestratorTaskView.tsx`
warnings as before).

### What's next

- Frontend hook/component tests still don't exist (see "Non-goals" under Automated Tests above) —
  unaffected by this pass either way.
- If the app ever gains real per-agent runtime telemetry (current task, token usage, ETA), the
  `AgentNetwork` nodes and `RightPanel`'s agent-detail card are the natural place to surface it —
  deliberately left out now since no such data exists yet.
- Command palette actions are static (view/agent/model/settings/theme); if action count grows,
  revisit `components/layout/CommandPalette.tsx`'s scoring (currently a plain substring filter).

## Per-agent model override + parallel agent sessions

Two related gaps, closed together: every agent was hardcoded to one model (no way to say "use
Recon Agent, but with a different model this time" without editing its JSON file), and only one
agent could be "doing something" at a time — Chat was one global `sessionStorage` thread and the
Workbench was one global active task, even though the *backend* already ran tasks independently
(`services/orchestrator.ts`'s `Map<string, OrchestratorTask>` never assumed a single active task).
The limitation was entirely in the frontend's single-instance state.

**Model override (backend)**: `chatService.ts#AgentChatRequest` gained `model?: string`;
`streamAgentChat` now uses `request.model ?? agent.model`. The agent's own offline-status gate
(`AgentOfflineError`) only applies when *no* override is given — a request overriding to a
different, available model shouldn't be blocked by the agent's *default* model being unavailable;
Ollama still errors normally if the override itself isn't installed, same as the model-only (no
agent) chat path already relied on. `routes/agents.ts`'s `POST /:id/chat` and
`routes/orchestrator.ts`'s `POST /tasks` both accept an optional `model` in the body now.
`OrchestratorTask` gained `model?: string`, stored once at `createTask` and reused by every
`advance()` step (including across `resumeTask`), so a task's model choice is stable for its whole
lifetime rather than re-resolved per step. Never mutates the agent's own config — purely a
per-request/per-task choice, verified with new test cases in `chatService.test.ts` (asserting the
built request's `model` field) and `orchestrator.test.ts` (asserting the override reaches
`streamAgentChat` on both the initial step and a resumed one).

**Parallel sessions (frontend)**: a **session** is one live unit of work bound to an agent (or,
for a no-agent chat, just a model) — `kind: "chat" | "task"`, matching the two backend mechanisms
that intentionally aren't unified (chat has no tool-use/confirmation loop; Workbench/Orchestrator
does). `hooks/useSessions.ts` owns the lightweight `SessionMeta[]` list (persisted to
`sessionStorage`) plus which tab is focused *per kind* — Chat and Workbench each have their own
notion of "active tab". ~~Enforces one open session per (agent, kind): opening an agent that
already has a session of that kind focuses it instead of duplicating it~~ — still true for chat,
no longer true for task sessions, which now allow multiple concurrent sessions per agent (a task is
one objective/tool-run, not an ongoing thread) - see "Concurrent task sessions per agent" near the
end of this document.

**The key simplification that avoided rewriting `useChat`/`useOrchestratorTask`**: each open
session renders its own mounted `ChatSessionPanel` or `TaskSessionPanel`
(`components/chat/ChatSessionPanel.tsx`, `components/workbench/TaskSessionPanel.tsx`), which calls
those hooks internally exactly as before — a distinct component instance already gives each
session fully independent state for free. `useChat`'s only required change was its
`sessionStorage` key becoming session-scoped (`` `8rack:chat-history:${sessionId}` ``, was a single
hardcoded key). **All open sessions stay mounted simultaneously** (inactive ones hidden via CSS
`hidden` class, never unmounted) — this is what makes "Recon Agent keeps working while I look at
Output Parser" actually true; an inactive tab's in-flight stream/task lives in a component that
never stopped running. Verified live: two chat sessions (Recon Agent, Output Parser) each held
correct, isolated message histories after interleaved sends; a Workbench task (Code Assistant)
reached `completed` in the background while a chat session stayed focused and interactive the
whole time (confirmed via DOM inspection of both views' mounted-but-hidden content, not just
screenshots — see the framer-motion/backgrounded-tab caveat below for why).

**Task sessions carry a one-shot auto-start**: the Workbench "New Task" form collects
agent/project/objective before any tab exists, so a newly created task session's `SessionMeta`
carries `projectId`/`initialObjective`, consumed once by `TaskSessionPanel`'s mount effect (guarded
by both a `useRef` — protects against React StrictMode's synchronous double-invoke within one
mount — and a persisted `started` flag on the session — protects against a reload re-firing it,
since a task's live state was never `sessionStorage`-persisted to begin with, same as before this
change; the tab would otherwise silently re-create the task on every refresh).

**Live status reporting**: `useSessions.ts` also holds a `Record<sessionId, Tone>` status map with
a `reportStatus(id, tone)` setter, called by each panel via a `useEffect` watching its own real
state (`sending` for chat, `STATUS_TONE[task.status]` for a task — reusing
`OrchestratorTaskView.STATUS_TONE`). This is what lets `SessionTabs` (the tab strip) and
`AgentNetwork` (the map) show live activity without owning that state themselves — a session's
*content* component is the only source of truth for its own status.

**Dynamic network map**: `components/chat/AgentNetwork.tsx`'s existing radial agent ring gained a
second layer — one small node per open session, connected by a line to its parent agent node (or,
for a manual/no-agent chat, to the center hub), colored/pulsing from `reportStatus`'s live tone.
New nodes/lines appear the instant a session opens and disappear when it closes, since they're a
direct render of `sessions`, not a separate decorative state. Clicking an agent node opens/focuses
a *chat* session for it (the default "start working with this agent" gesture); clicking a session
node focuses that session's tab — for a task-kind node, this also has to switch the active nav view
to Workbench, which the map has no say over (`onFocusTaskSession` callback threaded down from
`App.tsx`).

**Ripple effects on existing global state**: `App.tsx` dropped `selectedAgentId`/`modelLocked`
entirely — there's no more single "selected agent" the rest of the app depends on.
`Sidebar`/`AgentList`'s agent click now opens/focuses a chat session instead of setting global
state (highlighting is now "has ≥1 open session", not "is selected"); `ModelSelector` in the
sidebar is now specifically "pick the model for the next manual chat", no longer a lock target
(the whole `disabled`/`modelLocked` prop chain was removed). `TopBar`'s badge and `RightPanel`'s
agent-detail card now source from whichever session is *focused* in the current view, not a global
selection; `RightPanel`'s old single-thread message count was replaced with a real "N chats, M
tasks" running-sessions readout (a per-session live count wasn't cleanly available at `App.tsx`'s
level without new plumbing, and the aggregate reading fits the multi-session reality better
anyway). `SettingsPanel` deliberately **stays** one global panel applied to every session's next
send — historically Workbench tasks never received Settings-panel overrides at all (only
`model`/`toolsPreamble` were ever threaded through), so this pass didn't change that; going further
(per-session settings) was out of scope.

**A gap caught only by trying to verify the model-override claim, not by typecheck**: the first
implementation pass added backend support and "seed from the agent's default at session creation"
but never actually built a UI control to *change* a session's model afterward — exactly what the
user asked for. Added a compact model `<select>` in `ChatSessionPanel`'s own header (with an
"overridden" badge + reset-to-default button once it diverges from the agent's default) and a
second `<select>` next to the agent picker in the Workbench's New Task form (task sessions choose
their model at creation, not afterward — a running task's model is fixed for its lifetime, per the
backend section above). Verified end-to-end by patching `window.fetch` in-browser to capture the
actual outgoing request body after changing a session's model away from its default, confirming
`POST /api/agents/recon-agent/chat` carried the overridden model, not the agent's configured one.

**Verified live in-browser** (real Ollama + real tools): two concurrent chat sessions across
different agents with correctly isolated histories; a Workbench task completing in the background
while a different chat session stayed focused and interactive; the model-override UI and its
actual effect on the outgoing request (via the `fetch` patch above); the network map growing a node
per opened session with the right connector/status color and clicking one focusing the right tab;
`cd backend && npm test` (105 passing, up from 99) and `cd frontend && npx tsc -b && npm run lint`
both clean throughout.

### Deliberate non-goals

- `MultiAgentPlanner` (Plans view) is untouched — it already runs one plan at a time with its own
  multi-step agent picking; true parallel *plans* (not just parallel single-agent work) is a bigger
  follow-up, not requested here.
- No hard cap on total open sessions — not needed at this scale (8 shipped agents × 2 kinds).
- Per-step model override in the Plans builder — same reasoning as the redesign's deliberately
  deferred items, a mechanical extension of the same pattern if actually wanted later.

## RAG over a workspace codebase

Fills in `types/rag.ts`/`extensions/retrievalRegistry.ts`, an untouched Task-11 placeholder
(`retrieve()` just returned `[]`), so agents can semantically search a real codebase instead of
relying purely on `grep`/`read_file`/manual browsing — pairs with `WORKSPACE_ROOT` (see the
"reach my folder for code review" ask): RAG indexes exactly that same folder.

**A real operational constraint discovered before writing any code**: this Ollama instance (0.32.5)
flatly rejects `POST /api/embed` for any model without the `embedding` capability — confirmed live
against an installed chat model (`{"error":"This server does not support embeddings..."}`), and
none of this project's 7 installed models declare that capability in `GET /api/tags`. So a
dedicated embedding model (`ollama pull nomic-embed-text`, ~274MB) isn't an optimization, it's a
hard requirement — verified end-to-end live (see below), including the actual error message a user
sees if they try to reindex before pulling one.

**Indexing** (`services/ragIndex.ts`, new): `walkWorkspace()` recursively walks `env.workspaceRoot`
skipping `node_modules`/`dist`/`build`/`__pycache__` and anything hidden (dotfiles/dotdirs —
deliberately including `.env`, so a real secret file can never end up embedded into the persisted
index), plus files over 500KB or that look binary (a null-byte heuristic in the first 8KB).
`chunkText()` splits each file into 50-line chunks with 5-line overlap (exported and unit-tested
directly — pure line-index math, no fs/Ollama needed). `embed()` lives in `services/ollama.ts`
(the file that already owns every other Ollama HTTP call) and maps the "does not support
embeddings" / model-not-found responses to a new `EmbeddingModelUnavailableError`
(`services/errors.ts` + `middleware/errorHandler.ts`, 503) instead of a raw Ollama string.
`reindex()` walks + chunks + embeds everything (batched 32-at-a-time /api/embed calls), replaces
the in-memory index, and persists to `backend/data/rag/index.json` (new, gitignored like
`backend/data/projects/*` — embedded chunks of someone's real codebase are exactly the kind of
thing that shouldn't accidentally end up in git). `loadIndexFromDisk()` hydrates at startup (same
convention as `orchestrator.ts#loadTasksFromDisk`) so a restart doesn't force re-embedding a whole
folder. No incremental reindexing — every reindex rebuilds from scratch, deliberately simple and
correct for a bounded review folder rather than a monorepo. New `routes/rag.ts`:
`GET /api/rag/status`, `POST /api/rag/reindex` (blocking — a bounded folder walk+embed is fine
synchronous, not worth a progress-streaming endpoint).

**Agent-facing tool** (`services/orchestrator.ts`): extends the Orchestrator's existing plain-JSON
tool-request convention (the same one `bash`/`grep`/`nmap` use) with a `search_knowledge_base`
pseudo-tool — only advertised in `buildToolsPreamble()` once the index actually has chunks, so a
model isn't invited to request something guaranteed to fail in the common "never indexed" case.
Unlike every real `ExecTool`, `advance()` branches to it **before** the `requestExecution` call:
it's an in-process vector search over a pre-built local index, not an OS command, so it
deliberately skips `toolManager.ts` and the human-confirmation gate every real tool requires —
nothing runs, nothing touches the filesystem beyond data already embedded ahead of time. Pushes a
tool-result message shaped to match the exact fields `OrchestratorTaskView.tsx` already renders
generically (`{tool, status, success, exitCode, stdout, parsedOutput}`), then recurses into
`advance()` immediately (mirrors the exact retry pattern already used for a failed
`requestExecution` call) — the task never enters `waiting_confirmation` for this tool. Still counts
against `task.toolCallCount`'s loop-prevention cap, same as real tools. An empty index or a failed
search (e.g. the embedding model becoming unavailable mid-task) pushes a `{success: false,
message}` tool result the same way rather than failing the task outright — verified via 4 new
`orchestrator.test.ts` cases (skips confirmation, respects the cap, both failure paths recover).
**Zero frontend changes were needed for the tool-call/result display itself** — `AssistantCard`/
`ToolResultCard` already pattern-match `{tool, arguments}`/`{tool, status, ...}` generically.

**Frontend**: `components/KnowledgeBasePanel.tsx` (status: chunk/file counts, workspace path,
embedding model, relative "indexed Xm ago" time, or "Not indexed yet"; a Reindex button that says
"Indexing…" while the blocking request is in flight) lives in `OrchestratorWorkbench.tsx`'s Home
tab next to `ProjectPanel` — both are workspace-level setup concerns, the index is global over
`env.workspaceRoot` rather than project-scoped. `hooks/useRag.ts` mirrors `hooks/useTools.ts`'s
shape (`services/ragApi.ts`: `fetchRagStatus`, `reindex`).

**Verified live end-to-end**, not just typecheck: `GET /api/rag/status` reflecting real backend
state through the frontend panel; clicking Reindex against the (empty) workspace correctly
producing "0 chunks across 0 files" and updating the "indexed just now" timestamp; dropping a real
file into the workspace and reindexing again correctly surfacing the exact
`EmbeddingModelUnavailableError` message (`Pull a model with embedding support, e.g.: ollama pull
nomic-embed-text`) in the panel, with the previously-successful status left untouched by the failed
attempt rather than being corrupted or cleared. `cd backend && npm test` (119 passing, up from
105) and `npm run typecheck`; `cd frontend && npx tsc -b && npm run lint` both clean.

### Deliberate non-goals

- Not wired into plain Chat (`/api/chat` / `/api/agents/:id/chat`) or the native
  `toolRegistry.ts`/Ollama tool-calling path (still zero registered tools there) — scoped to the
  Orchestrator's tool convention only, per what was confirmed before building this.
- One global index over `env.workspaceRoot`, not per-Project.
- No chunking-strategy configurability — fixed line-based chunking, not exposed as a setting.

### What's next

- The actual end-to-end "agent retrieves real code and answers correctly" path is still unverified
  against a real folder — blocked on the user providing a `WORKSPACE_ROOT` path and running
  `ollama pull nomic-embed-text`, both flagged as prerequisites when this was scoped.

## Logo/favicon + a small polish pass

`frontend/public/8Rack.png` (the full lockup: circuit-"8"-with-targeted-bug icon + "8RACK"
wordmark) was cropped down to just the icon glyph — `8rack-icon.png`, 256×256 — since the
wordmark would be illegible at favicon/badge sizes and is redundant next to the "8Rack" text label
already shown beside it everywhere the badge appears. Replaces `index.html`'s favicon link (which
had been pointing at a `favicon.svg` that didn't exist), the sidebar header badge, and the
`AgentNetwork` Command Center hub node — all three were still showing a plain "8R" text placeholder.

Two real gaps surfaced by re-auditing the newer session/RAG UI against the design-system
conventions established during the redesign's own polish pass, rather than by typecheck:

- **`SessionTabs`'s close (×) button was keyboard-invisible** — `opacity-0 group-hover:opacity-100`
  with no `focus-visible:opacity-100`, the exact same gap the redesign polish pass already fixed
  for `AgentList`/`ProjectPanel`'s delete buttons, just missing here since `SessionTabs` was built
  afterward. Fixed the same way. Also gave session tabs a framer-motion enter/exit
  (fade+scale+width) instead of popping in/out instantly — every other dynamic list in the app
  (agent-network nodes, `Collapsible`, `Sheet`, the command palette) animates; the tab strip was
  the one place that didn't.
- **`KnowledgeBasePanel`'s Reindex button icon didn't spin while indexing** — every other
  refresh-style control in the app (`ModelSelector`, `AgentList`, `ToolRegistry`, `ProjectPanel`)
  spins its `RefreshCw` icon while loading, all via `IconButton`, where applying the spin class to
  the whole button works because there's no text label to avoid spinning. `KnowledgeBasePanel`
  uses `Button` (icon + "Reindex"/"Indexing…" text together), so the same trick would have spun
  the text too. Added `iconClassName` to the shared `Button` component (applies only to the icon,
  not the button) so this — and any future icon-plus-label loading button — can reuse the same
  pattern cleanly instead of a one-off hack.

`npx tsc -b` and `npm run lint` clean; verified live (tab open/close, the close button's
`focus-visible:opacity-100` class present in the rendered DOM, the favicon resolving with the
right content-type, both badge locations showing the real image).

## Agent.tools activation

`Agent.tools?: string[]` had been unread since Task 11 — DEVELOPMENT.md's "Tool-calling round
trip" section flagged this as the natural next step "now that the tool-calling plumbing exists,"
and TODO.md called it out explicitly. `chatService.ts#streamAgentChat` now defaults to it:
`const tools = request.tools ?? (request.toolsPreamble ? undefined : agent.tools)` — the same
override-layering shape already used for `model`/`options` (request-level value wins if given,
agent's own config is the fallback).

**The one real design decision here**: whether this fallback should also apply when
`streamAgentChat` is called from `orchestrator.ts#collectAgentReply`. It must not — the
Orchestrator speaks its own separate plain-text tool-request convention
(`buildToolsPreamble`/`parseToolRequest`) and never uses Ollama's native `tool_calls` mechanism at
all (see "Tool-calling round trip" and "Orchestrator" above for why those two systems are
deliberately kept apart). If an agent with `tools` configured ran inside an Orchestrator task and
this fallback applied unconditionally, the model would receive both the Orchestrator's plain-text
tool instructions *and* a native tool schema on the same request — free to reply in whichever
format it preferred, which could easily be the one `parseToolRequest` doesn't parse, silently
breaking the task. Fixed by keying the fallback off `toolsPreamble`'s own presence — it's already
`collectAgentReply`'s tell that "this call came from the Orchestrator" (that's literally what its
doc comment already said), so no new signal needed.

Still functionally inert as of this pass: none of the 8 shipped agent configs set `tools`, and
`extensions/toolRegistry.ts` has zero tools registered (unchanged since "Tool-calling round trip" —
the calculator tool was removed and nothing has taken its place there; the RAG work registered
`search_knowledge_base` into the *Orchestrator's* tool convention only, a deliberate scope
decision at the time, not this one). The plumbing is just correctly wired and ready.

4 new `chatService.test.ts` cases: activates `agent.tools` when the request doesn't specify any;
an explicit `request.tools` still overrides it; `toolsPreamble` presence suppresses the fallback
entirely; an agent with no `tools` configured is unaffected. `npm test` (123 passing, up from 119)
and `npm run typecheck` both clean. Verified live with a real (tools-less) agent chat call to
confirm no regression on the common path.

## start.sh: PID-tracked process cleanup

TODO.md had flagged `start.sh`'s stale-process cleanup as worth revisiting "if this ever needs to
coexist with other projects' dev servers on the same machine." The mechanism was already
path-scoped (`pkill -f "$ROOT_DIR/backend/node_modules/.bin/tsx"` etc. — a different checkout's
tsx binary lives at a different absolute path, so it was never actually at risk of matching
another project), but it was still fundamentally *guessing* at command-line shapes, which is
exactly what had already broken twice before (the `.bin/tsx` pattern not matching `tsx watch`'s
actual invocation, then `tsx watch`'s grandchild `preflight.cjs` process not matching either
pattern and surviving to squat on the port — both documented above).

Replaced the primary mechanism with PID tracking: each service is launched via
`setsid bash -c "cd ... && exec npm run dev"`, which makes it (and *every* descendant it spawns,
without exception — the grandchild included) the leader of its own new process group. The
resulting PID is written to `.backend.pid`/`.frontend.pid` (gitignored, this checkout's own
runtime state), and the next `start.sh` run (or a clean Ctrl-C) kills by process group
(`kill -TERM -$pid` — a *negative* PID targets the whole group) read back from those files. This
is precise by construction: it can only ever kill PIDs this exact checkout's own script wrote,
regardless of what any other project's dev servers look like on the same machine, and it can never
miss a grandchild again since process-group membership isn't something a new process can quietly
fall outside of the way a command-line pattern can quietly stop matching. The original path-scoped
`pkill -f` patterns stay as a belt-and-suspenders fallback sweep (for stragglers from before this
mechanism existed, or a start.sh run that was itself killed before writing/cleaning up its PID
files) — same safety property, just less precise, which is exactly why it's the fallback now
rather than the primary method.

**Verified live**, not just read through: with an already-running instance in the exact
orphaned-grandchild state DEVELOPMENT.md describes above (parent `tsx watch` + orphaned
`preflight.cjs` both alive), ran `start.sh` and confirmed via `ps aux` that all of it was replaced
by a fresh instance (the fallback sweep catching the pre-existing pattern-based mismatch case);
ran `start.sh` again immediately after and confirmed via `ps aux` that this second run's cleanup
killed the *first* run's full tree — parent, tsx, and grandchild together — using only the PID-file
path (the fallback `pkill` patterns no longer had anything left to match), and that both a fresh
backend and frontend came up and answered normally afterward.

## Execution history search + bookmarks

TODO.md had flagged this from the redesign's own design spec (the Workbench `ExecutionConsole`
picked up Copy + Export at the time, but not Search/Bookmark "across execution history," judged
disproportionate to a visual pass). Built now as a frontend-only addition — no backend change was
needed at all: `GET /api/tools/executions?projectId=` already returns every execution's full
`resolvedCommand`/`result.stdout`/`result.stderr`, so "search across history" is just a client-side
filter over data the Workbench was already fetching via `useTools`.

New `components/ExecutionHistoryPanel.tsx`, added to `OrchestratorWorkbench.tsx`'s Home-tab aside
right below `ToolRegistry` (same "workspace-level setup concern" placement as `ProjectPanel`/
`KnowledgeBasePanel`). The search box matches against tool id, resolved command, *and* output text
— searching what a command actually produced, not just its name, is the point of the original
design spec's ask. Each row is expandable (reusing the existing `ExecutionConsole` component
unchanged) to inspect a past run's full output inline. Bookmarking is a new `hooks/useBookmarks.ts`
— a `localStorage`-backed `Set<string>` of execution ids, persisted the same way Settings/theme
already are, since which past executions matter to *you* is a personal preference, not project
data the backend needs to know about.

**One real structural conflict caught while building this, not by typecheck**: the shared
`Collapsible` primitive (from the redesign's polish pass) wraps its entire `trigger` in one
`<button>`, but a history row needs a *second*, independently-clickable bookmark-star control in
that same header — nesting an interactive bookmark button inside `Collapsible`'s trigger button
would be invalid HTML and would fire both handlers on one click. `ExecutionHistoryPanel` therefore
implements its own light expand/collapse locally instead of forcing reuse of `Collapsible` where
the two controls' click targets would have collided.

Also extracted `KnowledgeBasePanel`'s local `relativeTime()` helper into `lib/relativeTime.ts` so
this panel's "just now"/"3m ago" timestamps share the exact same implementation rather than a
second copy.

**Verified live end-to-end** against two real tool executions (a real `dig` and a real `whois`
run, requested and confirmed via the actual `/api/tools` endpoints, not fixtures): the search box
correctly narrowed the list to just the matching tool; bookmarking an execution flipped its button
label and persisted the exact execution id to `localStorage`; the "bookmarked only" filter
correctly showed just that one execution; expanding a row correctly rendered its real resolved
command and success badge via `ExecutionConsole`. `npx tsc -b` and `npm run lint` clean throughout
(no backend tests needed - no backend code changed).

## Frontend hook/component tests

Closes the gap TODO.md had been flagging since the backend test pass ("Automated tests" above) —
the frontend had zero automated coverage, hook logic (streaming, sessionStorage persistence,
abort/timeout handling) and component interaction (two-step delete, tool-call rendering) alike
verified manually only. 128 tests across 18 files, `cd frontend && npm test` (or `npm run
test:watch`).

**Tooling**: [Vitest](https://vitest.dev) + [React Testing Library](https://testing-library.com/react)
+ `@testing-library/user-event` + `jsdom`, all new frontend devDependencies. `vitest.config.ts`
(separate from `vite.config.ts`, mirroring the backend's own separate `vitest.config.ts`) sets
`environment: "jsdom"` and a `setupFiles` entry, `src/test-utils/setup.ts`: imports
`@testing-library/jest-dom/vitest` matchers, clears `localStorage`/`sessionStorage` and calls
`vi.resetAllMocks()` before every test (mirrors backend's per-file `beforeEach(() =>
vi.clearAllMocks())`, just hoisted to one place since every frontend test file mocks a service
module the same way), and calls RTL's `cleanup()` after every test. Test files are co-located next
to the source they test, same convention as the backend suite.

**A real Node-version gotcha, not a config mistake**: on Node 22+, `localStorage`/`sessionStorage`
exist as *native* globals (an experimental Web Storage API, SQLite-backed) that throw
`localStorage is not available because --localstorage-file was not provided` the instant they're
touched. Vitest's jsdom environment is supposed to shadow these with jsdom's own in-memory
implementation, but on this machine's Node version (26.5.1) that shadowing loses to Node's own
global — every storage-hook test failed with that exact error until `npm test`/`npm run
test:watch` were changed to run with `NODE_OPTIONS=--no-experimental-webstorage` (see
`frontend/package.json`), which disables Node's native implementation so jsdom's is the only one
left standing.

**Scope**: every hook was covered (`useSettings`, `useTheme`, `useBookmarks`,
`useModels`/`useAgents`/`useProjects`/`useTools`/`useRag` — all four share the same
fetch/loading/error/refresh shape, `useChat`, `useSessions`, `useOrchestratorTask`,
`useMultiAgentPlan`), plus six components chosen for actual interaction logic rather than pure
presentation: `PromptInput` (Enter-to-send vs. Shift+Enter, disabled/sending states),
`ModelSelector`, `AgentList` (warnings banner, selection), `ProjectPanel` (two-step delete, create
form validation/error), `ChatMessageView` (role rendering, tool-call/tool-result bubbles, the
copy-to-clipboard timeout), and the shared `ui/Collapsible` primitive. `Button`/`IconButton` and
other pure-presentation `ui/` primitives were deliberately left untested directly — they're
exercised indirectly through every component test that renders one.

**Two non-obvious bugs the tests themselves exposed while being written** (both in the *test*
code, not the app — confirming the tests are actually exercising real behavior, not passing
vacuously):
- `useModels.test.ts`'s `refresh()` case initially reused the same `mockFetchModels` mock across
  assertions without resetting it, so a later `toHaveBeenCalledTimes(2)` saw 5 calls — leftover
  `mockResolvedValueOnce`/`mockRejectedValueOnce` queues plus the earlier tests' default
  implementation, all still live. Fixed by moving mock-reset into `setup.ts`'s global `beforeEach`
  (`vi.resetAllMocks()`) rather than patching each test file individually, since every hook test in
  this suite mocks a service module the same way.
- `ChatMessageView.test.tsx`'s copy-button test originally set `navigator.clipboard.writeText` to a
  `vi.fn()` *before* calling `userEvent.setup()` — but `userEvent.setup()` installs its own
  `navigator.clipboard` implementation (to back `user.copy()`/`user.paste()`), silently clobbering
  the spy assigned before it. Fixed by calling `userEvent.setup()` first, then `vi.spyOn(navigator
  .clipboard, "writeText")` on the object it installs, rather than assigning a fresh one.

**`useSessions.test.ts` caught a real same-tick dedup limitation, not a bug**: `useSessions`'
`openChatSession`/`openTaskSession` dedup against the *existing* session list to avoid opening a
duplicate tab for an agent that already has one open — but the dedup check reads the hook's
`sessions` state via closure, so two calls issued inside the same React batch (i.e., the same
`act()`) both see the pre-batch state and both create a session, since neither has re-rendered
between the two calls yet. Real user interactions (clicking two different agents) never land in
the same batch, so this isn't reachable in practice; the test exercises that sequence across
separate `act()` calls (one commit each) instead of asserting a same-tick guarantee the hook was
never designed to provide.

**Sanity-checked, not just written**: temporarily broke `useTheme.ts`'s toggle logic (`t === "dark"
? "light" : "dark"` → always `"light"`) and `ProjectPanel.tsx`'s two-step delete (made the first
click call `onDelete` immediately instead of arming confirmation), confirmed the matching tests
failed with the exact expected/received mismatch both times, then reverted.

`npx tsc -b` and `npm run lint` both clean throughout — no non-test source changes were needed.

## Orchestrator task continuation

User-reported: "I can't do further steps on the Recon Agent, we need to continue and not always
create a new task." Root cause: `services/orchestrator.ts#resumeTask` only advances a task from
`waiting_confirmation` (after a tool confirm/reject) — once a task reached `completed`, there was
no way to send it another message. The frontend's only path forward was the "New Task" form, which
always calls `createTask` - a fresh task id, fresh `messages` array, no memory of the finished
conversation. Not a bug in the strict sense (every existing code path did exactly what it was
built to do), just a missing capability - the Orchestrator had a "one objective in, one final
answer out" shape with no way to keep talking to the same task.

**Backend**: `services/orchestrator.ts#continueTask(id, message, onChunk?, signal?)` - pushes a
`{role: "user", content: message}` onto the task's existing `messages` array (same array
`resumeTask` and the original `createTask` share) and calls the same internal `advance()` loop, so
a continuation can just as validly trigger another tool request (→ `waiting_confirmation` again) as
a plain answer. Only callable when `task.status === "completed"` (`InvalidTaskStateError`
otherwise) - deliberately excludes the other terminal statuses:
- `waiting_confirmation` already has its own continuation path (`resumeTask`) and mixing the two
  would let a caller skip the pending tool confirmation entirely.
- `failed`/`cancelled`/`max_executions_reached`/`max_time_reached` are each a state something
  *decided* the loop shouldn't continue from - and for the two caps specifically, continuing
  wouldn't even work usefully: `toolCallCount` and `createdAt` aren't reset by a continuation, so
  the very next `advance()` call would immediately re-trip the same cap it just hit. Making that
  work for real (resetting or extending the caps) is a bigger, separate design decision than what
  was asked for here.

New route `POST /api/orchestrator/tasks/:id/continue` (`{message: string}` body), NDJSON-streamed
via the same `runAndStreamTask` helper `create`/`resume` already use — one non-obvious consequence
worth calling out: continuing a task that goes on to request *another* tool call correctly lands it
back in `waiting_confirmation` with a *new* `pendingExecutionId`, appended to the same
`toolExecutionIds` list, so the existing confirm/reject/Approve-Reject UI needs zero changes to
handle a tool call that originates from a continuation instead of the original objective.

**Frontend**: `services/orchestratorApi.ts#continueTask` mirrors `resumeTask`'s streaming shape.
`hooks/useOrchestratorTask.ts` gained a `continueTask(message)` action (no-ops if there's no task or
`task.status !== "completed"`, same guard the backend enforces, so the UI never even attempts the
call in a state that would 400). `OrchestratorTaskView.tsx` gained a small `ContinueTaskInput`
(Enter-to-send textarea + button, styled like `PromptInput`) rendered only when `task.status ===
"completed"` and only when the caller passes an `onContinue` prop - `TaskSessionPanel.tsx` (the
Workbench) wires it up; `MultiAgentPlanner.tsx`'s per-step task view deliberately does not, since a
plan step is one fixed leg of a sequential plan, not a thread worth talking to on its own past its
step's objective.

**Verified**: 6 new backend tests (`orchestrator.test.ts`, `continueTask` describe block - unknown
id, wrong-status rejection, message ordering/task-id preservation across a continuation,
toolExecutionIds/toolCallCount surviving a continuation unchanged, a continuation that itself
triggers a new tool call, and the time cap re-tripping immediately as described above) - 129
backend tests total. 4 new frontend hook tests (`useOrchestratorTask.test.ts`) - 132 frontend tests
total. Both `npx tsc -b`/`npm run typecheck` and `npm run lint` clean.

**Live end-to-end, not just unit tests**: exercised the new `/continue` endpoint directly via curl
first (a real task against a real Ollama model, confirmed the same task id and a growing message
array came back, and that continuing a `waiting_confirmation` task correctly 400s with
`INVALID_TASK_STATE`), then in-browser via the real Workbench UI - started a Recon Agent task,
let it complete, typed a follow-up into the new input, and confirmed it landed in the *same*
"Recon Agent" tab (no second tab/task ever appeared) with the transcript now showing both
objective/answer pairs, status still `Completed`.

## Cancelling a waiting_confirmation task left the execution stuck forever

User-reported: "pending_confirmation cancelation doesn't work." Root cause:
`toolManager.ts#cancelExecution` only works on an execution that's actually **running** - it looks
up an `AbortController` in `runningControllers` (registered by `runRecord` once a tool process is
actually spawned) and throws if there isn't one. An execution still at `pending_confirmation` was
never confirmed, so it was never run, so there's no controller and no process to abort.
`orchestrator.ts#cancelTask` called `cancelExecution` unconditionally and silently swallowed the
resulting throw (`catch { /* nothing to cancel */ }`) - the task itself still flipped to
`cancelled` correctly, but the underlying `ExecutionRecord` was left sitting at
`pending_confirmation` **forever**, showing up as a permanent "Awaiting confirmation" warning pill
in the Tool Registry and Execution History for a task that supposedly no longer exists.

Fix: `cancelTask` now reads the execution's actual status first and picks the operation that's
valid for it - `rejectExecution` (the correct "this tool call never happened" terminal state) when
still `pending_confirmation`, `cancelExecution` (abort the live process) when actually `running`.
4 new/rewritten tests in `orchestrator.test.ts`'s `cancelTask` block - one rewritten test used to
assert the *buggy* behavior (`cancelExecution` called on a `pending_confirmation` record, which
only "passed" because that test never bothered mocking `getExecution`'s return value, so the new
status check silently fell through to the same branch by accident). 130 backend tests total.
Sanity-checked by reverting to the old unconditional-`cancelExecution` behavior and confirming the
new test failed with the exact expected/received mismatch, then reverted back.

**Verified live against the real running app**, not just unit tests: curl'd a fresh task to
`waiting_confirmation`, cancelled it, and confirmed via `GET /api/tools/executions` that the
execution flipped to `rejected` (previously would've stayed `pending_confirmation`). Also found
direct evidence of the *original* bug still sitting in the user's real `nexus.htb` project data
from before this fix: an orchestrator task (objective "scan and recon 10.129.98.45") already
`cancelled`, whose `pendingExecutionId` still pointed at a `ffuf` execution stuck at
`pending_confirmation` from ~10 minutes earlier - exactly the stale-forever state this fix
prevents going forward. That record is pre-existing data, not touched automatically (see chat log
for the offer to clean it up on request).

## Concurrent task sessions per agent

User-reported: "we should be able to spawn new recon agent for different tool." The redesign's
"Parallel sessions" work (see "Per-agent model override + parallel agent sessions" above)
deliberately enforced **one open session per (agent, kind)** - opening an agent that already had a
session of that kind just focused the existing one instead of creating a new one, on the reasoning
that concurrency should be about different agents working at once, not many copies of one agent.
In practice, for **task** sessions specifically, that reasoning didn't hold: a task is one
objective/tool-run, not an ongoing thread (task continuation now exists as its own explicit
mechanism - see "Orchestrator task continuation" above) - wanting the Recon Agent to run `nmap` in
one task and `ffuf` in another, concurrently, is completely ordinary and the old dedup silently
prevented it. Worse, it was silently *destructive*: clicking "Start Task" with a new objective
typed in, while that agent already had any task session open (even a long-finished, `completed`
one), just refocused the old tab and threw the newly-typed objective away with no task ever
created for it and no error shown.

Notably, `AgentNetwork.tsx` (the Chat view's Command Center map) already had `sessionNodePosition`
math for spreading N sibling session nodes around one agent node - this constraint was never a
capability limit elsewhere in the app, just the one dedup check in `useSessions.ts`.

Fix: `hooks/useSessions.ts#openTaskSession` no longer checks for an existing session before
creating one - every call opens a brand new task session and focuses it. **Chat sessions are
unchanged** (still one per agent) since that wasn't part of what was asked and a chat is genuinely
one ongoing conversation, unlike a task. Since two open task tabs for the same agent now share a
name, `SessionTabs.tsx` folds the objective into a task tab's label (`"Recon Agent: run nmap
against..."`, truncated by the tab's existing CSS ellipsis, full text still in the `title`
tooltip) and `AgentNetwork.tsx`'s session-node tooltip does the same - both were previously just
the bare agent name / "Task session", indistinguishable across multiple tabs.

New `useSessions.test.ts` case asserting two `openTaskSession` calls for the same agent produce two
distinct sessions with the newest focused. 133 frontend tests total.

**Verified live**: started a Recon Agent task (requested `nmap`, left it at
`waiting_confirmation`), then - without resolving it - went back to New Task and started a
*second* Recon Agent task with a different objective (ffuf-related question) on the same session.
Both tabs coexisted, correctly labeled with their distinct objectives, with independent status
dots (amber "waiting" on the first, green "completed" on the second). Cancelling the first task
from its own tab correctly left the second one completely untouched - confirming the two fixes in
this session compose cleanly (cancelling one task's stuck-forever execution doesn't interact with
a sibling task for the same agent).

## Human-in-the-loop tool failure recovery (waiting_guidance)

User-reported: "agents now execute tools one by one, if fails we need to be able to intervene and
correct behavior - for example if tool is missing or output is non-existing user should be able to
make a suggestion." Two distinct places in `orchestrator.ts` silently handled a failure with zero
human visibility, both inside `advance()`:

1. **A tool request that fails outright** - unknown/disabled tool, invalid arguments, or (the
   user's literal example) `ExecutableUnavailableError` when the requested binary isn't on `PATH`.
   `requestExecution` throws before any `ExecutionRecord` even exists, so there was never a
   `waiting_confirmation` pause to begin with - the old code fed the error back and recursed
   `advance()` **immediately**, spending one of the task's limited tool-call attempts on a blind
   retry the human never saw happen until reading the finished transcript afterward.
2. **A confirmed execution that ran and failed** - nonzero exit, timeout, or a genuinely empty/
   wrong result (the user's other example). `resumeTask` already paused for confirm/reject, but
   once confirmed, it always auto-called `advance()` with the result, again with no human
   checkpoint between "here's what happened" and "here's what to try next".

Both now pause the task at a new terminal-*but-not-terminal* status, **`waiting_guidance`** (added
to `TaskStatus`/`MultiAgentPlanStatus` on both backend and frontend) - same shape as
`waiting_confirmation`, just triggered by a failure instead of a pending tool call. A successful
execution or an explicit reject (already a deliberate human decision, not a failure to react to)
both keep auto-continuing exactly as before - **zero added friction on the common path**, this only
intervenes when something actually went wrong.

**`services/orchestrator.ts#provideGuidance(id, note?)`** resumes from `waiting_guidance`: an
optional human note (e.g. "that tool isn't installed, try httpx instead") is appended as a fresh
`user` message before re-advancing the same loop - can itself trigger another tool request (landing
right back in `waiting_confirmation`, or `waiting_guidance` again if that one also fails), same as
any other turn. Passing no note just lets the agent retry with only what's already in the
transcript. `toolExecutionIds`/`toolCallCount` and the task's overall time budget are untouched by
a guidance round, so repeated failures still correctly trip `max_executions_reached`/
`max_time_reached` - continuing from a failure isn't a way to bypass the caps, it's a way to spend
each attempt more deliberately (with a human steering) instead of automatically. New route
`POST /api/orchestrator/tasks/:id/guidance` (`{note?: string}`), NDJSON-streamed like resume/
continue.

**Multi-agent plans needed the same status taught to them separately** -
`multiAgentOrchestrator.ts#continueAfterStepTask` is a status `switch`-by-inspection over the
step's underlying task (`waiting_confirmation` → pause the plan; `completed` → advance to the next
step; *anything else* → whole plan fails/cancels). Without an explicit `waiting_guidance` branch,
a step merely pausing for guidance would have fallen into that `anything else` catch-all and been
misreported as the whole plan failing - a real regression caught by tests before it ever shipped
(the new `createPlan` test asserting `plan.error` stays `undefined` at `waiting_guidance`). New
`provideStepGuidance(id, note?)` mirrors `resumePlan` one level up, and a new
`POST /api/plans/:id/guidance` route.

**Frontend**: `OrchestratorTaskView.tsx` gained a `GuidanceInput` card (optional textarea +
Continue button, Enter-to-send like `PromptInput`/`ContinueTaskInput`) shown whenever
`task.status === "waiting_guidance"` - reuses the existing `ExecutionConsole` above it to show
*what* failed when there's a `pendingExecution` (the confirmed-then-failed case; the
tool-request-failure case has no execution to show, just the error already visible in the
transcript above). Wired into both `TaskSessionPanel.tsx` (Workbench) and `MultiAgentPlanner.tsx`
(current-step view) since both can now reach this state - `onProvideGuidance` is a required prop on
`OrchestratorTaskView`, unlike `onContinue` (which the Planner deliberately omits, since continuing
a *finished* task doesn't make sense mid-plan - see "Orchestrator task continuation" above).

**Sanity-checked** by temporarily disabling each new pause branch (`resumeTask`'s
failed/cancelled check, and `continueAfterStepTask`'s `waiting_guidance` branch) and confirming the
matching tests failed with the exact expected/received mismatch, then reverted. 15 new backend
tests (145 total across `orchestrator.test.ts`/`multiAgentOrchestrator.test.ts`), 8 new frontend
hook tests (141 total). Both `npm run typecheck`/`npx tsc -b` and `npm run lint` clean throughout.

**Verified live against the real running app**, not just tests: curl'd a task asking the Recon
Agent to run `amass` specifically (not installed on this machine) - confirmed it landed on
`waiting_guidance` with `pendingExecutionId: null` and the actual "not found on PATH" error in the
transcript, instead of the old silent-retry behavior. Sent a guidance note suggesting `subfinder`
instead - the agent switched tools, which also wasn't installed, and correctly paused *again*
rather than looping (with `toolCallCount` at 2, one per real attempt). A final guidance note asking
for a plain-text answer instead brought the task to `completed`. Repeated the exact same sequence
in-browser through the real Workbench UI: the warning banner, the failed tool's output, the
guidance box, and recovery to `Completed` (at which point the existing continue-task follow-up box
correctly took over) all rendered and behaved exactly as designed.

## Security scanners (Scan Profiles)

`types/scanner.ts`/`extensions/scannerRegistry.ts` were a placeholder stub (`Scanner.scan(target)
=> ScanResult`, never implemented) from the original Task 11 extension points. By the time this
was picked up, the Tool Execution Framework + Findings Engine already covered most of what a
"scanner" would do - real recon tools (nmap/httpx/ffuf/katana/nuclei/subfinder/amass/whois/dig) run
through `toolManager.ts` and their output is auto-parsed into structured Findings. What was still
missing, and what the user actually wanted: a one-click way to chain several of those tools against
a target as a single named "scan", without hand-typing each tool/target combination one at a time
in the Workbench.

**Design decisions (confirmed with the user before building):**
- **Deterministic, not agent-driven.** A `ScanProfile` (`backend/src/scanners/builtins.ts`) is a
  fixed, human-authored list of `{toolId, arguments}` steps with a `{target}` placeholder - no LLM
  chooses the tools or arguments at runtime. This ruled out the alternative of an "agent-driven scan
  mode" and is why a profile's steps can safely skip the Orchestrator's per-tool-call approval.
- **One confirmation for the whole chain, not one per step.** Every `ExecTool` still requires human
  confirmation before running (`toolManager.ts`) - but for a profile, the human already reviewed and
  approved the *exact* resolved command for every step via a preview (`POST /scans/preview`) before
  clicking "Confirm & Run All". `scanRunner.ts#createScanRun` auto-confirms each step's
  `ExecutionRecord` the instant it's requested (see the code comment there for why this differs from
  the Orchestrator, where an LLM picks tools/arguments live and each one needs its own approval).
- **A step failing doesn't abort the scan.** Real recon often has some tools missing/erroring while
  others still add value (proven live below), so `createScanRun` keeps going through the remaining
  steps and reports the overall run as `"completed"` with individual step statuses
  (`completed`/`failed`/`skipped`) - only an explicit cancel skips the rest.

**Backend**: `types/scanner.ts` rewritten in place (`ScanProfile`/`ScanProfileStep`/`ScanStepRun`/
`ScanRun`/`ScanPreview`) - same "supersede the placeholder" pattern as multi-agent orchestration
replacing `extensions/orchestrator.ts`. `extensions/scannerRegistry.ts` is now a profile registry
(`registerScanProfile`/`getScanProfile`/`listScanProfiles`), populated at startup from
`scanners/builtins.ts`'s four profiles (Quick Recon, Subdomain Discovery, Web App Scan, Full Port
Scan). `services/scanRunner.ts` is the core: `previewScan` resolves a profile's commands against a
target with zero side effects (for the confirm UI); `createScanRun` runs every step sequentially
through the existing `requestExecution`/`confirmExecution` pipeline (so workspace path containment,
executable-availability checks, and Execution → Parser → Findings ingestion all apply unchanged),
streaming `{type:"scan"|"step"|"output"}` events to an optional callback; `cancelScanRun` flags the
run to stop scheduling further steps and aborts whichever step is currently in flight via the same
`cancelExecution` used elsewhere. Persistence mirrors every other project-scoped history
(`scans.json` per project via `projectStore.ts`, hydrated at startup by `loadScansFromDisk`).
`routes/scanners.ts`: flat `GET /api/scanners` (profile roster) plus project-scoped
`GET/POST /api/projects/:projectId/scans[...]` - `POST /` streams NDJSON progress for the whole run
in one request (mirrors `routes/orchestrator.ts`'s `runAndStreamTask`/`routes/tools.ts`'s
confirm-execution stream), with a client disconnect cancelling the scan the same way it cancels a
single tool execution or an orchestrator task. New error classes (`ScanProfileNotFoundError`/
`ScanRunNotFoundError`/`ScanTargetRequiredError`/`InvalidScanStateError`) wired into
`errorHandler.ts`. The still-unimplemented `plugin.ts`/`report.ts`/`pluginRegistry.ts` placeholders
that referenced the old `Scanner`/`ScanFinding` types were updated to the new `ScanProfile` shape
(`report.ts` now points at the real `Finding` type from `types/finding.ts` instead, since that's
what a report would actually draw from) so the rewrite didn't leave the codebase in a
non-typechecking state. 11 new backend tests (`scanRunner.test.ts`, 220 total) covering preview
resolution, sequential execution, per-step failure isolation, and cancellation (aborting the
in-flight step and skipping the rest).

**Frontend**: `types/scanner.ts` mirror, `services/scannersApi.ts` (`fetchScanProfiles`,
`previewScan`, `createScan` NDJSON stream, `fetchScans`, `cancelScan`), `hooks/useScans.ts`
(project-scoped, same shape as `useTools.ts`/`useOrchestratorTask.ts` - tracks `profiles`/`scans`/
`run`/`liveOutput`/`preview`, exposes `runPreview`/`clearPreview`/`runScan`/`cancel`/`reset`). A
step's live event stream doesn't carry an explicit array index, so `runScan`'s event handler tracks
position with a simple pointer (`nextStepIndexRef`) that advances once a step's *terminal* event
arrives (running → no advance, completed/failed/skipped → advance) - robust even for a cancelled
scan where later steps go straight to `skipped` with no preceding `running` event. New
`components/ScannerPanel.tsx` (profile + target picker → inline preview/confirm card, matching
`ProjectPanel`'s established "no native `confirm()`, do it inline" convention → live step list +
output pane while running → a "Recent Scans" history strip), added into `OrchestratorWorkbench.tsx`'s
Home tab between `ProjectPanel` and the New Task form. 12 new frontend hook tests
(`useScans.test.ts`, 182 total across the frontend suite).

**A real bug caught by live verification, not tests**: the first draft of `scanners/builtins.ts` had
each profile step repeat `"-silent"` for httpx/katana/nuclei/subfinder, e.g.
`{ toolId: "httpx", arguments: ["-silent", "-u", "{target}"] }` - but those tools' own `ExecTool`
entries in `tools/exec/builtins.ts` already bake `-silent` into `defaultArguments`, and
`toolManager.ts#buildResolvedCommand` concatenates `defaultArguments + arguments`, so the resolved
command doubled up as `httpx -silent -silent -u example.com`. Caught immediately via a live
`POST /scans/preview` curl against the running dev backend before ever reaching the browser; fixed
by dropping the redundant flag from every profile step (steps only add what a tool's own defaults
don't already cover).

**Verified live** against the real running app (curl + in-browser through the actual Workbench UI,
targeting `example.com` - a real, safe, universally-authorized test domain, not a live scope target):
previewed and ran the Quick Recon profile end-to-end - `dig`/`whois` completed with real output,
`httpx` failed (`Exited with code 2`) because the `httpx` binary installed on this dev machine isn't
ProjectDiscovery's httpx and doesn't recognize `-silent`/`-u` the same way - an environment mismatch
unrelated to this feature, and useful proof that per-step failure isolation works: the scan still
reached `completed` with steps 1-2 shown as `completed` and step 3 as `failed` with its stderr
visible. Separately ran Full Port Scan (`nmap`) against `127.0.0.1` and cancelled it mid-flight via
`POST /scans/:id/cancel` while its stream was still open - the running `nmap` step flipped to
`skipped` (its subprocess actually aborted, not just stopped being watched), the still-pending
`httpx` step was skipped without ever starting, and the run settled as `cancelled` through the same
open NDJSON connection. In-browser: created a throwaway project, picked Quick Recon, confirmed the
preview's resolved commands (correctly `httpx -silent -u example.com`, no duplicate flag), watched
the same partial-failure result render live with per-step status pills and the failed step's output,
and saw it land in the Recent Scans history strip. `npm run typecheck`/`npm run build` (backend) and
`npx tsc -b`/`npm run lint`/`npm run build` (frontend) all clean.

### What's next

`extensions/scannerRegistry.ts` only holds the four built-in profiles - there's no API to create a
custom profile yet (would need a small CRUD surface + frontend editor, same shape as the Agent
Editor). Scan run history has no search/bookmark treatment the way `ExecutionHistoryPanel` does for
raw tool executions. Findings ingestion happens automatically per step already (each step's
`ExecutionRecord` goes through the same `ingestExecution` pipeline any manually-run tool does) - a
scan-level "N findings discovered" summary on the `ScanRun` itself would be a nice follow-up but
wasn't part of what was asked.

## Persistent top-level views (nav-switch state loss)

User-reported: "sessions, chats and task should persist inside tabs when switching all of them."
`SessionTabs`/`ChatSessionPanel`/`TaskSessionPanel` already keep every open session mounted and
just toggle a `hidden` class when you switch between tabs *within* the Chat or Workbench view (see
"Per-agent model override + parallel agent sessions" above) - but one level up, `App.tsx`'s
top-level nav switch (Chat/Workbench/Plans/Findings) did the opposite: `center` conditionally
rendered only the active view (`activeView === "chat" && <ChatView/>`, etc.) inside a single
`motion.div key={activeView}`. Changing `activeView` gave that `motion.div` a new `key`, which React
treats as "this is a different element" - the old view (and everything inside it) gets fully
unmounted, a fresh one mounts in its place.

That's fatal for exactly the state this session-tab work was built to keep alive:
- `useOrchestratorTask`'s `task`/`liveOutput`/`streamingText` (inside every open `TaskSessionPanel`
  and `ChatTaskPanel`) is plain `useState` with **no persistence at all** - confirmed by
  `ChatTaskPanel.tsx`'s own `restore()` call, added specifically because a page *reload* wipes this
  state even though the backend task and `session.taskId` both survive. Unmounting on a plain nav
  switch hits the exact same wipe, except there was no `restore()` path for a `TaskSessionPanel`
  wired up for it (its auto-start effect's `session.started` guard, sessionStorage-backed, would
  have silently stayed `true` and just never called `start()` again - the task would come back as a
  permanently blank "Starting…" tab, not even a duplicate task).
- Any in-flight `useChat` stream got orphaned: `sendMessage`'s `updateMessages`/`setSending` calls
  are closures over the *old* component instance's state setters. Once that instance unmounts,
  those calls become no-ops on a dead component - the sessionStorage-persisting `useEffect` never
  fires again either (its component is gone), so the rest of a streaming reply was silently lost,
  not just visually hidden.

**Fix**: `App.tsx` now tracks `visitedViews` (a `Set<AppView>`, seeded with `"chat"`) alongside
`activeView`. A view is added to the set the first time you navigate to it (via a new `changeView`
wrapper used everywhere `setActiveView` used to be called directly - `Sidebar`, `CommandPalette`,
`handleSelectAgent`, `handleFocusTaskSession`, `handleGoHome`) and, once in the set, stays mounted
for the rest of the session - `center` now renders `visitedViews.has("chat") && <div className={cn("h-full", activeView !== "chat" && "hidden")}><ChatView .../></div>` (and the same for
workbench/plans/findings) instead of the old conditional-render-inside-a-keyed-`motion.div`.
Lazy-mount-on-first-visit rather than mounting all four upfront, so opening the app doesn't
immediately fire every view's data fetches (`useProjects`, `useFindings`, `useMultiAgentPlan`, RAG
status) for views you may never open.

**Deliberate tradeoff**: this drops the `AnimatePresence`/`framer-motion` fade-and-slide transition
between top-level views entirely (`framer-motion`/`AnimatePresence` imports removed from
`App.tsx`) - keeping it would have meant either accepting the state loss it was built on top of, or
re-architecting it into an absolutely-positioned opacity-crossfade stack, which is real added
complexity for a purely cosmetic effect the user didn't ask to keep. The result matches the
zero-animation `hidden`-class toggle every other tab switch in this app already uses
(`SessionTabs`, `TaskSessionPanel`, `ChatSessionPanel`) - consistent, not a regression in kind, just
one level higher up than before.

**Verified live** against the real running app: started a Recon Agent task in Workbench (objective:
list the workspace directory via `list_directory`), approved it up to the tool-call step so it sat
at `waiting_confirmation` with a live Approve/Reject card, then navigated Workbench → Chat →
Findings → Workbench. The confirm card - objective text, the assistant's `list_directory([])` tool
call bubble, the pending-confirmation execution card, Approve/Reject buttons - was still there
exactly as left, no "Starting…" flash and no duplicate task. Approved it from there and confirmed
the task completed normally (tool output rendered, final assistant summary, follow-up input became
available) - proving the fix doesn't just preserve stale UI, the live `useOrchestratorTask` instance
genuinely kept running underneath the whole time. `npx tsc -b`, `npm run lint`, `npm test` (182
passing), and `npm run build` all clean throughout.

## Full-project audit

User asked for a whole-project audit with findings written to `TODO.md` "if necessary" - it was.
Three parallel reviews (backend security, backend architecture/correctness, frontend
correctness/lifecycle) plus manual spot-checks (repo hygiene, `git ls-files` secret scan, `npm
audit`/`npm outdated` both workspaces, doc-accuracy cross-checks). Full findings list with
severity and fix suggestions lives in `TODO.md`'s "Audit findings (2026-08-07)" section - not
duplicated here to avoid the two files drifting apart.

**Headline finding**: `projectId` is accepted as a raw string everywhere it reaches a filesystem
path (`projectStore.ts#projectDir`, used by every project-scoped service) with only a
non-empty-string check at the route layer, never a shape check - `path.join` doesn't sanitize `..`
segments, so a crafted `projectId` can write/delete files outside `backend/data/projects/`
entirely (confirmed via a standalone `path.join` computation, no filesystem actually touched - no
exploit was run against the live backend). Not fixed yet, deliberately - flagged as the audit's one
High item pending the user's go-ahead on scope, since the fix touches every project-scoped
route/service (`toolManager.ts`, `orchestrator.ts`, `multiAgentOrchestrator.ts`,
`findingsManager.ts`, `scanRunner.ts`, `projectManager.ts`), not a one-line patch.

**Fixed inline during the audit** (cheap, unambiguous, no scope decision needed): a "231 total"
backend-test-count arithmetic error introduced in this session's own Security-scanners
`DEVELOPMENT.md`/`TODO.md` entries (actual was 220, corrected in both files), and `CLAUDE.md`'s
"There are no automated tests yet" line (stale since before the very first Vitest suite existed).
`CLAUDE.md`'s broader "Architecture" section - the `backend/src/` directory tree and
extension-point description - is still the original Task-11 scaffold and doesn't mention anything
built since (Tool Execution Framework, Orchestrator, Projects, RAG, Findings Engine, Security
Scanners, Multi-agent plans); left as a flagged `TODO.md` item rather than rewritten inline since
it's a substantial rewrite of the user's own governing instructions file, not a quick fact-patch.

Everything else (Medium/Low severity: a nav-switch-adjacent chat-context-loss bug in the
still-in-progress tool-enabled-chat feature, a persistence write-race + silent-corruption pair in
`projectStore.ts`, an unguarded startup-hydration window, dead `extensions/` files, test coverage
gaps, README/CLAUDE.md staleness) is documented in `TODO.md` with file:line-level detail, not
fixed - none of it is actively exploited-by-design the way the projectId issue is, and fixing all
of it in one pass would have gone well beyond "audit."

## Report generation

The last unbuilt item from the original Task 11 extension-point list (`types/report.ts`,
`extensions/reportGenerator.ts`) - also one of the audit's own "confirmed dead code" findings
above, resolved as a side effect of actually building it, same as the Scanner stub before it.

**Design (confirmed with the user first)**: reports are generated from a **multi-finding
selection** (checkbox-select rows in the Findings table, "Generate Report from N selected"), not
one finding at a time - matching the `ReportInput`/`Report` type's existing shape
(`findings: Finding[]` in, structured `sections: ReportSection[]` out) rather than the simpler
single-finding "Explain with AI" pattern already in `FindingDetails.tsx`. Reports are **persisted
history**, not ephemeral - `reports.json` per project, same write-through pattern as executions/
tasks/plans/scans, with a list/view/delete UI, not just a one-off streamed panel.

**Backend**: `types/report.ts` rewritten in place (`Report` gained `projectId`/`findingIds`/
`agentId`/`model`/`markdown`, `createdAt` switched from an ISO string to a `number` to match every
other entity in the app). `extensions/reportGenerator.ts` - confirmed zero importers anywhere -
was deleted outright rather than kept as a wrapper, same as `extensions/orchestrator.ts` was
deleted when the real Orchestrator landed. `services/reportManager.ts` is the real thing: one
agent call via `chatService.ts#streamAgentChat` (no tool loop - a report is a one-shot writeup, not
an Orchestrator task) against the **Report Writer** agent (`backend/data/agents/report-writer.json`
- reused directly, same as `FindingDetails.tsx`'s "Explain with AI" reuses the Vulnerability
Validator agent rather than adding a dedicated one). The prompt embeds every selected finding's
type/severity/target/tool/confidence/description/evidence and asks for Markdown with an
"## Executive Summary" then one "## Finding: ..." section per finding, each covering Impact/
Reproduction/Remediation as `###` subsections. `splitSections()` parses the response on `## `
headings into `ReportSection[]` - deliberately lenient (falls back to one whole-document section
if the model skips/reflows the requested headings) rather than requiring strict structure, same
philosophy as `orchestrator.ts#parseToolRequest`'s fence-stripping fallback: local 7B models don't
always follow formatting instructions exactly, and losing content because of that would be worse
than an occasionally-flat report. `routes/reports.ts`: project-scoped
`GET/POST/DELETE /api/projects/:projectId/reports[...]`, `POST /` streams NDJSON
(`{type:"chunk"|"report"|"error"}` - the same shape as `routes/orchestrator.ts`'s
`runAndStreamTask`, since this is a single generation, not a multi-step process like a scan). New
error classes `ReportNotFoundError`/`NoFindingsSelectedError`, wired into `errorHandler.ts`.
10 new backend tests (`reportManager.test.ts`, 230 total).

**Frontend**: `types/report.ts` mirror, `services/reportsApi.ts` (`fetchReports`, `createReport`
NDJSON stream, `deleteReport`), `hooks/useReports.ts` (project-scoped, same shape as
`useScans.ts` - `generate`/`remove`, `streamingText` for the live-writing UX). `FindingsTable.tsx`
gained a checkbox column (per-row + a header "select all visible" checkbox, `stopPropagation`'d so
checking a row doesn't also open its details drawer) - `selectedIds` is a `Set<string>` of ids, not
full `Finding` objects, so a selection survives a `findings` refresh untouched. `FindingsView.tsx`
gained a 4th view mode ("Reports", alongside Table/Timeline/Graph) and, in Table mode, an inline
"Generate Report" bar that appears once at least one finding is checked - a title input + Generate
button, live-streaming the agent's reply (`Markdown`-rendered, same `StreamingCursor` treatment as
chat/task streaming) while it writes, then clearing the selection and switching to the Reports tab
once it lands. New `ReportsPanel.tsx` is purely presentational (takes `reports`/`loading`/`error`/
`onDelete` as props from `FindingsView`'s single owned `useReports()` call, same "one owner, props
down" convention `OrchestratorWorkbench.tsx` already uses for `ToolRegistry`/
`ExecutionHistoryPanel` over one `useTools()`) - a list (title, finding count, relative time),
click-to-open a full-width (`max-w-3xl`) `Sheet` rendering the complete Markdown via the existing
`Markdown` component (code blocks, headings, everything `ChatMessageView` already gets), an Export-
to-`.md` download (same `Blob`/`createObjectURL` technique as `ExecutionConsole`'s output export),
and the established two-step inline delete (`confirmDeleteId` state, no native `confirm()`) from
`ProjectPanel.tsx`. 21 new frontend tests (10 `useReports.test.ts` + 5 new `FindingsTable.test.tsx`
selection cases + updates to its existing tests for the new required props, 195 total).

**Verified live** against the real running app, with a real local model (`qwen2.5-coder:7b`, the
Report Writer agent's configured model) - not a mock: created a throwaway project, added two real
findings via `POST /api/projects/:id/findings` (a critical SQL-injection finding and a low missing-
CSP-header finding, both with genuine evidence text), then generated a report from both via curl
(`POST /projects/:id/reports`) - the agent produced a properly structured document (Executive
Summary + one section per finding, each with real Impact/Reproduction Steps/Remediation content
grounded in the evidence given, no fabrication observed) that `splitSections()` correctly parsed
into 3 sections. Repeated the exact flow in-browser through the real Findings UI: selected both
findings via checkboxes (including the header "select all"), typed a title, watched the report
stream live into the inline bar, landed automatically on the Reports tab, opened the full document
in the wide Sheet (headings/code blocks/syntax highlighting all rendering correctly), and exercised
the two-step delete (confirm card appeared, Delete removed it from the list). `npm run typecheck`/
`npm run build` (backend) and `npx tsc -b`/`npm run lint`/`npm run build` (frontend) all clean
throughout; cleaned up the throwaway project afterward via the DELETE endpoint.

## Fixed: projectId path-traversal

The audit's one High-severity finding: `projectId` reached a real filesystem path
(`services/projectStore.ts#projectDir(id) = path.join(PROJECTS_DIR, id)`) with only a
non-empty-string check anywhere above it, and `path.join` doesn't sanitize `..` segments - a
crafted id like `"../../../../tmp/x"` could write/delete files well outside
`backend/data/projects/`.

**Where to fix it**: every project-scoped service (`toolManager.ts`, `orchestrator.ts`,
`multiAgentOrchestrator.ts`, `findingsManager.ts`, `scanRunner.ts`, `reportManager.ts`) only ever
touches disk through `projectStore.ts`'s `readProjectJson`/`writeProjectJson`, and those - plus
`projectManager.ts`'s own `readProjectMeta`/`writeProjectMeta`/`deleteProject` - all funnel through
`projectDir(id)` itself. That makes `projectDir` the one real chokepoint: validating there (a
`PROJECT_ID_PATTERN` UUID regex, same shape as `agentManager.ts`'s existing `AGENT_ID_PATTERN`
check for agent ids) closes the hole for every current caller *and* every future one, without
needing a scattered `assertValidProjectId()` call added to each route/service by hand (the
original audit's suggested fix) - nothing new can forget to add a check that already lives inside
the only function capable of producing the path.

**The one subtlety**: `readProjectJson` and `projectManager.ts#readProjectMeta` both wrap their
`readFile` in a `try { ... } catch { return [] / undefined }` - a deliberate "no data yet" fallback
for a missing file. `projectDir(id)` was originally called *inside* that try block in both, so a
rejected id would have been silently swallowed by the same catch and returned as an ordinary empty
result - the traversal would still have been blocked (the read/write never happens), but the
caller would have no way to tell "this id is malformed" apart from "this project legitimately has
no data yet", which is exactly the kind of ambiguity the audit's separate silent-corruption finding
(`readProjectJson`'s catch-all) already flagged as risky. Fixed by resolving `projectDir(id)`
*before* the try block in both functions, so a rejection propagates as a real `InvalidProjectIdError`
(400 `INVALID_PROJECT_ID`) instead of masquerading as empty state. `writeProjectJson` and
`projectManager.ts#writeProjectMeta` already called `projectDir` outside any try/catch, so they
needed no change.

5 new regression tests in `projectManager.test.ts` (235 total) - the existing test file already
exercised `projectStore.ts`'s real functions (via the shared `fakeFs` double under
`node:fs/promises`, not a fully-mocked `projectStore.js`), so this also meant swapping its
placeholder ids ("nope", "proj", "older", "newer") for UUID-shaped ones to keep testing the
*intended* "not found" behavior distinctly from the new "rejected outright" behavior - every other
service's test file mocks `projectStore.js` wholesale and never exercises the real `projectDir`, so
none of them needed touching.

**Verified live** against the real running backend, not just tests: replayed the audit's own PoC
payload (`projectId: "../../../../tmp/8rack-poc"`) against `POST /api/orchestrator/tasks` and got a
clean `{"error":"\"../../../../tmp/8rack-poc\" is not a valid project id"}` instead of a task ever
starting - confirmed via `ls` that no directory was created anywhere under `/tmp` or
`backend/data/projects/`. Repeated against `/api/tools/request` (clean 400, same message) and
`/api/projects/:id/scans` (the actual scan-creation route, which persists - `/scans/preview` was
also tried and correctly returns 200 regardless of the id, but that's expected: `previewScan()` is
a pure computation and never receives `projectId` at all, so there was never anything for it to
traverse with). A normal project (real UUID) still creates, round-trips, and deletes exactly as
before. `npm run typecheck`, `npm run build`, and `npm test` (235 passing) all clean.

## Fixed: the six Medium audit findings

All six Medium-severity items from the earlier full-project audit, fixed in one pass at the user's
request (the seven Low-severity items and the Plugin system remain open - see `TODO.md`).

**Bind to `127.0.0.1` by default.** `app.listen(env.port, ...)` had no host argument, so Node
defaulted to `0.0.0.0` - every tool-execution/scan/orchestrator endpoint reachable from anything
else on the same network, in an app with no auth by design. New `env.host` (defaults to
`127.0.0.1`, override via `HOST`) is now passed explicitly: `app.listen(env.port, env.host, ...)`.
Verified against the real running dev server via `ss -ltnp` - it previously showed `*:3001`
(`0.0.0.0`, observed earlier in this same session before this fix existed), and now shows
`127.0.0.1:3001` exclusively - and the frontend's Vite proxy (which targets `localhost:3001`) still
resolves and works, since `localhost` resolves to loopback either way.

**Workspace-containment caveat on `bash`/`python`.** `toolManager.ts`'s path-containment check
inspects each argv element as its own path - it has no way to see "inside" a `bash -c "<script>"`/
`python3 -c "<code>"` string, so `arguments: ["-c", "cat ~/.ssh/id_rsa"]` was never flagged, even
though it plainly reads outside the workspace. This was always true by design (human confirmation
is the real gate for these two tools, not the containment check), just never stated anywhere a
reviewer would see it. Both tools' `description` in `tools/exec/builtins.ts` now say so explicitly
("NOT confined to the workspace root... Review the exact resolved command before approving"), and
the module's own doc comment above the roster explains why. No UI change needed - tool descriptions
already surface in the Tool Registry and wherever a tool is referenced, which is exactly where this
caveat needs to land.

**Serialized per-project-file writes.** `projectStore.ts#writeProjectJson` did a bare
`writeFile` snapshot with no ordering guarantee - two overlapping writes to the same
project+file (e.g. two `persistExecutions` calls firing close together) could have their
underlying disk writes complete out of call order, permanently reverting the file to a stale
snapshot with nothing to indicate it happened. New `enqueueWrite`/`writeQueues` (keyed per
`"{projectId}:{filename}"`, not just per project, so e.g. `executions.json` and `tasks.json`
writes for the same project don't block each other) chains writes through a `Promise` per key via
`previous.then(task, task)` - the `task, task` (not just `task`) matters: it means a failed write
still lets the *next* queued write run, so one bad write can't permanently wedge a project's
history. 3 new tests: a deliberately-delayed "older" write proven to still block a "newer" one's
actual disk write until the older one settles (not just "eventually both succeed" - the test
asserts the mock's call count stays at 1 while the first write is deliberately held open),
independent files not blocking each other, and a failed write not wedging the next one.

**Corrupted JSON logs a warning instead of vanishing silently.** `readProjectJson`
(`projectStore.ts`) and `readProjectMeta` (`projectManager.ts`) both wrapped `readFile` +
`JSON.parse` in one `try/catch`, so a file that exists but fails to parse (e.g. from a crash
mid-`writeFile`, before the write-queue fix above existed) looked byte-for-byte identical to a
project with no history yet - `[]`/`undefined`, zero indication anything was wrong. Both now
resolve `readFile` and `JSON.parse` in separate try blocks: a missing file stays silent (the common,
expected case), but a parse failure on a file that does exist gets a `console.warn` naming the
project id and filename before falling back to the same empty result. 2 new tests confirming the
warning fires only for actually-invalid JSON, not for a plain missing file.

**Guarded startup hydration.** `index.ts`'s `app.listen(env.port, env.host, async () => {...})`
callback ran `loadAgents`/`loadExecutionsFromDisk`/.../`loadIndexFromDisk` with no `try/catch`
around any of it, *after* the port was already accepting connections - a thrown error partway
through was an unhandled rejection that silently aborted every step after it (e.g. the RAG index
quietly never loading, with no log saying why). The whole body is now wrapped in try/catch with a
`console.error` naming what may not have loaded and pointing at "restart to retry" - deliberately
not crashing the process, since no route actually depends on this hydration completing (each
service just reads its own in-memory state, which starts empty regardless of whether hydration
succeeds or fails). Didn't add the "gate requests behind a 503 until ready" half of the original
suggestion - a real architectural addition (readiness middleware) disproportionate to what a
`try/catch` already fixes (the actual bug: silent, total failure with no trace). Verified live: the
dev server picked up the change and restarted cleanly, `/health` and the frontend's `/api/*` proxy
both kept working.

**Notice when enabling tools mid-chat.** The audit's original framing assumed the prior plain-chat
messages "stay visible above" once you pick a project - re-reading `ChatSessionPanel.tsx` while
fixing this showed that's not true: picking a project switches the render from
`<ChatArea/><PromptInput/>` to `<ChatTaskPanel/>` entirely, so the old messages don't just lose
context, they disappear from view completely (still safe in `useChat`'s sessionStorage, just not
rendered). Given that, seeding the new `OrchestratorTask` from `useChat`'s message history wasn't
really the more "honest" fix either - the two message shapes don't convert losslessly and the user
still wouldn't see their own history in the new task-oriented view. Went with the notice option
instead: `ChatSessionPanel.tsx` now shows an amber `AlertTriangle` banner (matching
`OrchestratorTaskView.tsx`'s existing warning-banner styling) above `ChatTaskPanel` whenever
`useChat`'s `messages` is non-empty, spelling out exactly what's true - this is a fresh
tool-enabled thread, the N earlier messages aren't shown here and aren't seen by the agent, and how
to get back to them (switch Project back to "No project"). 4 new tests
(`ChatSessionPanel.test.tsx` - didn't exist before this fix) covering all four combinations of
project-set/unset × messages-present/absent, plus singular/plural phrasing. Verified live
end-to-end: sent a plain message to General Assistant, picked a project, saw the exact notice text
with the correct message count and agent name, switched back to "No project" and confirmed the
original messages were still there untouched.

**Verified together**: `npm run typecheck`/`npm run build` (backend), `npx tsc -b`/`npm run lint`/
`npm run build` (frontend), `npm test` both sides (240 backend, 199 frontend) all clean.

## Fixed: the seven Low audit findings

The last batch from the full-project audit - with this, every finding across all three severities
(High/Medium/Low) is resolved; only the Plugin system remains open from the audit's adjacent
findings (see `TODO.md`'s "Later" section).

**Scan target flag-injection guard.** `scanRunner.ts#requireTarget` now rejects any target starting
with `-` (new `InvalidScanTargetError`, 400 `INVALID_REQUEST`) before `previewScan`/`createScanRun`
do anything else with it. Not a real command-injection risk to begin with (argv-based `spawn`, no
shell) - genuinely just cheap hardening. Verified live: `POST /scans/preview` with target
`-oG=/tmp/evil` against a real project returned a clean 400 with an explanatory message.

**Prune sessions on agent deletion.** New `hooks/useSessions.ts#pruneOrphanedSessions(validAgentIds)`
drops any session (including a closed-but-retained chat session - the one case with no other
eviction path) whose `agentId` isn't in the given set; manual/no-agent sessions (`agentId === null`)
are never touched. Wired from a new `App.tsx` effect that runs whenever `agents` changes - gated on
`!agentsLoading`, since pruning against the transient empty list before the very first `useAgents()`
fetch resolves would otherwise wipe out every agent-backed session on initial page load.

**Abort in-flight requests on unmount.** Both `useChat.ts` and `useOrchestratorTask.ts` gained a
one-line unmount-cleanup effect (`return () => abortRef.current?.abort()`). Worth double-checking
this actually fires when it matters: closing a session tab does genuinely unmount the owning
`ChatSessionPanel`/`TaskSessionPanel` (and thus this hook instance) for real - `closeSession`
either filters the session out of `taskSessions` entirely, or (for a chat session) flips
`closed: true`, which removes it from the `chatSessions` array the `.map()` in `ChatView.tsx`
renders from - neither is the same as the `hidden`-CSS-class technique used for merely-inactive
(but still open) tabs, which stays mounted. Confirmed with a test asserting the abort signal is
still unset right up until `unmount()`, then set immediately after.

**`ollama.ts` test coverage.** New `ollama.test.ts`, 29 tests, the last file in `services/` with
zero coverage. A fake streaming `Response` (`streamResponse()`) built from raw byte-string chunks
lets tests control exactly how NDJSON lines land across `reader.read()` calls - one test
deliberately splits a single line's bytes across two reads to exercise `streamChat`'s own
buffering, another omits the trailing newline on the final chunk to exercise the post-loop flush.
Every error mapping is covered (`OllamaModelNotFoundError` for a 404 naming the model,
`OllamaConnectionError`/`RequestCancelledError` for the two ways the initial `fetch()` can fail,
`RequestCancelledError` again for a stream aborted mid-read, `EmbeddingModelUnavailableError`'s two
trigger phrases). `streamChatWithTools` is tested by driving real multi-round HTTP responses
through the mocked `fetch` (not by trying to mock `streamChat` from outside - ESM modules don't let
a test intercept another export's *internal* call to a sibling export in the same file, so this is
the only way to actually exercise the round-trip logic) - native `tool_calls`, the
tag-noncompliant fallback parser recovering a bare JSON tool-call from plain content, an unknown
tool name producing an error tool-result instead of throwing, and the `MAX_TOOL_ROUNDS` cap
actually stopping a model that requests a tool forever at exactly 4 rounds. Needed a
`vi.clearAllMocks()` in `beforeEach` after the first pass showed a real cross-test leak - the
shared `fixtureTool.execute` mock's call history was accumulating across tests, so a later test
asserting "the tool was never called" saw calls left over from a completely different, earlier
test. `services/projectStore.ts`'s half of this same finding was already closed as a side effect of
the Medium-severity persistence fixes earlier in this audit, not repeated here.

**README/CLAUDE.md staleness.** `README.md`'s Features list gained Security Scanners, the Findings
Engine + CVE lookup, and Report generation (all shipped after the README was last touched), plus
two Configuration-table rows (`HOST`, `NVD_API_KEY`) that were genuine gaps from earlier fixes in
this same audit, not just pre-existing staleness. `CLAUDE.md`'s "Architecture" section - flagged as
the single most-misleading doc for a future session, since it's auto-loaded context - got a full
rewrite of both directory trees plus a new services-file reference table, and three new short prose
sections: "Two tool-calling mechanisms" (native Ollama `tool_calls` via the empty `toolRegistry.ts`
vs. the Orchestrator's own plain-text JSON convention driving the real Tool Execution Framework -
genuinely easy to conflate, since both exist and both are named "tools"), "Projects" (the
`projectId`/`projectStore.ts#projectDir` convention nearly everything is keyed on, with a pointer to
the path-traversal fix), and a correction to the "Agents" section's stale claim that `Agent.tools`
"isn't read anywhere yet" - it, and the newer `Agent.execTools`, both are. Deliberately kept as a
map with pointers into `DEVELOPMENT.md`'s much more detailed per-feature sections, not a duplicate
of them.

**Verified together**: `npm run typecheck`/`npm run build` (backend), `npx tsc -b`/`npm run lint`/
`npm run build` (frontend), `npm test` both sides (271 backend, 204 frontend) all clean throughout;
the scan-target fix additionally verified live via curl against the real running backend.

## Project-scoped chat

The last item from the original build plan's "Later" list. Deliberately deferred at the time (see
"Projects" above) - by the time this was picked up, a lot had changed underneath it: chat sessions
had gained a *per-session* `projectId` field (`ChatSessionPanel.tsx`'s Project dropdown) that opts
a thread into tool use, backed by an `OrchestratorTask` (`ChatTaskPanel.tsx`) - which already
partially overlaps with what "project-scoped chat" originally meant. Asked the user to disambiguate
before touching anything, since the obvious reading from when the TODO item was written no longer
obviously applied.

**Chosen design**: one chat thread per **(agent, project)** pair, not a backend persistence change.
`ChatView.tsx` gains its own page-level "current project" selector - a `ProjectPanel`, the same
component and pattern Workbench/Findings/Scanners/Reports already each use independently (no
project selection is shared globally across views, by established convention - see `CLAUDE.md`'s
"Projects" section). Picking an agent while a project is selected opens/resumes *that project's*
thread with the agent; switching projects and reopening the same agent gets a genuinely separate
thread, exactly like task sessions already coexist per agent (see "Concurrent task sessions per
agent" above) - just keyed by project instead of by a fresh id every time.

**Reused the existing field instead of adding a parallel one**: `hooks/useSessions.ts#openChatSession`
gained a third, optional `projectId` parameter, and its dedup lookup changed from
`s.agentId === agentId` to `s.agentId === agentId && s.projectId === projectId`. Since `projectId` is
the *same* field that already opts a chat into tool use, a project-scoped thread now starts
tool-enabled automatically - not a separate decision. This was a deliberate consequence of the
option the user picked, not an oversight: `ChatSessionPanel`'s own per-session Project dropdown is
unchanged and still works exactly as before, just now pre-filled from the page-level selection at
creation time rather than being the only place a project is ever picked. Manual (no-agent) chats
dedup by project too (`agentId === null` combined with `projectId` in the same lookup), so picking
a project and starting a manual chat also gets its own thread, separate from the global one.

**Disambiguating labels**: `SessionTabs.tsx` already folded a task session's objective into its tab
label since same-agent task tabs stopped deduping a while back (see "Concurrent task sessions per
agent"); the same problem now exists for chat tabs, so it gained a `projects?: Project[]` prop
(optional - only `ChatView` passes one; `OrchestratorWorkbench`'s task tabs don't need it, since
`initialObjective` already disambiguates those) and appends `· <project name>` to a project-scoped
chat tab's label, falling back to just the agent name if the project can't be resolved (e.g. it was
deleted out from under an open session). `AgentNetwork.tsx`'s `SessionNode` tooltip got the same
treatment for the Command Center map's session nodes.

**What didn't change**: no backend changes at all - this is purely a frontend session-identity/UI
feature. Plain (no-project) chat still behaves exactly as before (one global thread per agent,
`useChat.ts`'s `sessionStorage`, no persistence change). `env.workspaceRoot` stays a single global
directory, unaffected - that was always a separate non-goal from chat scoping.

9 new frontend tests: 5 in `useSessions.test.ts` (dedup with a different project produces a
separate thread; dedup with the same pair resumes instead of duplicating; manual/no-agent sessions
scope by project too; a newly-created project-scoped session correctly starts with `projectId` set)
and a new `SessionTabs.test.tsx` (no dedicated test existed before this - covers the new
project-suffix label logic, a task session's objective still taking priority, an unresolvable
`projectId` falling back gracefully, and the `projects` prop's default when omitted). 214 frontend
tests total.

**Verified live** against the real running app: created two throwaway projects, selected the first
and opened the Recon Agent from the Command Center map - a new tab opened, correctly labeled
"Recon Agent · <project>", Project dropdown pre-filled, and tools already enabled (the "Recon Agent
can request to run commands" message showed immediately, no extra step). Switched to the second
project and reopened the Recon Agent - a genuinely separate second tab opened (confirmed via the
right panel's "2 chats, 0 tasks" count), both coexisting. Switched back to the first project and
reopened the Recon Agent a third time - refocused the *original* tab instead of creating a third
(count stayed at 2), proving the dedup-by-(agent,project) lookup works both ways. Cleaned up both
throwaway projects afterward via the DELETE endpoint. `npx tsc -b`, `npm run lint`, `npm test` (214
passing), and `npm run build` all clean throughout.

**Later removed**: the page-level `ProjectPanel` picker described above (`ChatView.tsx`'s Home tab,
above the `AgentNetwork` map) was removed - user feedback that it was unnecessary clutter on the
Command Center. It only ever controlled which project a *new* session started pre-scoped to;
`ChatSessionPanel.tsx`'s own per-session Project dropdown (`onChangeProject`) already does the same
plain→project-scoped transition after the fact, so no capability was lost, just the up-front step.
New chat sessions from the Command Center now always start project-less; `openChatSession`'s third
`projectId` argument is simply omitted from both the per-agent and manual-chat call sites. The
dedup-by-(agent,project) lookup, tab-label project suffix, and `AgentNetwork` session-node tooltip
logic from the original feature are untouched - a project can still be assigned to a session, just
not before it exists.

## Tool Registry UI: version, path, enable/disable, category rework

First of five large feature requests dropped into TODO.md's "NEW TODO AND CHECK UPS IF ALREADY
IMPLEMENTED" section, worked one at a time per explicit user instruction. Before touching anything,
audited all five against the current codebase (see TODO.md's per-task checklists) - a lot of what
Task 1 asked for already existed (tool discovery, per-agent `execTools` allowlist with a proper
multi-select UI in `AgentEditor.tsx`), so this pass only closed the real gaps: version display,
visible resolved path, a runtime enable/disable toggle, and the category taxonomy rework.

**Category taxonomy**: `ExecToolCategory` changed from the original 5 (`filesystem`/`network`/
`recon`/`exec`/`vcs`) to the 7 the task specified (`recon`/`network`/`web`/`fuzzing`/`analysis`/
`os`/`reporting`). Every builtin tool in `tools/exec/builtins.ts` got remapped by what it actually
does rather than a mechanical rename: all the filesystem/git/bash/python tools collapsed into `os`
(there's no dedicated "system" category in the new 7, and OS is the closest fit for "runs on the
local machine, not against a target"); `curl`/`http_request`/`httpx`/`katana` became `web` (HTTP-
layer specific) as distinct from `nmap`/`whois`/`dig`/`nslookup` staying `network` (IP/DNS/port-
layer); `ffuf` is the only `fuzzing` tool, `nuclei` the only `analysis` tool. Nothing is categorized
`reporting` - none of the ~20 builtins fit it, and the task explicitly said not to add new security
tools this pass, so that category exists in the type but currently has zero tools, which is
expected rather than a bug.

**Version detection**: `ExecTool` gained an optional `versionFlag` (e.g. `"--version"`, `"-V"`) -
deliberately per-tool rather than a single hardcoded flag, since project-discovery-family tools
(`httpx`/`katana`/`nuclei`/`subfinder`/`amass`) use single-dash `-version`, `nmap` only recognizes
`-V`, and GNU-style tools take `--version`. More importantly, `whois` and `nslookup` got **no**
`versionFlag` at all on purpose: on at least one common `whois` implementation, an unrecognized
flag is read as the query target, meaning `whois --version` would fire a real outbound whois query
for the literal string `"--version"` instead of failing safely - not something to risk on every
`GET /api/tools` call. `toolManager.ts#resolveVersion` runs the probe via `spawnSync` with a 3s
timeout and empty stdin, taking the first non-empty line of stdout (falling back to stderr) as the
version string; no flag, a nonzero exit, or a timeout all just leave `version` undefined rather than
guessing. This runs alongside the existing `which`-based availability check in
`listExecToolsWithStatus`, so every `GET /api/tools` call now does up to two synchronous child
processes per tool - acceptable for a local desktop tool count (~20) but would need to move off the
request path if the roster grows much larger.

**Enable/disable**: `ExecTool.enabled` was already read at request time (`ExecToolDisabledError` in
`requestExecution`), but was static config baked into `builtins.ts` with no way to flip it without
editing source. Rather than turning every tool config into a per-tool JSON file (agents' pattern),
went with a single small overlay file, `backend/data/tools/overrides.json` - a flat
`{toolId: boolean}` map of every registered tool's current `enabled` value, written in full on every
toggle (`toolManager.ts#persistToolOverrides`) and re-applied on top of the freshly-registered
builtins at startup (`loadToolOverridesFromDisk`, called from `index.ts` right after
`registerExecTool` has run for every builtin, before the "Loaded N tool(s)" boot log line). New
`PATCH /api/tools/:id` route, body `{"enabled": boolean}`, reuses the existing
`ExecToolNotFoundError` → 404 mapping. Frontend: `toolsApi.ts#setToolEnabled`, threaded through
`useTools.ts#toggleTool` (reconciles from the backend's response rather than assuming the optimistic
value, so availability/version/etc. stay accurate too), and a `Power`-icon `IconButton` in
`ToolRegistry.tsx` next to the availability pill - disabled tools also get a "disabled" pill and the
whole row dims. `onToggleEnabled` is an optional prop on `ToolRegistry`, wired at all three of its
call sites (`OrchestratorWorkbench.tsx`, `MultiAgentPlanner.tsx`,
`workbench/TaskSessionPanel.tsx`). `backend/data/tools/` follows the same gitignore pattern as
`backend/data/projects/`/`backend/data/rag/` - a tracked `.gitkeep`, everything else runtime state.

**Path visibility**: `ToolRegistry.tsx` previously rendered the bare `executable` name with
`resolvedPath` only in a hover tooltip. Now renders `resolvedPath ?? executable` directly as visible
text - a one-line change, but it was one of the task's explicit asks ("show tool name, version,
path...").

5 new backend tests in `toolManager.test.ts` (unknown-tool-id rejection, a full toggle round trip
through `requestExecution`'s `ExecToolDisabledError`, override re-application across a simulated
restart, no-op on a missing overrides file, and malformed-JSON tolerance) - added a `node:fs/promises`
mock alongside the existing `projectStore.js` mock so these don't touch the real filesystem. 1 new
frontend test in `useTools.test.ts` covering `toggleTool`'s backend call and state reconciliation.
276 backend / 215 frontend tests total, both `tsc` checks and `oxlint` clean.

**Verified live**: `GET /api/tools` shows real detected versions (`GNU bash, version 5.3.15...`,
`curl 8.21.0...`, `Nmap version 7.99...`) and resolved paths for every available tool. `PATCH
/api/tools/nmap {"enabled":false}` flipped it, `backend/data/tools/overrides.json` picked up the
change, and a follow-up `GET /api/tools` reflected it - toggled back and deleted the test override
file afterward so no stray state was left behind. In the browser: clicked the Power toggle on Bash
in the Workbench's Tool Registry panel - row dimmed, "disabled" pill appeared, toggled back cleanly.
Opened the Code Assistant agent's editor, switched to "Select specific tools" - all 6 populated
categories (Recon 0/2, OS 0/8, Web 0/4, Network 0/4, Fuzzing 0/1, Analysis 0/1) rendered with correct
per-category tool membership and counts.

### What's next

Tasks 2-5 from the same TODO.md audit, in order, one at a time: Task 2 (attach an `agentId` to
`ExecutionRecord` so the Tool Registry/Execution History views can show which agent triggered a
given execution - small, well-scoped), then the substantially larger Tasks 3 (Mission/scope system),
4 (richer Findings/Evidence fields), and 5 (automatic Mission Controller planning + live graph UI),
each likely warranting its own scoping discussion before implementation given their size.

## Execution records now carry an agentId

Task 2 of the same TODO.md audit. The Orchestrator's tool-calling loop itself was already fully
built (analyze → select tool → generate args → confirm → execute → analyze result → continue - see
"Orchestrator" above) and never bypassed human confirmation; the one real gap the audit found was
that `ExecutionRecord` had no link back to which agent requested it, so the flat, project-wide Tool
Registry/Execution History views (which blend every agent's - and every manual, agent-less -
execution together) couldn't show it, even though a single task session's own view already made the
agent obvious from context.

**Threading**: `ToolRequestBody.agentId?: string` (new, optional) → `ExecutionRecord.agentId?: string`
(new, optional) - both undefined for a manual request with no agent involved. The only real producer
is `orchestrator.ts#advance`, which already had `task.agentId` in scope at its one `requestExecution`
call site and now passes it straight through. `routes/tools.ts`'s `POST /request` validates it as an
optional string for symmetry (nothing currently sends it over HTTP directly - the Orchestrator calls
`requestExecution` in-process - but the route's contract should still describe the full shape
faithfully rather than silently stripping a field a caller might reasonably send).

**Display**: `ExecutionHistoryPanel.tsx` gained an `agents: AgentWithStatus[]` prop and the same
`agentName(agents, id)` resolve-or-fall-back-to-raw-id pattern `OrchestratorWorkbench.tsx`/
`MultiAgentPlanner.tsx` already each have their own copy of (not extracted to a shared helper - three
near-identical four-line functions didn't seem worth a new shared module for). A resolved name
renders as a small badge next to the tool id in each history row, omitted entirely when
`agentId` is absent rather than showing an empty or "manual" placeholder - keeps the common case
(this app runs almost everything through an agent) uncluttered. Also folded into the row's search
matching, so typing an agent's name filters the list the same way searching a tool id or command
output already did. Left `ToolRegistry.tsx`'s "last execution" pill alone - the audit only flagged
the Execution History view specifically, and the registry's per-tool pill is a much smaller, more
incidental display.

**Deliberately not touched**: `ExecutionConsole.tsx` (used both by `ExecutionHistoryPanel`'s expanded
row and by `OrchestratorTaskView.tsx`'s live/pending-confirmation card) - the latter already shows
the agent via the task session's own header, so adding it a second time inside the console itself
would be redundant there; threading an optional label through would have meant a prop that's
meaningful in one caller and dead in the other.

2 new backend tests in `toolManager.test.ts` (agentId carried through end-to-end for an agent-driven
request, undefined for a manual one) and 2 existing `orchestrator.test.ts` assertions updated (they
asserted the exact object passed to the now-mocked `requestExecution`, which gained the new field).
No new frontend test file - `ExecutionHistoryPanel.tsx`/`ToolRegistry.tsx` have no dedicated test
suite yet (verified by hand instead, see below), consistent with how they were before this pass.

**Verified live**: `POST /api/tools/request` with `agentId: "recon-agent"` in the body round-tripped
the field through `GET /api/tools/executions` unchanged (then rejected the test execution via `POST
.../reject` to avoid leaving stray state). In the browser, the Workbench's Execution History panel
showed a "Recon Agent" badge on that row and no badge at all on an older manual `list_directory`
execution directly below it.

## Bug Bounty Mission Workspace (Task 3)

The largest of the five TODO.md audit tasks - big enough to scope explicitly with the user before
starting rather than guess. Four design forks were genuinely open-ended (not just implementation
detail), so asked directly: (1) keep "Project" as the term everywhere vs. rename to "Mission"
throughout the codebase, (2) how strictly to enforce scope given tool arguments have no structured
"target" concept, (3) build Assets as a new backend entity vs. derive it from existing Findings
data, (4) same question for Activity. User picked the lower-churn option each time: keep "Project",
best-effort-block-plus-warn, derive both Assets and Activity from existing data. All four shaped
the implementation below directly.

### Structured mission fields stay on Project, not a new entity

`types/project.ts`'s `Project` gained six new optional fields - `description`, `scope: string[]`,
`outOfScope: string[]`, `rules`, `startDate`, `status: MissionStatus` (`"planning" | "active" |
"paused" | "completed"`) - alongside the original `id/name/notes/createdAt`. All optional so every
existing `project.json` on disk keeps working unmodified; `projectManager.ts#createProject` gained
a third optional `mission` parameter, `updateProject`'s patch type widened to accept any of them.
`routes/projects.ts` validates each field independently (array-of-strings for scope/outOfScope, one
of the four status literals, etc.) on both POST and PATCH, sharing one `validateMissionFields`
helper so the two routes can't drift.

**Frontend**: no new top-level nav view or "Mission" screen - deliberately, given the terminology
answer above. Instead, a new `MissionEditor.tsx` (`Sheet`-based, same pattern as `AgentEditor.tsx`)
opened from a new Edit (pencil) affordance on each `ProjectPanel` card, wired through the
already-existing-but-previously-unused `useProjects.ts#update()` path (audited at the start of this
task and found to have zero real callers - every consumer only ever created/deleted projects, never
edited one). Quick create (name + notes) stays exactly as it was in `ProjectPanel` itself;
`MissionEditor` is edit-only, so a mission doesn't need every field filled in before it even has an
id to key findings/executions/tasks against. Scope/outOfScope are edited as one-target-per-line
textareas rather than a tag-input widget - simpler to build, and the values are meant to be pasted
in bulk from a program's scope page anyway. `startDate` round-trips through a native `<input
type="date">` via local-timezone (not UTC) date-string conversion, since a naive `toISOString()`
slice can shift the displayed date by a day depending on the user's timezone offset.

### Scope enforcement is best-effort by design, not a gap to "finish" later

The core problem, confirmed by research before implementation: a `ToolRequestBody.arguments` is an
opaque `string[]` - `nmap -sV 10.0.0.5` and `bash -c "curl https://x"` carry no metadata saying
which token is "the target". Only Scan Profiles (`ScanRun.target`) have an explicit target field.
Given that, and the user's explicit choice of "best-effort block + always-visible warning" over
either "warn-only, never block" or "only enforce where a real target field exists":

New `services/scopeMatcher.ts`, three layers:
- `extractTargets(args)` - regex-pulls URL/IPv4/domain-looking tokens out of `args.join(" ")`.
  Domain matches are filtered through a curated ~70-entry common-TLD allowlist
  (`COMMON_TLDS`) rather than accepting any `word.word` pattern - an early version without this
  filter matched `process.stdout.write(...)` and `config.yaml`/`app.py` as "domains", which would
  have wrongly blocked completely ordinary bash/python one-liners the moment any scope was
  configured. Under-matching here just degrades a real target to the "unknown" (warn-only) verdict,
  never to a silent skip, so erring toward a smaller TLD list is the safe direction.
- `isInScope(target, list)` - matches an exact domain/IP, a subdomain against its bare parent
  domain, a `*.example.com` wildcard, an IP inside a CIDR range, or a URL entry by hostname.
- `checkScope(scope, outOfScope, args)` - the decision: no scope configured at all → always
  `no_restriction`; scope configured but `extractTargets` found nothing → `unknown`; every found
  target passes → `in_scope`; any found target is excluded by `outOfScope` or fails a non-empty
  `scope` allowlist → `out_of_scope` (`outOfScope` checked first, so it can carve out a subdomain
  from a broader wildcard `scope` entry).

Wired into the one real chokepoint, `toolManager.ts#requestExecution` (after tool/argument
validation, before the record is created): `out_of_scope` throws a new `OutOfScopeError` (mapped to
403/`OUT_OF_SCOPE`), rejecting the request before it's even parked as `pending_confirmation`;
`unknown` doesn't block anything, but sets a new `ExecutionRecord.scopeWarning` string, surfaced as
an amber banner in `ExecutionConsole.tsx` (both the live pending-confirmation card in
`OrchestratorTaskView.tsx` and `ExecutionHistoryPanel.tsx`'s expanded row) so the human approving it
sees "scope wasn't actually checked here" rather than assuming a silent pass meant "checked and
clear". The `getProject(projectId)` lookup itself is wrapped in `.catch(() => undefined)` -
scope-checking is defense-in-depth, not something that should ever be capable of taking down tool
execution if a project lookup fails for an unrelated reason.

**Scan Profiles get real enforcement for free, no separate wiring**: `scanRunner.ts` already routes
every step through the same `requestExecution`, with the target substituted directly into
`arguments` as a literal token (`substituteTarget`) - so `extractTargets` reliably finds it (it's
never a freeform code string), meaning a scan against an out-of-scope target hits the same
`out_of_scope` block deterministically, no `unknown` case possible. Considered adding a second,
Scan-Profile-specific enforcement path directly against `ScanRun.target` for a "more definitive"
check, but it would have been redundant - the shared path already gets it right, and
`scanRunner.ts`'s existing per-step try/catch around `requestExecution` already turns any thrown
error (including a new `OutOfScopeError`) into a normal failed-step outcome with zero new code.

### Mission context injection

`orchestrator.ts#buildToolsPreamble` already had `projectId` in scope (it builds the
`query_findings`/`lookup_cves` tool descriptions from it) - became `async`, fetches the project via
`projectManager.ts#getProject`, and prepends a `Mission: <name> (status: ...)` block with
whichever of description/scope/outOfScope/rules are actually set, omitted entirely for a project
with none configured (avoids preamble noise on the common case). Explicitly tells the agent
"Tool executions against a target outside this scope are automatically blocked" - the text itself
isn't the enforcement (that's `scopeMatcher.ts`/`toolManager.ts` above), just makes the agent aware
upfront instead of discovering it via a rejected tool call. The one call site (`collectAgentReply`)
already awaited everything around it, so making this one function async was a fully contained
change. `orchestrator.test.ts` needed a new `vi.mock("./projectManager.js", ...)` (defaulting
`getProject` to resolve `undefined`, matching pre-change behavior) since its fixture project ids
like `"proj-1"` aren't UUID-shaped and would otherwise throw through the real
`projectStore.ts#projectDir`'s validation - same reasoning as `toolManager.test.ts`'s existing
`projectStore.js` mock.

### Assets and Activity are views, not new stores

Both delivered as pure client-side derivations over data that already existed, per the user's
choice:

- `AssetsView.tsx` regroups a project's already-fetched `Finding[]` by type into the categories the
  task asked for (Domains/Subdomains/Ports/Technologies/APIs/Endpoints), deduplicated by each
  finding's canonical `value` with an occurrence count. No dedicated `ip` `FindingType` was added
  (the original plan considered one, see TODO.md) - none of the existing parsers would ever
  populate it without further parser changes, which was out of scope for this pass, so it would
  have been a type that's valid but permanently empty. Instead, IP addresses are recovered from any
  finding whose `target` field already happens to be IPv4-shaped (every port/service finding from
  an IP-based nmap scan satisfies this for free).
- `ActivityFeed.tsx` + `hooks/useActivity.ts` merge a project's tool executions
  (`GET /api/tools/executions`) and Orchestrator task transcripts (`GET /api/orchestrator/tasks` -
  already existed as `services/orchestratorApi.ts#fetchTasks`, just had zero UI consumers before
  this) into one chronological feed, each row resolving its `agentId` to a name via the same
  `agentName(agents, id)` lookup pattern used elsewhere (`OrchestratorWorkbench.tsx`,
  `ExecutionHistoryPanel.tsx`).

Both slot into `FindingsView.tsx` as two more entries in its existing `VIEW_MODES` tab strip
(Table/Timeline/Graph/**Assets**/**Activity**/Reports) rather than a new nav item or dedicated
"Mission" screen - consistent with the terminology decision to not restructure the app around a
new concept.

10 new frontend tests across `AssetsView.test.tsx` (grouping, dedup-with-count, IP derivation,
empty state, non-asset-type findings ignored) and `ActivityFeed.test.tsx` + `useActivity.test.ts`
(merge ordering, agent-name resolution, error/loading states). 23 new `scopeMatcher.test.ts` tests
(including the code-identifier/filename false-positive regression case), 6 new
`toolManager.test.ts` scope-enforcement cases, 3 new `orchestrator.test.ts` mission-context cases,
several new `projectManager.test.ts` mission-field cases, and a new `MissionEditor.test.tsx` (8
cases covering pre-fill, list-splitting, date conversion, and save/error states). 314 backend / 240
frontend tests total, both `tsc` checks and `oxlint` clean throughout.

**Verified live**: opened the Mission editor on a real project (`https://www.showpad.com/`), set a
description, status "active", and scope (`showpad.com`, `*.showpad.com`) - saved successfully, the
project card immediately reflected the new "active" status pill. Confirmed via direct API calls
against that same now-scoped project: `POST /api/tools/request` for `dig evil.com` returned 403
`OUT_OF_SCOPE`, the identical request for `dig showpad.com` succeeded normally (cleaned up via
reject afterward). In the browser, the Findings view's new Assets tab correctly showed "No assets
discovered yet" for a project whose only findings are `type: "information"` (whois metadata, not an
asset-eligible type) - and the Activity tab rendered a real merged, chronologically-sorted feed of
that project's actual execution/task history with agent names resolved throughout.

### What's next

Tasks 4 (richer Findings/Evidence fields) and 5 (automatic Mission Controller planning + live graph
UI) remain, in order, one at a time. Task 5 in particular now has more to build on than before -
`Project.scope`/`Assets`/`Activity` give it real primitives ("update the asset inventory",
"scope-aware") that didn't exist when it was originally audited as ~10% done.

## Findings & Evidence System (Task 4)

Task 4 of the same TODO.md audit. Pre-implementation research turned up one thing the earlier
audit had undersold: agents could already *read* findings (`query_findings`, read-only) but had no
way to *create* one - the task's actual headline sentence, "Agents must be able to create findings
instead of only writing text," wasn't addressed by anything already in the codebase. That became
the centerpiece of this pass, alongside the requested new fields, status vocabulary, evidence
model, and dashboard filters.

### Status vocabulary: renamed wholesale, migrated automatically

`FindingStatus` went from a mechanical `discovered`/`updated`/`verified`/`dismissed` (tracking
"has this been re-observed" more than any real triage state) to the task's actual bug-bounty
vocabulary: `potential`/`investigating`/`confirmed`/`false_positive`/`reported`/`duplicate`.
Chose a full rename over layering the new values alongside the old ones (same call as Task 1's
`ExecToolCategory` rework) - a mixed vocabulary would have been more confusing long-term than a
one-time migration.

The migration itself (`findingsManager.ts#migrateStatus`/`migrateFinding`) runs on every finding
*and every history entry* loaded from disk (`loadFindingsFromDisk`), not as a one-off script:
`discovered`/`updated` → `potential`, `verified` → `confirmed`, `dismissed` → `false_positive`.
It's idempotent (a value already in the new vocabulary passes through unchanged), so re-running it
on every startup is free and there's no "have we migrated yet" flag to track or get out of sync.
The re-detection logic in `upsertFinding` changed to match: only a `"potential"` finding advances
on re-detection (still logging a history entry either way, so "this was re-observed" stays visible
in the Timeline even when the status itself doesn't move) - anything a human/agent has explicitly
triaged past `potential` stays put across a re-scan, same intent as the old "preserve verified/
dismissed" rule, just against the new vocabulary.

### Evidence: string → typed array, migrated the same way

`Finding.evidence` changed from a single string (repeatedly concatenated with `\n---\n` and capped
at a raw character length on re-detection - the old `EVIDENCE_MAX_LEN`) to `EvidenceItem[]`, each
tagged `http_request`/`http_response`/`terminal_output`/`tool_result`/`agent_reasoning`/`note` with
its own `content`+`createdAt`. Capped at 20 items now (`EVIDENCE_MAX_ITEMS`), oldest dropped first,
deduplicated by exact content match (`pushEvidence`) rather than the old substring-containment
check. Same migration mechanism as status: a finding loaded from disk with a legacy plain-string
`evidence` field gets wrapped into a single `note`-typed item
(`findingsManager.ts#migrateFinding`).

**Deliberately not built**: screenshot/file attachments, despite being named in the task
("Screenshots, Files"). Every other requested evidence type is text - HTTP requests/responses,
terminal output, tool results, agent reasoning - and fits the existing JSON-over-HTTP,
no-file-storage shape of everything else in 8Rack. Binary attachments would need a real upload
endpoint and a storage directory (a new, separate feature, not a natural extension of
`EvidenceItem`), so this was scoped out explicitly rather than half-built. `ParsedFinding`/
`FindingCreateInput` still take `evidence?: string` (not the full item shape) at their input
boundary - callers (parsers, the manual creation route, the new `create_finding` pseudo-tool) just
provide raw text, and `findingsManager.ts` is the only place that wraps it into a typed
`EvidenceItem`, which kept every parser file untouched.

### New fields: parameter, impact, reproductionSteps, executionIds, relatedAgents

`parameter`/`impact`/`reproductionSteps` are plain optional strings on `Finding`, threaded through
`ParsedFinding`/`FindingCreateInput`/`FindingPatchInput` the same way `metadata`/`tags` already
were - editable in `FindingDetails.tsx`'s new "Details" form (not gated behind an edit-mode toggle,
just three always-visible fields with a "Save details" button, enabled only when something actually
changed).

`executionIds: string[]` closes the "every finding should link back to the exact execution... that
produced it" ask - `toolManager.ts#requestExecution`'s call into `ingestExecution` already had the
`ExecutionRecord.id` in hand; it's now threaded through `upsertFinding`'s new `opts.executionId` and
appended (deduplicated) on every ingestion, including re-detections.

`relatedAgents: string[]` is stamped by the new `createAgentFinding` path (see below) and
accumulates across re-detection by a *different* agent (e.g. a Recon Agent's initial finding later
re-confirmed by a Validator agent both end up listed) - a manual or scanner-sourced finding never
gets an agent added to this array purely by being queried or viewed; only actually *creating*
touches it, keeping the field meaningful rather than "every agent that ever looked at this."

### create_finding: closing the actual headline gap

A fourth pseudo-tool alongside `search_knowledge_base`/`query_findings`/`lookup_cves` in
`orchestrator.ts`, same structural pattern (parsed out of the model's plain-text tool-request
JSON, a tool-result message pushed back into the conversation, `advance()` recurses). Two things
make it different from the other three:

- **It's always listed**, not conditional on existing data (the other three only appear once
  there's something to search/query/look up) - there's no precondition for "record a finding."
- **It genuinely mutates project state** rather than being read-only, but still skips human
  confirmation - the same reasoning that already applied to a human manually logging a finding via
  `POST /api/projects/:id/findings` with no approval gate: it records data, it doesn't run a
  command or touch the filesystem/network. The bar for requiring confirmation in this codebase has
  always been "does this execute something," not "does this write something."

**Argument encoding**: every existing pseudo-tool's `arguments` is a flat `string[]`, fine for
zero or one plain value (`query_findings`'s optional type filter, `lookup_cves`'s product name).
`create_finding` needs many fields, several optional - flattening them positionally would be
fragile for a small local model to get right and impossible to extend. Instead, `arguments` is
still exactly one element, but that element is a JSON object *encoded as a string* -
`{"tool": "create_finding", "arguments": ["{\"type\":\"potential_vulnerability\",...}"]}`. This
keeps the outer tool-request shape identical to every other tool call (so `parseToolRequest` needed
zero changes), while giving the finding payload real structure.
`parseCreateFindingArgs`/`runCreateFinding` validate every field independently and return a specific
error string per failure (missing/invalid `type`, an attempt to set `confirmed_vulnerability`
directly, malformed JSON, etc.), fed back to the agent as a failed tool result so it can retry with
a corrected payload - same recover-and-retry loop `InvalidToolArgumentsError` already gives a real
ExecTool call, just implemented locally since this isn't a real ExecTool.

### Dashboard filters

`FindingsView.tsx` gained two filter dropdowns: Confidence (preset ≥50/70/90% thresholds rather
than a free-form number input - simpler UI, and the presets cover the realistic triage thresholds)
and Agent (only rendered when the project has at least one agent-touched finding, matching either
`tool` for an agent-sourced finding or membership in `relatedAgents` - distinct from the existing
Tool filter, which mixes real tool ids and agent ids together since `Finding.tool` doubles for
both depending on `source`).

`FindingsTable.tsx` also gained a Status column (there wasn't one at all before this pass - the
only prior status-driven behavior was dimming a `dismissed` row) - now dims `false_positive` and
`duplicate` rows, and shows a proper status pill using the same `STATUS_TONE`/`STATUS_VERB` maps
`FindingsTimeline.tsx`/`FindingDetails.tsx` already exported.

23 new backend tests (`findingsManager.test.ts`: status/evidence migration, `executionIds`
accumulation, evidence dedup/cap, `createAgentFinding`, the two new `listFindings` filters;
`orchestrator.test.ts`: `create_finding` preamble/success/validation-error/confirmed_vulnerability-
rejection/tool-call-cap cases). New `FindingDetails.test.tsx` (12 cases - the component had no
prior test coverage, and the amount of new interactive logic in this pass - status buttons, the
Details form, evidence rendering - was substantial enough to be worth a dedicated file, matching
how `MissionEditor.test.tsx` was added in Task 3). `FindingsTable.test.tsx`/
`FindingsTimeline.test.tsx`/`AssetsView.test.tsx`/`useFindings.test.ts`/`reportManager.test.ts`
fixtures all updated for the new status vocabulary and evidence shape. 328 backend / 252 frontend
tests total, both `tsc` checks and `oxlint` clean.

**Verified live** against the real `showpad.com` project (already had real findings from earlier
sessions, migrated under the old vocabulary): confirmed via direct API call that an existing
finding's status read back as `"confirmed"` (was `"verified"`) and its evidence as a `note`-typed
`EvidenceItem` array (was a plain string) - the migration ran automatically on the dev server's
next restart, no manual step. Created a finding through the manual API with
parameter/impact/reproductionSteps/evidence set and confirmed every field round-tripped correctly,
then deleted it. In the browser: the Findings table showed the new Status column with correct
pills (`Confirmed`/`Potential`) and the "Any confidence" filter; opened a finding's details and
confirmed all six status buttons render with the current one highlighted and disabled, the Details
form pre-fills correctly, and the Evidence section shows the migrated item with its type label and
timestamp instead of one flat preformatted block.

### What's next

Task 5 (autonomous Mission Controller + live graph UI) remains - the last and largest of the five.
`Project.scope`, the Assets/Activity views, and now `Finding.executionIds`/`relatedAgents` give it
considerably more to build on than when it was first audited as ~10% done.

## Embedding-only models are hidden from the chat/agent model pickers

`nomic-embed-text` was showing up in every model dropdown and failing the moment it was picked.
That isn't a wiring bug — it's what the model is. `/api/tags` reports it as `family: nomic-bert`,
137M params, `capabilities: ["embedding"]`: an encoder with no generative decoder at all. Ollama
itself refuses the request outright:

```
$ curl http://localhost:11434/api/chat -d '{"model":"nomic-embed-text:latest","messages":[...]}'
{"error":"\"nomic-embed-text:latest\" does not support chat"}
```

It exists in this project for exactly one job: `EMBEDDING_MODEL` (`config/env.ts`, default
`nomic-embed-text`), which `services/ragIndex.ts` uses to build and search the knowledge-base
index. The reverse of the constraint documented in the "RAG over a workspace codebase" section —
chat/coder models don't declare `embedding` and get rejected by `/api/embed` — is equally true, and
neither direction was being enforced in the UI.

The reason it leaked into the pickers is that nothing had ever looked at `capabilities`.
`GET /api/models` forwards `/api/tags` verbatim (`routes/models.ts`), `useModels.ts` passed the
result straight through, and the field wasn't even present on the `OllamaModel` type on either
side — so no consumer *could* have filtered on it. Worse, `App.tsx`'s "auto-select the first model"
effect (`if (!selectedModel && models.length > 0) setSelectedModel(models[0].name)`) picked
whatever Ollama listed first, which on this machine was `nomic-embed-text:latest` — so a fresh load
could land on an unusable model with no user action at all.

**The fix.** `capabilities?: string[]` added to both `OllamaModel` types (backend and frontend
mirror), and a new `frontend/src/lib/modelCapabilities.ts` with `isChatCapable`/`chatCapableModels`.
The filter is applied **once, in `useModels.ts`**, not at each call site: every consumer of that
hook's `models` (the sidebar `ModelSelector`, `ChatSessionPanel`, `OrchestratorWorkbench`,
`AgentEditor`, `CommandPalette`) is a chat or agent picker where an embedding-only model can only
ever fail, and filtering centrally means a sixth picker added later can't quietly reintroduce the
bug. The hook additionally returns `allModels` (unfiltered), so the raw list stays available —
there's no embedding-model picker today (`EMBEDDING_MODEL` is env-only, `KnowledgeBasePanel` just
displays whatever RAG status reports), but hiding models behind a hook named `useModels` without
leaving the full list reachable would be a trap.

`isChatCapable` **fails open**: `/api/tags` only started reporting `capabilities` in recent Ollama
versions, so a model that declares nothing (or an empty array) is treated as chat-capable rather
than hidden. Hiding a working model on an older Ollama would be a far worse failure than showing
one that errors clearly. Backend behavior is deliberately unchanged — `/api/models` still reports
everything installed (it answers "what's installed", not "what can chat"), and if an embedding
model does reach `/api/chat` some other way, Ollama's own `does not support chat` message already
passes through `OllamaRequestError` intact.

`AgentEditor.tsx`'s existing "keep the current value even if it's not in the list" `<option>`
fallback (line 206) means an agent already saved against an embedding model still shows its
configured model rather than silently switching — no migration needed.

7 new frontend tests (`lib/modelCapabilities.test.ts` — completion/embedding-only/absent-and-empty
capabilities, plus the list filter; `useModels.test.ts` — `models` filtered while `allModels` stays
whole). 258 frontend / 328 backend tests, both `tsc` checks and `oxlint` clean.

## Fixed: mission-scope enforcement bypasses (2026-08-08 audit, Medium)

The 2026-08-08 audit's remaining Medium item on `scopeMatcher.ts`/`toolManager.ts` had five
distinct sub-issues, all fixed in one pass (see `TODO.md`'s own entry for the itemized list of
what changed). The two worth expanding on here:

**IPv6 was the real gap, not "add a regex".** `scopeMatcher.ts` had only ever extracted IPv4 —
`curl http://[::1]/` extracted zero targets, landing on the `"unknown"` verdict and running
unchecked even against a strict allowlist project. Getting IPv6 *extraction* right with a
hand-written regex is genuinely hard (compressed `::` forms, embedded IPv4 tails, variable group
counts) — precise enough to reject every invalid shape without also rejecting valid ones is not a
few-line regex. The fix instead extracts loose `[0-9a-fA-F:]+` candidate runs and validates each
with `node:net`'s `isIPv6` — over-matching candidates is harmless since `isIPv6` is the real gate,
and it's the same "let the platform's own parser do the hard part" move the pre-existing IPv4
handling already leaned on for decimal/hex/octal forms (see below). *Matching* then needed its own
new piece: two IPv6 addresses can be the same address spelled differently (`::1` vs
`0:0:0:0:0:0:0:1`, case), so scope-entry and extracted-target strings need a shared canonical form
before `===` means anything — `canonicalizeIPv6()` expands `::` and zero-pads every group to a
lowercase 8-group form. IPv6 CIDR (`"2001:db8::/32"`) reuses the same canonicalizer plus a 128-bit
`BigInt` mask, mirroring the existing IPv4 CIDR check's 32-bit approach.

**Decimal/hex/octal IPv4 forms turned out to already be half-solved by accident.** The audit named
`curl 2130706433` (decimal for `127.0.0.1`) as a bypass. Testing it live surfaced something not
obvious from reading the code: `new URL("http://2130706433/").hostname` already returns
`"127.0.0.1"` — Node's WHATWG `URL` host-parsing algorithm normalizes decimal/hex/octal/
partially-dotted IPv4 forms itself, for any of these embedded in an actual `http(s)://` URL. So the
existing `URL_RE` extraction branch already covers this case today, entirely for free, and always
has. The genuine remaining gap is a *bare*, schemeless alternate-form IP — `curl 2130706433` with
no `http://` — which `curl` itself still resolves to `127.0.0.1` but which never goes through
`new URL()` in this code at all. Deliberately **not** fixed: a "treat any integer argument as a
possible decimal IP" heuristic would misfire constantly (port numbers, thread counts, retry
counts — any bare number in any tool's argv). That case still falls through to `checkScope`'s
`"unknown"` verdict, same as before, and is now blocked outright rather than silently warned when a
strict scope allowlist is configured — see below.

**The other three sub-issues were behavioral, in `toolManager.ts`, not `scopeMatcher.ts`.** The
inline scope-check logic in `requestExecution` got pulled out into a new `checkExecutionScope()`
so `confirmExecution` could call the identical logic instead of duplicating it. Three behavior
changes landed on that one shared function: (1) `"unknown"` (nothing target-shaped found) now
throws `OutOfScopeError` instead of just attaching a `scopeWarning`, but *only* when the project has
a non-empty `scope` allowlist configured — a project with no scope, or only an `outOfScope`
denylist, still just warns, since "unknown" isn't the violation case there; (2) a project that
can't be loaded (deleted, malformed id, or `getProject` itself throwing) now always attaches a
`scopeWarning` saying so, instead of silently skipping the check with `.catch(() => undefined)` and
leaving zero trace that scope was never actually verified; (3) `confirmExecution` now calls
`checkExecutionScope` again immediately before the tool actually runs — a mission's scope edited
(tightened) in the window between request and confirm previously went unchecked a second time, so a
now-out-of-scope execution could still be confirmed and run.

A smaller fifth fix, `matchesEntry`: a scope entry with a port (`"example.com:8080"`) previously
matched nothing at all, since `extractTargets` never carries a port through from the argv in the
first place (`DOMAIN_RE`/`IPV4_RE` both stop at the colon) — entries are now stripped to host-only
before matching (guarded against colliding with IPv6 addresses, which are colon-heavy themselves).

15 new backend tests (`scopeMatcher.test.ts` +9 covering IPv6 extraction/matching/CIDR and the
port-stripping fix, `toolManager.test.ts` +6 covering the strict-scope-blocks-unknown behavior
change, the undefined/unresolvable-project warning, and a confirm-time re-check race), 364 total,
both `tsc` and `oxlint` clean. Verified live against the real running backend: a strict-scope
project's `bash -c "echo hi"` (no identifiable target) → clean 403 `OUT_OF_SCOPE` (previously ran
unchecked); `curl http://[::1]/` against that same project → 403 with `offending: ["::1"]`
(previously the exact bypass named in the finding); a genuine in-scope `curl https://example.com` →
still runs cleanly; a tool request against a nonexistent `projectId` → 200 with a `scopeWarning`
explaining scope couldn't be checked, instead of the prior silent no-op.

## Fixed: outbound HTTP had no timeout anywhere (2026-08-08 audit, Medium)

`ollama.ts`'s `ollamaFetch` and `cveLookup.ts`'s NVD call both plain `fetch()`ed with no
`AbortSignal` at all - a wedged Ollama process (mid model-load, or just hung) or a dead-but-open
NVD connection blocked the request forever, with no recovery path.

**The two call shapes need genuinely different bounds, and conflating them would have been the
real bug here.** `/api/tags`, `/api/embed`, and the NVD lookup are all "should complete quickly or
something's wrong" calls - a plain `AbortSignal.timeout(ms)` is the right tool, and that's what
`ollamaFetch` now takes as an optional third parameter (`env.ollamaRequestTimeoutMs`/
`env.nvdRequestTimeoutMs`, both configurable, defaulting to 60s and 15s). `/api/chat` is not that
shape at all - CLAUDE.md's own streaming-protocol section, and the frontend's existing
`IDLE_TIMEOUT_MS` watchdog (`hooks/useChat.ts`), already document that a large local model can
legitimately take a long time to load and generate on constrained hardware, and a fixed-duration
cap would kill exactly the slow-but-genuinely-working case this project cares about supporting.
Live testing while implementing this surfaced a concrete number, not just a hypothetical: a real
27B local model's `load_duration` alone was 22 seconds, out of the request's total 32.

**The fix for `streamChat` mirrors the frontend's own solution, just on the backend side of the
same stream.** A dedicated `AbortController` is armed for `env.ollamaChatIdleTimeoutMs` (default 5
minutes - the same number as `IDLE_TIMEOUT_MS`) before the request starts, and re-armed every time
`reader.read()` actually resolves - so the clock only ever measures *silence*, never total
duration. It's combined with the caller's own cancellation `signal` via `AbortSignal.any([signal,
idleController.signal])` so either source stops the stream. The tricky part was distinguishing the
two reasons the combined signal can fire once code reaches a catch block: both a real user
cancellation and an idle timeout surface as the same `AbortError` name from `fetch`/the reader -
resolved by checking `idleController.signal.aborted` first in both catch sites (the initial
`ollamaFetch` call and the read loop), since that flag is `true` if and only if *this* timer, not
the caller's signal, is what fired. Wired through to a new `OllamaTimeoutError` (mapped to a `504`
in `errorHandler.ts`, `OLLAMA_TIMEOUT`) distinct from `OllamaConnectionError`'s "Is it running?"
message, which would have been actively misleading for a timeout (Ollama *is* running, it's just
not answering).

A smaller side effect worth naming: the audit finding also flagged that a hung `lookup_cves`
pseudo-tool (no human confirmation gate, called directly by the agent) could pin an orchestrator
task past `maxOrchestratorTaskTimeMs` forever, since that cap is only evaluated between agent calls
(a known, separate, still-open Low finding). `queryNvd` timing out on its own within
`nvdRequestTimeoutMs` closes that specific instance of the problem without needing to touch the
orchestrator's own timeout-checking logic at all.

12 new backend tests: `ollama.test.ts` +8 (timeout-mapping + "a bounded signal was actually passed"
for both `listModels`/`embed`, plus two `vi.useFakeTimers()` cases for `streamChat` - one proving
the idle timeout actually fires and maps to `OllamaTimeoutError`, one proving a stream that keeps
producing chunks just under the idle deadline is never killed even across multiple near-miss
windows), `cveLookup.test.ts` +2. 372 total, both `tsc` and `oxlint` clean. Verified live against
the real running backend and a real local 27B model: `/api/models` round-trips normally with the
new bounded signal attached (confirmed via the response, not just a passing test), and a real
`/api/chat` call with a 22s model-load completed normally start to finish - proof the idle-timeout
wiring doesn't interfere with the exact slow-but-alive case it's designed not to kill.

## Fixed: streamed tool output was uncapped, no global execution concurrency limit (2026-08-08 audit, Medium)

Two related but genuinely separate bugs under one finding, fixed together since they're both about
one confirmed execution being able to consume unbounded resources.

**The streaming bug was a call-order bug, not a missing check.** `toolExecutor.ts#appendOutput`
already had the right cap logic (`maxOutputBytes`, default 1MB per stream) for the *accumulated*
`stdout`/`stderr` strings that end up on the persisted `ExecutionRecord` - but it called
`onOutput?.(...)` (the live callback that streams NDJSON to the confirming client) *before* that
cap check ran, every single time, regardless of whether the chunk was actually going to be kept.
So a tool emitting far more than 1MB (a huge `ffuf` wordlist, `head -c 1e8 /dev/urandom`) had its
*accumulated* result correctly truncated, while the *live stream* to the client kept growing
without bound the whole time the process ran - the truncation existed, it just wasn't wired to the
path that actually mattered for memory pressure under backpressure. The fix moves the `onOutput`
call to only fire when a chunk is actually accepted, and adds an early return once a stream's
`truncated` flag is already set, so once a stream crosses the cap it stops being processed *at
all* - no more accumulation, no more streaming, matching "further output is dropped" (the doc
comment's own stated intent) literally rather than only for the stored copy.

**The concurrency limiter reused existing state instead of adding a new counter.**
`toolManager.ts` already had `runningControllers`, a `Map<string, AbortController>` populated the
moment `runRecord` calls `runExecutable` and cleared the moment it resolves - which is to say, its
`.size` *is* "how many real OS processes are spawned right now," module-wide, at every instant.
Rather than inventing a parallel counter that could drift, the cap check is just
`runningControllers.size >= env.maxConcurrentExecutions` at the top of `runRecord` - and because
`runRecord` is the one point every caller (manual `POST /tools/request` → confirm, Orchestrator
tasks, Scan Profiles chaining through the same confirm/execute path) funnels through, one check
there covers all of them. No scan-level or task-level limiter was needed on top.

**Deliberately not a queue.** A queued caller waiting for a slot has real design cost (does a
queued execution register a cancel handle? does the human confirming it get any feedback that
it's merely waiting, not actually running? does queue order need to be fair across
projects/agents?) that isn't worth it for what is fundamentally a "the human already decided to
run this - let them just try again shortly" scenario. `runRecord` throws a new
`TooManyConcurrentExecutionsError` (429 `TOO_MANY_CONCURRENT_EXECUTIONS`) *before* mutating
anything - `record.status` never leaves `pending_confirmation`, so a rejected confirm is exactly as
retryable as one that was never attempted, and the human doesn't need to distinguish "still queued"
from "reset, try again."

2 new backend tests: `toolExecutor.test.ts` +1 (writes two chunks, the second pushing past a 5-byte
cap, and asserts the total bytes ever passed to `onOutput` stays under it); `toolManager.test.ts`
+1 (spins up `env.maxConcurrentExecutions` real long-running `setTimeout` child processes via
`confirmExecution`, confirms a request one over the cap is rejected with the record untouched at
`pending_confirmation`, cancels everything, then confirms the same execution again succeeds once
slots are free). 374 total, both `tsc` and `oxlint` clean.

Verified live against the real running backend, not just mocks: fired 6 concurrent `bash -c "sleep
5"` confirms at once - exactly 5 came back `200`, the 6th came back a clean `429` with the
documented error body, and `GET /api/tools/executions` confirmed that 6th record was still sitting
at `pending_confirmation`; confirming it again once the other 5 finished ran it normally. Separately,
a `bash -c` piping 3MB of output through: the live NDJSON stream's `stdout`-chunk bytes summed to
exactly 1,044,480 (just under the 1MB cap) and the final stored `result.stdout` was independently
capped at that identical byte count with `truncated: true` - proof both halves of the fix land on
the same boundary rather than one silently exceeding the other.

## Tool selection hints - teaching an agent which tool fits an objective, without the objective naming one

User-reported: agents were reliable at using a tool once told which one ("run nmap against..."),
but didn't reliably pick the right tool on their own from a bare objective ("find open ports on
..."). The autonomous decide-which-tool-and-call-it loop itself already existed in full (Task 2,
see "Autonomous Agent Execution Loop" above) - `orchestrator.ts#buildToolsPreamble` already lists
every allowed tool as `- id: description` and tells the model to reply with the tool JSON only when
it actually needs one, no tool name required from the user. The gap was in what the model has to
work with when deciding: the ~20 real `ExecTool` descriptions were one-liners ("Network
port/service scanner.") with no "use this when the objective looks like X" cue and no example of
the `arguments` shape - contrast the pseudo-tools (`search_knowledge_base`, `query_findings`,
`lookup_cves`, `create_finding`), which already got a full worked JSON example in their preamble
line and presumably select more reliably as a result.

**The fix**: a new optional `ExecTool.usageHint` field (`types/execTool.ts`), populated for all 20
builtins (`tools/exec/builtins.ts`) with a short "use this when..." clause plus a minimal example of
the *caller-supplied* `arguments` (i.e. the part after `defaultArguments`, which the model never
sees or supplies itself - e.g. nmap's hint shows `arguments: ["-sV", "-p-", "<host>"]`, not the
resolved command). Kept as a field separate from `description` rather than folding the hint into it,
specifically so the Tool Registry UI (`ToolRegistry.tsx`, which truncates `description` to one line)
stays exactly as concise as before - `usageHint` is read in exactly one place,
`buildToolsPreamble`, and appended after the description only when present:
`` `- ${t.id}: ${t.description}${t.usageHint ? ` ${t.usageHint}` : ""}` ``.

**A real side-finding surfaced while writing `write_file`'s hint, not fixed here**: the plain-text
`{"tool", "arguments"}` convention an agent replies with has no `stdin` field at all -
`ToolRequestBody.stdin` can only ever be set by the manual "New Request" form in the UI. So an
agent-driven call to `write_file` (`tee`) always creates/truncates an *empty* file - it can never
actually write content through this path, even though "write the findings to a file" is an entirely
plausible-sounding objective. Documented explicitly in the tool's own `usageHint` (steering the
model toward `bash`'s `echo '...' > path` instead) rather than left for the model to discover by
producing silently-empty files. Left as a known gap, not fixed - giving the orchestrator's tool-
request convention a content-carrying field would be a small but real protocol change, out of scope
for a prompt-content pass.

1 new backend test (`orchestrator.test.ts` - asserting the hint is appended after the description
and that a tool with no hint doesn't leave a stray trailing space), plus the existing preamble tests
still passing unchanged since they only ever asserted `.toContain(...)` substrings. 375 total,
typecheck/oxlint clean.

Verified live against the real running backend with real local models, not just tests - the actual
scenario this was meant to fix: the Recon Agent (whose system prompt *does* still name a few tools
as examples) given "Find out what ports are open on scanme.nmap.org" (no tool named in the
objective) correctly requested `{"tool": "nmap", "arguments": ["-sV", "-p-", "scanme.nmap.org"]}` -
but the cleaner proof is the Web Analyzer agent, whose system prompt names **zero** tools at all,
given "Check what web server and technology stack https://scanme.nmap.org is running" - it
correctly requested `{"tool": "httpx", "arguments": ["-u", "https://scanme.nmap.org"]}`, matching
httpx's `usageHint` example exactly. Both tasks were cancelled before confirming (scanme.nmap.org
permits scanning, but running it wasn't the point of the test) and the throwaway project deleted
afterward.

## Fixed: agent-driven write_file couldn't actually write content

The side-finding from the tool-selection-hints pass above, now fixed for real. The plain-text
`{"tool", "arguments"}` convention every tool speaks (`orchestrator.ts#parseToolRequest`) has no
`stdin` field at all - only `ToolRequestBody.stdin` carries it, and that field can only be set by a
caller passing it explicitly to `requestExecution()`. Checking every reachable caller confirmed this
wasn't even an orchestrator-specific gap: the frontend's `requestToolExecution` (the only client
function that *can* attach `stdin`) turned out to have zero callers anywhere in the frontend either
- there is no "manual new tool request" UI at all, only confirm/reject/cancel on executions
something else already created. So `write_file` (`tee`) was 100% non-functional for writing real
content through *any* path in the running app, not just the agent one - it could only ever
create/truncate an empty file.

**The fix teaches the orchestrator to translate write_file's argument shape, not the wire protocol
itself.** Changing the model-facing convention to include a real `stdin` field would mean either
every tool call ships an always-empty `stdin` key (noise) or the parser has to special-case which
tools get one (fragile). Instead, `write_file`'s own `usageHint` (see the tool-selection-hints
section above) tells the model to reply with exactly two `arguments` elements - `[path, content]` -
and a new `orchestrator.ts#splitWriteFileContent`, called right before the `requestExecution` call
in `advance()`, is what turns that two-element convention into the real shape:
`arguments: [path], stdin: content`. Every other tool is untouched - `splitWriteFileContent` is a
no-op unless `toolRequest.tool === "write_file"`.

**Visibility for the confirming human was the part that needed real thought, not just plumbing.**
`toolManager.ts` already had a deliberate design decision predating this fix: `pendingStdin` is kept
in a separate in-memory map, never written into the persisted/listable `ExecutionRecord`, "so
potentially large/sensitive write_file content doesn't linger in history." That's the right call to
keep - but it also meant the confirming human would now be approving a real file write with *zero*
visibility into what's about to be written, which cuts against this app's whole "human stays the
approval authority" design principle repeated throughout this codebase. Rejected alternative:
re-implementing `write_file` on top of `bash`+a heredoc so content shows up in `resolvedCommand`
directly - discarded because it would reintroduce shell-metacharacter/quoting hazards into the one
tool that's currently immune to them by construction (`tee` reading literal stdin bytes, no shell
parsing involved at all - exactly the "argv-only spawn, never a shell string" principle
`toolExecutor.ts`'s own doc comment states as this framework's whole safety model). The fix actually
shipped: `requestExecution` now appends a byte-count annotation to `resolvedCommand` whenever
`body.stdin` is set - `tee agent-output.txt (stdin: 55 bytes)` - enough for a reviewer to sanity-
check ("that's way more than I expected") without the content itself ever reaching the persisted
history. Generic, not write_file-specific - any future stdin-carrying tool gets this for free.

4 new backend tests: `orchestrator.test.ts` +3 (the two-argument split, the no-content-given
fallback to `stdin: undefined`, and a non-write_file tool proving the split is genuinely a no-op for
everything else), `toolManager.test.ts` +3 in a new "resolvedCommand stdin visibility" describe
block (the byte-count annotation appears and the raw content never does, a real UTF-8-vs-JS-string-
length distinction using a multibyte character, and no annotation at all when `stdin` is omitted).
381 total, typecheck/oxlint clean.

Verified live against the real running backend with a real local model, full round trip: gave the
General Assistant (system prompt names no tools, unrestricted `execTools`) the objective "Save the
text '...' to a file named agent-output.txt in the workspace" - it correctly requested
`{"tool": "write_file", "arguments": ["agent-output.txt", "Hello from the agent, this file was
written end to end."]}`; the pending execution's *persisted* `arguments` were confirmed to be just
`["agent-output.txt"]` (content never touched the record) while its `resolvedCommand` read
`tee agent-output.txt (stdin: 55 bytes)`; confirming it wrote the file to the real workspace with
the exact content, byte for byte - the precise thing that silently didn't work at all before this
fix, through any path in the app.

## Fixed: deleteProject left ghost records in every service's in-memory store (2026-08-08 audit, Medium)

`projectManager.ts#deleteProject` only ever `rm`'d the project's directory - none of the six
project-scoped services' in-memory `Map`s (`toolManager.ts`'s executions, `orchestrator.ts`'s
tasks, `findingsManager.ts`'s findings, `scanRunner.ts`'s scans, `reportManager.ts`'s reports,
`multiAgentOrchestrator.ts`'s plans) ever found out a project was gone, so they kept returning
records for it indefinitely, and any of them writing through afterward would recreate the
just-deleted directory (`writeProjectJson`'s `mkdir(recursive)`).

**Why a callback registry instead of `projectManager.ts` just calling each service directly.** All
six of those services already import `getProject`/etc. from `projectManager.ts` - if
`projectManager.ts` turned around and imported `toolManager.ts` (or any of the others) to call a
"purge this project" function directly, that's a circular import. The fix instead is a small
registry: `onProjectDeleted(handler)`, exported from `projectManager.ts`, called once by each
service at its own module load time with a closure over its own `Map`(s). `deleteProject` calls
every registered handler after removing the directory, each wrapped in its own try/catch so one
store's purge failing can't block the others or make the delete itself look like it failed - the
directory is already gone by that point, which is the part a caller can actually observe/retry on.

**Two of the six needed more than "just delete the Map entry".** `toolManager.ts`'s handler also
aborts a still-*running* execution's real subprocess (via the same `runningControllers` map
`cancelExecution` already uses) before deleting it - a still-running process for a project that no
longer exists shouldn't keep running just because nothing told it to stop.
`orchestrator.ts`'s handler does the same for a still-in-flight task generation, via
`runningTaskControllers` (the same map the "cancelTask doesn't abort in-flight generation" audit fix
introduced). The other four (`findingsManager.ts`/`scanRunner.ts`/`reportManager.ts`/
`multiAgentOrchestrator.ts`) have no "actively running" concept of their own to abort - a finding, a
scan record, a report, or a plan is just data, so their handlers are a one-line Map filter-and-delete.
`multiAgentOrchestrator.ts`'s plans specifically don't need their own abort logic either: a plan's
current-step task is a real entry in `orchestrator.ts`'s own `tasks` map under the same `projectId`,
already aborted by that module's independently-registered handler.

**Testing this couldn't just call the real `deleteProject()`.** `toolManager.test.ts`/
`orchestrator.test.ts` both mock `./projectManager.js` wholesale (they only need `getProject`), so
`onProjectDeleted` became a `vi.fn()` that does nothing by default - calling it doesn't actually
register anything a test could later trigger. The fix: capture every function ever *passed to* that
mock (`mockOnProjectDeleted.mock.calls`) once, right after the module's own imports resolve (before
any test runs), into a plain array a test can iterate to simulate a real delete's purge pass. This
had to be captured at module load, not read lazily inside the test helper -
`orchestrator.test.ts`'s own `beforeEach(() => vi.clearAllMocks())` wipes `mock.calls` before every
test, and these registrations only ever happen once, at import time; reading them lazily inside a
test-scoped helper would just find an empty array by the time any test body ran. (This also
explained why `toolManager.test.ts`, which has no such `beforeEach`, "worked" with the naive lazy
version first - purely accidental, fixed to the same robust pattern in both files for consistency.)

13 new backend tests: `projectManager.test.ts` +3 (the registry mechanism itself - a handler gets
called with the right id, one handler throwing doesn't block the others or the delete, handlers
aren't called when deletion itself fails), `toolManager.test.ts` +4 (a deleted project's executions
vanish from `listExecutions`/`getExecution`, another project's are untouched, a still-running one is
actually aborted and removed rather than just marked cancelled, and the concurrency slot it held is
correctly freed afterward), `orchestrator.test.ts` +3 (the same three shapes for tasks, including the
in-flight-generation-abort case). 391 total, typecheck/oxlint clean.

**Verified live against the real running backend - and this surfaced a genuine residual edge case
worth being honest about, not just a clean pass.** Deleted a project while a real `bash -c "sleep
10"` execution was actively running against it: `ps` confirmed the subprocess was actually killed
within about a second, and `GET /api/tools/executions?projectId=...` immediately returned `[]`
instead of the stale record - the actual bug is fixed. But the in-flight execution's own
`persistExecutions()` call (already past the abort by the time it runs) still fires afterward and
recreates an *empty* orphan directory via `writeProjectJson`'s `mkdir(recursive)`. Confirmed this is
genuinely harmless, not a reopened version of the original bug: `persistExecutions` re-derives what
to write from the (already-purged) in-memory Map, so it persists `[]`, never the stale record's
actual content; `GET /api/projects` correctly omits the orphan (no `project.json`, same filter
`listProjects()` always applied); a restart's hydration reads that same empty array and adds
nothing. A clean delete (nothing in flight) was verified separately to leave no directory at all.
Closing this last sliver would mean adopting the audit finding's *other* suggested fix - gating
every project-scoped write across all six services on the project still existing - a real fs check
added to every write, to prevent an empty, harmless, cosmetic directory. Left as a known, accepted,
low-value edge case rather than pursued; the actual "ghost records persist and can be re-hydrated"
problem is closed.

## Fixed: task transcripts grew unboundedly, embedding full tool output (2026-08-08 audit, Medium)

`orchestrator.ts#resumeTask` is the one place a tool result gets embedded into `task.messages` -
every other `role: "tool"` push in the file is a pseudo-tool result (knowledge-base search,
findings query, CVE lookup, create_finding), each naturally small. `resumeTask` was serializing
`execution.result.stdout`/`stderr` verbatim, and each of those is independently capped at 1MB by
`toolExecutor.ts`'s own `DEFAULT_MAX_OUTPUT_BYTES` - so a single tool call could add up to ~2MB to
a task's transcript. `env.maxOrchestratorToolCalls` (default 10) already bounds how many such
results one task can ever accumulate, so the real fix only needed to bound each one, not invent a
separate message-count cap - the "and/or cap message count" half of the suggested fix turned out to
already exist, just for a different reason (loop prevention, not size).

**Two fields needed genuinely different truncation strategies, not one blanket cut.**
`truncateForTranscript(text, maxBytes = 4000)` handles `stdout`/`stderr` (and a string-shaped
`parsedOutput`) - a straightforward byte cap, but done on a UTF-8 byte boundary via `Buffer`, not a
naive JS string `.slice()` by character count: slicing mid-multi-byte-character with `.slice()`
would silently corrupt the last character instead of just cutting cleanly, so the truncation goes
through `Buffer.from(text, "utf-8").subarray(0, maxBytes)` and lets `Buffer`'s own UTF-8 decoding
replace any partial trailing sequence with `U+FFFD` - a barely-noticeable cosmetic artifact right at
a boundary that already announces itself as truncated a few characters later.
`truncateParsedOutputForTranscript` handles the other common shape separately: an array (the
"lines" parser's output - subfinder/httpx/amass/etc, easily hundreds or thousands of short entries)
is capped by *item count* (200), not serialized bytes, since "a list of short lines" and "a blob of
text" need different caps entirely - a byte cap on a 500-item array would arbitrarily cut mid-item
depending on how long earlier items happened to be, while an item-count cap always keeps whole,
readable entries. Any other JSON-serializable shape (an object, from the "json" `OutputParserKind` -
not used by any current builtin tool, but a real type the framework allows) falls back to a
byte-capped *serialized* string if it's actually over the limit - changing shape from object to
string on truncation is fine here, since this value only ever feeds into an already-`JSON.stringify`'d
`ChatMessage.content` string, never re-parsed as structured data by anything downstream.

5 new backend tests in `orchestrator.test.ts`'s `resumeTask` describe block: a large stdout/stderr
truncated with the exact byte count verified in the truncation note, a normal-sized one left
completely untouched (no "truncated" text at all), a 500-item array capped to exactly 200 items
plus one truncation-note entry, and an oversized object falling back to a truncated string. 395
total, typecheck/oxlint clean.

Verified live against the real running backend with a real local model - not just the mocked unit
tests: asked General Assistant (via a real orchestrator task) to run `bash -c "head -c 20000
/dev/zero | tr '\0' 'a'"`; confirming and resuming showed the real `ExecutionRecord.result.stdout`
correctly holding the full 20,000 bytes (`toolExecutor.ts`'s own cap, completely untouched by this
fix - confirmed `truncated: false` there, since 20KB is well under its own 1MB limit), while both
the task's in-memory transcript (`GET`'s response) and the persisted `orchestrator-tasks.json` file
on disk correctly held only 4,044 bytes (4000 truncated bytes plus the marker text) for that exact
same tool result - proof the two caps are genuinely independent and both active at once, each
serving its own distinct purpose.

## Bug Bounty Factory transformation (Missions, Assets, Work Orders, Factory Director, Validation, Report status, factory UI)

The largest single change to this codebase since the original 11-task build: turning 8Rack from an
agent-centric workstation with a first-pass Mission layer (Task 3/4 above) into "an AI-powered bug
bounty factory" per an explicit external spec. Reverses two of Task 3's own deliberate lower-churn
calls - see that section above - on the user's explicit instruction: `Project` is renamed to
`Mission` throughout (not just field-level), and Assets become a real stored entity (not derived
from Findings on every render). Everything else in this section is genuinely new. Built across six
sequential/parallel passes, each independently typecheck/test-verified before the next began, plus
one direct fix in between for a gap the second pass caught (see below) and a full live/browser
verification pass at the end - not just the unit suites.

### Project → Mission rename

Mechanical but wide: `types/project.ts` → `types/mission.ts` (`Project` → `Mission`),
`services/projectManager.ts` → `missionManager.ts`, `services/projectStore.ts` →
`missionStore.ts` (`projectDir`/`PROJECTS_DIR` → `missionDir`/`MISSIONS_DIR`, the on-disk directory
itself renamed `backend/data/projects` → `backend/data/missions`), `routes/projects.ts` →
`routes/missions.ts` mounted at `/api/missions`, every `projectId` field/param across
`ExecutionRecord`/`OrchestratorTask`/`MultiAgentPlan`/`Finding`/`ScanRun`/`Report` → `missionId`,
and the frontend mirror (`useProjects`→`useMissions`, `projectsApi.ts`→`missionsApi.ts`,
`ProjectPanel.tsx`→`MissionPanel.tsx`). No back-compat shims - this is a local, no-auth, no-external-
consumer app, so a clean rename was safe; only 2 mission directories existed on disk at the time
(one an all-zero test fixture). `MissionStatus` was also expanded from its original 4 values
(`planning/active/paused/completed`) to the spec's 10-stage pipeline
(`draft/ready/recon/investigating/validating/reporting/review/completed/paused/cancelled`), with a
`migrateMissionStatus()` function mapping the 4 legacy values to their nearest equivalent
(`planning`→`draft`, `active`→`recon`) on every read from disk, so no manual data migration step was
needed - this expansion was originally missed by the rename pass and caught by the very next pass
(Asset/WorkOrder build) noticing the Factory Director's planned status-auto-advance had nothing to
advance through; fixed directly (not re-delegated) before continuing.

### Asset Inventory becomes a real entity

New `types/asset.ts`/`services/assetManager.ts`, same Map-in-memory + write-through-`assets.json`-
per-mission + `onMissionDeleted`-purge-handler shape every sibling service already uses. `Asset.type`
is `domain|subdomain|url|ip|port|service|api|technology` per spec; `status` is
`active|inactive|unverified` (active = confirmed by a scanner/agent, unverified = agent-reported
via `upsert_asset` with no scanner backing); a `parentId` field encodes the domain→subdomain→url→
port→service tree. `upsertAsset` dedups by `(missionId, type, value)`, updating `lastSeen`/`status`/
`metadata` on a repeat sighting instead of duplicating. Ingestion is centralized, not per-agent
(mirroring how scope-checking is centralized): `findingsManager.ts`'s existing finding-ingest path
now also calls `upsertAsset` for any finding whose type is `domain/subdomain/port/service/
technology/api`, and a new `upsert_asset` orchestrator pseudo-tool (mirrors `create_finding` exactly)
lets an agent register an asset with no accompanying finding. `AssetsView.tsx` (previously deriving
groupings from `Finding[]` client-side on every render) now fetches real `Asset[]` via a new
`useAssets` hook.

### Security Work Orders + the Factory Director

New `types/workOrder.ts`/`services/workOrderManager.ts`: `WorkOrder` (`id, missionId, agentId,
objective, target, status, priority, dependencies, relatedAssets, relatedFindings,
orchestratorTaskId`), status `pending|queued|running|waiting_approval|completed|failed|cancelled`
(the underlying `OrchestratorTask`'s finer `waiting_guidance` folds into `waiting_approval` - both
mean "needs a human before continuing"). `startWorkOrder` reuses `createOrchestratorTask` exactly
the way `multiAgentOrchestrator.ts#createPlan` already does for its own first step - no second
execution mechanism.

`services/factoryDirector.ts` sits one level above that - reads a mission's scope/assets/findings/
work orders and deterministically (not via an LLM planning call, a deliberate v1 choice for
reliability/testability) seeds and starts work orders: no assets yet → one Recon work order; a new
`domain/subdomain/ip` asset → one Enumeration work order; an unsettled (`potential`/`investigating`)
finding → one Validation work order assigned to `vulnerability-validator`. All idempotent - re-
running `advanceMission` never creates a duplicate for something that already has one. Mission
`status` auto-advances through the pipeline stages as this progresses (no assets → `recon`; assets
but unsettled findings → `investigating`; nothing left to run → `reporting`) but only ever moves
*forward*, and never touches a mission a human has parked at `paused`/`cancelled`/`review`/
`completed`. Request-driven like the rest of this app (no background timers anywhere) -
`POST /api/missions/:id/factory/advance` runs one step and auto-chains through everything that
doesn't need approval, pausing at the same `waiting_approval` point a work order's own task would,
exactly the external contract `multiAgentOrchestrator.ts#resumePlan` already has for its own pause
points. A work order settling `failed`/`cancelled` deliberately stops the auto-chain rather than
immediately trying something else - a human-attention signal, not something to paper over, and (per
live verification below) not something the Director retries on its own once one exists for that
agent - a human has to create a fresh one.

### Finding Validation pipeline

`Finding` gained `validatedBy?: string`. New `validate_finding` orchestrator pseudo-tool (mirrors
`create_finding`/`upsert_asset` exactly) - `{findingId, verdict: confirmed|false_positive|duplicate,
severity?, notes}` - transitions the finding's status, sets `validatedBy`, and appends an
`agent_reasoning` `EvidenceItem` with the justification. `EvidenceItem` (on `Finding`) gained its
own `id` plus optional `agentId`/`executionId` refs while this was being touched, giving the full
Finding→Evidence→ToolExecution→Agent→Mission trace the spec wants without a redundant new top-level
CRUD surface for something never listed independently of its finding (a deliberate scope choice,
made explicit before implementation started). `backend/data/agents/vulnerability-validator.json`'s
`systemPrompt` was rewritten to spell out the spec's checklist (reproducible? in scope? evidence
sufficient? impact realistic? likely duplicate? right severity?) explicitly - data-driven, no
hardcoded TS logic. See "Live verification" below for a real run where a 27B local model correctly
rejected an evidence-free finding as a false positive using exactly this checklist.

### Report status machine

`Report` gained `status: draft|ai_generated|human_review|ready|submitted`, defaulting to
`ai_generated` on creation (a report is always born from a synchronous LLM call in this app - there's
no not-yet-generated placeholder state to call `draft`; `draft` exists for a human to mark a
generated report as needing rework). `PATCH /api/missions/:id/reports/:reportId` transitions it - no
enforced transition graph (any status → any other via PATCH), matching `Finding.status`'s existing
lack of transition constraints as the precedent for how much rigor this needed.

### Mission Activity Timeline becomes an explicit event log

`ActivityFeed.tsx` previously derived its content by merging tool executions + orchestrator task
transcripts - real data, but reactive/inferred, not a first-class record. New `types/missionEvent.ts`/
`services/activityLog.ts` (same Map+JSON+purge-handler shape) with `logActivity(missionId, type,
summary, meta?)` called at the exact point each real action already happens: mission created/status
changed, asset discovered, work order created/started/completed/failed, finding created/status
changed/validated, report generated/status changed, and - closing a real gap an earlier gap-analysis
pass had flagged - `scope_blocked` at the exact point `toolManager.ts#checkExecutionScope` rejects an
execution, so a blocked action now reliably reaches the audit trail instead of only living in a
403 response nobody's watching. One real circular-import constraint shaped this: `activityLog.ts`
must import `onMissionDeleted` from `missionManager.ts` for its own purge handler, so
`missionManager.ts` can't import `activityLog.ts` back - mission-level logging (`mission_created`,
human-driven `mission_status_changed`) happens at the route layer instead, and the Factory Director's
own *auto*-advance status changes (which call `missionManager.updateMission` directly, bypassing the
route) get a second, separate `logActivity` call inside `factoryDirector.ts` itself to cover that
path - caught during this pass's own test-writing, not left as a silent gap.

### Mission-centric UI

`layout/types.ts`'s `AppView` expanded from `chat|workbench|plans|findings` to add the spec's
primary nav - `factory|missions|assets|workorders|evidence|reports|agents|tools` (`Settings` stays
the existing gear-icon `Sheet` modal rather than becoming a tab, since that would regress its
"reachable from any view" behavior; `Settings` was never a tab-shaped concept here). Default
`activeView` changed from `"chat"` to `"factory"` - the app no longer opens on an agent picker.
`chat`/`workbench`/`plans` are kept reachable as a visually secondary sidebar group below a divider,
per the original spec's own "extend, don't replace the existing working architecture" instruction -
not deleted, just no longer primary.

New: `FactoryDashboard.tsx` (mission stat tiles - assets/work orders/running agents/potential+
confirmed+critical findings/pending approvals - plus a "Start/Advance Factory" action that streams
the Director's NDJSON response), `FactoryPipeline.tsx` (the spec's 10-stage visual pipeline, embedded
in the Dashboard rather than a separate nav item - it's a visualization, not its own data domain),
`ApprovalQueue.tsx` (aggregates pending-confirmation executions for a mission into one queue, also
embedded in the Dashboard), `WorkOrdersView.tsx`, `EvidenceView.tsx` (a client-side flatten of every
finding's evidence for a mission - no new backend endpoint, per the Evidence design choice above),
`MissionsView.tsx` (a real mission-management hub, plus home for the full Activity Timeline - a
compact recent-activity strip also lives on the Dashboard), `AgentsView.tsx`/`ToolsView.tsx`
(promoting `AgentList`/`ToolRegistry`+`ExecutionConsole` to real top-level nav instead of sidebar-
only/Workbench-embedded), and `AgentToolAccess.tsx` (a compact ✓ allowed / ✕ restricted tool list
per agent, reused in both `AgentEditor` and `AgentsView` - closes a previously-flagged gap where no
UI showed an agent's actual tool permissions at all). `AssetsView.tsx` was repointed from its
`findings: Finding[]` prop to the new `useAssets` hook. Every mission-scoped view keeps its own
`MissionPanel` mission selector rather than a new global-selected-mission concept in `App.tsx` -
following this codebase's existing, explicit precedent (see the "Projects" section of `CLAUDE.md`)
rather than introducing a new one partway through.

### Live verification (not just the unit suites)

Backend `npm test` 458/458, frontend `npm test` 303/303, both typechecks clean, `oxlint` at the
documented pre-existing baseline (3 warnings, `OrchestratorTaskView.tsx`) - all before the live pass
below even started. Then, against the real running backend + a real local Ollama model
(`qwen3.8:27b` - the recon/web-analyzer/vulnerability-validator/report-writer agents' shipped default
`qwen2.5-coder:7b` wasn't pulled on the verification machine, so those four agents' `model` field was
temporarily pointed at the available model for this pass only, then reverted):

- Created a mission with real scope/outOfScope/rules via `POST /api/missions`.
- Confirmed the out-of-scope failure path end-to-end: `POST /api/tools/request` targeting a host
  outside scope → clean `403 OUT_OF_SCOPE`, and a real `scope_blocked` event landed in
  `GET /api/missions/:id/activity` - closing the exact gap the "explicit event log" work above was
  built to fix.
- `POST /api/missions/:id/factory/advance` seeded and ran a real Recon work order end-to-end - the
  `recon-agent` genuinely called the `upsert_asset` pseudo-tool, a real `example.com` domain asset
  landed in `assetManager`, and the mission's `status` auto-advanced `(none) → recon`.
- A second `advance` call correctly noticed the new asset and seeded/ran a real Enumeration work
  order for `web-analyzer` (status auto-advanced `recon → investigating`); confirmed the Director
  does *not* retry a work order that already exists for an agent once one has settled (by design,
  see above) - a fresh manually-created work order was used to continue the live test past that
  point, which is the intended human-in-the-loop recovery path for a failed step.
- A `web-analyzer` work order called `create_finding` for real, producing a genuine `potential`
  finding; the Director's next `advance` call correctly auto-seeded a Validation work order
  targeting `vulnerability-validator` for exactly that finding.
- The Validator agent, running the real checklist-driven system prompt from the section above,
  correctly identified the finding had an empty `evidence` array and reasoned through all six
  checklist points before calling `validate_finding` with verdict `false_positive` - the finding's
  `status`/`severity`/`validatedBy` all transitioned for real, and its `evidence` array gained a real
  `agent_reasoning` entry with the model's own justification. (First attempt at this step showed a
  known, pre-existing characteristic of this app's plain-text tool convention, not a new bug: the 27B
  model reasoned in prose *before* emitting the tool-call JSON and got cut off by `maxTokens`, so
  `parseToolRequest` correctly treated the whole reply as a plain-text final answer rather than a
  tool call, and no state changed - re-run with a more directive one-shot objective produced a clean
  tool call. Same "local models don't always follow the ONLY-JSON convention" gap already documented
  in the original "Tool-calling round trip" section above, encountered again here, not introduced by
  this work.)
- Confirmed `GET /api/missions/:id/activity` correctly recorded every one of the above as its own
  named, correctly-typed event (`mission_created`, `scope_blocked`, `asset_discovered`, four
  `work_order_*` events per work order, `finding_created`, `finding_validated`,
  `mission_status_changed` twice) in the right order - the full audit trail the spec asked for,
  proven against real data, not just the unit tests' fixtures.
- Report generation (`POST /api/missions/:id/reports`, streamed) completed live: a real two-section
  Markdown report ("Executive Summary" + "Finding: Reflected XSS in Search") was generated by
  `report-writer` from the one validated finding, `status` correctly defaulted to `ai_generated` on
  creation, and `PATCH /api/missions/:id/reports/:id` correctly transitioned it to `human_review`.
  Took several minutes end-to-end on the verification machine's hardware for a 27B model at
  `maxTokens: 2048` - slow, not broken.
- Browser-verified every new nav view against the real backend (not screenshots of mocked data):
  Factory Dashboard (correct stat tiles, pipeline stage coloring, live recent-activity feed), Work
  Orders (correctly grouped by status with real objectives/agents/targets), Assets (real grouped
  `Asset[]` data, not findings-derived), Findings (reduced to Table/Timeline/Graph after Assets/
  Activity/Reports were extracted to their own nav items, the validated finding showing its real
  `false_positive`/`info` state), and Evidence (the real `agent_reasoning` evidence item with correct
  finding/agent attribution).
- One pre-existing, unrelated doc/behavior mismatch surfaced during live verification, not introduced
  by this work: `CLAUDE.md`'s "Agents" section says agent configs are "Loaded fresh from disk on
  every GET /api/agents call - not cached at boot" - `agentManager.ts` actually caches the agent list
  after first load and only refreshes it via `reloadAgents()` (called by create/update/delete, or the
  existing `POST /api/agents/reload` endpoint) - editing a `.json` file under `backend/data/agents/`
  directly does *not* take effect until that reload endpoint is hit. Worth a one-line `CLAUDE.md`
  correction next time that section is touched; not fixed here as out of scope for this transformation.

## Nav simplification: cut Chat/Workbench/Plans and a standalone Evidence view

A direct follow-up to the Bug Bounty Factory transformation above, on explicit user feedback that
the resulting app ("way too complicated, a mess") had accumulated more surface area than it needed
- three pre-Factory features (plain manual Chat, the freestanding Workbench task UI, user-authored
multi-agent Plans) plus a standalone Evidence nav page were each redundant with something the
Factory model now does natively, not load-bearing in their own right:

- **Workbench** (`OrchestratorWorkbench.tsx`) let you give an agent an objective + tools outside
  any mission. A Work Order is exactly this, just mission-scoped and tracked - keeping both meant
  two places to watch an agent run tools at two different abstraction levels.
- **Plans** (`MultiAgentPlanner.tsx`) let a human author a fixed `{agent, objective}[]` chain by
  hand. `factoryDirector.ts`'s automatic Work Order dependency seeding now does this without the
  manual authoring step.
- **Chat** (`components/chat/*`) was a parallel, disconnected way to talk to a model outside the
  mission model entirely - its own session concept, no scope enforcement, no findings. It never
  served the bug-bounty-factory purpose; it predates that purpose existing.
- **Evidence** as its own top-level nav view was always just `Finding.evidence` flattened client-
  side (see the transformation section's Design call #2) - a whole page for a reshape of data
  Findings already owns was more surface than the feature earned. Folded back into `FindingsView.tsx`
  as a fourth tab (Table/Timeline/Graph/Evidence), reusing the exact same rows/filter logic
  `EvidenceView.tsx` had.

**What was actually deleted** (not just hidden): `components/chat/` (`ChatView`, `ChatSessionPanel`,
`ChatTaskPanel`, `AgentNetwork`), `components/workbench/TaskSessionPanel.tsx`,
`OrchestratorWorkbench.tsx`, `MultiAgentPlanner.tsx`, `OrchestratorTaskView.tsx`, `EvidenceView.tsx`,
`layout/RightPanel.tsx`, `layout/SessionTabs.tsx`, `ModelSelector.tsx`, and the hooks/services that
existed only to support them - `useChat.ts`, `useOrchestratorTask.ts`, `useMultiAgentPlan.ts`,
`useSessions.ts`, `services/plansApi.ts`. `services/orchestratorApi.ts` was trimmed from seven
exports down to just `fetchTask` (all WorkOrdersView's read-only "Inspect" needs - task creation/
resume/cancel/guidance now only happen server-side, via `workOrderManager.ts`/`factoryDirector.ts`
calling `orchestrator.ts` directly, never through the frontend). `ExecutionConsole.tsx`'s `liveOutput`
prop (only ever fed by a live Workbench session) was removed - `ExecutionHistoryPanel.tsx`, its one
remaining caller, only ever showed historical `result`, never live streaming.

**One real feature would have been silently orphaned and wasn't**: Security Scanners (`ScannerPanel.tsx`
- the deterministic Quick Recon/Subdomain Discovery/Web App Scan/Full Port Scan chains) was only
reachable from inside Workbench. Relocated into `ToolsView.tsx` (a third section below Tool
Registry/Execution History, all genuinely tool-related) rather than deleted along with its old host.

**Backend untouched.** `orchestrator.ts`/`multiAgentOrchestrator.ts` and every `/api/orchestrator/*`/
`/api/plans/*` route stay exactly as they were - `orchestrator.ts` is still what every Work Order
runs on underneath (`workOrderManager.ts#startWorkOrder`), and `multiAgentOrchestrator.ts` remains
the pattern `factoryDirector.ts` itself follows. Only the frontend surfaces that let a human drive
those mechanisms *directly, outside a mission* were cut - the mechanisms and their HTTP routes are
still real and still load-bearing under Work Orders.

**Sidebar simplified alongside this**: the "Manual" secondary nav group is gone (nav is one flat
list of 8: Factory/Missions/Assets/Work Orders/Findings/Reports/Agents/Tools), the sidebar's
`ModelSelector` ("model for the next manual chat") is gone since nothing needs it any more, and
clicking an agent (sidebar row or Cmd/Ctrl+K palette) now opens its editor directly instead of
opening a chat session - `AgentList.tsx`'s separate pencil-icon edit button was removed too since it
became a second control for the identical action.

**Verified**: backend untouched, still 461/461 (sanity-checked, not expected to change). Frontend
`npx tsc -b` clean, `oxlint` now fully clean (the 3 pre-existing `only-export-components` warnings
were in the just-deleted `OrchestratorTaskView.tsx`), `npm test` 207/207 (was 303 - the drop is
exactly the deleted test files, not a coverage loss on anything still real). Browser-verified live:
the simplified 8-item nav, Findings' new Evidence tab rendering real evidence, and Tools' Security
Scan section still fully functional at the bottom of the page.

## Audit and fix pass (2026-11-05)

A whole-project audit, with each fix pinned by a regression test. Behavior changes worth knowing first:

- **Approving a tool now continues the factory.** `advanceMission` resumes `waiting_approval` orders
  whose execution has settled (`workOrderManager.ts#resumeWorkOrderIfReady`), and the dashboard calls
  advance after every approve/reject. Before this nothing ever resumed a paused order, so a mission
  stalled at its first approval. Further tool runs still stop at the Approval Queue.
- **The task time cap counts agent time only** (`OrchestratorTask.activeMs`). It used to be wall-clock,
  so a task that sat overnight waiting for a human failed the moment it was approved.
- **Cancelling something already finished is now an error** for tasks, work orders, and plans, instead
  of overwriting a real outcome with `cancelled`.
- **Agents can't validate their own findings** (`validate_finding` refuses when the finding's source
  agent is the caller).
- **POSTs from foreign origins get a 403** (`middleware/originCheck.ts`), and writes to a missing
  mission get a 404 (`middleware/requireMission.ts`) instead of creating an orphan directory.
- **The Approval Queue says "No scope warning", not "In scope"** - it also showed for missions with no
  scope at all and for local filesystem tools, where "in scope" was simply untrue.
- **Agent output can't load remote images** (`Markdown.tsx` renders them as links) - viewing a report
  must not send a request to a host a prompt-injected agent chose.

Fixed, by area:

- **Process execution:** a child exiting before reading stdin crashed the whole backend (EPIPE);
  multibyte output split across chunks was corrupted; SIGTERM-ignoring tools now get SIGKILL after 3s;
  shutdown stops running tools, which otherwise outlive the backend in their own process groups.
- **Confirmation:** a double confirm ran the tool twice; a reject during confirm's await still ran it;
  a 429 retry lost stdin and truncated the target file; filesystem tools were scope-checked as if their
  paths were hosts; the privileged-verb regex matched hostnames like `su.example.com`.
- **Persistence:** mission files are written atomically (temp + rename) with coalesced queued writes;
  stray non-UUID directories are ignored; startup settles whatever a dead process left `running` -
  executions, tasks, work orders, plans, and scans.
- **Director:** follow-up seeding could loop forever (capped at `MAX_WORK_ORDERS_PER_ADVANCE`); paused,
  cancelled, review, and completed missions now return a `blockedReason` instead of running.
- **Work orders:** a double start ran twice; a cancel couldn't reach a task in its first generation; a
  client disconnect now resets to `pending`.
- **Orchestrator:** tool-call parsing takes the first balanced valid object and coerces arguments;
  empty replies, null JSON arguments, and unexpected errors settle the task instead of crashing it.
- **Reports:** evidence reached the model as `[object Object]`, so reports were written without any;
  findings from another mission are refused; an empty reply is an error, not a saved report.
- **Ollama:** mid-stream `{"error"}` lines were ignored, so a crashed model read as a short answer.
- **Scope:** a mission's own TLDs (`.gg`, `.internal`) weren't recognized, so an out-of-scope
  `admin.acme.gg` only drew a warning; trailing-dot hosts bypassed `outOfScope`; `std::cout` read as IPv6.
- **HTTP:** bodyless POSTs and malformed or oversized JSON returned 500; a failed bind logged
  "listening"; blank numeric env values became 0, which set the concurrency cap to "nothing can run".
- **RAG:** a failed reindex replaced the live index before failing, and the budget wasn't checked during
  file reads.
- **Findings:** confidence is clamped to 0-1 and history capped at 50 entries; dedupe lookups no longer
  sort the whole mission per item.
- **Frontend:** work orders could never be cancelled from the UI, locking their mission panel forever;
  stale responses in `useWorkOrders`/`useAssets`; mission switching during an advance; a silent report
  failure on the dashboard; several unhandled rejections now show errors; start dates saved a day early
  west of Greenwich.

Verified: backend 559 tests, frontend 218 tests, both typechecks, oxlint, and both builds. Live against a built backend: 400/413/403/404 responses, concurrent confirm refused, scope
verdicts on an unlisted TLD, paused-mission `blockedReason`, EADDRINUSE exit, and SIGTERM killing a
running tool.

Then two real runs on `qwen2.5-coder:7b` against a throwaway site on `127.0.0.1:8765`. The first, with
human notes, went recon -> validation -> `reporting` and produced a report containing real nmap evidence.
The second, with no notes, reached `investigating` and then paused on an `ffuf` wordlist. Approve, reject
and guidance all resumed correctly. Those runs found four more bugs, all fixed:

- Advance returned no reason for an order waiting on a human note: empty queue, nothing to click.
  `workOrderNeedsGuidance` now drives a `blockedReason`.
- Nmap's usage hint recommended `-sV -p-` with a 120s timeout, so the suggested first scan timed out. The
  hint now says `--top-ports 1000`, and the timeout is 15 minutes for the Full Port Scan profile.
- Agents were offered tools that aren't installed, picked one, and paused. The preamble now lists only
  available tools.
- Local models repeat a successful recording call until the 10-call cap, which failed finished work
  orders. An exact repeat of a successful `create_finding`/`upsert_asset`/`validate_finding` now
  completes the task. Real tools are unaffected.

Architecture notes from the audit: the service-per-concern layout, the `missionStore` chokepoint, and
the confirmation gate all held up. The recurring weakness was state machines with no owner - each
service settles its own statuses, which is where nearly every race and stuck-`running` bug lived, and
why startup repair had to be added five separate times. A shared transition helper would be the
next structural improvement, alongside the route-level tests still missing (POLISH.md D1).

## UI cleanup (2026-11-05)

A usability audit of the running app, then a removal pass. The app had grown a feature per request,
so the same job was often offered several ways. Every removal below was checked against what the
backend and other views actually depend on. No mission data is affected.

### The big reversal: one current mission

Every view had its own `MissionPanel` and its own selection, so you re-picked the mission on all seven
pages. The earlier "deliberate, repeated pattern" note argued against a global selector, but it was
written before anyone counted the clicks, and nothing depended on views differing from each other.
`App.tsx` now owns the selection (`useSelectedMission`, derived against the live list so a deleted
mission falls through to the next one) and passes `mission` down. `MissionSwitcher` in the sidebar is
the only picker. It locks only while the Factory is advancing; the old lock during a running or
approval-waiting work order is gone, because a work order runs server-side and survives a switch.

`MissionEditor` now also creates (scope can be set up front, since nothing runs without it - sent as
one POST so a failure can't leave a half-made mission) and deletes (two-step).

### Removed

| What | Why |
| --- | --- |
| Missions page, `MissionPanel` | Picker duplicate; its timeline moved to Factory's Activity ("Show all") |
| Sidebar agent list (`AgentList`) | Duplicate of the Agents page; its config-warning detail moved there |
| Search box, Cmd+K `CommandPalette` | Looked like search, only navigated between seven visible links |
| Findings Graph (`FindingsGraphView`, `graphLayout`, d3 deps, `GET .../findings/graph`, `buildFindingsGraph`) | Target-string heuristic that added nothing to the table, for four dependencies and a backend path |
| Findings Timeline and Evidence tabs | Same data as the table; evidence is in the finding drawer |
| 5 of 8 finding filters, plus 3 evidence filters | Tool/target/tag/agent/confidence overlap with search. Status filter added, which was missing |
| Execution bookmarks (`useBookmarks`) | Browser-local only, and search covers it |
| Tool "last run"/"never run" pill | Mostly "never run" noise; History answers this |
| Mission start date field | Stored, never read |
| Work order priority and related counts | The Director doesn't let anyone act on them |
| 7 stat tiles down to 4, the 8-segment bar, the 10-stage pipeline | Three displays of one status. The 10 stages claimed more than the 6 statuses the Director tracks, and repeated "work order failed" on two of them |
| Duplicate page headings, manual refresh buttons, `AppShell.rightPanel`, dead `TopBar` props, logo home button | Clutter |

The agent reload button stays: it's the only way to pick up a direct edit to `data/agents/*.json`.

### Fixed

- **Stale pages.** Views stay mounted across nav switches and only fetched once, so Work Orders could
  show "waiting approval" after you approved on Factory. `useRefreshOnActivate` re-fetches when a view
  is shown again, which is what made the refresh buttons removable.
- **Failed work orders were invisible** once the activity feed scrolled past them. Factory now has a
  banner linking to Work Orders.
- **Findings said "no findings match the current filters"** on a mission with no findings at all.
- **Phone layout.** The 280px sidebar left 95px of a 375px screen. It now stacks above the content,
  with the nav scrolling sideways.
- **Tools page.** Scans were hidden at the bottom of a long page; the page is now four tabs, kept
  mounted so a scan keeps streaming while another is open.
- **Notes vs Description** read as the same field. The form now says that agents get Description and
  never Notes (checked: nothing in the backend reads `mission.notes` into a prompt).

### Verified

Backend and frontend typecheck, lint, tests, and builds. In the browser, at desktop and 375px: every
page and Tools tab, create with scope, selection surviving a reload, switching carrying across pages,
two-step delete falling through to the next mission, all API calls 200. Advance, approval, and report
generation were not re-run live here (the handlers were kept as they were, with unit tests); neither
was a mission with real findings, so the filter bar and report bar were only exercised by tests.

## End-to-end mission run (2026-11-05)

First live run of a whole mission since the UI cleanup, using throwaway missions against a local
`http.server` on `127.0.0.2:8080` (bound there so `nmap` couldn't reach anything else on the machine),
on `qwen2.5-coder:7b`. Each failure below was found by a real run and fixed before the next one.

- **Replies with several tool calls.** The parser ran the first call and silently dropped the rest. The
  model then wrote a `<tool_response>` for the dropped call, which was parsed as a new request, failed,
  and restarted the cycle until the cap. Now `parseToolRequests` returns every call and the rest wait in
  `OrchestratorTask.queuedToolCalls`, each written out as its own assistant turn, each real tool behind
  its own approval. A rejection, failure or human note drops the queue, because that changes what the
  agent should do. Result-shaped JSON is never a request, and a reply that only claims a result gets a
  correction instead of becoming the final answer.
- **Recording loops.** `repeatOfRecordedCalls` now covers a whole re-sent batch, not just the previous
  call. A third identical failed recording call completes the task (`stuckRecordingFailure`): the real
  work is already done, and failing the order would block the chain. Raising the cap alone did not fix
  this - a run hit 20 just as it had hit 10. The cap default still went to 20, since the guard needs room
  to fire and a real recon run spends about 10 calls.
- **Enumeration never ran for most missions.** The Director only enumerates `ip`/`domain`/`subdomain`
  assets, and recon reports ports and services. Once recon has found anything, `withScopeHosts` adds each
  concrete in-scope host. Wildcards and CIDRs are ranges, so they're skipped. The Web Analyzer's objective
  now lists known ports and services, because without them it guessed (`ls -la`).
- **Smaller fixes.** ffuf's terminal escapes ended up in finding values (`[2Kbackup`), now stripped in
  `parseExecutionOutput`. `ffuf` has a shipped wordlist. Port spellings merge in `upsertAsset`, keeping
  different hosts and protocols apart. A numeric asset `value` is accepted. A paused order now shows the
  actual error rather than pointing at a transcript the UI no longer has.

Verified live: mission creation, Advance, approve and reject, the queue resuming after each, Web Analyzer
and validators running, `ffuf` findings, guidance note, Findings filter and drawer, report bar, report
generation, Reports view, Retry on a cancelled order. Not exercised: Retry on a failed order (same code
path), Export, moving a report between statuses, phone width. The approval gate held throughout: the only
confirm calls came from the Approve button.

Still wrong, and tracked in TODO.md: the plumbing works but the output can't be trusted yet. Reports
contain made-up evidence and validators confirm too easily. In a hidden Browser pane, screenshots and
animations lag badly - read the DOM before concluding the UI is stale.

## Report evidence from recorded runs (2026-11-06)

The end-to-end run's worst finding: asked for evidence, the Report Writer wrote `nmap` output and HTTP
responses that never happened (Nmap 7.92, when the real run was 7.993). Asking it nicely can't fix that
on a small local model, so the model no longer writes those sections at all.

- **The model** writes the executive summary and each finding's impact and remediation.
  `sanitizeNarrative` removes code blocks and any reproduction/evidence/PoC section it adds anyway, and
  demotes its `#`/`##` headings so they can't open a new report section. Sanitizing is enforcement, not
  a safety net for a good prompt - the prompt says the same thing and small models ignore it.
- **8Rack** (`services/reportEvidence.ts`) writes evidence and reproduction from `ExecutionRecord`s in
  the same mission, and `reportManager.ts` assembles the final Markdown.
- **What counts as recorded:** evidence linked to an execution that really exists, or text found in a
  run's stdout/stderr after stripping terminal codes and collapsing whitespace. Agent `create_finding`
  evidence has no execution link, so the text check is what can verify it. Quotes under 12 characters
  never match, since "200 OK" appears everywhere.
- **Everything else** goes under "Unverified statements", and an "Evidence Check" section counts the
  findings with no recorded output. A finding's `reproductionSteps` are shown labelled as unchecked.
- **Target-controlled text:** tool output is fenced with a backtick run longer than any inside it, and
  titles are forced to one line, so neither can forge a report section.
- Findings are numbered in the headings (`## Finding 3: ...`) because the model refers to them that way.

Verified live on a throwaway mission against a local site on `127.0.0.2`: real `nmap -sV` output, one
scanner finding, one agent-style finding quoting that output (counted as recorded) and one with a made-up
response (labelled unverified, counted in Evidence Check). The report rendered correctly in the app.
`curl` was not used because it's disabled in the Tool Registry.

Known limits:

- The prose isn't checked. In the live run the model described "the exposure of backup files" for the
  made-up finding, right above the label saying nothing backs it. See TODO.md.
- A text match proves the output is real, not that it means what the finding says.
- While a report generates, the view streams the model's raw reply, including anything sanitizing later
  removes. It's replaced by the assembled report when generation finishes, and only that is stored.
- Reports generated before this change keep their old Markdown - regenerate them.

## Planned: MCP servers as the tool and RAG providers (design, 2026-11-08)

Not built yet - this is the agreed direction and the reasoning behind it. The steps are in TODO.md under
the same heading.

**Goal.** The model stays on this machine (Ollama, through `ollama.ts`, unchanged). Recon tools and the
knowledge base move behind MCP servers, and 8Rack becomes their MCP client. MCP sits between the
Orchestrator and tool execution, not between 8Rack and Ollama.

**Why.** Today every ExecTool is an OS process on the same machine as 8Rack, confined only by
argument checks against `WORKSPACE_ROOT` - and `curl`'s own description admits a flag can embed an output
path that passes that check. A tool server in its own container or VM is a much stronger boundary than a
path check, and it doesn't have to be this machine: a dedicated scanning host fits a bug bounty tool. It
also gives a real plugin boundary (tools in any language, existing MCP servers) where today there's only
the unbuilt `extensions/toolRegistry.ts` / `types/tool.ts`.

### What stays in 8Rack

MCP's model is "the model asks, the server runs it". 8Rack's is "the model asks, a human approves, then
it runs". So every decision stays in the backend, and servers only execute:

- **The approval gate.** `requestExecution` (`toolManager.ts`) creates a `pending_confirmation` record and
  the Orchestrator pauses at `waiting_confirmation` until a human confirms. That flow wraps the MCP call:
  model asks, record created, human approves, *then* the client calls the server. MCP has no "ask a human
  first" of its own to rely on.
- **Scope.** `checkExecutionScope` runs at request time and again at confirm time. It reads the
  arguments, so it works the same whoever executes them.
- **Enabled/disabled tools** (the Tool Registry overrides) apply to MCP tools too.
- **Findings, assets, history and activity.** `ingestExecution` and the per-mission execution log wrap a
  run, so they wrap an MCP result the same way. The parsers need raw output, so the tool server must
  return stdout, stderr and exit code, not a summary.
- **All six pseudo-tools.** `create_finding`, `upsert_asset`, `validate_finding`, `query_findings` and
  `lookup_cves` read or write 8Rack's own records, so they stay in-process. `search_knowledge_base` is the
  exception: it becomes a call to the RAG server.

### What changes

- **New `services/mcpClient.ts`:** connects the servers listed in config, discovers their tools, and
  merges them into the catalog the Orchestrator's preamble is built from. Uses the official TypeScript
  MCP SDK (a new dependency).
- **Orchestrator:** keeps the current plain-text `{"tool": ..., "arguments": [...]}` convention at first.
  Only what happens after parsing changes - dispatch to the MCP client instead of `toolExecutor.ts`.
  Switching to Ollama's native tool-calling is a separate, later decision; it trades a parser 8Rack
  controls for the model's own tool-call reliability.
- **Argument checks split.** `validateArguments` checks paths against *this* machine's workspace. On a
  remote server those paths mean nothing here, so path containment moves to the server, which owns its own
  filesystem. Checks that don't depend on a filesystem (types, allowed flags, scope) stay here.
- **"Is this tool installed"** (`resolveToolExecutable`) becomes "does a connected server offer it".
- **Live output.** The confirm route streams stdout chunks today. MCP's progress notifications aren't a
  stdout stream, so live output in the Execution Console may be coarser over MCP until a server sends
  output as progress messages.
- **Cancellation** maps to MCP's cancel notification; the server is then responsible for killing the
  process group, as `toolExecutor.ts` does now.

### Trust

- **Server output is untrusted** - it already is (tool output is target-controlled). So are a server's
  tool names and descriptions, which the model reads in the preamble. Only connect servers named in
  config, and show newly discovered tools in the Tool Registry disabled until a human turns them on.
- **Remote transport needs auth.** stdio has none to configure; streamable HTTP to another host must be
  authenticated, or anyone who can reach that port can run scans.

### RAG specifics

`ragIndex.ts` indexes `WORKSPACE_ROOT` and embeds through Ollama. A RAG server elsewhere needs the files
to be there too, and needs its own way to embed - either its own embedding model or a call back to this
machine's Ollama. Reindex and status (`/api/rag/*`, the Knowledge Base panel) become calls to that server.

### Decided: HTTP to a separate scanning host (2026-11-08)

The tool server runs on its own host and 8Rack reaches it over streamable HTTP. What that commits to:

- **Auth and TLS are required.** The server runs whatever an approved request names, so anyone who can
  reach it unauthenticated can run scans. HTTPS, plus a bearer token checked on every request; the server
  listens only on the interface 8Rack reaches it through. Server URL and token are new `.env` settings,
  never in the repo or the UI. 8Rack's own `HOST`/`hostCheck` rules are unaffected - 8Rack is the client
  here, making outbound calls.
- **The approval gate is only as strong as the token.** The server can't tell an approved request from an
  unapproved one; it trusts 8Rack to only call after a human confirms. Anyone else holding the token
  bypasses approval entirely. Treat the token like a credential for the scanning host.
- **Scans come from a different IP.** Targets see the scanning host's address, not this machine's. Some
  programs require registered source IPs, so the mission should record which address it scans from, and
  the approval prompt should show it.
- **The connection can drop.** An unreachable server shows as offline and requests fail fast with a clear
  error. A run in progress when the connection drops is marked failed rather than left running, and the
  server kills its process group when the client goes away, as `toolExecutor.ts` does on cancel today.
- **Tool output crosses the network.** It's target data, possibly sensitive, so HTTPS matters for it as
  much as for the token.

### Decided: Python for the MCP servers (2026-11-08)

Both servers - RAG and tools - are written in Python, with the official Python MCP SDK. The client stays
TypeScript in the backend; MCP doesn't care which language either side uses.

- **Why Python.** Security tooling and custom recon tools are mostly Python, and so is the embedding and
  vector-search ecosystem. Neither server does heavy work itself (nmap or the embedding model does), so
  Rust's speed wouldn't show. Rust's main draw was a single binary to deploy on the scanning host; not
  worth a smaller MCP ecosystem and slower changes. TypeScript would have reused the most existing code,
  and that's the cost of this choice: step 3 becomes a reimplementation rather than a move.
- **Layout.** In this repo, under `mcp-servers/` - `mcp-servers/rag/` and `mcp-servers/tools/`, each its
  own Python project with its own tests, deployed from there. The repo goes from two workspaces to
  three.
- **The tool server reimplements what `toolExecutor.ts` does**: run each tool with an argument list and
  never a shell, bound it by a timeout and an output limit, and kill the whole process group on cancel or
  disconnect. `toolExecutor.ts` and `tools/exec/builtins.ts` are the reference until step 4 removes them,
  and step 4's side-by-side run is what shows the two behave the same.
- **Tool definitions move to Python, so the per-tool checks move with them.** That opens one question
  for step 3: the scope check uses the tool id today - tools in `LOCAL_ONLY_TOOL_IDS` skip it, and a
  command with no identifiable target is refused. MCP tools must default to being scope-checked. A tool
  with no target is exempted in 8Rack's own config, never on the server's word, since the server's tool
  descriptions are untrusted.
- **RAG embedding** - decided right after this; see the next section.

### Decided: the RAG server embeds through local Ollama (2026-11-08)

The RAG server calls this machine's Ollama for embeddings rather than running its own model. That keeps
one place where models live and keeps today's `EMBEDDING_MODEL` (`nomic-embed-text`).

**So the RAG server runs on this machine, not on the scanning host.** Ollama has no authentication and
listens on localhost only by default. A RAG server elsewhere could only reach it if Ollama listened on the
network, and then anyone who can reach that port could use Ollama's whole API - not just embeddings, but
pulling, creating and deleting models. Keeping the RAG server here avoids that entirely, and it also
settles where the indexed files live: `WORKSPACE_ROOT` is on this machine already.

- The RAG server listens on 127.0.0.1 only, and 8Rack reaches it over plain http, which the client
  already accepts for localhost and nowhere else.
- It still requires a bearer token (`MCP_TOKEN_RAG`). On localhost that's what stops other programs on
  the machine, or a web page in a browser, from using it.
- Only the tool server goes on the scanning host. The two servers no longer share a location, which is
  fine: 8Rack treats each server in `MCP_SERVERS` separately.
- The index is rebuilt by the new server rather than carried over from `backend/data/rag/index.json`.
  The model is the same, so old vectors would still compare correctly, but the index format is the
  server's own and reindexing a workspace is cheap.

If the RAG server ever does need to run elsewhere, Ollama would need a proxy in front of it that requires
a token and allows only the embedding endpoint, with a firewall rule limiting it to that host. Not
planned.

### Order

RAG first: it needs no approval, so it proves the client, config and discovery with the least risk. Then
the tool server, running beside the local executor behind a setting so both can be compared on the same
mission. The local executor is removed only after a full mission run matches.

## MCP client (step 1, 2026-11-08)

Step 1 of "Planned: MCP servers as the tool and RAG providers" above. 8Rack can now connect to MCP
servers and list their tools. **Nothing calls an MCP tool yet** - agents don't see them, and the Tools
page says so.

- **Config** (`.env`): `MCP_SERVERS` is comma-separated `id=url` entries, and each server's token is in
  its own `MCP_TOKEN_<ID>`. A token never goes in the URL - an entry with credentials in its URL is
  rejected, since URLs are shown in the UI and logs. https is required, except http to localhost, so a
  local test server doesn't need a certificate. A bad entry shows as `misconfigured` with the reason
  instead of failing the backend or the other servers.
- **`services/mcpClient.ts`** uses the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2, the
  backend's first runtime dependency beyond Express/cors/dotenv) over streamable HTTP. Each check
  connects, lists tools (following pagination) and disconnects. Nothing needs a held connection yet,
  and this way a server that restarts needs no reconnect logic - revisit when tools are called.
  - The token is sent as a bearer header. Redirects are only followed within the same origin (the SDK
    default, set explicitly), so a redirect can't carry the token to another host.
  - Each request is bounded by `MCP_REQUEST_TIMEOUT_MS` (default 10s).
  - Errors are reported by what to fix: a 401/403 names the `MCP_TOKEN_<ID>` variable, an unreachable
    host gives the network error code, a silent server gives the timeout. The token never appears in
    any response or log.
  - Tool names and descriptions are untrusted (they'll be shown to the model later). Only names
    matching `[A-Za-z0-9_.-]{1,64}` are kept, duplicates are dropped, there's a cap of 200 per server,
    and descriptions are cut at 1000 characters. The count of skipped tools is shown.
  - Concurrent checks share one round of connections.
- **Startup** checks every configured server in the background (not awaited) and logs one line, e.g.
  `MCP: tools online (2 tool(s)); rag misconfigured: MCP_TOKEN_RAG is not set`.
- **API:** `GET /api/mcp/servers` (last result, or `checking` before the first check finishes) and
  `POST /api/mcp/servers/refresh`.
- **Frontend:** a read-only "MCP servers" tab on the Tools page (`McpServersPanel`, `useMcpServers`,
  `mcpApi.ts`) with each server's state, its error, and its tools. If a server is still `checking` when
  the page loads, the hook asks for a check, which joins the one already running.

Moved out of step 1, because neither does anything until agents can call an MCP tool: adding MCP tools to
the Orchestrator's catalog, and the enable switch. Both went to step 2 first, then on to step 3 - see
"RAG server (step 2)" below for why. `extensions/toolRegistry.ts`
/ `types/tool.ts` were considered as the adapter and rejected: their `execute()` runs a tool directly, with
no approval step.

Tests: `mcpClient.test.ts` (13) runs a real MCP server from the same SDK on a local port that checks the
token - discovery, a wrong token, an unreachable server, a server that never answers, unsafe tool names,
config parsing. Frontend: `McpServersPanel.test.tsx` (5) and `useMcpServers.test.ts` (4). Verified live:
the backend started with a throwaway local MCP server and a second entry missing its token. The tab showed
one online with 2 tools (a third, with an unsafe name, skipped) and one misconfigured. After the test server
was stopped, "Check again" showed `Can't reach the server (ECONNREFUSED)`. The tab fits at phone width with
no console errors. Not verified: a real remote host over https - no scanning host exists yet.

## RAG server (step 2, 2026-11-08)

Step 2 of "Planned: MCP servers as the tool and RAG providers". The knowledge base can now be served by an
MCP server, `mcp-servers/rag/`, the first Python code in the repo. With `MCP_RAG_SERVER` unset nothing
changes: the built-in index in `ragIndex.ts` is still used.

**Plan change.** Step 2 was going to bring the enable switch and add MCP tools to the Orchestrator's
catalog. It doesn't: agents keep the existing `search_knowledge_base` pseudo-tool, and 8Rack calls the
server's `search` behind it. So no server tool name or description ever reaches the model, and nothing
needs enabling. Both items move to step 3, where agents first call a server's tools by name - and where
the approval gate they need already lives.

### The server (`mcp-servers/rag/`)

- Python, official MCP SDK (`mcp` 2.3.0, pinned), served by uvicorn over streamable HTTP in stateless
  JSON mode. Three tools, each with structured output: `search(query, top_k=5)` → `{results: [...]}`,
  `reindex()` → status, `status()` → status. The shapes match the backend's `RagSearchResult` and
  `RagIndexStatus`, camelCase included, so 8Rack passes them through after validating them.
- **Always 127.0.0.1** - the host isn't configurable. The SDK's DNS-rebinding protection (Host/Origin
  allowlist for 127.0.0.1, localhost and [::1]) is on. Every HTTP request needs
  `Authorization: Bearer <RAG_MCP_TOKEN>`, compared in constant time; the token must be at least 16
  characters or the server won't start.
- **Index** (`rag_server/index.py`) is a port of `ragIndex.ts` with the same rules: 50-line chunks with 5
  lines of overlap, the same skip list, size caps, `pdftotext` for PDFs (argument list, no shell),
  null-byte binary detection. Hidden entries and symlinks are skipped, so nothing outside the workspace
  is followed. It never walks into its own index folder or 8Rack's `backend/data`. Reindex holds a lock
  (a second one is refused, not queued), times out after 5 minutes, writes the index atomically
  (temp file + rename) and swaps it in only on success, so a failed reindex keeps the previous index.
- **Embeddings** come from local Ollama's `/api/embed` (decided above). A missing model says
  `Run: ollama pull <model>`; an unreachable Ollama says so with its URL. Errors reach 8Rack as tool
  errors.
- Settings come from the environment or `mcp-servers/rag/.env` (see its `.env.example`); the environment
  wins.

### The backend

- **`mcpClient.ts#callTool(serverId, name, args, timeout)`** - connect, call, close, like the tool listing.
  It returns the tool's structured result. Every failure is an `McpRequestError` naming the server:
  not in `MCP_SERVERS`, misconfigured, unreachable, token rejected (names `MCP_TOKEN_<ID>`, never shows
  the token), timed out, a tool error (its text, truncated) or no structured result. `errorHandler`
  maps it to 502 `MCP_REQUEST_FAILED`.
- **`services/knowledgeBase.ts`** is the one place that decides local index vs. server; the
  Orchestrator, `routes/rag.ts` and startup all call it instead of `ragIndex.ts`.
  - Server answers are validated field by field; a malformed answer is an error, not passed on.
    Results are capped at the requested `top_k` (max 20) and each text at 20,000 characters.
  - `getStatus()` stays synchronous because the Orchestrator builds every tool list from it. For the
    server it returns the last status the server sent, kept from startup, each status request and each
    reindex. Until the server first answers, the status is "not indexed", so agents aren't offered
    `search_knowledge_base`.
  - Reindex gets 6 minutes - longer than the server's own 5-minute limit, so the server's clearer
    timeout message arrives first.
  - **No fallback.** If the server is configured but down, status and reindex return 502 and an
    agent's search fails with the reason. Silently searching a different (local, possibly stale) index
    would hide the problem.
- `GET /api/rag/status` now asks the server each time (it was a synchronous read). The local index is
  only loaded at startup when no server is configured.
- `MCP_SERVERS` entries now say which one is the knowledge base (`knowledgeBase: true`).

### Frontend

The Knowledge Base tab says where the index lives ("Served by MCP server rag" or "Local index on this
machine"); server errors show above it. The MCP servers tab tags the knowledge-base server, and its
note now says agents reach that server's search through `search_knowledge_base` only.

### Tests and verification

Python: 29 (`tests/` - chunking, the walk's skip rules incl. symlinks and excluded folders, reindex
locking/atomicity/failure, reload after restart, config errors, tool errors, the token middleware).
Backend: `knowledgeBase.test.ts` (12) against a real SDK server on a local port - local mode, status
caching, reindex, search arguments, the `top_k` cap, malformed answers, tool errors, a wrong token, an
unconfigured or misconfigured server, no fallback when down; plus the 502 mapping. Frontend:
`KnowledgeBasePanel.test.tsx` (3) and a knowledge-base tag test in `McpServersPanel.test.tsx`.

Verified live with the real Python server and the TypeScript client (SDK 1.32.2 against Python 2.3.0 -
they agree on the protocol). No embedding model is pulled on this machine, so Ollama's `/api/embed` was
stood in for by a small local script. Startup logged the server online with 3 tools; reindex and status
through `/api/rag/*` returned the server's status; a search ranked the right file first; an empty query
and a wrong token came back as clear errors. In the UI both tabs showed the server. With the server
stopped, Reindex showed `Can't reach the server (ECONNREFUSED)` and `/api/rag/status` returned 502. Not
verified: real embeddings from `nomic-embed-text`, and an agent calling `search_knowledge_base` against
the server during a mission (the Orchestrator path is covered by its existing tests with the module
mocked).
