#!/usr/bin/env node
// End-to-end smoke test for the 8Rack backend.
//
// The Vitest suites mock Ollama and the services. This drives the REAL running stack over HTTP - the
// backend plus a live Ollama with the agents' model pulled - along the path a mission takes: an agent
// replies, a work order runs on the server, the agent asks for a tool, the request is approved, the
// tool runs, and the run resumes by itself to a final answer. Each stage reports PASS/FAIL, so a
// regression points at the link that broke.
//
//   Prerequisites: `ollama serve` with the agents' model pulled, and the backend up (`npm run dev`).
//   Then:  npm run smoke          (SMOKE_BASE_URL overrides http://localhost:3001)
//
// It works in a throwaway mission with no scope, deleted at the end even if a stage fails. The only
// tool it ever approves is `list_directory` on the workspace root (read-only, local, no network). If the
// agent asks for anything else, the request is rejected and the stage fails - this script must never
// approve a scan or a command on its own.
//
// The agent is a real model, so stages 6-8 can fail on a run where it answers without using the tool.
// Run it again before treating that as a regression.
//
// Exits 0 only if every stage passes.

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3001";
const AGENT_TIMEOUT_MS = 180_000;

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
    process.stdout.write(`\r  PASS  ${name}${detail ? ` - ${detail}` : ""}\n`);
    return detail;
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "FAIL", detail: message });
    process.stdout.write(`\r  FAIL  ${name} - ${message}\n`);
    return undefined;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(path, timeoutMs = 10000) {
  const res = await fetchWithTimeout(`${BASE}${path}`, {}, timeoutMs);
  const body = await res.json().catch(() => ({}));
  assert(res.ok, `GET ${path} returned HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`);
  return body;
}

async function send(method, path, body, timeoutMs = 10000) {
  const res = await fetchWithTimeout(
    `${BASE}${path}`,
    { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    timeoutMs,
  );
  return res;
}

async function sendJson(method, path, body, timeoutMs) {
  const res = await send(method, path, body, timeoutMs);
  const json = await res.json().catch(() => ({}));
  assert(res.ok, `${method} ${path} returned HTTP ${res.status}${json.error ? `: ${json.error}` : ""}`);
  return { status: res.status, body: json };
}

/** Polls `check` until it returns a value, or throws `timeoutMessage` after `timeoutMs`. */
async function waitFor(check, timeoutMs, timeoutMessage, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(intervalMs);
  }
  throw new Error(timeoutMessage);
}

/** The one request this script will approve: list_directory on the workspace root, nothing else. */
function isSafeToApprove(execution) {
  if (execution.toolId !== "list_directory") return false;
  return execution.arguments.every((arg) => arg === "." || arg === "./" || /^-[a-zA-Z]{1,4}$/.test(arg));
}

const SETTLED = new Set(["completed", "failed", "cancelled"]);

// --- the stages --------------------------------------------------------------
let agentId;
let missionId;
let workOrderId;
let execId;

console.log(`\n8Rack smoke test -> ${BASE}\n`);

await stage("1. Backend health", async () => {
  const body = await getJson("/health", 5000);
  assert(body.status === "ok", `expected {status:"ok"}, got ${JSON.stringify(body)}`);
  return "status ok";
});

await stage("2. Setup check (Ollama reachable)", async () => {
  const { setup } = await getJson("/api/setup", 30000);
  assert(setup.ollama.state === "ok", `Ollama: ${setup.ollama.detail ?? setup.ollama.state}`);
  const missing = [...setup.models, ...setup.tools].filter((i) => i.state !== "ok").map((i) => i.label);
  return missing.length ? `Ollama ok; not ready (not needed here): ${missing.join(", ")}` : "everything ready";
});

await stage("3. Agent availability", async () => {
  const { agents } = await getJson("/api/agents");
  assert(Array.isArray(agents) && agents.length > 0, "no agents returned");
  const online = agents.filter((a) => a.status === "online");
  assert(online.length > 0, `${agents.length} agent(s) exist but none are online (is the model pulled?)`);
  // code-assistant reliably asks for a tool when told to; any online agent will do otherwise.
  const chosen = online.find((a) => a.id === "code-assistant") ?? online[0];
  agentId = chosen.id;
  return `${online.length}/${agents.length} online, using "${agentId}" (${chosen.model})`;
});

await stage("4. Agent chat (streamed reply)", async () => {
  const res = await send(
    "POST",
    `/api/agents/${encodeURIComponent(agentId)}/chat`,
    { messages: [{ role: "user", content: "Reply with exactly the word PONG and nothing else." }], options: { temperature: 0 } },
    AGENT_TIMEOUT_MS,
  );
  assert(res.ok, `chat returned HTTP ${res.status}`);
  const lines = (await res.text()).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  const error = lines.find((l) => l.error);
  assert(!error, `chat errored: ${error?.error}`);
  const reply = lines.map((l) => l.message?.content ?? "").join("").trim();
  assert(reply.length > 0, "streamed reply was empty");
  return `reply: ${JSON.stringify(reply.slice(0, 40))}`;
});

