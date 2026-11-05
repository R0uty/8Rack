import type { Finding } from "../types/finding.js";
import type { ExecutionRecord } from "../types/execTool.js";

/**
 * The part of a report no model gets to write. A local model asked for evidence writes convincing
 * command output and HTTP responses that never happened, so these sections are built from what the
 * Tool Execution Framework actually recorded, and anything else on a finding is labelled as a claim.
 */

/** Below this, a match in tool output means nothing - "200" or "open" appears everywhere. */
const MIN_MATCHABLE_LENGTH = 12;
const MAX_EVIDENCE_CHARS = 2000;

const TERMINAL_CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface RecordedEvidence {
  content: string;
  command: string;
}

export interface FindingEvidence {
  /** Backed by a real execution: linked when it was ingested, or found verbatim in tool output. */
  recorded: RecordedEvidence[];
  /** Everything else on the finding - an agent's or a person's statement, nothing proves it. */
  claims: string[];
  /** Every command that produced this finding's recorded evidence, oldest first. */
  commands: string[];
}

function normalize(text: string): string {
  return text.replace(TERMINAL_CONTROL, "").replace(/\s+/g, " ").trim();
}

/** An agent's create_finding evidence carries no execution link, but when it quotes real output the
 * quote can be checked. */
function executionContaining(content: string, executions: ExecutionRecord[]): ExecutionRecord | undefined {
  const needle = normalize(content);
  if (needle.length < MIN_MATCHABLE_LENGTH) return undefined;
  return executions.find((e) => e.result && normalize(`${e.result.stdout}\n${e.result.stderr}`).includes(needle));
}

export function collectEvidence(finding: Finding, executions: ExecutionRecord[]): FindingEvidence {
  const byId = new Map(executions.map((e) => [e.id, e]));
  const recorded = new Map<string, RecordedEvidence>();
  const claims = new Set<string>();
  const commands = new Set<string>();

  for (const id of finding.executionIds) {
    const execution = byId.get(id);
    if (execution) commands.add(execution.resolvedCommand);
  }

  for (const item of finding.evidence) {
    const execution = (item.executionId ? byId.get(item.executionId) : undefined) ?? executionContaining(item.content, executions);
    if (execution) {
      commands.add(execution.resolvedCommand);
      if (!recorded.has(item.content)) recorded.set(item.content, { content: item.content, command: execution.resolvedCommand });
    } else {
      claims.add(item.content);
    }
  }

  return { recorded: [...recorded.values()], claims: [...claims], commands: [...commands] };
}

function truncate(text: string): string {
  return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}\n...[truncated]` : text;
}

/** Tool output is attacker-influenced: the fence must outlast any backtick run inside it, or the
 * content could close it and render as part of the report. */
function fenced(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The same concern for finding fields that land in Markdown prose - one line, so they can't start a heading. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderEvidence(evidence: FindingEvidence): string {
  const parts = ["### Recorded evidence"];
  if (evidence.recorded.length === 0) {
    parts.push("No tool output recorded by 8Rack backs this finding. Check it by hand before relying on it.");
  }
  for (const item of evidence.recorded) {
    parts.push(`From \`${oneLine(item.command).replace(/`/g, "'")}\`:`, fenced(truncate(item.content)));
  }
  if (evidence.claims.length > 0) {
    parts.push("### Unverified statements", "Reported on the finding, but not found in any recorded tool output:");
    for (const claim of evidence.claims) parts.push(quoted(truncate(claim)));
  }
  return parts.join("\n\n");
}

function renderReproduction(finding: Finding, evidence: FindingEvidence): string {
  const parts = ["### Reproduction"];
  if (evidence.commands.length > 0) {
    parts.push("Commands 8Rack ran to produce this evidence:", fenced(evidence.commands.join("\n")));
  }
  if (finding.reproductionSteps) {
    parts.push("Steps noted on the finding (not checked against tool output):", quoted(finding.reproductionSteps));
  }
  if (evidence.commands.length === 0 && !finding.reproductionSteps) {
    parts.push("No reproduction steps are recorded. Reproduce this by hand before submitting it.");
  }
  return parts.join("\n\n");
}

const NO_NARRATIVE = "_The model didn't write anything for this finding._";

export function renderFindingSection(finding: Finding, number: number, evidence: FindingEvidence, narrative: string): string {
  const facts = [
    `**Severity:** ${finding.severity}`,
    `**Status:** ${finding.status.replace(/_/g, " ")}`,
    `**Type:** ${finding.type.replace(/_/g, " ")}`,
    `**Target:** \`${oneLine(finding.target).replace(/`/g, "'")}\``,
  ].join(" · ");

  return [
    `## Finding ${number}: ${oneLine(finding.title)}`,
    facts,
    ...(finding.description ? [quoted(finding.description)] : []),
    narrative || NO_NARRATIVE,
    renderEvidence(evidence),
    renderReproduction(finding, evidence),
  ].join("\n\n");
}

/** A heading or bold line that opens a section the model was told not to write. */
const FORBIDDEN_SECTION = /reproduc|evidence|proof of concept|\bpoc\b/i;
const HEADING_LIKE = /^\s*(#{1,6}\s|\*\*[^*]+\*\*:?\s*$)/;
const DANGLING_EXAMPLE_LABEL = /^\s*(example|sample)\b.*:\s*$/i;

/**
 * Takes what a model wrote down to prose it can stand behind. The prompt asks for this already, but a
 * small local model ignores it often enough that it has to be enforced: a code block or a reproduction
 * section is where invented output lives. This also drops a genuine config snippet in a remediation -
 * telling those apart isn't possible here, and losing one costs far less than a fake scan result.
 */
export function sanitizeNarrative(text: string): string {
  const withoutFences = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|$(?![\s\S]))/gm, "");

  const kept: string[] = [];
  let skipping = false;
  for (const line of withoutFences.split("\n")) {
    if (HEADING_LIKE.test(line)) skipping = FORBIDDEN_SECTION.test(line);
    if (skipping || DANGLING_EXAMPLE_LABEL.test(line)) continue;
    // Below this report's own "## Finding" sections, so a model's heading can't open a new one.
    kept.push(line.replace(/^\s*#{1,2}\s+/, "### "));
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
