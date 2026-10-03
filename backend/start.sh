#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

# Live-update streams stay open; cap the wait so restarts and deploys never hang.
exec uvicorn app.main:app --host "$HOST" --port "$PORT" --timeout-graceful-shutdown 5
