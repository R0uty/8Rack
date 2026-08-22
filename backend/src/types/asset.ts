export type AssetType = "domain" | "subdomain" | "url" | "ip" | "port" | "service" | "api" | "technology";

/**
 * An asset's lifecycle status, independent of any Finding's own triage status - "active" (currently
 * believed to exist/respond, the default once a scanner/agent has actually observed it), "inactive"
 * (was seen once but hasn't been re-confirmed since - not deleted, just stale), "unverified" (agent-
 * reported via the upsert_asset pseudo-tool with no scanner confirmation backing it yet).
 */
export type AssetStatus = "active" | "inactive" | "unverified";

/**
 * The Asset Inventory - a real, deduplicated store of everything discovered for a mission, distinct
 * from a Finding (which describes something *about* a target - a vuln, a credential, a header) even
 * though both are populated from the same scanner/agent activity. See services/assetManager.ts.
 */
export interface Asset {
  id: string;
  missionId: string;
  type: AssetType;
  /** Canonical value for this asset's type - a hostname for domain/subdomain, a bare IP, a full URL,
   * "80/tcp"-style for a port (mirrors Finding.value's own per-type convention, so findingsManager.ts
   * can mirror a Finding straight into an Asset with no extra translation). */
  value: string;
  status: AssetStatus;
  /** Agent id, tool id, or "manual" - whoever/whatever most recently (re-)observed this asset. */
  discoveredBy: string;
  /** Same source vocabulary as Finding.source. */
  source: "scanner" | "agent" | "manual";
  firstSeen: number;
  lastSeen: number;
  metadata: Record<string, unknown>;
  /** Encodes the domain -> subdomain -> url -> port -> service tree from the factory spec's example -
   * the asset this one was discovered "on"/"under", if any (e.g. a port's parentId points at the
   * host it was found open on). Best-effort, not always resolvable. */
  parentId?: string;
}

export type AssetCreateInput = Pick<Asset, "type" | "value"> &
  Partial<Pick<Asset, "status" | "discoveredBy" | "source" | "metadata" | "parentId">>;

export type AssetPatchInput = Partial<Pick<Asset, "status" | "metadata">>;
