#!/usr/bin/env bash
# Starts the 8Rack backend and frontend dev servers together.
# Kills any stale instances first — this project has hit hung/duplicate dev-server
# processes during development, so a clean slate avoids port conflicts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pkill -f "$ROOT_DIR/backend/node_modules/.bin/tsx" 2>/dev/null || true
pkill -f "$ROOT_DIR/frontend/node_modules/.bin/vite" 2>/dev/null || true
# tsx watch spawns a detached grandchild (tsx/dist/preflight.cjs running src/index.ts) whose
# cmdline no longer matches the ".bin/tsx" pattern above, so it survives the pkill above and
# is left squatting on the backend port, silently serving stale code on future runs.
pkill -f "$ROOT_DIR/backend/node_modules/tsx/dist/preflight.cjs" 2>/dev/null || true
sleep 1

if ! curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "Warning: Ollama does not appear to be running at http://localhost:11434 (start it with: ollama serve)"
fi

echo "Starting backend..."
(cd "$ROOT_DIR/backend" && npm run dev) &
BACKEND_PID=$!

echo "Starting frontend..."
(cd "$ROOT_DIR/frontend" && npm run dev) &
FRONTEND_PID=$!

trap 'echo "Stopping..."; kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null' INT TERM EXIT

wait
