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
- [ ] Read `Agent.tools?: string[]` when building the agent-chat request so selecting an agent
      activates its own tools automatically — moot until a native-tool-calling tool exists again
      to activate.
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
- [ ] Add a "project" concept (selection UI + persisted per-project state) — currently there's
      exactly one global chat session and one global (in-memory, unpersisted) tool execution
      history; the spec's "every execution belongs to the currently selected project" assumes
      projects exist, and they don't yet.

## Polish / hardening

- [ ] Add automated tests (backend: route + service tests — `agentManager.ts` and `chatService.ts`
      are the highest-value first targets, see DEVELOPMENT.md; frontend: at least the hooks). All
      verification so far has been manual (curl + browser automation).
- [ ] Improve the dev-mode "backend unreachable" error message — currently generic because Vite's
      proxy returns an HTML 502 page instead of JSON (see `frontend/src/services/api.ts`).
- [ ] Add schema validation feedback for malformed `backend/data/agents/*.json` files — invalid
      files are currently skipped silently (`console.warn` only, not surfaced to the UI).
- [ ] `start.sh` kills anything matching the dev-server process patterns before launching — revisit
      if this ever needs to coexist with other projects' dev servers on the same machine.

## Later (once a real tool is wired up)

- [ ] RAG (`types/rag.ts`, `extensions/retrievalRegistry.ts`)
- [ ] Security scanners (`types/scanner.ts`, `extensions/scannerRegistry.ts`)
- [ ] Report generation (`types/report.ts`, `extensions/reportGenerator.ts`)
- [ ] Plugin system (`types/plugin.ts`, `extensions/pluginRegistry.ts`)
- [ ] Multi-agent orchestration (`types/orchestration.ts`, `extensions/orchestrator.ts`) — now that
      `chatService.ts#streamAgentChat` exists as an HTTP-independent "run this agent" primitive,
      an orchestrator can call it directly for each step of a sequential or parallel plan.
- [x] Real tool execution for recon (nmap, ffuf, nuclei, httpx, etc.) — done as the Tool Execution
      Framework above (`toolManager.ts`/`toolExecutor.ts`/`tools/exec/builtins.ts`), separate from
      the in-process `Tool`/`toolRegistry` used by the tool-calling round trip.
- [ ] Project-based conversations / a memory system — currently there's exactly one global chat
      session (`sessionStorage`) and one global tool execution history, no concept of separate
      projects or targets. See the Tool Execution Framework section for why this matters now too.
