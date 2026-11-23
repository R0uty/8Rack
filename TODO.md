# 8Rack - TODO

Open work only. Each item was re-checked against the code on 2026-11-21, when this list replaced the old
`TODO.md`, `POLISH.md`, `rework.md` and `PLAN.md`. Those are kept as they were in `docs/history/`,
together with how every closed item was fixed. When you finish an item, delete it here and note the
design change in `DEVELOPMENT.md` if there is one.

## Agent behaviour (seen in live runs)

These are what an operator notices most. All were seen on `qwen2.5-coder:7b`, the 2026-11-21 run at
16k context included.

- [ ] **A validator can do the work and still skip the verdict.** Seen 2026-11-21: one ran its check,
      reasoned the port was open, and ended in prose without calling `validate_finding`. The finding
      stayed `potential` and the Director seeded a second order for it. That one got the reused run
      and recorded the verdict, but it cost a whole agent run. Same root cause as "Agents write findings as text" below.
- [ ] **Repeated `http_request` still asks every time.** The Web Analyzer asked again for a URL it had
      already fetched in the same order. `http_request` is deliberately not reused, because a web
      response can change between requests. A per-task "you already fetched this" note, like the one for
      rejected repeats, might be enough.
- [ ] **Agents write findings as text instead of calling the tool.** The Web Analyzer replied with
      findings as markdown JSON blocks without a `tool` key, so nothing was recorded. One of them was
      an invented XSS. It ended with a question to the user. The order was correctly marked "no tool
      used". Options: a format-correction retry when a reply has finding-shaped JSON but no tool
      call, and/or a stricter Web Analyzer prompt.
- [ ] **The validator can confirm without evidence.** A verdict now records which real runs it rests
      on, and the UI labels one with none as "Unverified". But `confirmed` is still accepted without a
      run. Earlier runs confirmed a misidentified `ppp?` service and "Outdated Python" as high.
      Consider requiring a completed execution in the task before accepting `confirmed`.
- [ ] **Report prose can overstate a finding.** The prompt gives each finding's status and asks for
      conditional wording, but nothing checks the output. The model has described made-up evidence as
      real right next to the label saying nothing backs it.
- [ ] **Report remediation loses code blocks.** Sanitizing removes all of them, real config snippets
      included. Accepted for now: a lost snippet costs less than invented scan output.
- [ ] **A tool-call compliance check across agents and models** (from POLISH D5). A small harness that
      runs each agent's typical objective and counts well-formed tool calls. It would make the items
      above measurable instead of anecdotal.

## Factory and data

- [ ] **Duplicate assets under different names.** One port showed up as `port 3001/tcp`,
      `service 3001/tcp:http`, `service 3001` and `service http`. Normalize agent `upsert_asset` values
      against the parser-recorded port/service assets.
- [ ] **Scope by port and path.** Scope entries with a port or path are accepted, but only the host is
      enforced. The editor warns on each such line. Seen live: with rules naming one port, recon scanned
      the top 1000.
- [ ] **Retry and guidance get a 409 while a run is going**, instead of queueing behind it.
- [ ] **Tool output printed before a page reload isn't replayed.** Keep a server-side tail per running
      execution and send it when a client connects.
- [ ] **Abandoned `pending_confirmation` executions keep their stdin in memory**
      (`toolManager.ts#pendingStdin`) until the mission is deleted or the backend restarts. A large
      `write_file` payload stays resident.
- [ ] **Binary evidence (screenshots)** on findings (POLISH C1): an upload endpoint and a storage
      directory under the mission.
- [ ] **A Scan Profile composer** (POLISH C2). The four profiles are hardcoded in
      `scanners/builtins.ts`.
- [ ] **Mission export**: a zip of the mission's files and evidence, for archiving or submission
      (POLISH C4).
- [ ] **Activity timeline filters**, by event type and agent (POLISH C6).
- [ ] **Report generation as the last automatic step:** deliberately not done. The Director stops at
      `reporting` and a human generates the report. Revisit only if that changes.

## MCP (step 4 and what step 3 left)

