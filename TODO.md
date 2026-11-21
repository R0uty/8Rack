# 8Rack - TODO

Open work only. Each item was re-checked against the code on 2026-11-21, when this list replaced the old
`TODO.md`, `POLISH.md`, `rework.md` and `PLAN.md`. Those are kept as they were in `docs/history/`,
together with how every closed item was fixed. When you finish an item, delete it here and note the
design change in `DEVELOPMENT.md` if there is one.

## Agent behaviour (seen in live runs)

These are what an operator notices most. All were seen on `qwen2.5-coder:7b`, the 2026-11-21 run at
16k context included.

- [ ] **Validators re-run scans that were already done.** In the 2026-11-21 run, 4 of 5 validators asked
      for the same `nmap -sV --top-ports 1000` that recon had already run, to confirm a single port. Each
      one is an extra approval card with nothing new behind it. Options: give the validator the matching
      execution's output in its objective, or point it at a narrow check (`-p <port>`, `http_request`).
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

## MCP (steps 3 and 4)

Design and reasoning: `DEVELOPMENT.md`, "Knowledge base and MCP", and in full in
`docs/history/development-3-mcp-and-review.md` ("Planned: MCP servers as the tool and RAG providers").

- [ ] **3. A tool server beside the local executor.** A Python project in `mcp-servers/tools/`, running
      on the scanning host over HTTPS and checking the bearer token from `MCP_TOKEN_<ID>`.
      - It reimplements the ExecTools: definitions, argument checks, timeouts, output limits, and
        killing the process group on cancel. It runs argument lists, never a shell.
        `toolExecutor.ts` and `tools/exec/builtins.ts` are the reference.
      - It returns raw stdout, stderr and exit code, so the parsers keep working. It owns path
        containment on its own filesystem.
      - 8Rack keeps the approval gate, the scope checks (at request and confirm time), the
        enable/disable overrides, `ingestExecution`, and history.
      - A setting picks local or MCP execution.
      - This step also brings the enable switch (discovered tools start disabled) and adds enabled
        MCP tools to the Orchestrator's catalog.
- [ ] **Scope for MCP tools.** Scope-check by default. A tool without a target is exempted in 8Rack's
      own config, never because the server's description says so.
- [ ] **Scan source IP.** Record the scanning host's address on each mission (some programs require
      registered source IPs) and show it on the approval card.
- [ ] **Server unreachable.** Show the server as offline in the Tool Registry and fail requests with a
      clear error. A run in progress when the connection drops is marked failed, not left running.
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

- [ ] A guidance card in the Needs-you queue, filled in during a real run. The same goes for a failed
      card retried from the queue.
- [ ] The Work Orders transcript (Inspect) on a real order, adding a finding by hand, and bulk status
      change.
- [ ] Context-budget shortening. A 16k mission hasn't come close to the limit; it would take a longer
      mission or a smaller `OLLAMA_NUM_CTX`.

## Local environment (this machine, not the code)

- [ ] Delete `backend/data/missions/00000000-0000-0000-0000-000000000000/` by hand. It's skipped at
      load, but still on disk.
- [ ] `katana`, `subfinder` and `amass` aren't installed, and `/usr/bin/httpx` is the Python tool, not
      ProjectDiscovery's. The setup checklist has the install commands.
