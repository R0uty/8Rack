import type { ParsedFinding } from "../types/finding.js";

const KV_LINE = /^([A-Za-z][A-Za-z0-9 .\-/]*):\s*(.+)$/;

/** whois output has no consistent machine-readable format, so this curates a handful of
 * interesting fields (registrar, dates, name servers, registrant country) rather than trying to
 * parse the whole record. */
const INTERESTING_KEYS = [
  "registrar",
  "creation date",
  "updated date",
  "registry expiry date",
  "name server",
  "registrant country",
  "registrant organization",
  "dnssec",
];

export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const match = KV_LINE.exec(line);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();
    const normalizedKey = key.toLowerCase();
    if (!INTERESTING_KEYS.includes(normalizedKey) || !value) continue;

    findings.push({
      type: "information",
      severity: "info",
      title: `${key}: ${value}`,
      description: `whois record field "${key}" for ${target}`,
      tool: "whois",
      confidence: 0.8,
      target,
      value: `${normalizedKey}:${value.toLowerCase()}`,
      metadata: { key, value },
      evidence: line,
    });
  }

  return findings;
}
