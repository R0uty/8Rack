import type { ParsedFinding } from "../types/finding.js";

const SUBDOMAIN_LINE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** subfinder's only default argument is `-silent` (see builtins.ts), which prints one discovered
 * subdomain per line. The finding's target is the subdomain itself, not the scanned parent domain -
 * that's still recorded in metadata.parentDomain for correlation. */
export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];

  for (const raw of stdout.split("\n")) {
    const subdomain = raw.trim().toLowerCase();
    if (!subdomain || !SUBDOMAIN_LINE.test(subdomain)) continue;

    findings.push({
      type: "subdomain",
      severity: "info",
      title: `Subdomain discovered: ${subdomain}`,
      description: `subfinder discovered subdomain "${subdomain}" of ${target}`,
      tool: "subfinder",
      confidence: 0.85,
      target: subdomain,
      value: subdomain,
      metadata: { parentDomain: target },
      evidence: subdomain,
    });
  }

  return findings;
}
