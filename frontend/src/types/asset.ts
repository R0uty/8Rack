export const ASSET_TYPES = ["domain", "subdomain", "url", "ip", "port", "service", "api", "technology"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_STATUSES = ["active", "inactive", "unverified"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface Asset {
  id: string;
  missionId: string;
  type: AssetType;
  value: string;
  status: AssetStatus;
  discoveredBy: string;
  source: "scanner" | "agent" | "manual";
  firstSeen: number;
  lastSeen: number;
  metadata: Record<string, unknown>;
  parentId?: string;
}
