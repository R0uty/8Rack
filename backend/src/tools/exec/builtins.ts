import type { ExecTool } from "../../types/execTool.js";

/**
 * The built-in tool roster. `allowedArguments` is intentionally left unset for all of these —
 * with `requiresConfirmation: true` on every tool, the human reviewing the resolved command
 * before approving it is the primary safety control for this phase. Path-shaped arguments are
 * still checked against the workspace root regardless (see toolManager.ts#validateArguments) —
 * but that check inspects each argv element as its own path, so it can't see inside a `bash -c`/
 * `python3 -c` script string: `arguments: ["-c", "cat ~/.ssh/id_rsa"]` isn't a path-shaped
 * argument at all, so it sails through untouched. `bash`/`python`'s own descriptions below call
 * this out explicitly so a reviewer doesn't over-trust the "confined to workspace" framing that
 * genuinely does apply to the filesystem tools just above them — for these two, the resolved
 * command shown in the confirm card *is* the entire safety review.
 * Tightening specific tools with an allowlist later is a config-only change, not a code change.
 */
export const builtinExecTools: ExecTool[] = [
  // --- os: filesystem (confined to the workspace root) ---
  {
    id: "read_file",
    name: "Read File",
    description: "Reads and returns the contents of a file within the workspace.",
    category: "os",
    executable: "cat",
    defaultArguments: [],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "📄",
    versionFlag: "--version",
  },
  {
    id: "write_file",
    name: "Write File",
    description: "Writes content (passed as stdin) to a file within the workspace, creating or overwriting it.",
    category: "os",
    executable: "tee",
    defaultArguments: [],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "💾",
    versionFlag: "--version",
  },
  {
    id: "list_directory",
    name: "List Directory",
    description: "Lists the contents of a directory within the workspace.",
    category: "os",
    executable: "ls",
    defaultArguments: ["-la"],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "📁",
    versionFlag: "--version",
  },
  {
    id: "search_files",
    name: "Search Files",
    description: "Finds files within the workspace by name/path pattern.",
    category: "os",
    executable: "find",
    defaultArguments: [],
    timeout: 15_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🔍",
    versionFlag: "--version",
  },
  {
    id: "grep",
    name: "Grep",
    description: "Searches file contents within the workspace for a pattern.",
    category: "os",
    executable: "rg",
    defaultArguments: ["--line-number"],
    timeout: 15_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🔎",
    versionFlag: "--version",
  },

  // --- os: version control ---
  {
    id: "git",
    name: "Git",
    description: "Runs a git subcommand within the workspace.",
    category: "os",
    executable: "git",
    defaultArguments: [],
    timeout: 20_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🌿",
    versionFlag: "--version",
  },

  // --- os: code execution ---
  {
    id: "bash",
    name: "Bash",
    description:
      "Runs a shell command (e.g. arguments: [\"-c\", \"whoami\"]). NOT confined to the workspace " +
      "root - the script string isn't checked for path containment, so it can read/write anywhere " +
      "this process can. Review the exact resolved command before approving.",
    category: "os",
    executable: "bash",
    defaultArguments: [],
    timeout: 30_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "⚡",
    versionFlag: "--version",
  },
  {
    id: "python",
    name: "Python",
    description:
      "Runs Python (e.g. arguments: [\"-c\", \"print(1+1)\"]). NOT confined to the workspace root " +
      "- the script string isn't checked for path containment, so it can read/write anywhere this " +
      "process can. Review the exact resolved command before approving.",
    category: "os",
    executable: "python3",
    defaultArguments: [],
    timeout: 30_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🐍",
    versionFlag: "--version",
  },

  // --- web ---
  {
    id: "curl",
    name: "Curl",
    description: "Makes an arbitrary HTTP(S) request with full curl flag control.",
    category: "web",
    executable: "curl",
    defaultArguments: ["-s"],
    timeout: 20_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🌐",
    versionFlag: "--version",
  },
  {
    id: "http_request",
    name: "HTTP Request",
    description: "Makes an HTTP(S) request with safer defaults (headers shown, 15s cap).",
    category: "web",
    executable: "curl",
    defaultArguments: ["-s", "-i", "--max-time", "15"],
    timeout: 20_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "📡",
    versionFlag: "--version",
  },

  // --- network ---
  {
    id: "nmap",
    name: "Nmap",
    description: "Network port/service scanner.",
    category: "network",
    executable: "nmap",
    defaultArguments: [],
    timeout: 120_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🛰️",
    versionFlag: "-V",
  },

  // --- web ---
  {
    id: "httpx",
    name: "Httpx",
    description: "Probes HTTP servers for status, title, and tech fingerprints.",
    category: "web",
    executable: "httpx",
    defaultArguments: ["-silent"],
    timeout: 60_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🔗",
    versionFlag: "-version",
    // `httpx` is also the command name of the unrelated python-httpx HTTP client, which has none of
    // these flags (not even -silent). Require the ProjectDiscovery banner so that when python-httpx
    // is the one on PATH the tool reports unavailable instead of failing every run on "-s". Install
    // the real one from github.com/projectdiscovery/httpx (a Go binary earlier on PATH shadows the
    // python one - e.g. ~/.local/bin/httpx).
    identitySignature: "projectdiscovery",
  },

  // --- fuzzing ---
  {
    id: "ffuf",
    name: "Ffuf",
    description: "Fast web fuzzer for content/parameter discovery.",
    category: "fuzzing",
    executable: "ffuf",
    defaultArguments: [],
    timeout: 120_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🧨",
    versionFlag: "-V",
  },

  // --- web ---
  {
    id: "katana",
    name: "Katana",
    description: "Crawls a web target to enumerate endpoints.",
    category: "web",
    executable: "katana",
    defaultArguments: ["-silent"],
    timeout: 60_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🕸️",
    versionFlag: "-version",
  },

  // --- analysis ---
  {
    id: "nuclei",
    name: "Nuclei",
    description: "Runs template-based vulnerability scans against a target.",
    category: "analysis",
    executable: "nuclei",
    defaultArguments: ["-silent"],
    timeout: 180_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "☢️",
    versionFlag: "-version",
  },
  // --- recon ---
  {
    id: "subfinder",
    name: "Subfinder",
    description: "Passive subdomain enumeration.",
    category: "recon",
    executable: "subfinder",
    defaultArguments: ["-silent"],
    timeout: 60_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🌱",
    versionFlag: "-version",
  },
  {
    id: "amass",
    name: "Amass",
    description: "In-depth attack surface mapping and asset discovery.",
    category: "recon",
    executable: "amass",
    defaultArguments: [],
    timeout: 180_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "lines",
    icon: "🕷️",
    versionFlag: "-version",
  },

  // --- network ---
  {
    id: "whois",
    name: "Whois",
    description: "Looks up domain/IP registration information.",
    category: "network",
    executable: "whois",
    defaultArguments: [],
    timeout: 15_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "📇",
  },
  {
    id: "dig",
    name: "Dig",
    description: "Queries DNS records for a domain.",
    category: "network",
    executable: "dig",
    defaultArguments: [],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🧭",
    versionFlag: "-v",
  },
  {
    id: "nslookup",
    name: "Nslookup",
    description: "Queries DNS to resolve a domain or IP.",
    category: "network",
    executable: "nslookup",
    defaultArguments: [],
    timeout: 10_000,
    enabled: true,
    requiresConfirmation: true,
    parser: "text",
    icon: "🔬",
  },
];
