# 8Rack - review and fix plan (2026-11-09)

Whole-project review on branch `rag-mcp-server` at `571ccc4`. Supersedes nothing: `TODO.md` stays the
record of earlier audits, `POLISH.md` phases C/D are folded in below where they still apply.

## How this was checked

- Ran: backend typecheck + 623 tests, frontend `tsc -b` + oxlint + 196 tests. All pass.
- Read: every route, the middleware, `orchestrator.ts`, `factoryDirector.ts`, `workOrderManager.ts`,
  `toolManager.ts` (execution half), `missionStore.ts`, `activityLog.ts`, and the frontend's App,
  Factory Dashboard, Approval Queue, Work Orders view and their hooks.
- Looked at the running app in a browser: every nav view, the mission editor, light theme, 375px
  width. Only the two existing local missions; nothing was advanced, approved or scanned.
- Not checked: a live factory run (so everything about run-time behavior below is from reading code,
  not from watching it), the parsers, `scanRunner.ts`, `reportManager.ts`, `ragIndex.ts`,
  `mcpClient.ts`, the Python RAG server, and most of `FindingDetails`/`AgentEditor`.

Each item says how it is known: **seen** (in the running app or on disk), **read** (in the code, not
reproduced), or **known** (already open in `TODO.md`).

## Summary

The code is in good shape: tests are green, the security basics (host/origin checks, path
containment, confirmation gate, scope checks at request and confirm time) are in place and tested.
The weak side is the operator's experience of a run. A factory run lives inside one browser tab's
HTTP request, the dashboard is frozen while it runs, the things that need a human are split across
two views, and a failed order doesn't say why it failed. Most of the UI work below follows from
fixing that one thing (Phase 2).

## Phase 1 - Small fixes (each under an hour or two)

**Status (2026-11-20): done, except 1.4 and 1.5, which move into Phase 2.** Both concern a run being
tied to a browser request, which Phase 2 replaces, so fixing them now would be thrown away. Not
committed. What changed for each item, and how it was checked, is in DEVELOPMENT.md's "Phase 1 fixes
(2026-11-20)". Two items came out differently from the table:

- 1.6: the list endpoint gained a `status` filter rather than output-free summaries. The dashboard now
  asks only for pending approvals; the History tab still loads full records, since its search covers
  output.
- 1.13: the stale `00000000-…` directory is now skipped at load, but not deleted. It is your local
  data, so deleting it is left to you.

| # | Problem | Where | Fix | Basis |
|---|---------|-------|-----|-------|
| 1.1 | A failed work order hides its reason. Inspect shows "No final response yet (failed)". | `WorkOrdersView.tsx` (card renders only `task.finalResponse`) | Show `workOrder.result` / `task.error` on the card, without needing Inspect. | seen (Portify mission) |
| 1.2 | Activity events logged in the same millisecond come out in the wrong order ("created" listed after "started"). | `activityLog.ts:18` sorts on `createdAt` only | Add a per-mission sequence number, or keep insertion order as the tie-break. | seen (`activity.json`: both `…486`) |
| 1.3 | Work order `start` / `refresh` / `cancel` don't check the order belongs to the mission in the URL. Same gap as the known one on scans and reports. | `routes/workOrders.ts:95-118`, `reports.ts:44,103,117`, `scanners.ts:42,114` | One `ownedBy(missionId, record)` helper used by all three routers; 404 otherwise. | read / known |
| 1.4 | Approving a tool ties the process to that HTTP request: reload or close the tab and the approved scan is killed. | `routes/tools.ts` confirm handler, `res.on("close")` → `cancelExecution` | Don't cancel on disconnect for confirm; cancellation is the explicit `/cancel` route. (Goes away with Phase 2.) | read |
| 1.5 | The Approval Queue throws the tool's output away and offers no cancel once running. A long nmap is a disabled button for minutes. | `ApprovalQueue.tsx:37` (`confirmExecution(id, () => {})`) | Show running executions in the queue with live output and a Cancel button. | read |
| 1.6 | The dashboard downloads every execution record with full stdout/stderr (up to 200 records, up to 1 MB per stream) to find the pending ones. | `GET /api/tools/executions`, `useTools` in `FactoryDashboard` | List endpoint returns summaries (no output); output loads when a record is opened. | read |
| 1.7 | `query_findings`, `lookup_cves`, `create_finding`, `validate_finding` put untruncated `parsedOutput` (whole finding objects) into the transcript, next to the same data in `stdout`. | `orchestrator.ts:565-573, 645-653, 810-818, 863-871` | Send one form only and run it through `truncateParsedOutputForTranscript`. Covers the open "trim the knowledge-base tool result" item too. | read / known |
| 1.8 | Every agent is offered `validate_finding`; the validator can confirm without running anything. | `orchestrator.ts:292-332` | Offer it only to `vulnerability-validator`. Record on the verdict whether any real tool ran in that task, and show "agent-asserted" on findings where none did. | known |
| 1.9 | Recon agent's prompt ends "if that isn't clear from the conversation, ask before running anything". A question in prose ends the task as `completed` with nothing done. | `backend/data/agents/recon-agent.json` | Drop the sentence (scope is already in the preamble). Mark an order that completed with zero tool calls and zero records as "no outcome" on its card. | read |
| 1.10 | A failed order still counts in the dashboard's failed banner after a successful Retry. | `FactoryDashboard.tsx` `failedWorkOrders` | Retry stores `retryOf` on the new order; a failed order that has been retried is shown as superseded and not counted. | known |
| 1.11 | No React error boundary: one render error blanks the whole app. | `frontend/src` (none exists) | One boundary around the view area with a reload action. | read |
| 1.12 | `cancelWorkOrder` isn't written to the activity timeline. | `workOrderManager.ts:265` | Log `work_order_cancelled`. | read |
| 1.13 | Stale local data: `backend/data/missions/00000000-…/executions.json` has no `mission.json` and a legacy `projectId` record stuck at `pending_confirmation`. It passes the id pattern, so it is loaded at startup. | `missionStore.ts#listMissionIds` | Skip directories without `mission.json`; delete the directory. | seen |
| 1.14 | The privileged-command check matches `su` as a path segment, so `curl https://host/su/` is refused. | `toolManager.ts:301` | Match the verb only at a command position (start, or after `;`, `&&`, `\|`, `env …`). | read, low priority |

