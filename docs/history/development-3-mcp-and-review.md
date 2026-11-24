> Archived 2026-11-21 from DEVELOPMENT.md (lines 3595-end). A record of what was built and why at the time; it is not kept
> current. For the current design see DEVELOPMENT.md; for open work see TODO.md.

# 8Rack - Development notes, part 3: MCP and the 2026-11 review

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
mocked). Both were then checked - see below.

### Real embeddings and an agent (2026-11-08)

With `nomic-embed-text` pulled, the server indexed a scratch copy of `backend/src` (not the real
`WORKSPACE_ROOT`, which holds files that shouldn't be embedded for a test): 111 files, 472 chunks, about
16 seconds. Searches put the right file first - "how is the mission id checked before building a file
path" → `missionStore.ts` (in the top 3), "where are DNS rebinding attacks blocked" → `hostCheck.ts`,
"parse nmap XML output into findings" → `nmapParser.ts`.

In a throwaway mission with no targets ("KB test (local)"), the Code Assistant (`qwen2.5-coder:7b`) was
asked two code questions. Both times it called `search_knowledge_base`, the call went through 8Rack to the
MCP server, and the result held the right file first (`missionStore.ts`, `nmapParser.ts`). **Both times
its next reply was "I'm sorry, but I can't assist with that request."** The MCP path worked end to end,
but the agent didn't use what it found. The cause was the next section.

## Fixed: every agent call ran in a 2048-token context window (2026-11-08)

8Rack never set `num_ctx`, and this Ollama has no `OLLAMA_CONTEXT_LENGTH`, so every agent call got
Ollama's default of 2048 tokens. Ollama doesn't reject a longer prompt - it drops the beginning and
answers anyway. The Orchestrator's system prompt (agent prompt + tools preamble) is about 2000 tokens on
its own, so in practice **every Orchestrator call, in every mission, lost its system prompt and often the
task itself** as soon as there was any conversation. Found while chasing the refusal above: a logging
proxy in front of Ollama captured the request after the knowledge-base search - 6964 tokens, of which
Ollama read 2050 (`prompt_eval_count`). Replaying it with `num_ctx: 16384` gave the right answer;
removing the duplicated results from the tool message did not.

- **`OLLAMA_NUM_CTX`** (default 16384, `.env.example`) is sent as `num_ctx` on every agent call, in
  `chatService.ts#streamAgentChat`. A request's own `options.num_ctx` still wins. 16384 fits the
  Orchestrator's prompts with room for tool output; it's half of qwen2.5-coder's 32768 limit, and more
  costs more memory.
- **A warning** is logged when Ollama reports reading at least 95% of `num_ctx` in prompt tokens - the
  only sign it gives that it cut a prompt.

Tests: 4 in `chatService.test.ts` (sent by default, a request can override it, the warning fires at the
limit and stays quiet below it). Verified live: both knowledge-base questions from above, rerun with the
fix, got correct answers (`parsers/nmapParser.ts` exporting `parse`; `services/missionStore.ts`), every
captured request carried `num_ctx: 16384`, and no warning was logged.

Not re-checked: earlier live mission runs (the end-to-end mission, report generation) were all done
under the 2048-token window, so agent behaviour described for them may improve now.

## Phase 1 fixes (2026-11-20)

Phase 1 of `PLAN.md` (the 2026-11-09 review). Items 1.4 and 1.5 (an approved run dies with the tab
that approved it; the Approval Queue shows no live output or cancel) were left for Phase 2, which
replaces the request-bound run they depend on.

- **Mission ownership on id routes (1.3).** `routes/workOrders.ts`, `reports.ts` and `scanners.ts` each
  check, in a `router.param` handler, that the id in the path belongs to the `:missionId` in the path,
  and 404 otherwise. Before, any work order could be started or cancelled, and any report or scan read,
  changed or deleted, through any mission's URL.
- **Activity order (1.2).** `activityLog.ts#logActivity` makes `createdAt` strictly increasing, so events
  in the same millisecond (an order's "created" and "started" usually are) list in the order they
  happened. Already-stored events keep their old order.
- **Cancelled orders are logged (1.12)** as `work_order_cancelled`.
- **Directories without `mission.json` are skipped (1.13).** `missionStore.ts#listMissionIds` checks for
  it, so a directory left by a write to a mission that never existed (the local `00000000-…` one, with a
  pending approval in it) is no longer loaded.
- **Pseudo-tool results sent once (1.7).** `search_knowledge_base`, `query_findings`, `lookup_cves`,
  `create_finding`, `upsert_asset` and `validate_finding` used to send their records twice (`stdout`
  and an untruncated `parsedOutput`). They now send `stdout` only, through `truncateForTranscript`.
  `query_findings` lists each finding's id, value and status, and given a finding id returns that
  finding in full, evidence included - the validator's work order now tells it to do that, since the
  list alone lacks the evidence it was asked to judge.
- **`validate_finding` is the validator's only (1.8).** It's listed for, and accepted from,
  `VALIDATOR_AGENT_ID` (`vulnerability-validator`) only. A verdict stores `validationExecutionIds`: the
  completed real runs in that task. Empty means the agent judged without running anything, and
  FindingDetails shows that as "Unverified"; the tool description tells the validator so. A human status
  change clears the agent's verdict. The id is a constant, not an agent setting - a custom validator
  agent would need one.
- **Recon prompt and "no tool used" (1.9).** The recon agent's prompt ended "ask before running
  anything", and a question in prose ends the task as completed with nothing done. That sentence is
  replaced. A work order completed with zero tool calls gets `noOutcome`, shown as "no tool used".
- **Retries (1.10).** Retry sends `retryOf` (checked to be an order in the same mission). A retried
  order shows "retried", loses its Retry button, and isn't counted in the dashboard's failed banner.
- **Failure reason on the card (1.1).** A failed order shows `workOrder.result`. It was always
  recorded, just never displayed - Inspect said "No final response yet (failed)".
- **Approval Queue fetch (1.6).** `GET /api/tools/executions` takes `status`; the dashboard uses the new
  `usePendingExecutions` hook to fetch only pending approvals, instead of `useTools` (the tool list plus
  up to 200 records with full output). The History tab is unchanged.
- **Error boundary (1.11).** Each view in `App.tsx` sits in its own `ErrorBoundary`, reset on mission
  change, so one view's render error no longer blanks the app.
- **Privileged-command check (1.14).** The regex is now a word check: the command is split on
  whitespace and shell punctuation, URLs are skipped, and each word's last path segment is compared to
  the verb list. `curl https://host/su/` is no longer refused; `bin/sudo`, `$(sudo id)` and `true&&su`
  still are.

Tests: backend 632 (was 623), frontend 205 (was 196); both typechecks and oxlint clean. Verified live
against a fresh backend: cross-mission GET/start/cancel on a work order and GET on a report return 404,
a cross-mission `retryOf` returns 400, the `status` filter works, the orphan directory isn't loaded
(2 missions), and the Portify mission's failed order shows its reason ("model … is not available
locally"). Not seen live: the validator rules and the "no tool used" label on a real run, and the
unverified note on a real finding - tests only.

## Phase 2: server-owned factory runs (2026-11-20)

PLAN.md Phase 2. Before this, a factory run was one streaming `POST /factory/advance`: closing or
reloading the tab aborted the generation, two tabs could advance the same mission at once, the
dashboard froze until the request ended, a "blocked" reason vanished on reload, and approving a tool
tied its process to that HTTP request (items 1.4 and 1.5).

### Backend

- **`services/missionRunner.ts`** owns one run per mission. `startRun` (advance), `startWorkOrderRun`
  (Retry/Start), `guideWorkOrderRun` (a note for an order paused on a failed tool request) all start a
  run in the background and return its state; a second start while one is running throws
  `RunInProgressError` (409, `RUN_IN_PROGRESS`). `stopRun` aborts the generation; the order it was on goes
  back to pending (the existing `RequestCancelledError` path in `startWorkOrder`). A running tool isn't
  touched by Stop - it has its own Cancel.
- **Auto-resume.** `resumeAfterExecution(executionId)` runs after a tool run settles (confirm route,
  once the process ends) or is rejected. If a work order of that mission is waiting on that execution,
  it starts a run, or - if one is already going - sets `resumeRequested`, so the current run calls
  `advanceMission` once more before it stops (it may already be past the Director's waiting-order loop).
  The frontend no longer calls advance after an approval.
- **Run state** (`types/missionRun.ts`): `idle | running | waiting_approval | waiting_guidance | blocked`,
  with `workOrderId` and `reason`, derived from the Director's result (plus any order still parked on
  approval). Kept in memory only; after a backend restart it's `idle`.
- **`services/missionEvents.ts`**, a dependency-free pub/sub (so `missionStore` can import it).
  `writeMissionJson` and `missionManager.writeMissionMeta` publish `changed` with the file name minus
  `.json` (`work-orders`, `executions`, `findings`, `assets`, `activity`, `orchestrator-tasks`,
  `reports`, `scans`, `mission`), gathered over 150 ms per resource so a run recording hundreds of
  findings sends one event.
- **`factoryDirector.advanceMission`** gained an `onWorkOrder` callback, called before each order is
  started or resumed, so chunks carry the `workOrderId` that produced them.
- **Routes.** `POST /api/missions/:id/factory/advance` returns `{run}` at once; new
  `POST /:id/factory/stop`, `GET /:id/factory/run`, and `GET /:id/events` (NDJSON: the current
  `run_state` first, then `run_state`/`chunk`/`changed`/`execution_output`; a blank line every 25 s).
  `POST /api/tools/executions/:id/confirm` now answers `{execution}` once the process has started
  (`confirmExecution`'s new `onStarted` callback, fired past every check that can refuse it) and no
  longer cancels on disconnect; output goes out as `execution_output` events. Work order `/start`
  returns `{run, workOrder}`; new `POST .../workorders/:id/guidance {note}`. `GET /api/tools/executions`
  `status` takes a comma list. `DELETE /api/missions/:id` stops the run first.

### Frontend

- `services/missionEvents.ts` (client store: last run state, the current order's output tail, live
  tool output per execution, each capped at 20 000 chars) and `hooks/useMissionEvents.ts`:
  `useMissionEventStream` (App.tsx, one per selected mission, reconnects after 2 s and then sends a
  `changed: *` so every hook re-reads), `useRefreshOnChange` (added to useWorkOrders, useAssets,
  useFindings, useActivity, useReports, useScans, useTools, usePendingExecutions, and App for the
  mission list), and `useMissionLive`.
- **Dashboard.** Advance starts the server run; while it runs, the button is Stop and the panel shows
  which order is running ("agent - objective") and its output. The blocked reason comes from the run
  state, so it survives a reload and shows in every tab. `onAdvancingChange` and the mission switcher
  lock are gone (`disabled` kept optional on MissionSwitcher).
- **Approval Queue** fetches `pending_confirmation,running`; an approved run stays as a "Running" card
  with live output and Cancel.
- **Work Orders.** Guidance goes through the new work-order route (`orchestratorApi.ts` is back to
  `fetchTask` only); Inspect re-reads the task when the order's status changes.
- FindingsView no longer hides its table while a refresh is loading (it flickered on every event).

### Tests and verification

Backend 649 (was 632): `missionRunner.test.ts` (14: start/409/idle, chunk tagging, waiting states,
blocked reason, stop, failure, resume-after-execution in both cases, work-order start/guidance and
their refusals) and `missionEvents.test.ts` (3). Frontend 212 (was 205): `useMissionEvents.test.ts`
(4), the queue's running card, the dashboard's Stop/output/reason; tests built on the old streaming
calls were rewritten. Typechecks and oxlint clean.

Verified live with a throwaway mission (scope `127.0.0.1`, deleted afterwards): advance returned at
once and a second advance got 409; the event stream carried the run states, `changed` events and
chunks tagged with the work order. Approving `nmap` in the browser showed it as Running with live
output; reloading the page mid-scan did not kill it. When nmap finished, the run resumed by itself
(no advance pressed): the recon order completed, assets and findings appeared on the dashboard
without a refresh, the pipeline moved to Investigate, and the validator ran (it recorded a
`false_positive`). Reject resumed the run; Stop ended it with "Stopped. Advance again to continue."
and the interrupted validator order went back to pending. No backend errors logged.

Known gaps: output printed before a reload isn't replayed (the store is client-side); Retry and
guidance get a 409 while a run is going rather than queueing; run state is lost on a backend restart
(orders and tasks aren't - the next advance picks them up).

## Phase 3: UI and usability (2026-11-21)

PLAN.md Phase 3. Built on Phase 2's event stream: every new list re-reads through
`useRefreshOnChange` rather than polling.

### Backend

- **`services/missionAttention.ts`**, `GET /api/missions/:id/attention`: everything waiting on a human.
  Approvals and running tools carry the tool's name, description and timeout, the hosts/IPs/URLs in
  the arguments (`extractTargets`), the work order, and the agent's prose from the reply that asked
  (fences and tool JSON stripped, 600 chars) - only while that request is the one the task is paused
  on. Orders needing a note carry the error/stderr they stopped on. Failed orders exclude ones already
  retried (`retryOf`).
- **`factoryDirector.previewAdvance`**, `GET /:id/factory/preview`: what the next advance would start
  (agent, objective, target, new or existing order) or why it wouldn't, plus waiting counts. Seeding was
  split into a pure `planSeeds` so the preview and the real advance share it.
- **Assets** gained `POST` (manual, defaults to `unverified`), `PATCH {status}` and `DELETE`
  (`assetManager.deleteAsset` unlinks children and logs the new `asset_removed` event), with an
  ownership check on `:assetId`; the router is now behind `requireMission`.
- **Work orders** record `toolCallCount` (from the task, in `syncFromTask`).
- **`services/setupCheck.ts`**, `GET /api/setup`: Ollama reachable; each enabled agent's model and,
  when the built-in index serves the knowledge base, the embedding model (a bare name matches its
  `:latest`); each enabled recon tool that `listExecToolsWithStatus` says is unavailable, with an install
  command. A tool whose name resolves on PATH but fails the identity check (the python `httpx`) is
  reported as "a different X is on PATH".

### Frontend

- **Shared:** `ui/Notice` (critical = `role="alert"`, others `role="status"`) replaced every inline red
  error line; `ui/EmptyState` (icon, title, text, one action) replaced the grey one-liners in Assets,
  Work Orders, Findings, Reports and NoMission. `lib/appNav.ts` is a context any view uses to switch
  view, open the mission editor or prefill a scan (App provides it).
- **Dashboard:** `NeedsYouQueue` replaced `ApprovalQueue` (and `usePendingExecutions`): approval cards
  with tool description, targets, timeout, objective and agent text; guidance cards with a note box;
  failed cards with Retry; running cards with live output and Cancel; an sr-only live count. Live
  output is split into labelled tool lines (`lib/agentOutput.ts`). A "Next:" line from the preview, a
  Stop button, a no-scope link into the editor. `useAttentionAlerts` puts the count in the tab title
  and, if switched on with the bell, raises a browser notification when it grows while the tab is
  hidden (`8rack.notifyOnAttention`). `SetupChecklist` sits on top while anything is missing; Hide
  remembers the set of gaps (`8rack.setupChecklistHidden`), so a new gap shows it again.
- **Work Orders:** agent names, duration, tool-call count, Start on pending, Retry, a New work order
  sheet (`NewWorkOrderSheet`, also opened from an asset), and Inspect showing the transcript
  (`TaskTranscript`), final answer, and the tool runs and findings the order produced.
- **Assets:** add form; per asset a status select, Scan (opens Tools → Scans prefilled), New work
  order, Mark out of scope (appends to `mission.outOfScope` and sets it inactive), Remove with confirm.
- **Findings:** Add finding (`NewFindingSheet`, `tool: "manual"`), bulk status for the selected rows,
  sortable columns (`lib/findingSort.ts`, `aria-sort`).
- **Mission editor:** the status dropdown is gone. A pill shows the status and buttons offer only
  the moves the Director never makes: Pause / Send to review / Complete while active, Resume /
  Complete when paused, Complete / Reopen in review, Reopen when completed or cancelled. They save at
  once; Resume and Reopen go to `ready`. The form's reset now keys on the mission id, so a status save
  doesn't wipe typed edits. Under Scope and Out of scope each line is shown as read
  (`lib/scopeLines.ts`, mirroring `scopeMatcher.matchesEntry`): lines that match nothing are red;
  `host:port` and URLs with a path get a warning that ports/paths aren't enforced.
- **Nav:** the active item scrolls into view in the horizontal strip below `md`; nav is labelled.
- **Tool Registry:** search (name, id, description, executable), category filter, "Not installed
  only", and a live "N of M".

### Deferred

Port and path granularity in scope. The matcher still drops both; the editor now says so per line.

### Tests and verification

Backend 661 (was 649): `missionAttention.test.ts` (4), `setupCheck.test.ts` (3), preview tests in
`factoryDirector.test.ts` (3), asset delete (2). Frontend 253 (was 212): NeedsYouQueue, agentOutput,
SetupChecklist (4), ToolRegistry filters (3), scopeLines (15), MissionEditor status/scope (3),
FindingsTable sorting, FindingsView add/bulk, AssetsView controls (4), and the updated dashboard and
work-order tests. Typechecks and oxlint clean.

Seen live with a throwaway mission (deleted afterwards): the setup checklist against this machine
(flagged amass, katana, subfinder missing and the wrong httpx on PATH); the scope check on six kinds
of line; Pause saving at once, switching the actions to Resume/Complete and keeping unsaved scope
edits; the active nav item visible at 375px after switching to Tools; Registry search. Asset
POST/PATCH/DELETE (including a 400 on a bad status and 404 on a second delete), `/attention` and
`/factory/preview` (blocked reason for a paused mission) checked with curl. Not seen live: the queue's
cards against a real run, the transcript, adding a finding, bulk status.

## Phase 4: backend (2026-11-21)

PLAN.md Phase 4.

### Removed API surface

- `/api/plans`, `services/multiAgentOrchestrator.ts` (and its tests), `types/orchestration.ts`, the
  frontend's `types/multiAgentPlan.ts`, `PlanNotFoundError`/`InvalidPlanStateError`. The Factory
  Director replaced hand-authored plans; nothing called these.
- Orchestrator routes are read-only now: `GET /api/orchestrator/tasks?missionId=` and
  `GET /tasks/:id`. `POST /tasks`, `/continue`, `/resume`, `/guidance`, `/cancel` started or steered
  agent runs outside the work-order model on an unauthenticated server; work orders have their own
  start/guidance/cancel routes.
- Native Ollama tool-calling: `extensions/toolRegistry.ts`, `types/tool.ts`,
  `ollama.ts#resolveOllamaTools`/`streamChatWithTools`, `Agent.tools`, the `tools` field on
  `/api/chat` and `/api/agents/:id/chat`, `UnknownToolError`, `isValidToolNames`. No agent set
  `tools` and nothing was ever registered. An old agent file with a `tools` key still loads.

### One source for enums

Finding types/severities/statuses, asset types/statuses, report statuses and mission statuses are
`as const` arrays in `types/` with the type derived from each. `routes/findings.ts`, `routes/assets.ts`,
`routes/reports.ts`, `routes/missions.ts`, the Orchestrator's pseudo-tools and `nucleiParser.ts` used
their own copies; they import the lists now. `routes/validate.ts` has `isOneOf`, `oneOfMessage` and
`isStringArray`. The frontend mirrors the arrays (its own workspace can't import the backend at
runtime); `frontend/src/types/backendMirror.test.ts` imports both and fails on any difference. No
schema library: the bodies are small, and the hand-written 400 messages are part of the API.

### Route tests and status codes

`app.ts#createApp()` builds the whole app without listening; `index.ts` listens and hydrates.
`test-utils/httpHarness.ts` serves it on a random port and sends the Host and Origin the real
frontend sends (node:http, since fetch won't set Host), so hostCheck/originCheck/requireMission and the
mount paths are all exercised. `routes/missions.routes.test.ts` (6), `workOrders.routes.test.ts` (7),
`tools.routes.test.ts` (6) mock the service layer, so the real `backend/data` is never touched. They
cover validation, a cross-site write (403), a write to a missing mission (404), starting/cancelling
another mission's order through this mission's URL (404), `retryOf` from another mission, 409 while a
run is going, an out-of-scope request (403), and resume after a reject.

`POST /api/missions` and `POST /api/tools/request` now answer 201 (work orders, findings, assets and
agents already did). Report creation streams, so it stays 200.

### Persistence

- **Tasks** are written after every step, not only when an `advanceTask` run ends: `touch()` and the
  start of each `advance()` schedule a write, coalesced over 250 ms. A crash now loses at most the step
  in flight. A pending write is cancelled when its mission is deleted.
- **Execution output** moved to `execution-output/<executionId>.json`, written once when the run
  settles; `executions.json` keeps the record with empty stdout/stderr and `outputStored: true`.
  Loading merges it back (a missing file shows as a note in stderr). An old `executions.json` with
  output inline loads as before, and the next write moves the output out. `missionStore` gained
  `writeMissionRecord`/`readMissionRecord`, which check the subdirectory and record id as strictly as
  `missionDir` checks the mission id.

### Context budget

`services/contextBudget.ts#fitToContext`, called from `chatService.streamAgentChat` for every agent
call. The budget is `num_ctx` minus room for the reply (`num_predict` capped at a quarter of the
window, else an eighth). If the system prompt plus transcript is estimated over it, older tool results
are replaced, oldest first, by a short `{tool, success, elided: true, preview}` until it fits. The
objective, every assistant turn and human note, and the two newest results stay whole. Only what is
sent changes; the stored transcript keeps everything. Tokens are estimated at 3 characters each, then
calibrated from each reply's `prompt_eval_count` (smoothed, bounded to 1.5-4). Each shortening logs
`[chat] <agent>: shortened N older tool result(s)`. The "prompt filled the whole window" warning stays
as the backstop.

### Carried-over fixes

- **Time cap during a generation.** Each generation gets `AbortSignal.timeout` for the remaining
  budget; when it fires the task ends `max_time_reached` instead of running on.
- **IPv4-mapped IPv6.** `scopeMatcher.ipv4FromMapped` turns `::ffff:10.0.0.5` and `::ffff:a00:5` into
  `10.0.0.5` on both sides of a match, so an IPv4 out-of-scope entry catches them. Found on the way:
  the IPv6 extractor stopped at the first dot, turning `::ffff:10.0.0.6` into `::ffff:10` (a valid,
  different address) and blocking an in-scope request.
- **Rejected tools requested again.** An exact repeat (same tool and arguments) of a request the human
  rejected in this task is answered with a refusal instead of a new approval card; a second refused
  repeat pauses the task for a note.
- **Report prose.** The Report Writer's prompt now gives each finding's status and asks for
  conditional impact wording ("if confirmed...") for anything not confirmed. Nothing checks the
  output yet.

### Not done

- MCP steps 3 and 4.

### Live mission rerun at 16k (2026-11-21)

This was a throwaway mission with scope `127.0.0.1`, using the default agents (qwen2.5-coder:7b) and
`OLLAMA_NUM_CTX` 16384. The human approved every tool run in the UI. The run went from start to `idle`
with no failed orders and nothing waiting for a human note. It created 7 work orders and 6 tool runs
(5 nmap, 1 http_request), and confirmed 5 findings.

**What worked:**
- Recon made 9 calls. They were coherent, and it ended with a closing message.
- Each validator made 3 calls and recorded a verdict through `validate_finding`.
- Per-step persistence held throughout.
- Every finished run's output was in `execution-output/<id>.json`.

**What the context budget did:** nothing, and that was correct. The largest transcript was recon's,
at about 7,350 characters (about 2.5k tokens). No `[chat] ... shortened` line was logged. At 16k
tokens, a mission this small never gets close to the limit. The elision path is covered by tests
only.

**What the operator would notice:**
- **Validators run the full scan again.** Four of the five validators asked for the same
  `nmap -sV --top-ports 1000` that recon had already run, just to confirm one port. Each one is a
  separate approval card for no new information. A validator should read the existing execution
  first, or be offered a narrower check, such as one port with `-p`.
- **The web-analyzer made no tool calls.** It wrote two "findings" as markdown JSON blocks without a
  `tool` key, so nothing was recorded. One of them was an invented reflected XSS on `/search?q`. It
  also swapped which port runs what, and ended by asking the user a question. The order was labelled
  `noOutcome`, which was correct. This is the first time the Phase 1 "no tool used" label has been
  seen on a real order. Nothing it made up reached the findings. The problem is prompt-following in
  the 7B model, not the context budget.
- **Duplicate assets.** The same port showed up as `port 3001/tcp`, `service 3001/tcp:http`,
  `service 3001` and `service http`. Agents' `upsert_asset` values aren't normalized against what the
  parsers recorded.

### Tests

Backend 667 (661 before; the plans and native tool-calling tests went with their code). New tests:
- route tests (19)
- `contextBudget.test.ts` (5) and a chatService check that the shortened messages are what reach Ollama
- per-step task persistence
- execution output on disk (3)
- the time cap during a generation
- repeated rejections (2)
- mapped IPv6 and the extractor (12)
- report status in the prompt

Frontend 260 (253 before; the mirror test added 7). Typechecks clean; oxlint shows only warnings that
were already there.

## MCP tool server (step 3, 2026-11-08)

Step 3 of "Planned: MCP servers as the tool and RAG providers" above - **the first time agents call a
server's tool by name**. A new Python MCP server (`mcp-servers/tools/`) runs recon tools on a scanning
host, and 8Rack calls them through the exact same request → human approval → scope-checked execution
path every local tool already uses. The enable switch and the Orchestrator-catalog registration, held
back from steps 1-2 because nothing called a tool yet, land here.

### The tool server (`mcp-servers/tools/`)

Built to the RAG server's conventions (own venv, `.env.example`, README, pytest, stateless
streamable-HTTP MCPServer, the same constant-time bearer-token middleware). What differs follows from
it running on a separate scanning host rather than loopback-only:

- **A fixed catalog, not "run any command".** `catalog.py` lists eight recon tools (nmap, httpx,
  nuclei, subfinder, dig, whois, ffuf, katana). Each becomes one MCP tool whose single `args`
  parameter is the argv appended after a fixed `executable` + `default_args` prefix - the same
  `defaultArguments` vs caller-supplied split 8Rack's own ExecTools use. The catalog's binaries don't
  need to be installed for the server to start; a missing one surfaces as a failed run with a clear
  message when that tool is actually called.
- **`runner.py` runs it safely:** argv only (never a shell string), a per-tool timeout, output capped
  per stream, path-shaped arguments confined to the workspace (the server owns path containment for
  *its own* filesystem, since 8Rack's workspace check is about a different machine), and the whole
  process group killed on timeout or when 8Rack disconnects.
- **HTTPS for a real host.** `config.py` binds loopback by default; a non-loopback bind must serve
  HTTPS, either directly (TLS cert/key) or behind a TLS-terminating proxy (`TOOLS_MCP_BEHIND_TLS_PROXY`,
  with `TOOLS_MCP_ALLOWED_HOST` for the proxy's public name so the SDK's DNS-rebinding guard accepts
  it). This matches 8Rack refusing plain http to anything but localhost.
- Tests: 30 pytest cases (config incl. the HTTPS rule, the runner incl. timeout/path-escape/missing
  binary, and the server's tools + bearer middleware), run with `.venv/bin/python -m pytest -q`.

### What 8Rack keeps (the whole approval model is unchanged)

An MCP execution is an ordinary `ExecutionRecord` with an `mcp: {serverId, toolName}` marker, so it
rides the existing machinery rather than a parallel one:

- **`requestExecution`/`confirmExecution`** (`toolManager.ts`) branch on that marker. The request is
  parked at `pending_confirmation` exactly like a local tool - MCP tools always require confirmation,
  because the approval gate is 8Rack's and the server can't tell an approved call from an unapproved
  one. On confirm, `runMcpRecord` calls the server (`mcpClient.ts#callMcpTool`) instead of spawning a
  process, then settles the record identically: raw stdout/stderr/exit code, findings ingestion,
  history, the concurrency cap, and an `AbortController` so a cancel/disconnect reaches the in-flight
  call. No local path/executable check (the server owns its filesystem); no live stdout streaming over
  MCP yet (only the final result lands).
- **Scope is enforced, never bypassed.** `checkExecutionScope` runs at request *and* confirm time,
  keyed on the arguments, so it works whoever executes them. MCP tool ids are deliberately never in
  `LOCAL_ONLY_TOOL_IDS`: a tool on a scanning host reaches targets over the network by definition, so
  it always goes through the full check - an out-of-scope target blocks outright, and "no identifiable
  target under a strict scope allowlist" blocks too.
- **Findings parsers keep working.** `ingestExecution` parses an MCP execution under its underlying
  tool name (`record.mcp.toolName`, e.g. `nmap`), not the `<server>.nmap` catalog id, so an MCP nmap
  feeds the nmap parser automatically.

### The enable switch and the catalog

- **Discovered tools start disabled.** `mcpClient.ts` now keeps a registry of callable tools (rebuilt
  from online servers on every refresh) and a persisted enabled-flag map
  (`backend/data/mcp/tool-overrides.json`, gitignored). A human enables a tool via
  `PATCH /api/mcp/tools/:id` from Tools → MCP servers (the panel gained a per-tool power toggle, an
  `enabled` pill, and copy saying approval + scope still apply). The qualified id is `<serverId>.<tool>`
  so two servers offering `nmap` never collide.
- **Enabled tools join the Orchestrator catalog.** `buildToolsPreamble` lists each enabled MCP tool by
  its qualified id, filtered by the agent's `execTools` allowlist exactly as local tools are. The
  request-time allowlist enforcement in `advance()` already gated any non-pseudo tool id, so it covers
  MCP tools with no change; a disabled or unknown id fails the request and pauses the task for guidance.
- New settings: `MCP_TOOL_TIMEOUT_MS` (default 15 min) bounds one tool call, far longer than
  `MCP_REQUEST_TIMEOUT_MS` (discovery). The server's token is still only ever in `MCP_TOKEN_<ID>`.

### Verified

All three suites green: backend (`tsc --noEmit`, 624 Vitest, build), frontend (`tsc -b`, oxlint, 195
Vitest, build), python (30 pytest). Plus a live cross-language round-trip the mocked unit tests can't
cover: the real tool server started on loopback, and the backend's own `mcpClient` discovered all eight
tools (disabled), enabled one (persisted), and called `dig` on the server - the real binary ran and its
raw stderr/exit code came back through the full MCP path. Not verified: a real remote host over HTTPS
(no scanning host exists yet), and live output streaming (coarser over MCP by design).

### Next (unchanged from the plan)

`extensions/toolRegistry.ts` and `types/tool.ts` (plus the native tool-calling branch in
`chatService.ts` that reads them) can now be deleted - see TODO.md. Then step 4: run a mission both
ways and remove the local executor once findings/assets/reports match.

### Brought onto the reviewed `main` (2026-11-22)

This step was built on the `main` from before the 2026-11 review phases and merged onto the reviewed
`main` afterwards. What changed in that merge:

- The confirm route now answers when the run starts (`onStarted`), not when it ends. The MCP path
  didn't call `onStarted`, so an approved MCP call would have left the approve request open forever.
  `runMcpRecord` now fires it once the call is under way.
- The RAG server (step 2) had already landed with its own `mcpClient.ts#callTool`. The knowledge-base
  server's tools are kept out of the callable registry and get no enable switch, since
  `knowledgeBase.ts` calls them with their own arguments, not as argv tools. `callMcpTool` reuses the
  shared `openClient`.
- Execution output now lives in `execution-output/<id>.json`; MCP runs go through the same
  `persistExecutions`, so nothing changed for them.
- The "MCP step 3" item in `TODO.md` was closed; "Scope for MCP tools" was closed with it (MCP tools
  are scope-checked with no exemptions). Two parts of step 3 weren't built and stay open in `TODO.md`:
  the setting that picks local or MCP execution for a tool, and live output for MCP runs.

## Validators reuse runs instead of re-scanning (2026-11-21)

Follow-up to the 16k run above, in which 4 of 5 validators asked for the same
`nmap -sV --top-ports 1000` that recon had already run. Each one was an approval card for output
that already existed.

- `orchestrator.ts#findReusableRun`: an identical request (same tool and arguments) to a successful
  run of a read-only scanner in this mission from the last 24 hours is answered with that run's
  recorded output, marked `reused`. Nothing runs, so there's no card. The run is kept in
  `task.reusedExecutionIds`, and a verdict counts it in `validationExecutionIds`.
- The validation objective no longer says "reproduce it with a real tool". It asks for one narrow
  check (`nmap -sV -p <port> <host>`, or `http_request`), and says a repeated scan returns recorded
  output.
- Inspect labels a reused result "earlier run reused, not run again", and counts reused runs in the
  Produced list.

Tests: 6 in `orchestrator.test.ts` covering:
- reuse instead of an approval;
- the second repeat getting a short reminder;
- a narrower command still asking for approval;
- no reuse of failed, stale, other-mission or bash runs;
- the newest run picked when several match;
- the verdict resting on the reused run.

Plus 2 in `TaskTranscript.test.tsx`. Backend 673, frontend 262.

**Live, on a throwaway mission scoped to `127.0.0.1`** (`qwen2.5-coder:7b`, a human approving in the
UI): recon ran the broad scan once. **No validator asked for it again.** Of five validator orders:
- Two asked for a one-port check (`-p 3001`, `-p 3000`), each approved by the human.
- Three asked for one of those same checks again, got the recorded output, and needed no card.

Four findings were confirmed, each resting on one recorded run. One validator ran its check but
ended in prose without a verdict. The Director seeded a second order for that finding, which got the
reused run and recorded the verdict (see TODO.md).

## A cancelled order no longer leaves its run "waiting" (2026-11-23)

Found while stopping the first MCP tool test: the recon agent asked for `tools.nmap` on the Kali tool
server, and the test was stopped by cancelling that work order. The request was rejected and the
dashboard showed nothing waiting, but `GET /factory/run` still said `waiting_approval` for the
cancelled order. A run parked on an approval only changed state when a tool run settled or a new run
started, and cancelling an order does neither. Stop didn't help either: a parked run has no
generation to abort.

- `missionRunner.ts#workOrderCancelled`, called by the cancel route: a stopped run parked on that
  order re-settles on any other order still waiting, or goes `idle`. A running run is left alone.
- `settledState`'s lookup of the parked order is now `parkedState`, shared by both.

Tests: 4 in `missionRunner.test.ts` (goes idle, moves to another waiting order, ignores another
order or a running run, no run at all) and 1 in `workOrders.routes.test.ts`. Backend 697.

Live: the same mission parked on `tools.nmap` again, the order was cancelled from Work Orders, and
the run state went straight to `idle`. No scan ran.

## First live mission on the MCP tool server (2026-11-23)

The tool server ran in the `kali-ai` container (host network, loopback, bearer token), with all eight
`tools.*` tools enabled. The throwaway mission "MCP tools test (local)" was scoped to `127.0.0.2`,
where a Python `http.server` on port 8080 served an index, a login form, `/api/status.json`,
`/admin/`, a `robots.txt` and a fake `.env`. The rules said to use the `tools.*` tools. A human
approved every card in the UI (`qwen2.5-coder:7b`).

**It works like a local run.** 16 approved MCP runs ran on Kali and settled (13 completed, 3 failed
on a wordlist path); 2 more were rejected:
- nmap found `8080/tcp open http SimpleHTTPServer 0.6`. The nmap parser recorded the port and
  service findings and the port/service assets, as for a local run.
- httpx recorded the live host, katana found all four pages, and ffuf found `.env`, `admin`, `api`,
  `index.html`, `login.html` and `robots.txt`.
- Output landed in `execution-output/`. A refused argument came back with the server's message
  (`"/workspace/wordlists/common.txt" resolves outside the workspace root`).

The run ended with 17 findings (13 confirmed, `.env` among them as medium), 13 assets, and 16
validator orders completed.

**What it showed** (all in `TODO.md`):
- The server's workspace was empty, so the first MCP ffuf failed on `wordlists/common.txt`. Copying
  `backend/workspace/wordlists` into the container fixed it. Told about the missing file, the recon
  agent guessed `/workspace/wordlists/...`, which the server refuses.
- Validators ignored the "use `tools.*`" rule. They ran local `http_request` 14 times and local nmap
  once.
- MCP runs are never reused. The Web Analyzer's repeats of recon's httpx, nmap and katana, and the
  retried recon order's four scans, each needed a new card.
- Both recon orders stopped at `MAX_ORCHESTRATOR_TOOL_CALLS` (20). In each, 10 calls were
  `upsert_asset`, so only 4-6 were scans.
- The Web Analyzer left four `potential_vulnerability` findings rated high or medium ("Potential
  login page exposure", ...) that no run backs.

Also seen live for the first time: a guidance note sent from the Needs-you queue, and a failed recon
order retried.

## Record-only calls get their own cap (2026-11-23)

From the MCP mission above: both recon orders stopped at `MAX_ORCHESTRATOR_TOOL_CALLS` (20) with 10
calls spent on `upsert_asset`, so only 4-6 were scans.

- `orchestrator.ts#spendToolCall` takes the tool. `create_finding`, `upsert_asset` and
  `validate_finding` (`RECORDING_TOOLS`) count against `MAX_ORCHESTRATOR_RECORD_CALLS` (default 60) in
  `task.recordCallCount`. Everything else, including lookups and malformed calls, still shares the
  20-call cap, so the loop guard holds, and the time cap bounds both.
- `toolCallCount` stays the total, so the "N tool calls" in Work Orders is unchanged. A task saved
  before this has no `recordCallCount`, so all of its calls count against the 20.

Tests: in `orchestrator.test.ts` the create_finding cap test now expects the record cap. Two are new:
more findings than the tool-call cap allows complete normally, and lookups mixed with record calls
still stop at 20. Backend 699, frontend 265. Not run live yet.

## MCP scanner runs are reused too (2026-11-24)

From the first MCP mission: the Web Analyzer's repeats of recon's httpx, nmap and katana, and the
retried recon order's scans, each put a new card in front of the human for an identical command.
`findReusableRun` returned early for any id outside the local scanner list, so `tools.nmap` never
matched.

- A record now qualifies when its scanner name is reusable: `mcp.toolName` for an MCP run, the
  tool id for a local one. It still has to match the requested catalog id exactly, so a local nmap
  and `tools.nmap`, or two servers' nmap, never stand in for each other.

Tests: 3 in `orchestrator.test.ts`. They cover an identical `tools.nmap` request reusing the earlier
MCP run, local/MCP/other-server runs not crossing over, and a non-scanner MCP tool not being reused.
Backend 702. Not run live yet.

## Agents are told where MCP tool paths resolve (2026-11-25)

From the first MCP mission: told a wordlist was missing, an agent guessed
`/workspace/wordlists/...`. The tool server refused it, because it was outside the server's workspace
(`/workspace/8rack`).

- `buildToolsPreamble` adds one note under the MCP tool lines whenever at least one is offered. File
  paths go to the scanning host relative to its workspace (e.g. `wordlists/common.txt`), absolute
  paths are refused, and a file in 8Rack's workspace may not exist there. 8Rack doesn't know the
  server's absolute path and doesn't need it, since relative paths resolve in it.
- Syncing `wordlists/` automatically was left out. The server only runs a fixed catalog and has no
  file-write tool, and a one-time `docker cp` (in DEVELOPMENT.md's environment notes) covers it.

Tests: 2 in `orchestrator.test.ts`. They cover the note appearing once with MCP tools offered, and not
at all when none is. Backend 704. Not run live yet.
