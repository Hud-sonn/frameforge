#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "Creating Python venv..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q fastapi "uvicorn[standard]" python-multipart aiofiles pydantic
fi

if [ ! -d "frontend/node_modules" ]; then
  echo "Installing frontend deps..."
  (cd frontend && npm install)
fi

if [ ! -d "frontend/dist" ]; then
  echo "Building frontend..."
  (cd frontend && npm run build)
fi

echo "Starting FrameForge on http://localhost:8000"
"$VENV/bin/uvicorn" backend.app:app --host 0.0.0.0 --port 8000 --reload