Design and reasoning: `DEVELOPMENT.md`, "Knowledge base and MCP", and in full in
`docs/history/development-3-mcp-and-review.md` ("Planned: MCP servers as the tool and RAG providers").

- [ ] **Local or MCP per tool.** Step 3 put each MCP tool beside the local one as its own
      `<server>.<tool>` catalog entry; the setting that picks one execution path for a tool wasn't
      built. Decide whether step 4's comparison needs it, or whether agents' `execTools` allowlists are
      enough to point a mission at one side. Seen 2026-11-23: mission rules saying "use the `tools.*`
      tools" were followed by recon and the Web Analyzer but not by validators, which used local
      `nmap` and `http_request` (the tool server has no `http_request`).
- [ ] **Repeated MCP requests always ask again.** MCP runs are never reused, so the Web Analyzer
      re-asking for recon's httpx, nmap and katana, and a retried recon order, each needed a new card
      for an identical command. Extend `findReusableRun` to MCP runs of the same read-only scanners.
- [ ] **Agents don't know the scanning host's paths.** An agent told about a missing wordlist guessed
      `/workspace/wordlists/...`, which the server refuses (outside `/workspace/8rack`), and nothing
      keeps the server's workspace in step with 8Rack's. Tell agents in the preamble that MCP tool
      paths are relative to the server's workspace, and consider syncing `wordlists/` to it.
- [ ] **Live output for MCP runs.** An MCP tool's output arrives only when the call ends; local runs
      stream it to the approval card.
- [ ] **Scan source IP.** Record the scanning host's address on each mission (some programs require
      registered source IPs) and show it on the approval card.
- [ ] **Server unreachable.** A run whose connection drops already settles as failed, and Tools → MCP
      servers shows the server's error. Still missing: a request for a tool on an offline server fails
      as "tool not found" (its tools leave the registry) instead of saying the server is offline.
- [ ] **4. Compare, then remove the local executor.** Run the same mission both ways; remove
      `toolExecutor.ts` execution only once findings, assets and reports match.
- [ ] **Remove the local knowledge-base index** (`ragIndex.ts`, `backend/data/rag/`, the `ollama.ts`
      embedding call) once the RAG server has been used for real, so there's one implementation.
- [ ] **Later, separately:** consider Ollama's native tool-calling for MCP tools instead of the
      plain-text convention.

## Engineering

- [ ] **Route tests for the rest:** findings, assets, reports, scans and agents (missions, work orders
      and tools have them; use `test-utils/httpHarness.ts`).
- [ ] **One NDJSON helper.** `routes/reports.ts`, `routes/scanners.ts` and `routes/missions.ts` (events)
      each write their own lines and terminal error; `streamUtils.ts#pipeNdjsonStream` covers only chat.
- [ ] **A shared status-transition helper.** Each service settles its own statuses. That's where most
      race and stuck-`running` bugs came from, and why startup repair exists in several places.
- [ ] **`InvalidToolArgumentsError` shows `WORKSPACE_ROOT`'s absolute path** to any caller. It's a
      local-only app, so the impact is low.

## Security notes (accepted, not fixed)

- [ ] **Prompt injection is reduced, not solved.** Target-controlled text reaches agent transcripts and
      the report prompt. Report prompts mark finding data as untrusted, and Markdown doesn't load
      remote images, but a local model can still follow injected text. The approval gate on every
      real tool run is the control that matters.
- [ ] **No authentication.** Safety rests on listening on 127.0.0.1 plus the host and origin checks.
      Anything that changes that (binding to a LAN address, a reverse proxy) needs real auth first,
      since `POST/PUT /api/agents` can rewrite an agent's prompt and tool list.

## Not yet seen live (tests only)

- [ ] The Work Orders transcript (Inspect) on a real order, adding a finding by hand, and bulk status
      change.
- [ ] Context-budget shortening. A 16k mission hasn't come close to the limit; it would take a longer
      mission or a smaller `OLLAMA_NUM_CTX`.

## Local environment (this machine, not the code)

- [ ] `katana`, `subfinder` and `amass` aren't installed, and `/usr/bin/httpx` is the Python tool, not
      ProjectDiscovery's. The setup checklist has the install commands.
