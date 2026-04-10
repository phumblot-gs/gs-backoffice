#!/usr/bin/env bash
set -euo pipefail

echo "=== gs-backoffice local setup ==="

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is required (v22+). Install via nvm or https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "WARNING: Node.js v22+ recommended (current: $(node -v))"
  echo "  Run: nvm install 22 && nvm use 22"
fi

if ! command -v pnpm &> /dev/null; then
  echo "ERROR: pnpm is required. Install via: corepack enable"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  echo "WARNING: Docker not found. Docker Compose services won't start."
fi

# Install dependencies
echo "--- Installing dependencies..."
pnpm install

# Copy .env if needed
if [ ! -f .env ]; then
  echo "--- Creating .env from .env.example..."
  cp .env.example .env
fi

# Build packages
echo "--- Building packages..."
pnpm build

# Start Docker services (if Docker is available)
if command -v docker &> /dev/null; then
  echo "--- Starting Docker services (PostgreSQL + EVT mock)..."
  docker compose -f docker/docker-compose.yml up -d db evt-mock

  echo "--- Waiting for PostgreSQL..."
  until docker compose -f docker/docker-compose.yml exec -T db pg_isready -U paperclip -d paperclip 2>/dev/null; do
    sleep 1
  done
  echo "--- PostgreSQL is ready."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "  PostgreSQL:   postgresql://paperclip:paperclip@localhost:5432/paperclip"
echo "  EVT Mock:     http://localhost:4000"
echo "  Paperclip:    http://localhost:3100 (start with: docker compose -f docker/docker-compose.yml up paperclip)"
echo ""
echo "  Useful commands:"
echo "    pnpm build       Build all packages"
echo "    pnpm typecheck   TypeScript check"
echo "    pnpm test        Run tests"
echo "    pnpm lint        Run ESLint"
echo "    pnpm dev         Start dev servers"
echo ""
