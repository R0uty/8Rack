#!/usr/bin/env node
// End-to-end smoke test for the 8Rack backend.
//
// Unlike the Vitest suites (which mock Ollama and test services in isolation), this drives the
// REAL running stack over HTTP: backend + a live Ollama with at least one pulled model. It walks
// the whole critical path a user relies on and reports PASS/FAIL per stage, so a regression points
// at exactly which link broke rather than a generic failure.
//
//   Prerequisites: `ollama serve` running with a model pulled, and the backend up
//   (`npm run dev`). Then:  npm run smoke
//
// Exits 0 only if every stage passes; non-zero (and prints the failing stage) otherwise.

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3001";

// --- tiny test harness -------------------------------------------------------
const results = [];
let failed = false;

async function stage(name, fn) {
  if (failed) {
    results.push({ name, status: "SKIP" });
    console.log(`  SKIP  ${name} (a previous stage failed)`);
    return undefined;
  }
  process.stdout.write(`  ....  ${name}`);
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail });
    process.stdout.write(`\r  PASS  ${name}${detail ? ` — ${detail}` : ""}\n`);
    return detail;
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", detail: message });
    process.stdout.write(`\r  FAIL  ${name} — ${message}\n`);
    return undefined;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(path, body, timeoutMs) {
  return fetchWithTimeout(
    `${BASE}${path}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    timeoutMs,
  );
}

// Reads an NDJSON stream to completion, returning the parsed JSON objects (one per line).
async function readNdjson(res) {
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- the stages --------------------------------------------------------------
let agentId;
let agentModel;
let projectId;
let taskId;
let execId;

console.log(`\n8Rack smoke test → ${BASE}\n`);

// 1. Backend health
await stage("1. Backend health", async () => {
  const res = await fetchWithTimeout(`${BASE}/health`, {}, 5000);
  assert(res.ok, `GET /health returned HTTP ${res.status}`);
  const body = await res.json();
  assert(body.status === "ok", `expected {status:"ok"}, got ${JSON.stringify(body)}`);
  return "status ok";
});

// 2. Agent availability
await stage("2. Agent availability", async () => {
  const res = await fetchWithTimeout(`${BASE}/api/agents`, {}, 10000);
  assert(res.ok, `GET /api/agents returned HTTP ${res.status}`);
  const { agents } = await res.json();
  assert(Array.isArray(agents) && agents.length > 0, "no agents returned");
  const online = agents.filter((a) => a.status === "online");
  assert(online.length > 0, `${agents.length} agent(s) exist but none are online (is the model pulled?)`);
  // Prefer code-assistant for the tool stages (reliably requests tools in practice), else any online one.
  const chosen = online.find((a) => a.id === "code-assistant") ?? online[0];
  agentId = chosen.id;
  agentModel = chosen.model;
  return `${online.length}/${agents.length} online, using "${agentId}" (${agentModel})`;
});

// 3. Agent chat (streamed reply reaches us and renders non-empty)
await stage("3. Agent chat", async () => {
  const res = await postJson(
    `/api/agents/${encodeURIComponent(agentId)}/chat`,
    { messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }], options: { temperature: 0 } },
    120000,
  );
  assert(res.ok, `chat returned HTTP ${res.status}`);
  const lines = await readNdjson(res);
  const reply = lines.map((l) => l.message?.content ?? "").join("");
  assert(reply.trim().length > 0, "streamed reply was empty");
  return `reply: ${JSON.stringify(reply.trim().slice(0, 40))}`;
});

// Setup: throwaway project for the tool/orchestration/plan stages
await stage("   (setup) create throwaway project", async () => {
  const res = await postJson("/api/projects", { name: "SMOKE-TEST", notes: "automated smoke test — safe to delete" }, 10000);
  assert(res.ok, `create project returned HTTP ${res.status}`);
  const { project } = await res.json();
  assert(project?.id, "no project id returned");
  projectId = project.id;
  return projectId;
});

// 4. Tool execution (agent requests a tool → task parks at waiting_confirmation)
await stage("4. Tool execution (agent requests a tool)", async () => {
  const res = await postJson(
    "/api/orchestrator/tasks",
    {
      agentId,
      projectId,
      objective:
        'Use the list_directory tool to list the contents of the workspace root directory (use "." as the path). Then tell me how many entries there are.',
    },
    150000,
  );
  assert(res.ok, `create task returned HTTP ${res.status}`);
  const lines = await readNdjson(res);
  const err = lines.find((l) => l.type === "error");
  assert(!err, `task errored: ${err?.error}`);
  const last = lines.filter((l) => l.type === "task").at(-1);
  assert(last, "no task object in stream");
  taskId = last.task.id;
  assert(
    last.task.status === "waiting_confirmation" && last.task.pendingExecutionId,
    `expected waiting_confirmation with a pendingExecutionId, got status "${last.task.status}" ` +
      `(the model may not have requested a tool this run — nondeterministic)`,
  );
  execId = last.task.pendingExecutionId;
  return `task ${taskId.slice(0, 8)} parked, pending exec ${execId.slice(0, 8)}`;
});

// 5. Tool confirmation (human approves → tool actually runs, output captured)
await stage("5. Tool confirmation (approve → execute → capture output)", async () => {
  const res = await postJson(`/api/tools/executions/${execId}/confirm`, {}, 60000);
  assert(res.ok, `confirm returned HTTP ${res.status}`);
  await readNdjson(res); // drain the stdout/stderr/result stream
  const check = await fetchWithTimeout(`${BASE}/api/tools/executions/${execId}`, {}, 10000);
  const { execution } = await check.json();
  assert(execution.status === "completed", `execution status was "${execution.status}"`);
  assert(execution.result?.exitCode === 0, `exit code was ${execution.result?.exitCode}`);
  assert((execution.result?.stdout ?? "").length > 0, "captured stdout was empty");
  return `exit 0, ${execution.result.stdout.length} bytes stdout captured`;
});

// 6. Single-agent orchestration (tool output fed back → agent produces final answer)
await stage("6. Single-agent orchestration (resume → final answer)", async () => {
  const res = await postJson(`/api/orchestrator/tasks/${taskId}/resume`, {}, 150000);
  assert(res.ok, `resume returned HTTP ${res.status}`);
  const lines = await readNdjson(res);
  const err = lines.find((l) => l.type === "error");
  assert(!err, `resume errored: ${err?.error}`);
  const last = lines.filter((l) => l.type === "task").at(-1);
  assert(last, "no task object in stream");
  assert(last.task.status === "completed", `task status was "${last.task.status}"`);
  assert((last.task.finalResponse ?? "").trim().length > 0, "finalResponse was empty");
  return `final answer: ${JSON.stringify(last.task.finalResponse.trim().slice(0, 50))}`;
});

// 7. Two-step multi-agent plan (step 1 output flows into step 2)
await stage("7. Two-step multi-agent plan", async () => {
  const res = await postJson(
    "/api/plans",
    {
      projectId,
      description: "smoke test 2-step plan",
      steps: [
        { agentId, objective: "List exactly three primary colors, one per line, and nothing else. Do not use any tools." },
        { agentId, objective: "Summarize the previous step's output in one short sentence. Do not use any tools." },
      ],
    },
    200000,
  );
  assert(res.ok, `create plan returned HTTP ${res.status}`);
  const lines = await readNdjson(res);
  const err = lines.find((l) => l.type === "error");
  assert(!err, `plan errored: ${err?.error}`);
  const last = lines.filter((l) => l.type === "result").at(-1);
  assert(last, "no plan result in stream");
  assert(last.plan.status === "completed", `plan status was "${last.plan.status}"`);
  assert(last.plan.stepRuns?.length === 2, `expected 2 step runs, got ${last.plan.stepRuns?.length}`);
  return `plan completed, ${last.plan.stepRuns.length} steps ran`;
});

// Cleanup — always attempt, even if a stage failed, so we don't leave test projects behind.
if (projectId) {
  try {
    await fetchWithTimeout(`${BASE}/api/projects/${projectId}`, { method: "DELETE" }, 10000);
    console.log(`\n  (cleanup) deleted throwaway project ${projectId}`);
  } catch (err) {
    console.log(`\n  (cleanup) WARNING: failed to delete project ${projectId}: ${err.message}`);
  }
}

// --- summary -----------------------------------------------------------------
const passed = results.filter((r) => r.status === "PASS").length;
const total = results.filter((r) => r.status !== "SKIP").length + results.filter((r) => r.status === "SKIP").length;
console.log(`\n${"─".repeat(60)}`);
if (failed) {
  const firstFail = results.find((r) => r.status === "FAIL");
  console.log(`SMOKE TEST FAILED at: ${firstFail.name}`);
  console.log(`Reason: ${firstFail.detail}`);
  console.log(`(${passed} stage(s) passed before the failure)`);
  process.exit(1);
} else {
  console.log(`SMOKE TEST PASSED — all ${passed} stages green.`);
  process.exit(0);
}
