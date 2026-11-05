# 8Rack — Polish plan

Dated `2026-09-20`. The full-project assessment found the codebase healthy (backend 461 tests,
frontend 213 tests, typecheck + oxlint clean) but with a set of correctness, UX, and hygiene gaps
worth closing. This is the living plan for that work, executed in phases — each phase ends with a
clean typecheck + full test suite on both sides. **Phase A is complete (474 backend / 226 frontend
tests green); Phase B is complete (474 backend / 207 frontend tests green).**

## Phase A — Correctness pass (complete)

Fixes bugs that bite in real daily use; no feature work.

All eight items verified: backend **474 tests** (30 files, was 461 at audit), frontend **226 tests**
(41 files), both typechecks + oxlint clean, `npm run build` on both sides. Two extra finds during
the pass (fixed or confirmed): the A3 review surfaced a type-narrowing issue in
`listExecToolsWithStatus` (widened `availability: string`) now annotated; B3 was already implemented.

- [x] A1 **Stale-response guards in the five mission-scoped data hooks.** `useTools.ts`/
      `useFindings.ts`/`useActivity.ts`/`useReports.ts`/`useScans.ts` each `refresh` on
      `[missionId]` with no AbortController and no "still the current mission" check, so a slow
      response for mission A resolving after a switch to B renders B's view with A's data (and the
      late `finally { setLoading(false) }` clears loading early). Added the `missionIdRef` guard +
      request-abort pattern the deleted `useChat`/`useOrchestratorTask` already used, plus guards on
      the mutation-settlement paths (`useReports` generate/remove/setStatus, `useScans` stream
      events + final append). Regression tests in each hook's `.test.ts`. Verified: hook suite 43
      tests; full frontend suite 226 tests, typecheck + oxlint clean. (Open Medium from the
      2026-08-08 audit.)
