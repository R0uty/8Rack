import type { ParsedFinding } from "../types/finding.js";

const ANSWER_RECORD = /^(\S+?)\.?\s+(\d+)\s+IN\s+(\w+)\s+(.+)$/;

/** Parses the ANSWER SECTION of dig's plain-text output (dig has no default flags requesting
 * structured output - see builtins.ts) into one Information finding per DNS record. */
export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.includes("ANSWER SECTION"));
  if (start === -1) return findings;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break; // ANSWER SECTION ends at the next blank line
    const match = ANSWER_RECORD.exec(line);
    if (!match) continue;

    const [, name, ttl, recordType, recordValue] = match;
    const value = recordValue.trim();

    findings.push({
      type: "information",
      severity: "info",
      title: `${recordType} record: ${value}`,
      description: `DNS ${recordType} record for ${name}`,
      tool: "dig",
      confidence: 0.9,
      target,
      value: `${recordType}:${value}`,
      metadata: { name, ttl: Number(ttl), recordType, recordValue: value },
      evidence: line,
    });
  }

  return findings;
}
