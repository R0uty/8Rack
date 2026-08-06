import { parseBareUrlList } from "./shared.js";
import type { ParsedFinding } from "../types/finding.js";

/** httpx's only default argument is `-silent` (see builtins.ts), which prints one live URL per
 * line with no title/tech-detect/status-code info - so this can only produce Endpoint findings,
 * not Technology findings, until the tool is invoked with extra flags. */
export function parse(stdout: string, _target: string): ParsedFinding[] {
  return parseBareUrlList(stdout, "httpx");
}
