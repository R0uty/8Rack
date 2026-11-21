# 8Rack - Development notes

How 8Rack works today and why it is built this way: the things you can't easily tell from reading the
code. `CLAUDE.md` is the file map and the commands, `README.md` covers running the app, and `TODO.md` is
the open work.

How each piece came to be - the build notes, audits, live runs and plans, as they were written - is in
[`docs/history/`](docs/history/README.md). Its index lists every old section heading of this file, so a
reference like "see DEVELOPMENT.md's Security scanners section" in an old comment or note still leads
somewhere. This file was rewritten from those notes on 2026-11-21; where it and the history disagree,
this file is current.

## State (2026-11-21)

- Backend 686 tests, frontend 263, the RAG server 29 and the tool server 30 (Python). Both typechecks
  are clean, and oxlint reports only warnings that were already there.
- Last full live run: 2026-11-21, a throwaway mission against `127.0.0.1` on `qwen2.5-coder:7b` with a
  16k context window. It ran to idle with 7 work orders, 6 tool runs and 5 confirmed findings. The
  problems it showed are in `TODO.md`.
- Not built yet: removing the local executor (MCP step 4), scope by port or path, binary evidence. See
  `TODO.md`. MCP step 3 (agents calling a tool server's tools, `mcp-servers/tools/`) landed on
  2026-11-22 and hasn't had a live mission run yet.

## The shape of a mission run

1. A human creates a **mission** with scope, out-of-scope entries and rules of engagement
   (`MissionEditor`). Without scope, nothing that targets a host can run.
2. **Advance** (`POST /api/missions/:id/factory/advance`) starts a run on the server
   (`missionRunner.ts`) and returns at once. There's one run per mission; a second start gets a 409.
3. The **Factory Director** (`factoryDirector.ts`) looks at the mission's assets, findings and work
   orders, and seeds the next **work orders** by fixed rules (below). It starts each one, chaining on
   until something needs a human or there's nothing left.
4. A work order runs an **orchestrator task** (`orchestrator.ts`): the agent replies, the reply is parsed
   for tool requests, and each real tool request becomes a `pending_confirmation` execution. The task
   pauses there.
5. A human **approves or rejects** the request in the dashboard's Needs-you queue. Approving runs the
   process (`toolManager.ts` → `toolExecutor.ts`). When it settles, the run **resumes by itself**
   (`missionRunner.resumeAfterExecution`): no second Advance is needed.
6. Tool output is **parsed into findings** (`parsers/`, `findingsManager.ts`), and findings of the right
   types become **assets** (`assetManager.ts`). Agents can also record findings and assets directly
   through pseudo-tools.
7. Each unsettled finding gets a **validation** work order for the Vulnerability Validator, which
   records a verdict with `validate_finding`.
8. When nothing is left, the mission moves to `reporting`. A human selects findings and generates a
   **report** (`reportManager.ts`). The Director never generates one itself.

Everything above writes to `backend/data/missions/<id>/`. The browser follows along through one event
stream per mission (`GET /api/missions/:id/events`), so closing the tab doesn't affect the run.

## Safety model

8Rack runs real scanners and shell commands that an LLM asks for. Everything here exists to keep a human
in control of what runs and against what.

- **No authentication, so it listens on 127.0.0.1 only** (`HOST`). Since anything on the machine (or a
  web page) could otherwise reach it, `middleware/hostCheck.ts` rejects unexpected `Host` headers (DNS
  rebinding) and `originCheck.ts` rejects POSTs from foreign origins with a 403.
  `securityHeaders.ts` adds a strict CSP, `nosniff`, `X-Frame-Options: DENY` and related headers.
- **Every real tool run needs a human's confirmation.** `requestExecution` only creates a
  `pending_confirmation` record; `confirmExecution` is the only thing that starts a process, or calls
  an MCP tool server (see "Knowledge base and MCP" - an MCP tool always needs confirmation). The
  pseudo-tools (`create_finding`, `upsert_asset`, `validate_finding`, `query_findings`, `lookup_cves`,
  `search_knowledge_base`) skip confirmation because they only read or write 8Rack's own records. A
  confirm called twice, or a reject that lands during a confirm, can't run the tool twice or after
  rejection.
- **The one exception is Scan Profiles** (`scanRunner.ts`, Tools → Scans). These are fixed chains of
  ExecTools with no agent involved. The human reviews every resolved command in the preview and
  approves the chain once. Each step still goes through `requestExecution`/`confirmExecution`, so scope
  and argument checks apply step by step. Nothing a model wrote runs without a per-call approval.
- **Scope is checked at request time and again at confirm time** (`checkExecutionScope`, using
  `scopeMatcher.ts`). Targets are pulled out of the arguments: hosts, IPs, CIDRs and URLs, with the
  mission's own TLDs recognized, trailing dots trimmed, and IPv4-mapped IPv6 compared as IPv4. A target
  outside scope gets a 403 and a `scope_blocked` activity event. A command with no identifiable target is
  refused, unless the tool is in `LOCAL_ONLY_TOOL_IDS` (filesystem tools). MCP tools are never in that
  set, whatever the server says about them. **Ports and paths in scope
  entries are not enforced.** Only the host is, and the mission editor says so on each such line.
- **Processes:** spawned with an argument list, never a shell string. Filesystem paths must stay inside
  `WORKSPACE_ROOT`. `sudo`/`su`/`doas`/`pkexec`/`setsid` are refused wherever they appear as a command
  word. Each run gets a timeout and a 1 MB cap per output stream. There's a global concurrency cap
  (`MAX_CONCURRENT_EXECUTIONS`, default 5). Cancel kills the whole process group, and SIGKILL follows
  after 3 s if SIGTERM is ignored. Shutting down the backend stops running tools.
- **Paths on disk:** every mission file path goes through `missionStore.ts#missionDir`, which rejects any
  id that isn't UUID-shaped. `writeMissionRecord`/`readMissionRecord` check their subdirectory and
  record id just as strictly. Add new mission-scoped stores through these functions, never a
  hand-built path.
- **Target-controlled text is untrusted.** Tool output, finding evidence and MCP tool descriptions can
  all carry prompt injection. An enabled MCP tool's description (cut to a fixed length) is shown to
  agents in the tools list, so a server can put text in front of a model. Report prompts mark finding data as untrusted. Rendered Markdown never
  loads remote images (they become links), so viewing a report can't make a request to a host an agent
  picked. Report evidence is fenced so it can't open a new section. None of this stops a model from
  *following* injected text. The approval gate is the actual control.
- **Agent configs can be rewritten over the API** (`POST/PUT /api/agents`), including `systemPrompt`
  and `execTools`. The host and origin checks are what stop another site or a LAN client from doing
  that.

## Agents

- One JSON file per agent in `backend/data/agents/`. All eight ship on `qwen2.5-coder:7b`.
  `agentManager.ts` **caches** the list after the first load. A direct file edit takes effect only
  after `POST /api/agents/reload` (the reload button on the Agents page), or a create/update/delete
  through the API.
- `enabled` is the author's switch: a disabled agent isn't listed. Online/offline is computed: is the
  agent's model pulled in Ollama? An enabled agent whose model is missing shows as offline rather than
  failing, and so does every agent when Ollama is down.
- `execTools` is an allowlist of ExecTool ids. It's enforced twice: in the tool list the agent is shown,
  and again when a request arrives.
- `validate_finding` is offered to, and accepted from, `vulnerability-validator` only
  (`VALIDATOR_AGENT_ID`, a constant, not a setting). An agent can't validate a finding it created.
- Every agent call sends `num_ctx` (`OLLAMA_NUM_CTX`, default 16384). Ollama's own default is 2048, and
  Ollama doesn't refuse a prompt that's too long: it **drops the beginning**, which is the system
  prompt and tool instructions, and answers anyway. Every mission run before 2026-11-08 ran like that.
  When the prompt fills at least 95% of the window, a warning is logged; that's the only sign Ollama
  gives.

## The orchestrator (one agent's tool loop)

- **Tool calls are plain text.** The tools preamble (`buildToolsPreamble`, appended to the agent's
  system prompt as one system message) lists the tools that are enabled, installed and allowed for this
  agent. It asks for `{"tool": "<id>", "arguments": [...]}` on its own. `parseToolRequests` takes every
  balanced, valid object in the reply, coercing arguments to strings. Ollama's native `tool_calls` was
  tried and removed: the small local models didn't emit the tags their templates need, and no agent
  used it.
- **Several calls in one reply** run in order (`OrchestratorTask.queuedToolCalls`), each real one behind
  its own approval. A rejection, a failure or a human note drops the rest of the queue, because each of
  those changes what the agent should do next.
- **Things that look like calls but aren't:** result-shaped JSON is never treated as a request. A reply
  that only *claims* a result gets a correction instead of becoming the final answer.
- **Task states:** `running`, `waiting_confirmation`, `waiting_guidance` (a failed or refused request
  that needs a human note), then `completed` / `failed` / `cancelled` / `max_executions_reached` /
  `max_time_reached`.
- **Caps:** `MAX_ORCHESTRATOR_TOOL_CALLS` (default 20) counts every attempted call, including invalid
  ones, so a model requesting garbage can't loop forever. `MAX_ORCHESTRATOR_TASK_TIME_MS` (default
  10 min) counts the agent's own time only (`activeMs`), not time spent waiting on a human. Each
  generation also gets an `AbortSignal.timeout` for whatever budget is left.
