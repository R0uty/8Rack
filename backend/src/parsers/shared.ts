import type { ParsedFinding } from "../types/finding.js";

/** Target-extraction helpers shared by every parser - findingsManager calls the right one per tool
 * before invoking that tool's parser, since target isn't always the last CLI arg (e.g.
 * `ffuf -u https://x.com/FUZZ -w wordlist.txt` has the wordlist last, not the target). */

/** Returns the value immediately following `flag` in `args`, e.g. extractFlagValue(["-u", "https://x.com"], "-u"). */
export function extractFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

/** Returns the last argument that doesn't look like a flag or a flag's value-in-waiting - the
 * conventional trailing positional target for tools like `nmap <target>`, `whois <target>`. */
export function lastPositionalArg(args: string[]): string | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

/** httpx/katana in `-silent` mode (their only default argument) both just print one live URL per
 * line - identical shape, so both parsers share this instead of duplicating the same loop. */
export function parseBareUrlList(stdout: string, tool: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || !/^https?:\/\//i.test(line)) continue;
    findings.push({
      type: "endpoint",
      severity: "info",
      title: `Live host: ${line}`,
      description: `${tool} detected a live HTTP(S) endpoint`,
      tool,
      confidence: 0.85,
      target: line,
      value: line,
      evidence: line,
    });
  }
  return findings;
}