- [x] A2 **`MissionPanel.disabled` mid-task lock.** Verified the post-nav-simplification call sites:
      the prop was already fully implemented (real `disabled` on New/Edit/Delete, `aria-disabled` +
      `tabIndex -1` + `pointer-events-none` on the card — no `aria-disabled`-on-`<button>` remains).
      Wired the lock in `WorkOrdersView` (`HAS_ACTIVE_TASK` = running/waiting_approval, so a mission
      with an in-flight or human-paused task can't be switched/deleted from that view), hardened the
      card's `onClick`/`onKeyDown` to also guard on `disabled` (defense beyond the CSS), and reset
      `ScannerPanel`'s stale run/preview on mission change (the scan append-to-wrong-mission bug this
      audit originally pointed at is covered by A1's guards). Tests: `MissionPanel`, `WorkOrdersView`
      (lock/unlock states), new `ScannerPanel.test.tsx`.
- [x] A3 **Stop blocking the event loop on tool-status probing.** `toolManager.ts#listExecToolsWithStatus`
      runs ~20 tools × up to two `spawnSync` probes (incl. 3s version timeouts) on every
      `GET /api/tools`, `PATCH /api/tools/:id`, and scan preview. Memoized with a 10s TTL cache
      (`STATUS_CACHE_TTL_MS`), invalidated on register/toggle/override-reload. Tests: cache identity
      within TTL + recompute-after each invalidation path.
- [x] A4 **Kill the process group, not the direct child.** `toolExecutor.ts` now spawns with
      `detached: true` and cancels via `process.kill(-pid, SIGTERM)` on external abort / timeout /
      already-aborted, so `bash -c 'sleep 3600 &'` and its whole tree die together. Regression test
      spawns a real backgrounded grandchild and asserts it's gone (ESRCH).
- [x] A5 **RAG reindex safety.** `ragIndex.ts`/`routes/rag.ts` now have (a) an in-flight guard that
      refuses a concurrent reindex with `RagReindexInProgressError` (409), (b) an overall budget
      (`REINDEX_TIMEOUT_MS` 5 min) via `AbortSignal.timeout` threaded through `embed` → `ollamaFetch`,
      surfacing `RagReindexTimeoutError` (504) on abort, and (c) an always-exclude of the app's own
      `backend/data` directory (lexical containment check in the walk + a full no-op if
      `WORKSPACE_ROOT` lands inside it). Tests: concurrent-reindex refusal, app-data exclusion.
- [x] A6 **`assertNotPrivileged` hardening.** Case-sensitive `\b(sudo|doas|pkexec|su)\b` missed
      `Sudo`/`SUDO`. Now case-insensitive (`/i`), also rejects `setsid` (whose child would escape the
      A4 process-group kill by opening a new session), and an `env -wrapped` escalation is caught by
      the (now case-insensitive) verb match while a plain `env VAR=x cmd` stays allowed. Tests cover
      the case variants, env-wrapped sudo vs. allowed bare env, and setsid.
- [x] A7 **dig/whois parser target attribution.** `lastPositionalArg` misattributed `dig
      example.com A` to `"A"`. New `firstPositionalArg` helper (shared.ts) used for dig/whois in
      `parsers/index.ts`; new `parsers/index.test.ts` covers attribution via `parseExecutionOutput`.
- [x] A8 **Security headers middleware.** New `securityHeaders.ts` (next to `hostCheck.ts`,
      registered first in `index.ts`) sets `X-Content-Type-Options: nosniff`,
      `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
      `Cross-Origin-Resource-Policy: same-origin`, and a strict CSP (`default-src 'none'` +
      `frame-ancestors 'none'`). Unit test + verified live: all five headers present on
      `GET /health` of a running `node dist/index.js` instance.

## Phase B — Orphan & UX cleanup (complete)

Closed decisions, dead code removal, and the missing human affordances. All five items verified:
backend **474 tests** (unchanged — none of these touched backend behavior), frontend **207 tests**
(38 files, down from 226/41 as the dead-Chat tests were deleted), both typechecks + oxlint clean.

- [x] B1 **Settings panel decision.** Removed `SettingsPanel.tsx`/`useSettings.ts`/`types/settings.ts`
      outright (decision: its values ruled nothing after Chat was cut — every agent carries its own
      sampling config). Unwired App.tsx (import, hook, `settingsOpen` state, render, the
      `onOpenSettings` prop on TopBar/CommandPalette), dropped the TopBar gear button, the Command
      Palette's settings command, and the related App.test mocks. Verified: no references remain,
      frontend tests + typecheck clean.
- [x] B2 **RAG surface decision.** Surfaced `KnowledgeBasePanel`/`useRag` as a full-width section in
      ToolsView (status + reindex), chose over cutting it — RAG is load-bearing
      (`search_knowledge_base` is a real pseudo-tool). Rewrote `ToolsView.test.tsx` with a
      knowledge-base mock + a scanner-selection test (MissionPanel mock now calls `onSelect`, the
      existing mission-selection reset needs a full mission object). Updated the stale
      `orchestrator.ts` message ("reindex it from the Tools view first.") and a dead Workbench
      reference in `scanRunner.ts`.
- [x] B3 **Failed Work Order retry button.** Found already implemented on the failed/cancelled work
      order cards in `WorkOrdersView.tsx` (`handleRetry` recreates the order with the same agent/
      objective/target and starts it) and covered by a test — nothing to do this pass. (The audit
      predates it.)
- [x] B4 **Report nudge.** Factory Dashboard now shows a "Generate report now" affordance when a
      selected mission sits at `reporting` with confirmed findings and no report yet — generates a
      report from exactly those confirmed finding IDs in one click (keeps report generation
      human-triggered, removes the discoverability gap). Wired `useReports` into the dashboard's
      mission-scoped hooks + `refreshAll`. Tests: nudge appears + calls `generate` with the confirmed
      IDs at `reporting`/no-reports; hidden once a report exists.
- [x] B5 **Dead-code sweep.** Deleted `ChatArea.tsx`, `PromptInput.tsx`, `ChatMessageView.tsx` + their
      now-testing-dead-UI tests (`PromptInput.test.tsx`/`ChatMessageView.test.tsx`) — re-verified dead
      (only self/test references). `extensions/pluginRegistry.ts`/`retrievalRegistry.ts` +
      `types/plugin.ts` were already deleted (commit a65fb26) — docs were stale, not code. Split the
      legacy `services/api.ts` into per-domain `modelsApi.ts`/`agentsApi.ts`/`chatApi.ts`, updated the
      three consumers (`useModels`/`useAgents`/`FindingDetails`) + their test mocks, deleted the
      original. Its `ApiError` re-export was dead (every other client imports from `httpClient`
      directly).

## Phase C — Factory completeness (bigger swings)

Feature work that makes the factory feel like a complete product.

- [ ] C1 **Binary evidence attachments** (screenshots) — the one disclosed partial gap in the
      Findings/Evidence system; needs an upload endpoint + storage dir.
- [ ] C2 **Scan Profile composer** — the 4 built-in profiles are hardcoded; let a human compose a
      named chain of ExecTools from the UI.
- [ ] C3 **Mission health stats** — assets discovered / findings / coverage on the Factory
      Dashboard.
- [ ] C4 **Mission export** (zip of a mission's JSON + evidence) for archiving/submission.
- [ ] C5 **Map watch-mode** — an optional auto-`/factory/advance` poll while a mission is mid-
      pipeline, since advance is currently fully request-driven.
- [ ] C6 **Activity timeline filters** (by event type / agent).

## Phase D — Hardening as a product

Engineering and test infrastructure.

- [ ] D1 **Route-level integration tests** (supertest) — the documented deferral from the first
      test pass; the riskiest surface (tool execution / agent mutation) is only indirectly covered.
- [ ] D2 **Shared NDJSON terminal helper** — 5 near-identical write/error loops in
      `streamUtils.ts` + routes drift in event types; extract one.
- [ ] D3 **Status-code consistency** (200 vs 201) across creation routes.
- [ ] D4 **Doc-debt sweep** — stale oxlint count in DEVELOPMENT.md; confirm CLAUDE.md/TODO.md claim
      accuracy; `ORCHESTRATOR_TASK_TYPE` field drift frontend vs backend.
- [ ] D5 **Local-model eval harness** — tool-call-compliance check across the 8 agents/models, plus
      the documented `vulnerability-validator` `maxTokens` bump for its longer checklist prompt.

## Decisions reached

- Scope for this pass: **Phase A** (correctness), per session choice on 2026-09-20.
- Plan lives in `POLISH.md` (new), keeps `TODO.md` as the historical/audit record; completed items
  here link or reference their verification.

## Audit and fix pass (2026-11-05)

Outside the phases above: a full audit found and fixed 40-odd correctness, durability, and security
bugs, including the Director never resuming a work order after approval. Test counts are now in
DEVELOPMENT.md's "Audit and fix pass (2026-11-05)", with what's still open in TODO.md. D5's
`vulnerability-validator` `maxTokens` bump is done (2048); the eval harness part isn't.

## UI cleanup (2026-11-05)

A follow-up usability pass removed duplicated surfaces and moved mission selection to one sidebar
switcher, reversing the per-view pattern. See DEVELOPMENT.md's "UI cleanup (2026-11-05)".
