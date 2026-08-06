import type { ParsedFinding } from "../types/finding.js";

const PORT_LINE = /^(\d+)\/(tcp|udp)\s+(\S+)\s+(\S+)(.*)$/;

/** Parses plain-text nmap output (no default JSON/XML flags - see builtins.ts) for open-port
 * lines like "80/tcp open  http" into Port + Service findings. */
export function parse(stdout: string, target: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    const match = PORT_LINE.exec(line);
    if (!match) continue;

    const [, port, protocol, state, service, detail] = match;
    if (state !== "open") continue;

    findings.push({
      type: "port",
      severity: "info",
      title: `Port ${port}/${protocol} open`,
      description: `Port ${port}/${protocol} is open (${service})`,
      tool: "nmap",
      confidence: 0.9,
      target,
      value: `${port}/${protocol}`,
      metadata: { port: Number(port), protocol, service },
      evidence: line,
    });

    if (service && service !== "unknown" && service !== "tcpwrapped") {
      findings.push({
        type: "service",
        severity: "info",
        title: `${service} on ${port}/${protocol}`,
        description: `Service "${service}" detected on port ${port}/${protocol}${detail ? ` (${detail.trim()})` : ""}`,
        tool: "nmap",
        confidence: 0.8,
        target,
        value: `${port}/${protocol}:${service}`,
        metadata: { port: Number(port), protocol, service, detail: detail.trim() || undefined },
        evidence: line,
      });
    }
  }

  return findings;
}
