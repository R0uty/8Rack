# 8Rack history

How 8Rack got to where it is: the build notes, audits and plans, kept as they were written. Nothing
here is kept current. `DEVELOPMENT.md` describes the system as it is now and `TODO.md` lists open
work; when they disagree with a file here, they win.

Code comments and old notes refer to sections by their heading ("see the Security scanners
section"). Every heading of the old `DEVELOPMENT.md` is listed below with the file it now lives in.

## [Part 1: from chat app to tool workstation (to 2026-08)](development-1-workstation.md)

- Stabilization pass (make-it-work audit)
- Status
- Architecture
- Key decisions (the "why", not visible from the code alone)
- Known gaps / things to check on the next session
- Extension points (Task 11)
- Agent Manager & Chat Service
- Tool Execution Framework (Phase 1: engine + confirmation gating, no orchestrator/UI yet)
- Orchestrator
- Workbench UI (Tool Registry + Execution Console + interactive Orchestrator)
- Projects
- Automated tests
- Multi-Agent Orchestration
- Premium UI/UX Redesign
- Per-agent model override + parallel agent sessions
- RAG over a workspace codebase
- Logo/favicon + a small polish pass
- Agent.tools activation
- start.sh: PID-tracked process cleanup
- Execution history search + bookmarks
- Frontend hook/component tests
- Orchestrator task continuation
- Cancelling a waiting_confirmation task left the execution stuck forever
- Concurrent task sessions per agent
- Human-in-the-loop tool failure recovery (waiting_guidance)
- Security scanners (Scan Profiles)
- Persistent top-level views (nav-switch state loss)
- Full-project audit
- Report generation
- Fixed: projectId path-traversal
- Fixed: the six Medium audit findings
- Fixed: the seven Low audit findings
- Project-scoped chat
- Tool Registry UI: version, path, enable/disable, category rework
- Execution records now carry an agentId

## [Part 2: missions and the bug bounty factory (2026-08 to 2026-11-06)](development-2-missions-and-factory.md)

- Bug Bounty Mission Workspace (Task 3)
- Findings & Evidence System (Task 4)
- Embedding-only models are hidden from the chat/agent model pickers
- Fixed: mission-scope enforcement bypasses (2026-08-08 audit, Medium)
- Fixed: outbound HTTP had no timeout anywhere (2026-08-08 audit, Medium)
- Fixed: streamed tool output was uncapped, no global execution concurrency limit (2026-08-08 audit, Medium)
- Tool selection hints - teaching an agent which tool fits an objective, without the objective naming one
- Fixed: agent-driven write_file couldn't actually write content
- Fixed: deleteProject left ghost records in every service's in-memory store (2026-08-08 audit, Medium)
- Fixed: task transcripts grew unboundedly, embedding full tool output (2026-08-08 audit, Medium)
- Bug Bounty Factory transformation (Missions, Assets, Work Orders, Factory Director, Validation, Report status, factory UI)
- Nav simplification: cut Chat/Workbench/Plans and a standalone Evidence view
- Audit and fix pass (2026-11-05)
- UI cleanup (2026-11-05)
- End-to-end mission run (2026-11-05)
- Report evidence from recorded runs (2026-11-06)

## [Part 3: MCP and the 2026-11 review phases](development-3-mcp-and-review.md)

- Planned: MCP servers as the tool and RAG providers (design, 2026-11-08)
- MCP client (step 1, 2026-11-08)
- RAG server (step 2, 2026-11-08)
- MCP tool server (step 3, 2026-11-08), after Phase 4 (written later, merged after it)
- Fixed: every agent call ran in a 2048-token context window (2026-11-08)
- Phase 1 fixes (2026-11-20)
- Phase 2: server-owned factory runs (2026-11-20)
- Phase 3: UI and usability (2026-11-21)
- Phase 4: backend (2026-11-21)
- Validators reuse runs instead of re-scanning (2026-11-21)
- A cancelled order no longer leaves its run "waiting" (2026-11-23)
- First live mission on the MCP tool server (2026-11-23)
- Record-only calls get their own cap (2026-11-23)
- MCP scanner runs are reused too (2026-11-24)

## Plans and lists

- [todo-archive.md](todo-archive.md) - the old `TODO.md`: audit findings (2026-08-07, 2026-08-08,
  2026-11-05) with how each was fixed, the original task specs, and the done items of every pass.
  Its open items were carried into `TODO.md` on 2026-11-21.
- [polish-plan-2026-09.md](polish-plan-2026-09.md) - the old `POLISH.md` (phases A-D, 2026-09-20).
- [factory-transformation-report.md](factory-transformation-report.md) - the old `rework.md`: the
  structured summary of the bug bounty factory transformation.
- [review-plan-2026-11.md](review-plan-2026-11.md) - the old `PLAN.md`: the 2026-11-09 review and its
  five phases, all done by 2026-11-21.
