import { useMemo } from "react";
import type { Finding, FindingType } from "../types/finding";
import { GlassPanel, SectionHeading } from "./ui";

interface AssetsViewProps {
  findings: Finding[];
}

/** Which FindingTypes count as "assets" for this view, and their display label - a subset of
 * FindingType, deliberately excluding vulnerability/credential/cookie/header/information findings
 * (those belong in the Findings table, not an asset inventory). */
const ASSET_TYPE_LABELS: Partial<Record<FindingType, string>> = {
  domain: "Domains",
  subdomain: "Subdomains",
  port: "Ports",
  technology: "Technologies",
  api: "APIs",
  endpoint: "Endpoints / URLs",
};

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

interface AssetItem {
  value: string;
  target: string;
  count: number;
  lastSeenAt: number;
}

function upsert(map: Map<string, AssetItem>, key: string, finding: Finding) {
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, finding.lastSeenAt);
  } else {
    map.set(key, { value: key, target: finding.target, count: 1, lastSeenAt: finding.lastSeenAt });
  }
}

function groupByType(findings: Finding[], type: FindingType): AssetItem[] {
  const map = new Map<string, AssetItem>();
  for (const f of findings) {
    if (f.type === type) upsert(map, f.value, f);
  }
  return [...map.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * There's no dedicated "ip" FindingType (see DEVELOPMENT.md's Assets view section for why) - IP
 * addresses are instead recovered from any finding whose `target` happens to already be one,
 * which every port/service finding from an IP-based nmap scan already satisfies.
 */
function distinctIps(findings: Finding[]): AssetItem[] {
  const map = new Map<string, AssetItem>();
  for (const f of findings) {
    if (IPV4_RE.test(f.target)) upsert(map, f.target, f);
  }
  return [...map.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * A read-only Assets inventory derived entirely from the project's existing Findings - no new
 * backend entity (see DEVELOPMENT.md). Regroups findings the Findings Engine already parsed out of
 * tool output into the asset categories the task asked for (domains, subdomains, IPs, ports,
 * technologies, APIs, endpoints/URLs), deduplicated by each finding's canonical `value`.
 */
export function AssetsView({ findings }: AssetsViewProps) {
  const groups = useMemo(() => {
    const entries = [
      { key: "ip", label: "IP addresses", items: distinctIps(findings) },
      ...(Object.keys(ASSET_TYPE_LABELS) as FindingType[]).map((type) => ({
        key: type,
        label: ASSET_TYPE_LABELS[type]!,
        items: groupByType(findings, type),
      })),
    ];
    return entries.filter((g) => g.items.length > 0);
  }, [findings]);

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted">
        No assets discovered yet — run recon tools or a Scan Profile against this project's target(s).
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {groups.map((group) => (
        <GlassPanel key={group.key} padding="md">
          <SectionHeading>
            {group.label} ({group.items.length})
          </SectionHeading>
          <div className="flex flex-col gap-1.5">
            {group.items.map((item) => (
              <div
                key={item.value}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs"
              >
                <span
                  className="truncate font-mono text-text"
                  title={item.target !== item.value ? `on ${item.target}` : undefined}
                >
                  {item.value}
                </span>
                {item.count > 1 && <span className="shrink-0 text-muted">×{item.count}</span>}
              </div>
            ))}
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}
