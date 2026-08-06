import type { FindingSeverity, ParsedFinding } from "../types/finding.js";

const RESULT_LINE = /^\[([^\]]+)]\s*\[([^\]]+)]\s*\[([^\]]+)]\s+(\S+)/;
const VALID_SEVERITIES: FindingSeverity[] = ["info", "low", "medium", "high", "critical"];

/** nuclei's only default argument is `-silent` (see builtins.ts), whose plain-text line format is
 * "[template-id] [protocol] [severity] matched-at". nuclei's own severity vocabulary maps 1:1 onto
 * FindingSeverity, so no translation is needed. Parsers only ever emit "potential_vulnerability" -
 * promoting to "confirmed_vulnerability" is a human/agent decision, not an automated one. */
export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const match = RESULT_LINE.exec(line);
    if (!match) continue;

    const [, templateId, protocol, rawSeverity, matchedAt] = match;
    const severity = rawSeverity.toLowerCase() as FindingSeverity;
    if (!VALID_SEVERITIES.includes(severity)) continue;

    findings.push({
      type: "potential_vulnerability",
      severity,
      title: `${templateId} (${severity})`,
      description: `nuclei template "${templateId}" matched via ${protocol} at ${matchedAt}`,
      tool: "nuclei",
      confidence: 0.7,
      target: matchedAt || target,
      value: templateId,
      metadata: { protocol, matchedAt },
      evidence: line,
    });
  }

  return findings;
}
