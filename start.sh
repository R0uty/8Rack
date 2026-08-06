#!/usr/bin/env bash
# Starts the 8Rack backend and frontend dev servers together.
# Kills any stale instances first — this project has hit hung/duplicate dev-server
# processes during development, so a clean slate avoids port conflicts.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PID_FILE="$ROOT_DIR/.backend.pid"
FRONTEND_PID_FILE="$ROOT_DIR/.frontend.pid"

# Each service below is launched via `setsid`, which makes it (and every child process it spawns,
# including tsx watch's grandchild node process — see the pkill fallback below for why that
# grandchild used to survive a plain `kill`) the leader of its own new process group. That means a
# single `kill -TERM -$pid` (a *negative* PID targets the whole group) reaches the entire tree in
# one shot, and the PID we track is this checkout's own — never another project's — so this can
# never accidentally touch a different project's dev servers running on the same machine, unlike
# guessing at command-line patterns that could drift (as the ones below already have once) or
# coincidentally overlap.
stop_tracked() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"
  [ -n "$pid" ] && kill -TERM "-$pid" 2>/dev/null || true
}

stop_tracked "$BACKEND_PID_FILE"
stop_tracked "$FRONTEND_PID_FILE"

# Belt-and-suspenders: also sweep any stragglers from before this PID-file mechanism existed, or
# from a start.sh run that was itself killed before it could write/clean up its PID files. Still
# scoped by this checkout's own absolute path, so it's as safe as the PID-file path above re:
# other projects — just less precise, which is why it's the fallback and not the primary method.
pkill -f "$ROOT_DIR/backend/node_modules/.bin/tsx" 2>/dev/null || true
pkill -f "$ROOT_DIR/frontend/node_modules/.bin/vite" 2>/dev/null || true
pkill -f "$ROOT_DIR/backend/node_modules/tsx/dist/preflight.cjs" 2>/dev/null || true
sleep 1

if ! curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "Warning: Ollama does not appear to be running at http://localhost:11434 (start it with: ollama serve)"
fi

echo "Starting backend..."
setsid bash -c "cd '$ROOT_DIR/backend' && exec npm run dev" &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"

echo "Starting frontend..."
setsid bash -c "cd '$ROOT_DIR/frontend' && exec npm run dev" &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"

cleanup() {
  echo "Stopping..."
  kill -TERM "-$BACKEND_PID" 2>/dev/null || true
  kill -TERM "-$FRONTEND_PID" 2>/dev/null || true
  rm -f "$BACKEND_PID_FILE" "$FRONTEND_PID_FILE"
}
trap cleanup INT TERM EXIT

wait
