import { parseBareUrlList } from "./shared.js";
import type { ParsedFinding } from "../types/finding.js";

/** katana's only default argument is `-silent` (see builtins.ts), which prints one crawled URL
 * per line - identical shape to httpx's silent output. */
export function parse(stdout: string, _target: string): ParsedFinding[] {
  return parseBareUrlList(stdout, "katana");
}
