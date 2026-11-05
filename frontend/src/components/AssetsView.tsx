import { useMemo } from "react";
import { NoMission } from "./NoMission";
import { GlassPanel, SectionHeading, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useAssets } from "../hooks/useAssets";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { relativeTime } from "../lib/relativeTime";
import type { Mission } from "../types/mission";
import type { Asset, AssetStatus, AssetType } from "../types/asset";

const TYPE_LABELS: Record<AssetType, string> = {
  domain: "Domains",
  subdomain: "Subdomains",
  url: "URLs",
  ip: "IP addresses",
  port: "Ports",
  service: "Services",
  api: "APIs",
  technology: "Technologies",
};

const TYPE_ORDER: AssetType[] = ["domain", "subdomain", "ip", "url", "port", "service", "api", "technology"];

const STATUS_TONE: Record<AssetStatus, Tone> = {
  active: "primary",
  unverified: "warning",
  inactive: "neutral",
};

function groupByType(assets: Asset[], type: AssetType): Asset[] {
  return assets.filter((a) => a.type === type).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** A mission's real Asset Inventory (backend/src/services/assetManager.ts), grouped by type. */
export function AssetsView({ mission, active = true }: { mission: Mission | null; active?: boolean }) {
  const { assets, loading, error, refresh } = useAssets(mission?.id ?? null);
  useRefreshOnActivate(active, refresh);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const groups = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type], items: groupByType(assets, type) })).filter(
        (g) => g.items.length > 0,
      ),
    [assets],
  );

  if (!mission) return <NoMission />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-xs text-critical">{error}</p>}
      {loading && assets.length === 0 && <SkeletonRows count={5} />}
      {!loading && groups.length === 0 && (
        <p className="text-xs text-muted">No assets yet - advance the factory or run a scan to discover some.</p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((group) => (
          <GlassPanel key={group.type} padding="md">
            <SectionHeading>
              {group.label} ({group.items.length})
            </SectionHeading>
            <div className="flex flex-col gap-1.5">
              {group.items.map((asset) => {
                const parent = asset.parentId ? byId.get(asset.parentId) : undefined;
                return (
                  <div key={asset.id} className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <span className="truncate font-mono text-text" title={parent ? `on ${parent.value}` : undefined}>
                        {asset.value}
                      </span>
                      <div className="mt-0.5 flex gap-1.5 text-[10px] text-muted">
                        <span>{asset.discoveredBy}</span>
                        <span>· {relativeTime(asset.lastSeen)}</span>
                      </div>
                    </div>
                    <StatusPill tone={STATUS_TONE[asset.status]} dot className="shrink-0 px-1.5 py-0.5 text-[10px]">
                      {asset.status}
                    </StatusPill>
                  </div>
                );
              })}
            </div>
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}