## Phase 2 - Make a run belong to the server, not to a tab

**Status (2026-11-20): done, not committed.** Details in DEVELOPMENT.md's "Phase 2: server-owned
factory runs (2026-11-20)". Differences from the plan below:

- The event stream has four types, not eight: `run_state`, `chunk` (with `workOrderId`),
  `execution_output`, and `changed` (a store was written; re-read it). Work orders, tool requests,
  findings and assets are all covered by `changed`, so clients re-read the list rather than patching
  it from per-record events.
- Run states are `idle | running | waiting_approval | waiting_guidance | blocked` (reason in `reason`).
- Tool output sent before a page reload is not replayed; the queue shows output from then on.

The one structural change, and the one most of the usability problems hang on.

Today `POST /factory/advance` is a single streaming request. Consequences, all **read**:

- Closing or reloading the tab aborts the generation and resets the order to pending.
- Nothing stops two tabs (or a script) advancing the same mission at once. `advanceChain` takes its
  `existing` work-order snapshot before awaiting (`factoryDirector.ts:261-283`), so duplicate
  enumeration orders are possible, and two chains can run side by side.
- The dashboard only refreshes after the request ends. During a 25-order chain the tiles, activity
  and work orders are frozen; the only sign of life is one unlabeled block of streamed text that mixes
  every agent's output and raw tool-call JSON.
- `blockedReason` ("needs a note", "paused after 25 orders") lives in React state and is gone after a
  reload.
- There is no Stop button. `abortRef` exists but only fires on unmount.

Plan:

1. A per-mission run record on the server: `idle | running | waiting_approval | waiting_guidance |
   blocked(reason)`, with the current work order. One run per mission; a second start returns 409.
2. `POST /factory/advance` starts the run and returns. `POST /factory/stop` cancels it.
3. `GET /api/missions/:id/events` streams typed NDJSON events: `run_state`, `work_order_started`,
   `chunk` (with `workOrderId`), `tool_requested`, `execution_output`, `work_order_settled`,
   `finding_recorded`, `asset_recorded`. A client that connects late gets the current state first.
4. Approving or rejecting an execution, or sending guidance, resumes the run on the server. The
   frontend no longer has to call advance again afterwards.
5. The frontend subscribes once per mission and updates its hooks from events instead of refetching
   six lists. The mission switcher lock becomes unnecessary.

This removes items 1.4 and 1.5 as separate work, replaces POLISH C5 (watch mode) and D2 (shared NDJSON
helper), and is the prerequisite for most of Phase 3's dashboard items. It touches
`factoryDirector.ts`, `routes/missions.ts`, `routes/tools.ts`, `FactoryDashboard.tsx`,
`ApprovalQueue.tsx` and the mission-scoped hooks. Roughly the size of the earlier "Factory
transformation" backend half. Do it behind the existing tests for `factoryDirector` and
`workOrderManager`, which already cover the chain logic.

## Phase 3 - UI and usability

**Status (2026-11-21): done, not committed**, except port and path granularity in scope (deferred:
the editor now says plainly that neither is enforced). Details in DEVELOPMENT.md's "Phase 3: UI and
usability (2026-11-21)".

### Factory Dashboard

- **One "Needs you" queue.** Approvals, guidance requests and failed orders in one list at the top.
  Guidance is currently only reachable through Work Orders → Inspect, and the hint pointing there
  disappears on reload. (read)
- **Approval cards say what and why.** Add the tool's description, the target, the timeout, the work
  order's objective, and the agent's text that preceded the request. Today: agent name, the command,
  and a scope line. (read)
- **Labelled live output.** Per work order: agent name, objective, a readable line per tool call
  instead of raw JSON. (read)
- **Stop button** while running. (read)
- **Say what Advance will do.** Under the pipeline: "Next: Recon on portifycv.app" or "Nothing to run
  - 3 findings need review". The button today gives no preview. (seen)