await stage("   (setup) create a throwaway mission", async () => {
  const { status, body } = await sendJson("POST", "/api/missions", {
    name: "SMOKE-TEST",
    notes: "Created by backend/scripts/smoke-test.mjs - safe to delete.",
    scope: [],
  });
  assert(status === 201, `expected 201, got ${status}`);
  missionId = body.mission?.id;
  assert(missionId, "no mission id returned");
  return missionId;
});

await stage("5. Mission event stream", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${BASE}/api/missions/${missionId}/events`, { signal: controller.signal });
    assert(res.ok, `GET /events returned HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      assert(!done, "stream ended before the first event");
      buffered += decoder.decode(value, { stream: true });
    }
    const first = JSON.parse(buffered.split("\n")[0]);
    assert(first.type === "run_state", `first event was "${first.type}", expected run_state`);
    return `first event run_state (${first.run?.status})`;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

await stage("6. Work order runs and asks for a tool", async () => {
  const created = await sendJson("POST", `/api/missions/${missionId}/workorders`, {
    agentId,
    objective:
      'Use the list_directory tool to list the workspace root directory (use "." as the path). Then say how many entries there are.',
  });
  assert(created.status === 201, `create work order: expected 201, got ${created.status}`);
  workOrderId = created.body.workOrder.id;
  await sendJson("POST", `/api/missions/${missionId}/workorders/${workOrderId}/start`, {});

  const execution = await waitFor(
    async () => {
      const { executions } = await getJson(`/api/tools/executions?missionId=${missionId}&status=pending_confirmation`);
      if (executions.length > 0) return executions[0];
      const { workOrder } = await getJson(`/api/missions/${missionId}/workorders/${workOrderId}`);
      if (SETTLED.has(workOrder.status)) {
        throw new Error(
          `the work order ended "${workOrder.status}" without asking for a tool` +
            (workOrder.result ? ` (${workOrder.result.slice(0, 80)})` : "") +
            " - the model is nondeterministic, run again before calling it a regression",
        );
      }
      return undefined;
    },
    AGENT_TIMEOUT_MS,
    "no tool request within the time limit",
  );
  execId = execution.id;
  return `asked for ${execution.toolId} ${JSON.stringify(execution.arguments)}`;
});

await stage("7. Approve the request, tool runs, output captured", async () => {
  const { execution: pending } = await getJson(`/api/tools/executions/${execId}`);
  if (!isSafeToApprove(pending)) {
    await send("POST", `/api/tools/executions/${execId}/reject`, {});
    throw new Error(
      `the agent asked for ${pending.toolId} ${JSON.stringify(pending.arguments)}; this script only approves ` +
        "list_directory on the workspace root, so it was rejected",
    );
  }
  await sendJson("POST", `/api/tools/executions/${execId}/confirm`, {}, 30000);
  const done = await waitFor(
    async () => {
      const { execution } = await getJson(`/api/tools/executions/${execId}`);
      return execution.status === "running" ? undefined : execution;
    },
    60000,
    "the tool was still running after 60 s",
  );
  assert(done.status === "completed", `execution ended "${done.status}"`);
  assert(done.result?.exitCode === 0, `exit code was ${done.result?.exitCode}`);
  assert((done.result?.stdout ?? "").length > 0, "captured stdout was empty");
  return `exit 0, ${done.result.stdout.length} bytes of output`;
});

await stage("8. Run resumes by itself to a final answer", async () => {
  const workOrder = await waitFor(
    async () => {
      const body = await getJson(`/api/missions/${missionId}/workorders/${workOrderId}`);
      return SETTLED.has(body.workOrder.status) ? body.workOrder : undefined;
    },
    AGENT_TIMEOUT_MS,
    "the work order hadn't settled after the tool finished",
  );
  assert(workOrder.status === "completed", `work order ended "${workOrder.status}": ${workOrder.result ?? ""}`);
  const { task } = await getJson(`/api/orchestrator/tasks/${workOrder.orchestratorTaskId}`);
  assert((task.finalResponse ?? "").trim().length > 0, "the task has no final answer");
  return `final answer: ${JSON.stringify(task.finalResponse.trim().slice(0, 50))}`;
});

// Cleanup - always attempted, even after a failure. Deleting the mission also stops its run.
if (missionId) {
  try {
    const res = await send("DELETE", `/api/missions/${missionId}`);
    console.log(
      res.ok
        ? `\n  (cleanup) deleted the throwaway mission ${missionId}`
        : `\n  (cleanup) WARNING: deleting mission ${missionId} returned HTTP ${res.status}`,
    );
  } catch (err) {
    console.log(`\n  (cleanup) WARNING: failed to delete mission ${missionId}: ${err.message}`);
  }
}

// --- summary -----------------------------------------------------------------
const passed = results.filter((r) => r.status === "PASS").length;
console.log(`\n${"-".repeat(60)}`);
if (failed) {
  const firstFail = results.find((r) => r.status === "FAIL");
  console.log(`SMOKE TEST FAILED at: ${firstFail.name}`);
  console.log(`Reason: ${firstFail.detail}`);
  console.log(`(${passed} stage(s) passed before the failure)`);
  process.exit(1);
} else {
  console.log(`SMOKE TEST PASSED - all ${passed} stages green.`);
  process.exit(0);
}
