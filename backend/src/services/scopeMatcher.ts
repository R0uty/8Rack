/**
 * Best-effort mission-scope checking (see Project.scope/outOfScope in types/project.ts). There is
 * no structured "target" concept anywhere in the Tool Execution Framework - a tool request is just
 * an opaque `string[]` argv, so a domain/IP/URL embedded in `bash -c "curl https://x"` is
 * indistinguishable from any other token without heuristics. This module extracts target-looking
 * substrings via regex and matches them against scope entries; when it can't find anything
 * target-shaped in the arguments at all, callers should treat that as "unknown" (warn, don't
 * block) rather than silently allowing or wrongly rejecting - see toolManager.ts#requestExecution.
 */

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
/** Requires a letters-only final label, so it never overlaps with IPV4_RE's all-numeric matches -
 * still needs the COMMON_TLDS check below, since this alone also matches code identifier chains
 * (`process.stdout.write`) and dotted filenames (`config.yaml`, `app.py`). */
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

/** Curated, not exhaustive - real bug-bounty targets overwhelmingly sit on one of these. Keeping
 * this a finite allowlist (rather than "any letters-only final label") is what keeps
 * DOMAIN_RE from firing on every dotted code identifier or filename in a bash/python one-liner -
 * missing an obscure TLD just degrades that target to the "unknown" (warn-only) verdict, never to
 * a silent allow, so under-covering here is the safe direction to err in. */
const COMMON_TLDS = new Set([
  "com", "net", "org", "io", "co", "gov", "edu", "mil", "info", "biz", "dev", "app", "ai", "cloud",
  "xyz", "me", "tv", "us", "uk", "ca", "de", "fr", "jp", "cn", "ru", "br", "in", "au", "nl", "se",
  "no", "fi", "dk", "es", "it", "pl", "ch", "at", "be", "nz", "za", "mx", "kr", "id", "sg", "hk",
  "tw", "ie", "pt", "gr", "cz", "ro", "hu", "il", "sa", "ae", "tr", "th", "vn", "ph", "my", "eu",
  "tech", "online", "site", "store", "blog", "cc", "name", "pro", "wiki", "network", "systems",
  "solutions", "services", "agency", "digital",
]);

function hasCommonTld(domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return COMMON_TLDS.has(tld);
}

/** Pulls every domain/IP/URL-hostname-looking token out of a tool's argv, deduplicated and
 * lowercased. Order isn't meaningful - this is a set of candidates to check, not a parse. */
export function extractTargets(args: string[]): string[] {
  const text = args.join(" ");
  const targets = new Set<string>();

  for (const match of text.matchAll(URL_RE)) {
    try {
      targets.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // Malformed URL-looking text - not a usable target, skip it.
    }
  }
  for (const match of text.matchAll(IPV4_RE)) targets.add(match[0]);
  for (const match of text.matchAll(DOMAIN_RE)) {
    const domain = match[0].toLowerCase();
    if (hasCommonTld(domain)) targets.add(domain);
  }

  return [...targets];
}

function ipToInt(ip: string): number | undefined {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** True if `target` matches a single scope entry - handles four entry shapes: a CIDR range
 * ("10.0.0.0/24"), a wildcard subdomain ("*.example.com"), a full URL (compared by hostname), or
 * a bare domain/IP (exact match, or - for a domain - any subdomain of it). */
function matchesEntry(target: string, entry: string): boolean {
  const t = target.toLowerCase();
  const e = entry.trim().toLowerCase();
  if (!e) return false;

  const cidrMatch = e.match(/^([\d.]+)\/(\d{1,2})$/);
  if (cidrMatch) {
    const targetInt = ipToInt(t);
    const baseInt = ipToInt(cidrMatch[1]);
    const maskBits = Number(cidrMatch[2]);
    if (targetInt === undefined || baseInt === undefined || maskBits > 32) return false;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (targetInt & mask) === (baseInt & mask);
  }

  if (e.startsWith("*.")) {
    const suffix = e.slice(1); // ".example.com"
    return t === e.slice(2) || t.endsWith(suffix);
  }

  if (e.startsWith("http://") || e.startsWith("https://")) {
    try {
      return new URL(e).hostname === t;
    } catch {
      return false;
    }
  }

  if (t === e) return true;
  return t.endsWith(`.${e}`);
}

export function isInScope(target: string, scope: string[]): boolean {
  return scope.some((entry) => matchesEntry(target, entry));
}

/** True if `target` is excluded by `outOfScope`, or falls outside a non-empty `scope` allowlist.
 * Both undefined/empty means no restriction is configured for this mission - never out of scope. */
export function isTargetOutOfScope(
  scope: string[] | undefined,
  outOfScope: string[] | undefined,
  target: string,
): boolean {
  if (outOfScope?.length && isInScope(target, outOfScope)) return true;
  if (scope?.length && !isInScope(target, scope)) return true;
  return false;
}

export type ScopeVerdict =
  | { verdict: "no_restriction" }
  | { verdict: "unknown" }
  | { verdict: "in_scope"; targets: string[] }
  | { verdict: "out_of_scope"; offending: string[] };

/** The general-purpose check for a freeform argv - see the module doc comment for why "unknown"
 * (nothing target-shaped found) is its own verdict rather than folded into either allow or deny. */
export function checkScope(scope: string[] | undefined, outOfScope: string[] | undefined, args: string[]): ScopeVerdict {
  if (!scope?.length && !outOfScope?.length) return { verdict: "no_restriction" };

  const targets = extractTargets(args);
  if (targets.length === 0) return { verdict: "unknown" };

  const offending = targets.filter((t) => isTargetOutOfScope(scope, outOfScope, t));
  if (offending.length > 0) return { verdict: "out_of_scope", offending };
  return { verdict: "in_scope", targets };
}
