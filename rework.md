# 8Rack → Bug Bounty Factory: transformation report

This documents the transformation of 8Rack from an agent-centric AI workstation into a
Mission-centric "bug bounty factory," per the 20-section architecture spec that initiated this
work. The existing agent framework, Ollama integration, tool execution/confirmation system, and
both orchestration layers (`orchestrator.ts`, `multiAgentOrchestrator.ts`) were **extended, not
rewritten** — every new service in this transformation sits above or alongside them and reuses
them directly (see "Modified services" below for exactly where).

A prior session had already built a first pass at the Mission concept, deliberately layered onto
the existing `Project` entity/API rather than renamed, with Assets derived from Findings client-side
rather than stored. This transformation explicitly reverses both of those lower-churn calls (full
rename, real Asset store) on direct instruction, and builds everything else the spec asked for that
didn't already exist: the Factory Director, Security Work Orders, an automated Validation stage, a
Report status machine, an explicit Activity event log, and the full Mission-centric UI (Factory
Dashboard, Pipeline, Approval Queue, Work Orders, Evidence, and nav redesign).

The full narrative write-up, with the reasoning behind every non-obvious decision, lives in
**`DEVELOPMENT.md`'s "Bug Bounty Factory transformation" section** — this document is the
structured summary the original spec asked for; that section has the prose.

---

## Architecture changes

- **`Project` renamed to `Mission` throughout** — not just field-level. Every route, service,
  type, hook, and API client that referred to a project now refers to a mission (`projectId` →
  `missionId` everywhere, `/api/projects` → `/api/missions`, `backend/data/projects/` →
  `backend/data/missions/` on disk). No back-compat shims — this is a local, no-auth, single-user
  app with no external consumers of the API, so a clean rename was safe.
- **`Mission.status` expanded** from 4 values (`planning/active/paused/completed`) to the spec's
  full 10-stage pipeline: `draft → ready → recon → investigating → validating → reporting → review
  → completed`, plus `paused`/`cancelled`. Old values on disk are migrated to their nearest
  equivalent on read (`migrateMissionStatus()`), so no manual data migration was needed.
- **Assets became a real, stored, first-class entity** (`assetManager.ts`) instead of being
  derived from `Finding[]` on every render. Ingestion is centralized in one place (mirroring how
  scope-checking is already centralized) — `findingsManager.ts`'s finding-ingest path and a new
  `upsert_asset` orchestrator pseudo-tool both funnel into `assetManager.ts#upsertAsset`, which
  dedups by `(missionId, type, value)` and tracks a `parentId` tree
  (domain → subdomain → url → port → service).
- **A new orchestration layer, the Factory Director** (`factoryDirector.ts`), sits above
  `multiAgentOrchestrator.ts`. It reads a mission's scope/assets/findings/work orders and
  deterministically (rule-based, not an LLM planning call — see "Known issues/design notes" below
  for why) creates and starts Security Work Orders, auto-chaining through everything that doesn't
  need human approval and pausing exactly where a work order's underlying task would. It never
  duplicates orchestration logic — every work order it starts runs through the existing
  `orchestrator.ts` via `workOrderManager.ts#startWorkOrder`, exactly the same reuse pattern
  `multiAgentOrchestrator.ts#createPlan` already established one level down.
- **Security Work Orders** (`workOrderManager.ts`) are the new trackable unit of factory work —
  each one is backed 1:1 by a real `OrchestratorTask`, so it can request tools and pause for
  confirmation like any other agent task, with no second execution mechanism.
- **Finding Validation became a real pipeline stage**, not just a possible manual status change:
  an unsettled finding auto-gets a Validation work order assigned to the Vulnerability Validator
  agent, whose system prompt now spells out an explicit checklist (reproducible? in scope? evidence
  sufficient? impact realistic? duplicate? right severity?), and a new `validate_finding`
  pseudo-tool is how it records its verdict — findings are never auto-confirmed.
- **Report generation gained a status machine** (`draft/ai_generated/human_review/ready/
  submitted`) instead of being a fire-and-forget artifact.
- **Mission activity became an explicit, first-class event log** (`activityLog.ts`) instead of
  being derived/inferred from tool-execution and task-transcript history — every real action
  (mission created, asset discovered, work order lifecycle, finding created/validated, report
  generated, and scope-blocked executions) now logs a named `MissionEvent`.
