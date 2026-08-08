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

# 4. Post-deploy healthcheck
echo ""
echo "🩺 Running post-deploy healthcheck..."
HEALTH_WAIT=${HEALTH_WAIT_SECONDS:-60}
HOST="localhost"
PORT="18789"
HEALTH_OK=0
for i in $(seq 1 "$HEALTH_WAIT"); do
  if nc -z "$HOST" "$PORT" 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  echo "   waiting for gateway on ${HOST}:${PORT} (${i}/${HEALTH_WAIT})..."
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo ""
  echo "❌ Healthcheck failed: gateway did not open port ${PORT} within ${HEALTH_WAIT}s."
  echo "   Check logs: docker compose -f $COMPOSE_FILE logs alfred"
  exit 1
fi

echo "   ✅ Gateway reachable on ${HOST}:${PORT}"

# 5. Clean old images
echo ""
echo "🧹 Cleaning unused Docker images..."
docker image prune -f

echo ""
echo "✅ Deploy complete! Alfred is running."
echo "   Check logs: docker compose -f $COMPOSE_FILE logs -f alfred"
echo "   Attach CLI: docker attach alfred-agent"