- **Loop guards for small models:**
  - An exact repeat of a successful recording call (or a re-sent batch) ends the task as completed.
  - A third identical failed recording call also completes it (`stuckRecordingFailure`), since the real
    work is already done.
  - An exact repeat of a request the human rejected gets a refusal instead of a new approval card. A
    second refused repeat pauses the task for a note.
- **What goes back into the transcript:** tool results pass through `truncateForTranscript`, and
  pseudo-tool results are sent once (no `parsedOutput` copy).
- **Context budget** (`contextBudget.ts`, called from `chatService.ts` on every agent call): if the
  system prompt plus transcript is estimated to exceed `num_ctx` minus room for the reply, older tool
  results are shortened to a 300-character preview, oldest first, until it fits. The objective, every
  assistant turn and human note, and the two newest results always stay whole. Only what is sent
  changes; the stored transcript doesn't. Tokens are estimated at 3 characters each, calibrated from
  Ollama's `prompt_eval_count`. A real mission at 16k has not needed this yet: the largest transcript
  seen was about 2.5k tokens.
- **Persistence:** a task is written after every step, coalesced over 250 ms. A crash loses at most the
  step in flight.

## Work orders and the Factory Director

- A **work order** is one agent, one objective, one optional target. It's backed 1:1 by an orchestrator
  task, so it pauses for approval like any task. Its statuses are coarser than the task's:
  `waiting_guidance` folds into `waiting_approval`, since both mean "needs a human".
