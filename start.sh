#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "Creating Python venv..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q fastapi "uvicorn[standard]" python-multipart pydantic
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend deps..."
  (cd frontend && npm install)
fi

# Rebuild frontend if dist/ doesn't exist OR if "--rebuild" flag is passed.
# Note: if you change frontend source files, either delete frontend/dist
# manually or pass --rebuild to this script.
if [ ! -d "frontend/dist" ] || [ "$1" = "--rebuild" ]; then
  echo "Building frontend..."
  (cd frontend && npm run build)
fi

echo "Starting FrameForge on http://127.0.0.1:8000"
"$VENV/bin/uvicorn" backend.app:app --host 127.0.0.1 --port 8000
