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
    usageHint: 'Use when you need to see a specific file\'s contents. arguments: ["<path/to/file>"]',
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
    // The plain-text {"tool","arguments"} convention every tool speaks has no stdin field of its
    // own - orchestrator.ts#splitWriteFileContent is what turns this tool's two-element convention
    // into the real stdin-carrying ToolRequestBody right before requestExecution is called, so the
    // model just needs to follow the shape below; it never sees or supplies a real "stdin" field.
    usageHint:
      "Use to save real content (notes, a report, extracted data) to a file in the workspace. " +
      'arguments: ["<path/to/file>", "<content to write>"] - exactly two elements, path first, ' +
      "then the full file content as a single string (use \\n for newlines). The confirming human " +
      "sees a byte count for the content, not the content itself, before approving.",
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
    usageHint: 'Use to see what\'s in a directory before deciding what to read next. arguments: ["<path>"] or [] for the workspace root.',
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
    usageHint:
      'Use to locate files by name/pattern before reading or grepping them. arguments: ["<start dir>", "-name", "<pattern>"], e.g. [".", "-name", "*.php"]',
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
    usageHint: 'Use to find where a specific string/pattern appears in already-downloaded files. arguments: ["<pattern>", "<path>"]',
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
    description:
      "Runs a git subcommand within the workspace. NOT fully confined: a flag whose value embeds " +
      "an absolute path (e.g. --git-dir=/etc, --work-tree=/etc) is checked as a single argv token " +
      "that resolves inside the workspace, so it passes containment even though git treats the " +
      "embedded path as absolute. Review the exact resolved command before approving.",
    usageHint: 'Use for version-control operations on a repo already in the workspace. arguments: ["log", "--oneline", "-10"] or ["status"]',
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
    usageHint: "Use as a fallback for a task no more specific tool covers - prefer a purpose-built tool when one exists.",
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
    usageHint: "Use as a fallback when a task needs real computation/parsing logic that no other tool covers.",
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
    description:
      "Makes an arbitrary HTTP(S) request with full curl flag control. NOT fully confined when " +
      "writing to disk: a flag whose value embeds an absolute output path (e.g. -o/tmp/x, " +
      "--output-dir=/etc) is checked as a single argv token that resolves inside the workspace, " +
      "so it passes containment even though curl writes to the embedded absolute path. Review the " +
      "exact resolved command before approving.",
    usageHint:
      'Use for a one-off HTTP(S) request when you need precise flag control (custom headers/method/body). arguments: ["https://example.com/path"]',
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
    description:
      "Makes an HTTP(S) request with safer defaults (headers shown, 15s cap). Same underlying " +
      "curl binary as the Curl tool above, so the same output-path caveat applies if arguments " +
      "add a write flag (e.g. -o) - review the exact resolved command before approving.",
    usageHint: 'Prefer this over Curl for a quick "what does this URL return" check. arguments: ["https://example.com"]',
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
    usageHint:
      'Use when the objective involves finding open ports/running services on a host or IP. arguments: ["-sV", "-p-", "<host>"]',
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
    usageHint:
      "Use to quickly check whether a host/URL is alive and what's running on it before deeper " +
      'probing (crawling, fuzzing, vuln scanning). arguments: ["-u", "https://example.com"]',
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
    // these flags (not even -silent). Require the MissionDiscovery banner so that when python-httpx
    // is the one on PATH the tool reports unavailable instead of failing every run on "-s". Install
    // the real one from github.com/missiondiscovery/httpx (a Go binary earlier on PATH shadows the
    // python one - e.g. ~/.local/bin/httpx).
    identitySignature: "missiondiscovery",
  },

  // --- fuzzing ---
  {
    id: "ffuf",
    name: "Ffuf",
    description: "Fast web fuzzer for content/parameter discovery.",
    usageHint:
      "Use when the objective involves discovering hidden directories/files/parameters on a web " +
      'target. Needs a FUZZ placeholder in the URL and a wordlist path. arguments: ["-u", ' +
      '"https://example.com/FUZZ", "-w", "<wordlist path>"]',
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
    usageHint:
      "Use to map out a site's URLs/endpoints before fuzzing or vuln-scanning them individually. " +
      'arguments: ["-u", "https://example.com"]',
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
    usageHint:
      "Use once you have a live URL and the objective involves checking for known vulnerabilities " +
      '(misconfigurations, CVEs, exposed panels, etc). arguments: ["-u", "https://example.com"]',
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
    usageHint:
      'Use when the objective involves discovering subdomains of a domain. arguments: ["-d", "example.com"]. ' +
      "Fast and passive - try this before Amass.",
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
    usageHint:
      "Use for deeper subdomain/asset discovery when Subfinder alone isn't turning up enough - " +
      'slower but more thorough. arguments: ["enum", "-d", "example.com", "-passive"]',
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
    usageHint: 'Use when the objective involves who owns/registered a domain or IP and when. arguments: ["example.com"]',
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
    usageHint:
      'Use when the objective needs a specific DNS record type (MX, TXT, NS, A, ...) for a domain. ' +
      'arguments: ["example.com", "MX"]',
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
    usageHint: 'Use for a quick resolve of a domain to its IP (or an IP to its hostname). arguments: ["example.com"]',
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