- **Seeding rules** (`planSeeds`):
  - No assets yet: one recon order.
  - Each `domain`/`subdomain`/`ip` asset, plus each concrete in-scope host once recon has found
    anything (`withScopeHosts`): one enumeration order for the Web Analyzer, with the known ports and
    services in its objective.
  - Each unsettled finding: one validation order.

  Seeding is idempotent and rule-based, not an LLM planner, so it's predictable and testable. It's
  capped at `MAX_WORK_ORDERS_PER_ADVANCE` (25) per run.
- **The Director doesn't retry.** A failed or cancelled order stops the chain and stays as a signal for
  a human. **Retry** creates a new order with `retryOf`. The old one then shows as retried and stops
  counting as failed.
- **Mission status moves forward only** (no assets → `recon`, unsettled findings → `investigating`,
  nothing left → `reporting`). The Director never touches a mission a human has put in
  `paused`/`cancelled`/`review`/`completed`. The mission editor offers only the moves the Director
  doesn't make: Pause, Resume, Send to review, Complete, Reopen.
- **No outcome:** an order that completes with zero tool calls is marked `noOutcome` and shown as "no
  tool used". In practice this means the agent wrote prose, or JSON without a `tool` key, instead of
  calling anything.
- `previewAdvance` (`GET .../factory/preview`) runs the same `planSeeds` without side effects. The
  dashboard's "Next:" line comes from it.
- The four agents the Director never seeds (Code Assistant, General Assistant, Output Parser, Planner)
  are reached through the New work order form.

## Runs, events and attention

- `missionRunner.ts` owns the run. Its states are `idle | running | waiting_approval |
  waiting_guidance | blocked`, plus `reason` and `workOrderId`. Run state is **in memory only**: after
  a backend restart it's `idle`, and the next Advance picks up the orders and tasks, which are on disk.
