import type { ScanProfile } from "../types/scanner.js";

/**
 * The built-in scan profile roster — each step's `toolId` must match a registered ExecTool (see
 * tools/exec/builtins.ts). "{target}" is substituted with the run's target verbatim (no per-tool
 * normalization between hostname/URL/IP forms), same as a human typing the same target into each
 * tool manually via the Workbench. Steps deliberately omit flags already baked into a tool's own
 * `defaultArguments` (e.g. "-silent" on httpx/katana/nuclei/subfinder) — toolManager's
 * buildResolvedCommand concatenates defaultArguments + these arguments, so repeating one here
 * would just duplicate it on the actual command line.
 */
export const builtinScanProfiles: ScanProfile[] = [
  {
    id: "quick-recon",
    name: "Quick Recon",
    description: "Fast first-pass reconnaissance: DNS records, WHOIS registration, and an HTTP probe.",
    icon: "🧭",
    steps: [
      { toolId: "dig", arguments: ["{target}"] },
      { toolId: "whois", arguments: ["{target}"] },
      { toolId: "httpx", arguments: ["-u", "{target}"] },
    ],
  },
  {
    id: "subdomain-discovery",
    name: "Subdomain Discovery",
    description: "Passive subdomain enumeration followed by a liveness probe of the target.",
    icon: "🌱",
    steps: [
      { toolId: "subfinder", arguments: ["-d", "{target}"] },
      { toolId: "amass", arguments: ["enum", "-passive", "-d", "{target}"] },
      { toolId: "httpx", arguments: ["-u", "{target}"] },
    ],
  },
  {
    id: "web-app-scan",
    name: "Web App Scan",
    description: "Probe, crawl, and run template-based vulnerability checks against a web target.",
    icon: "🕸️",
    steps: [
      { toolId: "httpx", arguments: ["-u", "{target}"] },
      { toolId: "katana", arguments: ["-u", "{target}"] },
      { toolId: "nuclei", arguments: ["-u", "{target}"] },
    ],
  },
  {
    id: "full-port-scan",
    name: "Full Port Scan",
    description: "Service/version detection across every port, then an HTTP probe of what's found.",
    icon: "🛰️",
    steps: [
      { toolId: "nmap", arguments: ["-sV", "-p-", "-T4", "{target}"] },
      { toolId: "httpx", arguments: ["-u", "{target}"] },
    ],
  },
];
