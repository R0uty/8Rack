import {
  Bomb,
  Bot,
  Compass,
  FileText,
  Folder,
  Bug,
  Globe,
  GitBranch,
  IdCard,
  Link,
  MessageCircle,
  Microscope,
  Network,
  Puzzle,
  Radiation,
  Radio,
  Satellite,
  Save,
  Search,
  SearchCode,
  Shield,
  Sprout,
  Telescope,
  Terminal,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Backend agent/tool configs (backend/data/agents/*.json, backend/src/tools/exec/builtins.ts)
 * carry an `icon` field as a raw emoji string — that's real data this redesign must not touch.
 * This table maps each emoji currently in use to a Lucide icon for the "Lucide icons only, no
 * emojis" visual language, falling back to a generic icon for anything unmapped (e.g. a
 * hand-edited agent config with a new emoji) so rendering never breaks.
 */
const EMOJI_TO_ICON: Record<string, LucideIcon> = {
  // Agents (backend/data/agents/*.json)
  "🧭": Compass, // Planner / dig
  "🔭": Telescope, // Recon Agent
  "🌐": Globe, // Web Analyzer / curl
  "💻": Terminal, // Code Assistant
  "🧩": Puzzle, // Output Parser
  "🛡️": Shield, // Vulnerability Validator
  "📝": FileText, // Report Writer
  "💬": MessageCircle, // General Assistant

  // Exec tools (backend/src/tools/exec/builtins.ts)
  "📄": FileText, // read_file
  "💾": Save, // write_file
  "📁": Folder, // list_directory
  "🔍": Search, // search_files
  "🔎": SearchCode, // grep
  "🌿": GitBranch, // git
  "⚡": Zap, // bash
  "🐍": Terminal, // python
  "📡": Radio, // http_request
  "🛰️": Satellite, // nmap
  "🔗": Link, // httpx
  "🧨": Bomb, // ffuf
  "🕸️": Network, // katana
  "☢️": Radiation, // nuclei
  "🌱": Sprout, // subfinder
  "🕷️": Bug, // amass
  "📇": IdCard, // whois
  "🔬": Microscope, // nslookup
};

export function iconFor(emoji: string | undefined | null, fallback: LucideIcon = Bot): LucideIcon {
  if (!emoji) return fallback;
  return EMOJI_TO_ICON[emoji] ?? fallback;
}

export { Wrench as ToolFallbackIcon };