- **"No scope set" is a dead end.** The warning is text only; make it open the mission editor. (seen)
- **Notify when attention is needed.** Runs take minutes; a tab-title count and an optional browser
  notification on a new approval. (read)

### Work Orders

- **Transcript.** Inspect shows only the final answer. Show the agent's messages, each tool call and
  its result, with links to the executions and findings the order produced. (seen)
- **Agent names, duration, tool-call count** on the card. It shows the raw agent id today. (seen)
- **New work order** form (agent, objective, target). The hook's `create` exists but nothing calls it
  except Retry. Without this, four of the eight agents (Code Assistant, General Assistant, Output
  Parser, Planner) can't be reached from the UI at all. Either add the form or delete those agents.
  (seen)
- **Start** on a pending order. Retry currently blocks on a non-streamed request for the whole
  generation, showing only "Retrying…". (read)

### Findings and Assets

- **Add a finding by hand.** The API and the hook support it; there is no button. (read)
- **Assets are read-only and have no actions.** Add: add/edit/remove an asset, mark out of scope,
  "scan this", "create a work order for this". The API is GET-only. (read)
- **Bulk status change** on selected findings; column sorting. (read)

### Mission editor

- **Status is a raw dropdown** including the stages the Director owns. Replace with actions: Pause,
  Resume, Send to review, Complete, Reopen. (seen)
- **Scope entries aren't checked while typing.** Show how each line is understood (domain, wildcard,
  CIDR, URL) and flag ones that match nothing. Add port and path granularity, which is the open
  "recon scanned 1000 ports when the rules named one" item. (seen / known)

### Everywhere

- **Setup checklist** for a first run: Ollama reachable, each agent's model pulled, embedding model
  pulled, which recon tools are missing (`katana`, `subfinder`, `amass`, the wrong `httpx`), with the
  install command. Today each of these shows up later as a failed order. (known)
- **Empty states** are one line of grey text. Give each a next action. (seen)
- **Narrow screens:** the nav becomes a horizontal strip and the active item scrolls out of view. (seen
  at 375px)
- **Screen readers:** there is no `aria-live` or `role="status"` anywhere, so streamed output, new
  approvals and errors are silent. Errors are small red text; add a consistent error/notice
  component. (read)
- **Tool Registry:** no search or filter over ~20 tools. (seen)

## Phase 4 - Backend

- **Remove API surface nothing calls.** `/api/plans` and `multiAgentOrchestrator.ts` (278 lines plus
  284 of tests), `POST /api/orchestrator/tasks`, `/tasks/:id/continue`, `/tasks/:id/resume`. The
  frontend uses only `GET /tasks/:id` and `/tasks/:id/guidance`. These are unauthenticated endpoints
  that start agent runs outside the work-order model. Also the already-planned `toolRegistry.ts` /
  `types/tool.ts`. (read)
- **Context budget.** The whole transcript is resent on every step. Twenty tool results at up to
  4 KB per field can pass the 16k window, and the only response is a log warning
  (`chatService.ts:84`) while Ollama drops the start of the prompt, which is where the tool
  instructions are. Elide or summarize old tool results when `prompt_eval_count` nears `num_ctx`.
  (read)
- **Persistence.** A task is written to disk only when an `advanceTask` run ends, so a crash loses
  that run's transcript. Every store rewrites its whole per-mission file on each change, including
  full tool output in `executions.json`. Persist after each step; move execution output to one file
  per execution. (read)
- **One source for enums and validation.** Finding types, severities and statuses are listed
  separately in `routes/findings.ts`, `orchestrator.ts` and the frontend; request bodies are
  validated by hand in every route. Export the lists from `types/` and consider a schema library.
  (read)
- **Route-level tests** (POLISH D1) for the routes that mutate: tools, work orders, missions. The
  mission-ownership fix in 1.3 is exactly what these would have caught. **Status codes** (D3):
  `POST /api/missions` returns 200, findings and work orders 201. (read / known)
- **Carried over, unchanged:** time cap checked only between generations; IPv4-mapped IPv6 against an
  IPv4 out-of-scope entry; report prose can overstate an unverified finding; agents re-request
  rejected tools; MCP steps 3 and 4. (known)
- **Rerun a full mission at the 16k context window** before spending time on agent-behavior items.
  Every earlier live run was at 2048 tokens, so several of those observations may no longer hold.
  (known)

## Phase 5 - Docs

`DEVELOPMENT.md` is 3,907 lines (300 KB) and `CLAUDE.md` asks for it to be read before non-trivial
changes. `TODO.md` is 1,426 lines, most of them completed items. Move finished sections to
`docs/history/`, keep `DEVELOPMENT.md` to current architecture and decisions, and keep `TODO.md` to
open items only. Fold `POLISH.md`, `rework.md` and this file's remaining items into it.

## Suggested order

1. Phase 1 items 1.1-1.3, 1.6-1.13: independent, small, no design decisions.
2. Rerun one full mission at 16k context and note what actually goes wrong for the operator.
3. Phase 2.
4. Phase 3, dashboard and work orders first.
5. Phase 4 cleanup and Phase 5, in any gaps.
