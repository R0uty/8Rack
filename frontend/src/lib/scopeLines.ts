/**
 * How the backend's scope checker (backend/src/services/scopeMatcher.ts#matchesEntry) will read each
 * line of a mission's Scope / Out of scope. Mirrors its shapes so the editor can show, while typing,
 * what a line means - and flag one it won't match anything with.
 */

export type ScopeLineKind = "domain" | "wildcard" | "ip" | "cidr" | "url" | "host-port" | "ipv6" | "unrecognized";

export interface ScopeLine {
  line: string;
  kind: ScopeLineKind;
  /** What the line covers, in words. */
  meaning: string;
  /** Set when the checker will read the line differently from how it is likely meant. */
  warning?: string;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,}$`);
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^[0-9a-f]*:[0-9a-f:]*$/;

function classifyHost(host: string): "domain" | "ip" | undefined {
  if (IPV4_RE.test(host)) return "ip";
  if (DOMAIN_RE.test(host)) return "domain";
  return undefined;
}

export function classifyScopeLine(raw: string): ScopeLine {
  const line = raw.trim();
  const e = line.toLowerCase().replace(/\.$/, "");

  if (/^https?:\/\//.test(e)) {
    try {
      const url = new URL(e);
      const hasPath = url.pathname !== "/" || url.search !== "";
      return {
        line,
        kind: "url",
        meaning: `Host ${url.hostname} only (not its subdomains)`,
        warning: hasPath ? `Paths aren't checked yet - every path on ${url.hostname} is in.` : undefined,
      };
    } catch {
      return { line, kind: "unrecognized", meaning: "Not a valid URL", warning: "This line will match nothing." };
    }
  }

  const cidr = e.match(/^([\d.]+)\/(\d{1,2})$/);
  if (cidr) {
    const bits = Number(cidr[2]);
    if (IPV4_RE.test(cidr[1]) && bits <= 32) {
      const size = 2 ** (32 - bits);
      return { line, kind: "cidr", meaning: `IP range, ${size.toLocaleString()} address${size === 1 ? "" : "es"}` };
    }
    return { line, kind: "unrecognized", meaning: "Not a valid CIDR range", warning: "This line will match nothing." };
  }

  const cidr6 = e.match(/^([0-9a-f:]+)\/(\d{1,3})$/);
  if (cidr6 && cidr6[1].includes(":") && Number(cidr6[2]) <= 128) {
    return { line, kind: "cidr", meaning: `IPv6 range /${cidr6[2]}` };
  }

  if (e.startsWith("*.")) {
    const base = e.slice(2);
    if (DOMAIN_RE.test(base)) return { line, kind: "wildcard", meaning: `${base} and every subdomain` };
    return { line, kind: "unrecognized", meaning: "Not a valid wildcard", warning: "This line will match nothing." };
  }

  const hostPort = e.match(/^([a-z0-9.-]+):(\d{1,5})$/);
  if (hostPort && classifyHost(hostPort[1])) {
    return {
      line,
      kind: "host-port",
      meaning: `${hostPort[1]}${classifyHost(hostPort[1]) === "domain" ? " and its subdomains" : ""}`,
      warning: `The port isn't enforced yet - every port on ${hostPort[1]} is in.`,
    };
  }

  const host = classifyHost(e);
  if (host === "ip") return { line, kind: "ip", meaning: "This IP address only" };
  if (host === "domain") return { line, kind: "domain", meaning: `${e} and its subdomains` };
  if (IPV6_RE.test(e) && e.includes(":")) return { line, kind: "ipv6", meaning: "This IPv6 address only" };

  if (e.includes("/")) {
    return { line, kind: "unrecognized", meaning: "A host with a path", warning: "This line will match nothing. Paths aren't checked; write the host instead." };
  }
  return { line, kind: "unrecognized", meaning: "Not a domain, IP, range or URL", warning: "This line will match nothing." };
}

export function classifyScopeText(text: string): ScopeLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(classifyScopeLine);
}
