#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker/docker-compose.yml"

echo "╔═══════════════════════════════════════════╗"
echo "║     Alfred — Deploy Script                ║"
echo "╚═══════════════════════════════════════════╝"

# 1. Pull latest code
if [ -d .git ]; then
  echo ""
  echo "📦 Pulling latest changes from git..."
  git pull
else
  echo ""
  echo "⚠️  Not a git repository, skipping git pull"
fi

# 2. Rebuild Docker image (no cache for fresh deps)
echo ""
echo "🐳 Rebuilding Docker image..."
docker compose -f "$COMPOSE_FILE" build

# 3. Recreate container if running
echo ""
echo "🚀 Recreating container..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate

# 4. Clean old images
echo ""
echo "🧹 Cleaning unused Docker images..."
docker image prune -f

echo ""
echo "✅ Deploy complete! Alfred is running."
echo "   Check logs: docker compose -f $COMPOSE_FILE logs -f alfred"
echo "   Attach CLI: docker attach alfred-agent"
