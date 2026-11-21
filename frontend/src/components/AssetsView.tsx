import { useMemo, useState } from "react";
import { Ban, Boxes, ClipboardList, Play, Plus, Radar, Trash2 } from "lucide-react";
import { NoMission } from "./NoMission";
import { NewWorkOrderSheet } from "./NewWorkOrderSheet";
import { Button, EmptyState, GlassPanel, IconButton, Notice, SectionHeading, SELECT_CLASS, SkeletonRows, StatusPill, type Tone } from "./ui";
import { useAssets } from "../hooks/useAssets";
import { useWorkOrders } from "../hooks/useWorkOrders";
import { useRefreshOnActivate } from "../hooks/useRefreshOnActivate";
import { createAsset, deleteAsset, setAssetStatus } from "../services/assetsApi";
import { updateMission } from "../services/missionsApi";
import { useAppNav } from "../lib/appNav";
import { relativeTime } from "../lib/relativeTime";
import type { AgentWithStatus } from "../types/agent";
import type { Mission } from "../types/mission";
import type { Asset, AssetStatus, AssetType } from "../types/asset";
import type { WorkOrderCreateInput } from "../types/workOrder";

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
const STATUSES: AssetStatus[] = ["active", "unverified", "inactive"];
/** Types that name something a scanner or an agent can be pointed at. */
const TARGETABLE: AssetType[] = ["domain", "subdomain", "ip", "url", "api"];

const STATUS_TONE: Record<AssetStatus, Tone> = {
  active: "primary",
  unverified: "warning",
  inactive: "neutral",
};

function groupByType(assets: Asset[], type: AssetType): Asset[] {
  return assets.filter((a) => a.type === type).sort((a, b) => b.lastSeen - a.lastSeen);
}

interface AssetsViewProps {
  mission: Mission | null;
  agents?: AgentWithStatus[];
  active?: boolean;
}

/**
 * A mission's Asset Inventory (backend/src/services/assetManager.ts), grouped by type. A human can add
 * an asset the agents missed, correct its status, remove one that isn't real, rule a host out of
 * scope, or point a scan or a work order at it.
 */
