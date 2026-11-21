> Archived 2026-11-21 from DEVELOPMENT.md (lines 2373-3594). A record of what was built and why at the time; it is not kept
> current. For the current design see DEVELOPMENT.md; for open work see TODO.md.

# 8Rack - Development notes, part 2: missions and the factory

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

