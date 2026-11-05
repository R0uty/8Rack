/**
 * Best-effort mission-scope checking (see Mission.scope/outOfScope in types/mission.ts). There is
 * no structured "target" concept anywhere in the Tool Execution Framework - a tool request is just
 * an opaque `string[]` argv, so a domain/IP/URL embedded in `bash -c "curl https://x"` is
 * indistinguishable from any other token without heuristics. This module extracts target-looking
 * substrings via regex and matches them against scope entries; when it can't find anything
 * target-shaped in the arguments at all, callers should treat that as "unknown" (warn, don't
 * block) rather than silently allowing or wrongly rejecting - see toolManager.ts#requestExecution.
 */

import { isIPv6 } from "node:net";

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
/** Candidate runs of hex-digits-and-colons - validated with `node:net`'s `isIPv6` rather than a
 * hand-rolled regex, since a regex precise enough to reject every invalid shape (too many/few
 * groups, more than one "::", etc.) without also rejecting valid compressed forms is genuinely
 * hard to get right; over-matching here is harmless because isIPv6 is the real gate. */
const IPV6_CANDIDATE_RE = /(?<![\w.-])[0-9a-fA-F:]*:[0-9a-fA-F:]*(?![\w-])/g;
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

function tldOf(domain: string): string {
  return domain.slice(domain.lastIndexOf(".") + 1);
}

/** The TLDs of a mission's own scope entries. Targets on those are recognized whatever they are, or
 * a scope of "corp.internal" could never be run against, and an out-of-scope "admin.acme.gg" would
 * only draw an "unknown" warning. */
function tldsFromEntries(entries: string[]): Set<string> {
  const tlds = new Set<string>();
  for (const entry of entries) {
    for (const match of normalizeHost(entry).matchAll(DOMAIN_RE)) tlds.add(tldOf(match[0].toLowerCase()));
  }
  return tlds;
}

/** A fully-qualified "example.com." resolves the same as "example.com" - left as is, it wouldn't
 * match an out-of-scope entry for that host, and neither would the "*.example.com" suffix check. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Expands a valid IPv6 address to a canonical, fully-expanded, lowercase, zero-padded 8-group
 * form (e.g. "::1" and "0:0:0:0:0:0:0:1" both become "0000:0000:0000:0000:0000:0000:0000:0001"),
 * so scope-entry and extracted-target strings compare equal regardless of which compressed/cased
 * spelling each happened to use. Returns undefined for anything `isIPv6` rejects. Doesn't attempt
 * to expand an embedded IPv4 tail (e.g. "::ffff:127.0.0.1") into hex groups - that segment is left
 * as-is, which is still consistent as long as both sides go through this same function. */
function canonicalizeIPv6(addr: string): string | undefined {
  if (!isIPv6(addr)) return undefined;
  let head = addr;
  let tail = "";
  const dbl = addr.indexOf("::");
  if (dbl !== -1) {
    head = addr.slice(0, dbl);
    tail = addr.slice(dbl + 2);
  }
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
  return parts.map((p) => p.padStart(4, "0").toLowerCase()).join(":");
}

function ipv6ToBigInt(addr: string): bigint | undefined {
  const canon = canonicalizeIPv6(addr);
  if (!canon) return undefined;
  return canon.split(":").reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
}

/** Pulls every domain/IP/URL-hostname-looking token out of a tool's argv, deduplicated and
 * lowercased. Order isn't meaningful - this is a set of candidates to check, not a parse. Node's
 * WHATWG `URL` host parser already normalizes decimal/hex/octal IPv4 forms and IPv6 forms embedded
 * in an actual `http(s)://` URL (e.g. "http://2130706433/" -> "127.0.0.1") - those are covered for
 * free via the URL_RE branch; a bare (schemeless) alternate-form IPv4 target (as e.g. `curl
 * 2130706433` accepts) isn't extracted here at all, since a blanket "any integer could be a
 * decimal IP" heuristic would misfire on ordinary flag values (port numbers, thread counts, ...) -
 * that case falls through to the "unknown" verdict instead, see checkScope's doc comment. */
