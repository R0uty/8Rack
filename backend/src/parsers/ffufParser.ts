import type { ParsedFinding } from "../types/finding.js";

const RESULT_LINE = /^(\S+)\s+\[Status:\s*(\d+),\s*Size:\s*(\d+)/;
const INTERESTING_PATTERN = /\.(git|env|bak|old|sql|zip|config)$|backup|\.git\//i;

/** ffuf's default arguments carry no `-o`/`-json` flag (see builtins.ts), so this parses its
 * plain-text result lines, e.g. "admin  [Status: 200, Size: 1043, Words: 45, Lines: 12, ...]". */
export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  const baseTarget = target.replace(/FUZZ/gi, "").replace(/\/+$/, "");

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const match = RESULT_LINE.exec(line);
    if (!match) continue;

    const [, path, status, size] = match;
    const interesting = INTERESTING_PATTERN.test(path);

    findings.push({
      type: interesting ? "interesting_file" : "directory",
      severity: interesting ? "medium" : "info",
      title: `${path} (${status})`,
      description: `ffuf discovered "${path}" on ${baseTarget || target} (status ${status})`,
      tool: "ffuf",
      confidence: 0.75,
      target: baseTarget || target,
      value: path,
      metadata: { status: Number(status), size: Number(size) },
      evidence: line,
    });
  }

  return findings;
}
