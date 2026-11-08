# 8Rack tools MCP server

8Rack's recon/scanning tools as an MCP server: it runs a fixed catalog of CLI tools (nmap, httpx,
nuclei, subfinder, dig, whois, ffuf, katana) over streamable HTTP and returns raw stdout, stderr and
exit code - the shape 8Rack's parsers expect. It runs on the scanning host, so scans come from that
host's address, not the machine running 8Rack.

**8Rack keeps every decision.** The model asks, a human approves, scope is checked (at request and
confirm time), and only then does 8Rack call this server. The server can't tell an approved request
from an unapproved one - it trusts the bearer token. Treat that token like a credential for the
scanning host: anyone holding it can run scans. See "Decided: HTTP to a separate scanning host" in the
repo's `DEVELOPMENT.md`.

Discovered tools arrive in 8Rack **disabled**; a human enables each one in Tools → MCP servers before
an agent can call it.

## Run it

Needs Python 3.11+. The catalog's binaries (nmap, httpx, ...) need to be installed on this host for the
tools that use them to work - a missing binary surfaces as a failed run with a clear message, not a
startup error.

```bash
cd mcp-servers/tools
python3 -m venv .venv
.venv/bin/pip install -e '.[test]'
cp .env.example .env    # set TOOLS_MCP_TOKEN and TOOLS_WORKSPACE_ROOT
.venv/bin/python -m tools_server
```

Then in `backend/.env` (loopback example; use `https://` for a real remote host):

```bash
MCP_SERVERS=tools=http://127.0.0.1:8767/mcp
MCP_TOKEN_TOOLS=<the same value as TOOLS_MCP_TOKEN>
```

Restart the backend, open Tools → MCP servers, and enable the tools you want agents to use.

## HTTPS and a remote host

8Rack refuses plain `http` to anything but localhost, so a real scanning host must serve HTTPS. Two
ways:

- **Direct TLS:** set `TOOLS_MCP_HOST` to the interface to bind, and point `TOOLS_MCP_TLS_CERTFILE` /
  `TOOLS_MCP_TLS_KEYFILE` at a cert/key pair.
- **Behind a TLS proxy:** bind loopback (or set `TOOLS_MCP_BEHIND_TLS_PROXY=1`), and let nginx/caddy
  terminate TLS and forward to the server. Set `TOOLS_MCP_ALLOWED_HOST` to the proxy's public
  hostname so the DNS-rebinding guard accepts it.

The bearer token is required on every request either way. The token and cert paths live only in
`.env`, never in the repo.

## Tests

```bash
.venv/bin/python -m pytest -q
```

## What it runs

A fixed catalog in `tools_server/catalog.py` - never an arbitrary command. Each tool runs
`<executable> <fixed default args> <the args 8Rack sends>`, argv only (no shell), in
`TOOLS_WORKSPACE_ROOT`, with a per-tool timeout and output capped at `TOOLS_MAX_OUTPUT_BYTES` per
stream. Path-shaped arguments are confined to the workspace. On timeout or when 8Rack disconnects, the
whole process group is killed.
