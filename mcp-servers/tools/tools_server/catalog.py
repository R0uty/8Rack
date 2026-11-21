"""The fixed catalog of CLI tools this server exposes.

Each entry becomes one MCP tool whose single `args` parameter is the argv appended after a fixed
`executable` + `default_args` prefix - the same split 8Rack's own ExecTools use (defaultArguments vs
caller-supplied arguments). The description is what 8Rack shows the model, so it says what the tool is
and the shape of `args`. Keeping the catalog fixed - not "run any command" - is a deliberate boundary:
the server only ever runs these programs, with argv the operator can read in the approval card.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# A tool id is shown to the model and used as the MCP tool name, and 8Rack namespaces it as
# "<serverId>.<id>" - keep it to characters that survive all of that unambiguously.
TOOL_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


class CatalogError(Exception):
    """A catalog entry is malformed - raised at startup so a bad catalog fails loudly, not per call."""


@dataclass(frozen=True)
class CommandSpec:
    id: str
    description: str
    # Binary name (resolved on PATH at call time) or an absolute path.
    executable: str
    # Always prepended before the caller-supplied args.
    default_args: tuple[str, ...] = ()
    # Per-tool override of Settings.command_timeout_s, in seconds. None uses the server default.
    timeout_s: float | None = None


def validate_catalog(catalog: tuple[CommandSpec, ...]) -> None:
    seen: set[str] = set()
    for spec in catalog:
        if not TOOL_ID_RE.match(spec.id):
            raise CatalogError(f"Tool id {spec.id!r} must be lowercase letters, digits and underscores, starting with a letter.")
        if spec.id in seen:
            raise CatalogError(f"Tool id {spec.id!r} is listed more than once.")
        seen.add(spec.id)
        if not spec.executable:
            raise CatalogError(f"Tool {spec.id!r} has no executable.")
        if spec.timeout_s is not None and spec.timeout_s <= 0:
            raise CatalogError(f"Tool {spec.id!r} has a non-positive timeout.")


def _args_hint(example: str) -> str:
    return f" args is the argv after the fixed command, e.g. {example}."


# The default roster - recon/scanning tools that belong on a scanning host. None of these need to be
# installed for the server to start or for its tests to pass; a missing binary surfaces as a failed
# run with a clear message when a tool is actually called.
DEFAULT_CATALOG: tuple[CommandSpec, ...] = (
    CommandSpec(
        id="nmap",
        description="Network port/service scanner (nmap)." + _args_hint('["-sV", "-T4", "127.0.0.1"]'),
        executable="nmap",
        timeout_s=600,
    ),
    CommandSpec(
        id="httpx",
        description="HTTP prober (ProjectDiscovery httpx) - probes hosts/URLs for live web services."
        + _args_hint('["-silent", "-title", "-status-code", "-u", "https://example.com"]'),
        executable="httpx",
    ),
    CommandSpec(
        id="nuclei",
        description="Template-based vulnerability scanner (nuclei)." + _args_hint('["-silent", "-u", "https://example.com"]'),
        executable="nuclei",
        timeout_s=900,
    ),
    CommandSpec(
        id="subfinder",
        description="Passive subdomain enumeration (subfinder)." + _args_hint('["-silent", "-d", "example.com"]'),
        executable="subfinder",
    ),
    CommandSpec(
        id="dig",
        description="DNS lookup (dig)." + _args_hint('["+short", "example.com", "A"]'),
        executable="dig",
        timeout_s=30,
    ),
    CommandSpec(
        id="whois",
        description="WHOIS registration lookup (whois)." + _args_hint('["example.com"]'),
        executable="whois",
        timeout_s=30,
    ),
    CommandSpec(
        id="ffuf",
        description="Web fuzzer (ffuf) - directory/parameter discovery." + _args_hint('["-u", "https://example.com/FUZZ", "-w", "wordlist.txt"]'),
        executable="ffuf",
        timeout_s=600,
    ),
    CommandSpec(
        id="katana",
        description="Web crawler (katana) - collects URLs/endpoints." + _args_hint('["-silent", "-u", "https://example.com"]'),
        executable="katana",
        timeout_s=600,
    ),
)


def default_catalog() -> tuple[CommandSpec, ...]:
    validate_catalog(DEFAULT_CATALOG)
    return DEFAULT_CATALOG
