import { useEffect, useMemo, useState } from "react";
import { MissionPanel } from "./MissionPanel";
import { GlassPanel, SectionHeading, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useMissions } from "../hooks/useMissions";
import { useAssets } from "../hooks/useAssets";
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

/**
 * The Assets nav view: the mission's real Asset Inventory (backend/src/services/assetManager.ts),
 * grouped by type - each entry shows its real status/discoveredBy/lastSeen, and its parent asset
 * (via `parentId`) where known, forming the domain -> subdomain -> url -> port -> service tree the
 * spec describes. Own top-level nav item + its own MissionPanel selector, same pattern as every
 * other mission-scoped view (Findings/WorkOrders/Evidence/...) - no longer a FindingsView tab, and
 * no longer derived client-side from findings (see hooks/useAssets.ts).
 */
export function AssetsView() {
  const {
    missions,
    loading: missionsLoading,
    error: missionsError,
    refresh: refreshMissions,
    create: createMission,
    update: updateMission,
    remove: removeMission,
  } = useMissions();
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const { assets, loading, error } = useAssets(selectedMissionId);

  useEffect(() => {
    if (selectedMissionId && !missionsLoading && !missions.some((m) => m.id === selectedMissionId)) {
      setSelectedMissionId(null);
    }
  }, [missions, missionsLoading, selectedMissionId]);

  const handleSelectMission = (mission: Mission) => {
    setSelectedMissionId((current) => (current === mission.id ? null : mission.id));
  };

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const groups = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type], items: groupByType(assets, type) })).filter(
        (g) => g.items.length > 0,
      ),
    [assets],
  );

  return (
    <div className="flex flex-col gap-4">
      <MissionPanel
        missions={missions}
        loading={missionsLoading}
        error={missionsError}
        selectedMissionId={selectedMissionId}
        onSelect={handleSelectMission}
        onCreate={createMission}
        onUpdate={updateMission}
        onDelete={removeMission}
        onRefresh={refreshMissions}
      />

      {!selectedMissionId && <p className="text-xs text-muted">Select or create a mission above to view its assets.</p>}

      {selectedMissionId && (
        <>
          <SectionHeading>Assets ({assets.length})</SectionHeading>
          {error && <p className="text-xs text-critical">{error}</p>}
          {loading && assets.length === 0 && <SkeletonRows count={5} />}
          {!loading && groups.length === 0 && (
            <p className="text-xs text-muted">
              No assets discovered yet — run recon tools, a Scan Profile, or "Start / Advance Factory" against this
              mission.
            </p>
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
        </>
      )}
    </div>
  );
}