export function AssetsView({ mission, agents = [], active = true }: AssetsViewProps) {
  const missionId = mission?.id ?? null;
  const { assets, loading, error, refresh } = useAssets(missionId);
  const { create: createWorkOrder, start: startWorkOrder } = useWorkOrders(missionId);
  useRefreshOnActivate(active, refresh);
  const { openView, scanTarget } = useAppNav();

  const [newType, setNewType] = useState<AssetType>("domain");
  const [newValue, setNewValue] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [workOrderTarget, setWorkOrderTarget] = useState<string | null>(null);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const groups = useMemo(
    () =>
      TYPE_ORDER.map((type) => ({ type, label: TYPE_LABELS[type], items: groupByType(assets, type) })).filter(
        (g) => g.items.length > 0,
      ),
    [assets],
  );

  if (!mission) return <NoMission />;

  const act = async (id: string, action: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyId(null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newValue.trim()) return;
    await act("new", () => createAsset(mission.id, { type: newType, value: newValue.trim() }), "Failed to add the asset");
    setNewValue("");
  };

  // Out of scope is a mission rule, not an asset flag: the scope checker then refuses tools aimed at
  // it, and the asset itself is marked inactive so the Director stops seeding work for it.
  const markOutOfScope = (asset: Asset) =>
    act(
      asset.id,
      async () => {
        const outOfScope = mission.outOfScope ?? [];
        if (!outOfScope.includes(asset.value)) await updateMission(mission.id, { outOfScope: [...outOfScope, asset.value] });
        await setAssetStatus(mission.id, asset.id, "inactive");
      },
      "Failed to mark the asset out of scope",
    );

  const handleCreateWorkOrder = async (input: WorkOrderCreateInput, startNow: boolean) => {
    const created = await createWorkOrder(input);
    if (startNow) await startWorkOrder(created.id);
  };

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Type
          <select value={newType} onChange={(e) => setNewType(e.target.value as AssetType)} className={SELECT_CLASS}>
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-[11px] text-muted">
          Value
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="e.g. api.example.com or 443/tcp"
            className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-text outline-none placeholder:text-muted focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
          />
        </label>
        <Button type="submit" variant="secondary" size="sm" icon={Plus} disabled={!newValue.trim() || busyId === "new"}>
          Add asset
        </Button>
      </form>

      {error && <Notice>{error}</Notice>}
      {actionError && <Notice>{actionError}</Notice>}
      {loading && assets.length === 0 && <SkeletonRows count={5} />}
      {!loading && groups.length === 0 && (
        <EmptyState icon={Boxes} title="No assets yet" action={{ label: "Open the Factory", icon: Play, onClick: openView && (() => openView("factory")) }}>
          Assets are the hosts, ports, URLs and technologies the factory discovers. Advance the factory, run a scan
          from Tools, or add one above.
        </EmptyState>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {groups.map((group) => (
          <GlassPanel key={group.type} padding="md">
            <SectionHeading>
              {group.label} ({group.items.length})
            </SectionHeading>
            <ul className="flex flex-col gap-1.5">
              {group.items.map((asset) => {
                const parent = asset.parentId ? byId.get(asset.parentId) : undefined;
                const busy = busyId === asset.id;
                const outOfScope = mission.outOfScope?.includes(asset.value);
                return (
                  <li key={asset.id} className="flex flex-col gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-text" title={parent ? `on ${parent.value}` : undefined}>
                          {asset.value}
                        </span>
                        <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-muted">
                          <span>{asset.discoveredBy}</span>
                          <span>· {relativeTime(asset.lastSeen)}</span>
                          {parent && <span>· on {parent.value}</span>}
                          {outOfScope && <span className="text-warning">· out of scope</span>}
                        </div>
                      </div>
                      <StatusPill tone={STATUS_TONE[asset.status]} dot className="shrink-0 px-1.5 py-0.5 text-[10px]">
                        {asset.status}
                      </StatusPill>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <select
                        aria-label={`Status of ${asset.value}`}
                        value={asset.status}
                        disabled={busy}
                        onChange={(e) => act(asset.id, () => setAssetStatus(mission.id, asset.id, e.target.value as AssetStatus), "Failed to update the asset")}
                        className={`${SELECT_CLASS} py-0.5 text-[11px]`}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      {TARGETABLE.includes(asset.type) && scanTarget && (
                        <IconButton icon={Radar} label={`Scan ${asset.value}`} size="sm" onClick={() => scanTarget(asset.value)} />
                      )}
                      {TARGETABLE.includes(asset.type) && (
                        <IconButton icon={ClipboardList} label={`New work order for ${asset.value}`} size="sm" onClick={() => setWorkOrderTarget(asset.value)} />
                      )}
                      {TARGETABLE.includes(asset.type) && !outOfScope && (
                        <IconButton icon={Ban} label={`Mark ${asset.value} out of scope`} size="sm" disabled={busy} onClick={() => markOutOfScope(asset)} />
                      )}
                      {confirmRemoveId === asset.id ? (
                        <>
                          <Button variant="danger" size="sm" disabled={busy} onClick={() => act(asset.id, () => deleteAsset(mission.id, asset.id), "Failed to remove the asset")}>
                            Remove
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmRemoveId(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <IconButton icon={Trash2} label={`Remove ${asset.value}`} size="sm" onClick={() => setConfirmRemoveId(asset.id)} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </GlassPanel>
        ))}
      </div>
      <NewWorkOrderSheet
        key={workOrderTarget ?? ""}
        open={workOrderTarget !== null}
        agents={agents}
        initialTarget={workOrderTarget ?? undefined}
        onClose={() => setWorkOrderTarget(null)}
        onCreate={handleCreateWorkOrder}
      />
    </div>
  );
}
