# TODO

All 11 tasks from the original build plan are done (see `DEVELOPMENT.md` for the full history).
This is the actionable list for what's next.

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
- [ ] Security scanners (`types/scanner.ts`, `extensions/scannerRegistry.ts`)
- [ ] Report generation (`types/report.ts`, `extensions/reportGenerator.ts`)
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
- [ ] Project-scoped chat — projects now exist (see "Next up" above) but only scope tool execution
      history and Orchestrator tasks; chat is still exactly one global `sessionStorage` session, on
      purpose (deliberately deferred, not forgotten — see DEVELOPMENT.md's "Projects" section for
      why). Making chat project-aware too is the natural follow-up once that's actually wanted.
