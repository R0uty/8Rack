"""Runs the server: python -m tools_server"""

from __future__ import annotations

import sys

import uvicorn

from .catalog import default_catalog
from .config import ConfigError, is_loopback, load_settings
from .server import create_app


def main() -> None:
    try:
        settings = load_settings()
        catalog = default_catalog()
    except ConfigError as err:
        print(f"tools-server: {err}", file=sys.stderr)
        sys.exit(2)

    scheme = "https" if settings.tls_certfile else "http"
    note = "" if (is_loopback(settings.bind_host) or settings.tls_certfile) else " (behind a TLS-terminating proxy)"
    print(
        f"tools-server: {len(catalog)} tool(s) [{', '.join(s.id for s in catalog)}] "
        f"on {scheme}://{settings.bind_host}:{settings.port}{note}; cwd {settings.workspace_root}"
    )
    uvicorn.run(
        create_app(settings, catalog),
        host=settings.bind_host,
        port=settings.port,
        log_level="info",
        ssl_certfile=str(settings.tls_certfile) if settings.tls_certfile else None,
        ssl_keyfile=str(settings.tls_keyfile) if settings.tls_keyfile else None,
    )


if __name__ == "__main__":
    main()