- Stop aborts the generation, and the interrupted order goes back to `pending`. Stop doesn't touch a
  running tool; that has its own Cancel.
- A settled or rejected execution calls `resumeAfterExecution`. If a run is already going, it sets
  `resumeRequested` instead, so the current run does one more pass before it stops.
- `missionEvents.ts` is a small pub/sub that `missionStore` can import without a cycle. Every
  `writeMissionJson` publishes `changed` with the store name, gathered over 150 ms per store. The stream
  sends `run_state` first, then `run_state` / `chunk` (tagged with `workOrderId`) / `changed` /
  `execution_output`, plus a blank line every 25 s.
- Clients **re-read a list on `changed`** rather than patching it from per-record events. That's simpler,
  and the lists are small.
- Output printed before a page reload isn't replayed, because the output tail lives on the client.
- `missionAttention.ts` (`GET .../attention`) builds the Needs-you queue. Its items:
  - approvals, with the tool's description, timeout, targets, objective, and the agent's prose from
    the asking reply;
  - running tools;
  - orders that need a note, with the error they stopped on;
  - failed orders not yet retried.

## Findings, assets and evidence

- **Findings** come from the parsers (one per recon tool, from raw stdout) and from agents
  (`create_finding`). They're deduplicated per mission; confidence is clamped to 0-1; history is capped
  at 50 entries.
- **Assets** are a real store, not derived from findings. They're deduplicated by
  `(missionId, type, value)`, and port spellings are merged. A `parentId` tree runs
  domain → subdomain → url → port → service. Findings of the right types create assets on ingest.
  Agents add theirs with `upsert_asset`, as `unverified`. Agent-supplied values aren't normalized
  against parser ones, so duplicates under different names happen (`TODO.md`).
- **Validation:** a verdict (`confirmed` / `false_positive` / `duplicate`) stores
  `validationExecutionIds`: the completed real runs in that task. Empty means the agent judged without
  running anything, and the finding shows "Unverified". A human status change clears the agent's
  verdict.
- **Evidence** stays an array on the finding (each item with its own id and optional
  `executionId`/`agentId`), not a separate store; it's never listed on its own. Binary evidence
  (screenshots) isn't supported.
- **CVE lookup** (`cveLookup.ts`) asks NVD on demand. Outbound HTTP has timeouts everywhere.

## Reports

- **The model writes only the prose:** an executive summary, and each finding's impact and remediation.
  `sanitizeNarrative` removes any code blocks and evidence/reproduction/PoC sections it writes anyway,
  and demotes its headings. That's enforcement, not tidying: small models invented scan output when
  asked for evidence.
- **8Rack writes the evidence and reproduction** (`reportEvidence.ts`) from the mission's recorded
  executions. Evidence counts as recorded if it is linked to a real execution, or if its text (12+
  characters, terminal codes stripped) appears in a run's output. Anything else goes under "Unverified
  statements", and an "Evidence Check" section counts the findings with no recorded output.
- The prompt states each finding's status and asks for conditional wording when it isn't confirmed.
  Nothing checks the prose.
- Status is `draft / ai_generated / human_review / ready / submitted`, with any-to-any moves through
  PATCH. Generation streams NDJSON and returns 200. The raw stream is replaced by the assembled report
  when it finishes, and only the assembled report is stored.

## Persistence

- Each service keeps a `Map` in memory, writes through to one JSON file per mission
  (`backend/data/missions/<id>/<store>.json`), and is hydrated from disk at startup. Writes are atomic
  (temp file + rename) and queued per file, so quick changes coalesce.
- **Tool output** is in `execution-output/<executionId>.json`, written once when the run settles.
  `executions.json` keeps the record with `outputStored: true` and empty stdout/stderr. An old file with
  output inline still loads; the next write moves the output out.
- **Startup repair:** whatever a dead process left `running` (executions, tasks, work orders, scans) is
  settled with a note. Directories that aren't UUID-shaped or have no `mission.json` are skipped.
- Deleting a mission calls every service's `onMissionDeleted` handler (stopping runs, aborting
  processes, dropping pending writes), so no ghost records survive or recreate the directory.
- `backend/data/missions/` and `backend/data/rag/` are gitignored: they hold target and scope data.

## Knowledge base and MCP

