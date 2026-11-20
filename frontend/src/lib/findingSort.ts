import type { Finding, FindingSeverity } from "../types/finding";

export type SortKey = "severity" | "status" | "type" | "title" | "target" | "tool" | "confidence" | "createdAt" | "updatedAt";

const SEVERITY_RANK: Record<FindingSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function sortValue(f: Finding, key: SortKey): string | number {
  if (key === "severity") return SEVERITY_RANK[f.severity];
  const v = f[key];
  return typeof v === "number" ? v : String(v).toLowerCase();
}

/** Sorts a copy; null leaves the input order (the server's, newest first). */
export function sortFindings(findings: Finding[], key: SortKey | null, dir: "asc" | "desc"): Finding[] {
  if (!key) return findings;
  const sign = dir === "asc" ? 1 : -1;
  return [...findings].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