export function extractTargets(args: string[], extraTlds: ReadonlySet<string> = new Set()): string[] {
  const text = args.join(" ");
  const targets = new Set<string>();

  for (const match of text.matchAll(URL_RE)) {
    try {
      const hostname = normalizeHost(new URL(match[0]).hostname);
      targets.add(hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname);
    } catch {
      // Malformed URL-looking text - not a usable target, skip it.
    }
  }
  for (const match of text.matchAll(IPV4_RE)) targets.add(match[0]);
  for (const match of text.matchAll(IPV6_CANDIDATE_RE)) {
    // A trailing/leading single ":" is often just adjacent punctuation (e.g. "target: ::1"), not
    // part of the address, so it's tried both as captured and with one stray colon trimmed off
    // each end - a real "::" prefix/suffix survives this since only a single colon is stripped.
    for (const candidate of [match[0], match[0].replace(/^:(?!:)/, "").replace(/(?<!:):$/, "")]) {
      if (isIPv6(candidate)) {
        targets.add(candidate.toLowerCase());
        break;
      }
    }
  }
  for (const match of text.matchAll(DOMAIN_RE)) {
    const domain = match[0].toLowerCase();
    const tld = tldOf(domain);
    if (COMMON_TLDS.has(tld) || extraTlds.has(tld)) targets.add(domain);
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
  const t = normalizeHost(target);
  let e = normalizeHost(entry);
  if (!e) return false;

  // A "domain:port"/"ipv4:port" scope entry (not IPv6 - those are colon-heavy themselves) matches
  // by host only: extractTargets never carries a port through (DOMAIN_RE/IPV4_RE stop at the
  // colon), so a target's port is unrecoverable here and an entry with one would otherwise never
  // match anything at all.
  const hostPortMatch = e.match(/^([a-z0-9.-]+):(\d{1,5})$/);
  if (hostPortMatch && !isIPv6(e)) e = hostPortMatch[1];

  const cidrMatch = e.match(/^([\d.]+)\/(\d{1,2})$/);
  if (cidrMatch) {
    const targetInt = ipToInt(t);
    const baseInt = ipToInt(cidrMatch[1]);
    const maskBits = Number(cidrMatch[2]);
    if (targetInt === undefined || baseInt === undefined || maskBits > 32) return false;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (targetInt & mask) === (baseInt & mask);
  }

  const cidr6Match = e.match(/^([0-9a-f:]+)\/(\d{1,3})$/);
  if (cidr6Match) {
    const targetInt = ipv6ToBigInt(t);
    const baseInt = ipv6ToBigInt(cidr6Match[1]);
    const maskBits = Number(cidr6Match[2]);
    if (targetInt === undefined || baseInt === undefined || maskBits > 128) return false;
    const full = (1n << 128n) - 1n;
    const mask = maskBits === 0 ? 0n : (full << BigInt(128 - maskBits)) & full;
    return (targetInt & mask) === (baseInt & mask);
  }

  if (isIPv6(t) && isIPv6(e)) return canonicalizeIPv6(t) === canonicalizeIPv6(e);

  if (e.startsWith("*.")) {
    const suffix = e.slice(1); // ".example.com"
    return t === e.slice(2) || t.endsWith(suffix);
  }

  if (e.startsWith("http://") || e.startsWith("https://")) {
    try {
      const hostname = new URL(e).hostname.toLowerCase();
      return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname) === t;
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

  const targets = extractTargets(args, tldsFromEntries([...(scope ?? []), ...(outOfScope ?? [])]));
  if (targets.length === 0) return { verdict: "unknown" };

  const offending = targets.filter((t) => isTargetOutOfScope(scope, outOfScope, t));
  if (offending.length > 0) return { verdict: "out_of_scope", offending };
  return { verdict: "in_scope", targets };
}
