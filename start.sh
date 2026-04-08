#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$ROOT_DIR/backend/start.sh" ]; then
  cd "$ROOT_DIR/backend"
  exec bash ./start.sh
fi

if [ -f "$ROOT_DIR/app/main.py" ]; then
  HOST="${HOST:-0.0.0.0}"
  PORT="${PORT:-8000}"
  exec uvicorn app.main:app --host "$HOST" --port "$PORT"
fi

echo "Could not find backend/start.sh or app/main.py from $ROOT_DIR" >&2
exit 1