- `knowledgeBase.ts` is the only entry point. If `MCP_RAG_SERVER` is set, every search, status and
  reindex goes to that MCP server. Otherwise the built-in `ragIndex.ts` handles them. **There's no
  fallback**: a configured server that's down is an error, not a silent switch to a possibly stale
  local index.
- **The RAG server** (`mcp-servers/rag/`, Python, official MCP SDK) listens on 127.0.0.1 only, requires
  a bearer token of at least 16 characters, and embeds through this machine's Ollama
  (`nomic-embed-text`). It runs here rather than on a scanning host because Ollama has no auth: exposing
  Ollama to reach it would expose model pull, create and delete too.
- **`mcpClient.ts`** connects to the servers in `MCP_SERVERS` (`id=url` entries, the token in
  `MCP_TOKEN_<ID>`, never in the URL). It requires https except for localhost, and follows redirects
  only within the same origin. Tool names and descriptions are untrusted: only safe names are kept,
  with a cap per server and descriptions cut. Each call connects, works and disconnects.
- **The tool server** (`mcp-servers/tools/`, Python) runs a fixed catalog of eight recon tools (nmap,
  httpx, nuclei, subfinder, dig, whois, ffuf, katana), not "any command". Each tool's one `args`
  parameter is the argv appended after a fixed executable and default arguments. It runs argv only,
  with a timeout and output caps, confines path-shaped arguments to its own workspace, and kills the
  process group on timeout or disconnect. It returns raw stdout, stderr and exit code, so 8Rack's
  parsers keep working. It binds loopback by default; any other bind must serve HTTPS, directly or
  behind a TLS proxy.
- **Agents call a server's tools through the same approval path as a local tool.** An MCP execution
  is an ordinary `ExecutionRecord` with an `mcp: {serverId, toolName}` marker. `requestExecution`
  parks it at `pending_confirmation` (always: the server can't tell an approved call from an
  unapproved one), and `confirmExecution` re-checks scope, then `toolManager.ts#runMcpRecord` calls
  the server (`mcpClient.ts#callMcpTool`) instead of spawning a process. It counts against the
  concurrency cap, can be cancelled, fires `onStarted` so the confirm route answers at once, and
  settles like a local run: history, `execution-output/`, `ingestExecution`. Findings are parsed under
  the tool's own name (`nmap`), not its catalog id. Live output isn't streamed; only the final result
  lands.
- **Scope applies in full.** MCP tool ids are never in `LOCAL_ONLY_TOOL_IDS`: a tool on a scanning host
  reaches the network by definition, so an out-of-scope target, or no identifiable target under a scope
  allowlist, is refused at request and at confirm time. There's no exemption list for MCP tools; a targetless one would need
  one in 8Rack's config, never on the server's word.
- **Discovered tools start disabled.** `mcpClient.ts` keeps a registry of callable tools, rebuilt from
  the online servers on every check, and a persisted enable flag per tool
  (`backend/data/mcp/tool-overrides.json`, gitignored; `PATCH /api/mcp/tools/:id` from Tools → MCP
  servers). The catalog id is `<serverId>.<tool>`, so two servers' `nmap` never collide. Enabled tools
  are listed in `buildToolsPreamble`, and an agent's `execTools` allowlist gates them at listing and at
  request time, like local tools. The knowledge-base server's tools are never in the registry and have
  no switch: `knowledgeBase.ts` calls them itself.
- **Two timeouts:** `MCP_REQUEST_TIMEOUT_MS` bounds discovery and the knowledge-base calls,
  `MCP_TOOL_TIMEOUT_MS` (default 15 min) one tool call. The server has its own per-tool timeout too.
- **What's left** (`TODO.md`): a scan source IP per mission, then step 4 - run the same mission with
  local and MCP tools, and remove the local executor only once findings, assets and reports match. Full
  reasoning for the plan is in `docs/history/development-3-mcp-and-review.md`.

## Frontend

- **One current mission**, owned by `App.tsx` (`useSelectedMission`, kept in `localStorage`) and picked
  in the sidebar's `MissionSwitcher`. Every mission-scoped view gets it as a prop. The earlier pattern
  of a picker in every view meant re-picking the mission on seven pages.
