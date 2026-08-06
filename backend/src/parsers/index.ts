import { extractFlagValue, lastPositionalArg } from "./shared.js";
import { parse as parseNmap } from "./nmapParser.js";
import { parse as parseHttpx } from "./httpxParser.js";
import { parse as parseFfuf } from "./ffufParser.js";
import { parse as parseKatana } from "./katanaParser.js";
import { parse as parseNuclei } from "./nucleiParser.js";
import { parse as parseSubfinder } from "./subfinderParser.js";
import { parse as parseDig } from "./digParser.js";
import { parse as parseWhois } from "./whoisParser.js";
import type { ParsedFinding } from "../types/finding.js";

type ParserFn = (stdout: string, target: string) => ParsedFinding[];

/** Registry of parsers keyed by exec tool id (backend/src/tools/exec/builtins.ts), each paired
 * with how to extract that tool's scan target from its invocation arguments - target isn't always
 * the last CLI arg (e.g. `ffuf -u https://x.com/FUZZ -w wordlist.txt` has the wordlist last). */
const PARSERS: Record<string, { parse: ParserFn; target: (args: string[]) => string | undefined }> = {
  nmap: { parse: parseNmap, target: lastPositionalArg },
  httpx: { parse: parseHttpx, target: (args) => extractFlagValue(args, "-u") ?? lastPositionalArg(args) },
  ffuf: { parse: parseFfuf, target: (args) => extractFlagValue(args, "-u") },
  katana: { parse: parseKatana, target: (args) => extractFlagValue(args, "-u") ?? lastPositionalArg(args) },
  nuclei: { parse: parseNuclei, target: (args) => extractFlagValue(args, "-u") },
  subfinder: { parse: parseSubfinder, target: (args) => extractFlagValue(args, "-d") ?? lastPositionalArg(args) },
  dig: { parse: parseDig, target: lastPositionalArg },
  whois: { parse: parseWhois, target: lastPositionalArg },
};

/** Parses a completed execution's stdout into findings for the given tool, or `[]` if there's no
 * parser registered for it, no arguments-derivable target, or the parser itself throws. */
export function parseExecutionOutput(toolId: string, args: string[], stdout: string): ParsedFinding[] {
  const entry = PARSERS[toolId];
  if (!entry) return [];

  const target = entry.target(args);
  if (!target) return [];

  try {
    return entry.parse(stdout, target);
  } catch (err) {
    console.error(`[parsers] parser for "${toolId}" threw:`, err);
    return [];
  }
}
