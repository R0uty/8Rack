export type AssetType = "domain" | "subdomain" | "url" | "ip" | "port" | "service" | "api" | "technology";

export type AssetStatus = "active" | "inactive" | "unverified";

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