- **Views stay mounted** when you switch away, so a running scan keeps streaming.
  `useRefreshOnActivate` re-reads when a view is shown again, and `useRefreshOnChange` re-reads on the
  store's `changed` event. That's why there are no refresh buttons.
- `lib/appNav.ts` is the context any view uses to switch view, open the mission editor, or prefill a
  scan.
- `ui/Notice` is the one way to show an error or notice: critical ones use `role="alert"`, others
  `role="status"`. `ui/EmptyState` gives every empty list a next action. Each view sits in its own
  `ErrorBoundary`.
- Browser-only preferences live in `localStorage`: `8rack.selectedMission`, `8rack:theme`,
  `8rack.notifyOnAttention`, and `8rack.setupChecklistHidden`. Nothing that matters to a mission lives in the
  browser.
- **Enums:** the backend's `as const` lists in `types/` are the source. The frontend keeps copies, since
  it can't import the backend at runtime. `frontend/src/types/backendMirror.test.ts` fails on any
  difference.

## Testing

- `cd backend && npm test`: service tests plus route tests. The route tests use `app.ts#createApp()`
  and `test-utils/httpHarness.ts`, which serves the real app on a random port with the Host and Origin
  the real frontend sends, so the middleware and mount paths are exercised. They mock the service
  layer, so they never touch `backend/data`. Routes for findings, assets, reports, scans and agents
  don't have route tests yet.
- `cd frontend && npm test`: hooks and components with React Testing Library.
- `cd mcp-servers/rag && .venv/bin/python -m pytest`, and the same in `mcp-servers/tools`.
- `cd backend && npm run smoke` (`scripts/smoke-test.mjs`) needs a running backend and Ollama. It
  covers:
  - health, setup, agents and a streamed agent reply;
  - the mission event stream;
  - a work order that asks for a tool, the approval, the run, and the run resuming by itself to a
    final answer.

  It works in a throwaway mission with no scope and deletes it at the end. The only request it ever
  approves is `list_directory` on the workspace root. Anything else is rejected and fails the stage,
  so it never approves a scan on its own. The agent is a real model, so a run where it answers
  without using the tool fails stage 6; run it again before calling that a regression.
- **Live checks matter here:** most real bugs in this project were found by running a mission against
  a local target, not by the unit suites. Use a throwaway mission with scope `127.0.0.1` (or a
  `127.0.0.2` server, so nmap can't reach anything else) and delete it afterwards. Tool approvals are
  the human's to give.

## Development environment notes

- `./start.sh` kills stale dev servers before starting new ones. Its patterns match the `tsx` binary
  path and `tsx/dist/preflight.cjs`, the grandchild that actually binds the port. An orphaned or
  stopped (`T` state) grandchild keeps the port and makes requests hang rather than fail. If requests
  hang, check `ps aux | grep 8Rack` first.
- Edits to `.env` need a backend restart; `tsx watch` doesn't watch it.
- The ProjectDiscovery tools (`katana`, `subfinder`, `amass`, `httpx`) are often missing, and
  `/usr/bin/httpx` is usually the unrelated Python one. The setup checklist (`GET /api/setup`) reports
  each case with an install command.
- In a hidden browser pane, screenshots and animations lag badly. Read the DOM before concluding the UI
  is stale.

## Conventions

- **Errors:** throw a domain `Error` subclass from `services/errors.ts` and let
  `middleware/errorHandler.ts` map it to a status and JSON body. Don't build error responses in routes.
- **Validation:** use `routes/validate.ts` (`isOneOf` against the `types/` lists, `isStringArray`).
  There's no schema library on purpose: the bodies are small, and the 400 messages are part of the API.
- **Status codes:** 201 for a create that returns the record. Creates that stream (reports) answer 200.
- **Streaming:** NDJSON, not SSE (an `EventSource` can't send a POST body, and Ollama speaks NDJSON).
  Detect client disconnect with `res.on("close")`, never `req.on("close")`, which fires as soon as the
  body has been read (`streamUtils.ts#abortOnClientDisconnect`).
- **Activity:** log named events explicitly with `logActivity` at the point the action happens.
  Mission-level events are logged in the route layer, because `activityLog.ts` imports
  `missionManager.ts`.
- **Docs:** after non-trivial work, update this file where the design changed, and `TODO.md` for what
  was closed or found. Dated narrative belongs in `docs/history/`, not here.