- **The frontend became Mission-centric.** The app now defaults to a Factory Dashboard instead of
  an agent picker; primary navigation is Factory/Missions/Assets/Work Orders/Findings/Evidence/
  Reports/Agents/Tools, with the pre-existing Chat/Workbench/Plans views kept reachable as a
  secondary group (per the spec's own "extend, don't replace" instruction) rather than removed.

## New storage structures

All new stores follow the exact same convention every existing project/mission-scoped store already
used: an in-memory `Map`, write-through to one JSON file per mission under
`backend/data/missions/<id>/`, hydrated from disk at server startup, and an `onMissionDeleted`
purge-handler registered at module load so a deleted mission can't leave ghost records.

| File (per mission) | Backed by | Entity |
| --- | --- | --- |
| `assets.json` | `services/assetManager.ts` | `Asset` (`types/asset.ts`) |
| `workorders.json` | `services/workOrderManager.ts` | `WorkOrder` (`types/workOrder.ts`) |
| `activity.json` | `services/activityLog.ts` | `MissionEvent` (`types/missionEvent.ts`) |

`mission.json` (was `project.json`) itself gained no new file, just new fields (`status`'s expanded
enum) and a read-time migration. `findings.json`'s `Finding.evidence[]` items gained their own `id`
plus optional `agentId`/`executionId` refs (still embedded on the finding, not a new file — see
"Design notes" below for why Evidence didn't get its own store). `reports.json`'s `Report` gained a
`status` field, no new file.

## New API routes

All mounted under the renamed `/api/missions` (was `/api/projects`):

| Route | Purpose |
| --- | --- |
| `GET /api/missions/:id/assets` | List a mission's Asset Inventory |
| `GET /api/missions/:id/workorders` | List a mission's Work Orders |
| `POST /api/missions/:id/workorders` | Manually create a Work Order |
| `GET /api/missions/:id/workorders/:workOrderId` | Fetch one Work Order |
| `POST /api/missions/:id/workorders/:workOrderId/start` | Start a pending Work Order |
| `POST /api/missions/:id/workorders/:workOrderId/refresh` | Re-sync a Work Order's status from its underlying task |
| `POST /api/missions/:id/workorders/:workOrderId/cancel` | Cancel a Work Order |
| `POST /api/missions/:id/factory/advance` | Run the Factory Director one step (streamed NDJSON, auto-chains) |
| `GET /api/missions/:id/activity` | List a mission's explicit event log |
| `PATCH /api/missions/:id/reports/:reportId` | Transition a report's status |

Every existing route (`/findings`, `/scans`, `/tools`, `/orchestrator`, `/plans`, `/agents`, `/rag`)
is unchanged in shape — only the `projectId` → `missionId` rename touched them.

## Modified services

| Service | What changed |
| --- | --- |
| `missionManager.ts` (was `projectManager.ts`) | Renamed; `MissionStatus` migration on read; logs `mission_created`/`mission_status_changed` (at the route layer — see design note) |
| `missionStore.ts` (was `projectStore.ts`) | Renamed; directory literal `data/projects` → `data/missions` |
| `findingsManager.ts` | Central asset-mirroring on ingest (`upsertAsset` for domain/subdomain/port/service/technology/api findings); new `validateFinding`; logs `finding_created`/`finding_status_changed`/`finding_validated` |
| `orchestrator.ts` | Two new pseudo-tools, `upsert_asset` and `validate_finding`, mirroring the existing `create_finding` exactly |
| `reportManager.ts` | `status: "ai_generated"` on creation; new `updateReportStatus`; logs `report_generated`/`report_status_changed` |
| `toolManager.ts` | Logs `scope_blocked` at both points `checkExecutionScope` can reject an execution |
| `multiAgentOrchestrator.ts` | Untouched logic-wise — read closely as the reuse pattern `factoryDirector.ts`/`workOrderManager.ts` both follow |

## New services

`assetManager.ts`, `workOrderManager.ts`, `factoryDirector.ts`, `activityLog.ts` — all described
under "Architecture changes" above.

## Modified frontend components

| Component | What changed |
| --- | --- |
| `layout/types.ts` / `Sidebar.tsx` | `AppView` expanded to the spec's primary nav; `chat`/`workbench`/`plans` demoted to a secondary sidebar group; default view → `"factory"` |
| `App.tsx` | Every new view wired into the existing lazy-mount-then-hide pattern |
| `AssetsView.tsx` | Repointed from a `findings: Finding[]` prop to real `Asset[]` via a new `useAssets` hook; became a standalone nav view instead of a `FindingsView` tab |
| `FindingsView.tsx` | Reduced to Table/Timeline/Graph tabs — Assets/Activity/Reports extracted to their own nav views |
| `ReportsPanel.tsx` | Gained a status dropdown per report |
| `AgentEditor.tsx` | Embeds the new `AgentToolAccess` widget as a live preview |
| `ActivityFeed.tsx` / `useActivity.ts` | Switched from deriving activity off executions+tasks to fetching the real `/activity` endpoint |

## New frontend components

`FactoryDashboard.tsx`, `FactoryPipeline.tsx` (embedded in the Dashboard), `ApprovalQueue.tsx`
(embedded in the Dashboard), `WorkOrdersView.tsx`, `EvidenceView.tsx`, `MissionsView.tsx`,
`AgentsView.tsx`, `ToolsView.tsx`, `AgentToolAccess.tsx`, plus the new `useAssets.ts`/
`useWorkOrders.ts` hooks and `assetsApi.ts`/`workOrdersApi.ts`/`factoryApi.ts`/`activityApi.ts`
API clients.

## Design notes (deliberate deviations from a literal spec reading)

1. **Factory Director planning is deterministic/rule-based, not a free-form LLM planner.** Reliable
   and testable end-to-end; the existing `planner` agent could be layered in later as a smarter
   planning step without changing the Director's shape.
2. **Evidence stays an enhanced embedded array on `Finding`, not a new top-level store.** Each
   `EvidenceItem` gained its own `id` and optional `agentId`/`executionId` refs, giving the full
   Finding→Evidence→ToolExecution→Agent→Mission trace without a CRUD surface for something never
   listed independently of its finding. `EvidenceView.tsx` still exists as a real nav item — it's a
   client-side flatten of already-fetched finding data, not backed by a new endpoint.
3. **The Factory Director is request-driven, not a background timer** — consistent with the rest
   of this app (nothing here runs on a poll loop).
4. **Settings stayed a modal, not a tab** — converting it to a persisted `AppView` tab would
   regress its current "reachable from any view" behavior.
5. **Chat/Workbench/Plans were kept reachable**, not removed, despite not appearing in the spec's
   literal 10-item nav list — per the spec's own "extend, don't replace the existing working
   architecture" instruction.
6. **Report generation is not auto-triggered by the Factory Director.** The Director advances a
   mission's `status` to `"reporting"` once everything else has settled, but leaves the actual
   `POST /api/missions/:id/reports` call to a human — the same approval-gate spirit as every other
   step in this app.

## Tests performed

All work was built and verified in independently-checked passes (each gated on a clean typecheck +
full test suite before the next began), converging on:

- **Backend**: `cd backend && npm run typecheck` — 0 errors. `npm test` — **458/458 passing**
  (baseline was 395 before this transformation; net +63 new tests across
  `assetManager.test.ts`, `workOrderManager.test.ts`, `factoryDirector.test.ts`,
  `activityLog.test.ts`, plus extensions to `missionManager.test.ts`, `orchestrator.test.ts`,
  `findingsManager.test.ts`, `reportManager.test.ts`, `toolManager.test.ts`).
- **Frontend**: `cd frontend && npx tsc -b` — 0 errors. `npm run lint` — 3 warnings, exactly the
  documented pre-existing baseline (`OrchestratorTaskView.tsx`), no new ones. `npm test` —
  **303/303 passing** (baseline was 271; net +32 new tests across `useAssets.test.ts`,
  `useWorkOrders.test.ts`, and one `.test.tsx` per new component).
- **Live end-to-end verification** against the real running backend + a real local Ollama model
  (see "Exact commands" below for the full transcript) — not just the unit suites.

## Known issues

- **The Factory Director never retries a Work Order once one exists for an agent, even a failed
  one** — deliberate ("a human-attention signal, not something to paper over"), but there's no UI
  affordance yet nudging a human toward the recovery path (manually `POST` a fresh Work Order for
  the same agent, confirmed as the actual working path during live verification). A "Retry" button
  on a failed Work Order card would close this.
- **`CLAUDE.md`'s "Agents" section is stale**, pre-existing and unrelated to this transformation:
  it claims agent configs are read fresh from disk on every request; `agentManager.ts` actually
  caches them after first load and needs `POST /api/agents/reload` (or an edit through the app's
  own agent editor) to pick up a direct file edit. Surfaced while temporarily repointing agents at
  an available model for live testing.
- **Local-model tool-call formatting compliance remains an open, pre-existing characteristic**, not
  a defect: during live testing, a 27B model validating a finding reasoned in prose before emitting
  the `validate_finding` tool call and got cut off by `maxTokens`, so the reply was correctly
  treated as a plain-text answer rather than a tool call (no state changed — re-run with a more
  directive prompt worked cleanly). The same gap already documented in this codebase's original
  "Tool-calling round trip" notes. Worth considering a higher default `maxTokens` for
  `vulnerability-validator` given its new, longer checklist-driven system prompt.
- The two Medium and remaining Low items already open in `TODO.md` from the prior audit (project-
  scoped data hooks landing stale responses on a quick mission switch; `ProjectPanel.disabled` now
  `MissionPanel.disabled` not wired in the Workbench) are unaffected by this transformation and
  remain open — out of scope here.

## Exact commands used to verify the complete workflow

```bash
# Automated verification (both sides)
cd backend && npm run typecheck && npm test      # 458/458
cd frontend && npx tsc -b && npm run lint && npm test   # 303/303, lint at baseline

# Live stack
./start.sh   # backend :3001, frontend :5173 (Ollama already running separately)

# End-to-end factory flow (curl), reproducing spec section 18:
curl -X POST localhost:3001/api/missions -H 'Content-Type: application/json' -d '{
  "name": "ACME Bug Bounty", "notes": "Authorized external assessment",
  "scope": ["example.com", "*.example.com"], "outOfScope": ["staging.example.com"],
  "rules": "No DoS testing" }'
# → mission created

# Failure path: out-of-scope target blocked
curl -X POST localhost:3001/api/tools/request -H 'Content-Type: application/json' -d \
  '{"missionId":"<id>","tool":"bash","arguments":["-c","curl https://evil-out-of-scope.test"]}'
# → 403 OUT_OF_SCOPE, and a real "scope_blocked" event lands in GET /api/missions/<id>/activity

# Start the factory
curl -X POST localhost:3001/api/missions/<id>/factory/advance
# → seeds + starts a Recon work order; recon-agent calls upsert_asset for real;
#   mission.status auto-advances (none) -> recon

curl -X POST localhost:3001/api/missions/<id>/factory/advance
# → notices the new asset, seeds + runs an Enumeration work order for web-analyzer;
#   status auto-advances recon -> investigating

# web-analyzer calls create_finding for real -> a genuine `potential` finding exists

curl -X POST localhost:3001/api/missions/<id>/factory/advance
# → auto-seeds a Validation work order targeting vulnerability-validator for that finding

curl -X POST localhost:3001/api/missions/<id>/workorders/<validationWoId>/start
# → the Validator runs the real checklist-driven system prompt, correctly identifies the
#   finding has no evidence, and calls validate_finding with verdict false_positive;
#   the finding's status/severity/validatedBy transition for real, with a real
#   agent_reasoning EvidenceItem attached

curl -X POST localhost:3001/api/missions/<id>/reports -H 'Content-Type: application/json' \
  -d '{"title":"ACME Bug Bounty - Interim Report","findingIds":["<findingId>"]}'
# → streamed NDJSON, report-writer generates a real two-section Markdown report,
#   status defaults to "ai_generated"

curl -X PATCH localhost:3001/api/missions/<id>/reports/<reportId> -H 'Content-Type: application/json' \
  -d '{"status":"human_review"}'
# → status transitions to "human_review"

curl localhost:3001/api/missions/<id>/activity
# → every one of the above appears as its own correctly-typed named event, in order:
#   mission_created, scope_blocked, mission_status_changed x2, asset_discovered,
#   work_order_created/started/completed x4 (one per work order), finding_created,
#   finding_validated, report_generated

# Browser verification (Claude in Chrome against the real running frontend):
# Factory Dashboard (stat tiles, pipeline stages, recent activity - all real data),
# Work Orders (grouped by status, real objectives/agents/targets), Assets (real Asset[]
# via useAssets, not findings-derived), Findings (reduced to Table/Timeline/Graph, the
# validated finding showing its real false_positive/info state), Evidence (the real
# agent_reasoning item with correct finding/agent attribution).
```
