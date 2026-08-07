import type { ScanProfile } from "../types/scanner.js";

const profiles = new Map<string, ScanProfile>();

export function registerScanProfile(profile: ScanProfile): void {
  profiles.set(profile.id, profile);
}

export function getScanProfile(id: string): ScanProfile | undefined {
  return profiles.get(id);
}

export function listScanProfiles(): ScanProfile[] {
  return [...profiles.values()];
}
