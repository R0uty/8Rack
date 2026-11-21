import { describe, expect, it } from "vitest";
import * as backendFinding from "../../../backend/src/types/finding";
import * as backendAsset from "../../../backend/src/types/asset";
import * as backendReport from "../../../backend/src/types/report";
import * as backendMission from "../../../backend/src/types/mission";
import { FINDING_SEVERITIES, FINDING_STATUSES, FINDING_TYPES } from "./finding";
import { ASSET_STATUSES, ASSET_TYPES } from "./asset";
import { REPORT_STATUSES } from "./report";
import { MISSION_STATUSES } from "./mission";

// The frontend can't share the backend's modules at runtime (two workspaces, no shared package),
// so it keeps its own copies of these lists. This fails the moment one side adds a value the other
// doesn't know about.
describe("enum lists mirror the backend", () => {
  it.each([
    ["FINDING_TYPES", FINDING_TYPES, backendFinding.FINDING_TYPES],
    ["FINDING_SEVERITIES", FINDING_SEVERITIES, backendFinding.FINDING_SEVERITIES],
    ["FINDING_STATUSES", FINDING_STATUSES, backendFinding.FINDING_STATUSES],
    ["ASSET_TYPES", ASSET_TYPES, backendAsset.ASSET_TYPES],
    ["ASSET_STATUSES", ASSET_STATUSES, backendAsset.ASSET_STATUSES],
    ["REPORT_STATUSES", REPORT_STATUSES, backendReport.REPORT_STATUSES],
    ["MISSION_STATUSES", MISSION_STATUSES, backendMission.MISSION_STATUSES],
  ])("%s", (_name, frontend, backend) => {
    expect([...frontend]).toEqual([...backend]);
  });
});
