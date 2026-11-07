import { env } from "../config/env.js";
import { CveLookupError } from "./errors.js";
import type { FindingSeverity } from "../types/finding.js";

/** The only outbound internet call 8Rack ever makes - only on-demand, when a user or agent
 * explicitly requests a CVE lookup (see findingsManager.ts's lookupCvesForFinding/lookupCvesByKeyword). */
const NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const MAX_RESULTS = 5;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Both spacings are safely under NVD's real limits (5 req/30s unauthenticated, 50 req/30s with a
 * free API key) - NVD doesn't return rate-limit headers, so this has to be enforced client-side. */
const UNAUTHENTICATED_INTERVAL_MS = 6500;
const AUTHENTICATED_INTERVAL_MS = 700;

export interface CveLookupResult {
  id: string;
  description: string;
  cvssScore: number | null;
  cvssSeverity: FindingSeverity;
  cvssVector: string | null;
  references: string[];
}

interface NvdCvssData {
  baseScore?: number;
  baseSeverity?: string;
  vectorString?: string;
}

interface NvdMetric {
  /** CVSS v2 metrics carry baseSeverity here, not under cvssData - v3.x metrics do the opposite. */
  baseSeverity?: string;
  cvssData?: NvdCvssData;
}

interface NvdCve {
  id: string;
  descriptions?: { lang: string; value: string }[];
  metrics?: {
    cvssMetricV31?: NvdMetric[];
    cvssMetricV30?: NvdMetric[];
    cvssMetricV2?: NvdMetric[];
  };
  references?: { url: string }[];
}

interface NvdResponse {
  vulnerabilities?: { cve: NvdCve }[];
}

const NVD_SEVERITY_MAP: Record<string, FindingSeverity> = {
  none: "info",
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

function severityFromScore(score: number): FindingSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
}

/** Falls back cvssMetricV31 -> cvssMetricV30 -> cvssMetricV2 (older CVEs often only have V2), then
 * falls back from NVD's own baseSeverity string to a baseScore threshold when baseSeverity is
 * absent entirely. */
function extractSeverity(cve: NvdCve): { score: number | null; severity: FindingSeverity; vector: string | null } {
  const metric = cve.metrics?.cvssMetricV31?.[0] ?? cve.metrics?.cvssMetricV30?.[0] ?? cve.metrics?.cvssMetricV2?.[0];
  if (!metric) return { score: null, severity: "info", vector: null };

  const score = metric.cvssData?.baseScore ?? null;
  const rawSeverity = metric.cvssData?.baseSeverity ?? metric.baseSeverity;
  const severity = rawSeverity
    ? (NVD_SEVERITY_MAP[rawSeverity.toLowerCase()] ?? "info")
    : score !== null
      ? severityFromScore(score)
      : "info";

  return { score, severity, vector: metric.cvssData?.vectorString ?? null };
}

let lastRequestAt = 0;
const cache = new Map<string, { results: CveLookupResult[]; expiresAt: number }>();

/** Test-only: clears the throttle timestamp and cache so tests don't leak state into each other
 * (fake-timer clock resets between tests otherwise interact badly with a monotonically-advancing
 * module-level lastRequestAt). Not used by application code. */
export function _resetForTests(): void {
  lastRequestAt = 0;
  cache.clear();
}

async function throttle(): Promise<void> {
  const interval = env.nvdApiKey ? AUTHENTICATED_INTERVAL_MS : UNAUTHENTICATED_INTERVAL_MS;
  const wait = lastRequestAt + interval - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/** Queries the NVD CVE database for `keyword` (typically a technology finding's title, e.g.
 * "nginx"). Cached for 24h per keyword and throttled to stay under NVD's rate limit. */
export async function queryNvd(keyword: string): Promise<CveLookupResult[]> {
  const key = keyword.trim().toLowerCase();
  if (!key) return [];

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  await throttle();

  const url = `${NVD_BASE_URL}?keywordSearch=${encodeURIComponent(key)}&resultsPerPage=${MAX_RESULTS}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "8Rack/1.0",
        ...(env.nvdApiKey ? { apiKey: env.nvdApiKey } : {}),
      },
      // A dead-but-open connection to NVD would otherwise hang this indefinitely - there's no
      // caller-supplied signal to combine with here, this is the only outbound internet call the
      // app ever makes and it's not user-cancellable mid-flight.
      signal: AbortSignal.timeout(env.nvdRequestTimeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new CveLookupError("NVD API did not respond in time", err);
    }
    throw new CveLookupError("Could not reach the NVD API - check network connectivity", err);
  }

  if (!response.ok) {
    throw new CveLookupError(
      response.status === 403
        ? "NVD API rate limit exceeded - wait a moment and try again"
        : `NVD API request failed with status ${response.status}`,
    );
  }

  let data: NvdResponse;
  try {
    data = (await response.json()) as NvdResponse;
  } catch (err) {
    throw new CveLookupError("NVD API returned an unparsable response", err);
  }

  const results: CveLookupResult[] = (data.vulnerabilities ?? []).map(({ cve }) => {
    const { score, severity, vector } = extractSeverity(cve);
    return {
      id: cve.id,
      description: cve.descriptions?.find((d) => d.lang === "en")?.value ?? "",
      cvssScore: score,
      cvssSeverity: severity,
      cvssVector: vector,
      references: (cve.references ?? []).map((r) => r.url),
    };
  });

  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  return results;
}
