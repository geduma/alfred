#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="docker/docker-compose.yml"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.alfred}"
ALFRED_UID="${ALFRED_UID:-1000}"

echo "╔═══════════════════════════════════════════╗"
echo "║     Alfred — Deploy Script                ║"
echo "╚═══════════════════════════════════════════╝"

# 0. Ensure the workspace directory exists and is writable by the container's
#    `node` user (UID $ALFRED_UID), so Docker can read/write the bind mount.
echo ""
echo "📁 Ensuring workspace directory..."
mkdir -p "$WORKSPACE_DIR"

if stat -c %u "$WORKSPACE_DIR" >/dev/null 2>&1; then
  DIR_UID="$(stat -c %u "$WORKSPACE_DIR")"
else
  DIR_UID="$(stat -f %u "$WORKSPACE_DIR")"
fi

if [ "$DIR_UID" != "$ALFRED_UID" ]; then
  echo "   Setting ownership of $WORKSPACE_DIR to ${ALFRED_UID}:${ALFRED_UID}..."
  if [ "$(id -u)" -eq 0 ]; then
    chown -R "$ALFRED_UID:$ALFRED_UID" "$WORKSPACE_DIR"
  else
    sudo chown -R "$ALFRED_UID:$ALFRED_UID" "$WORKSPACE_DIR"
  fi
fi

if ! grep -qF "~/.alfred:" "$COMPOSE_FILE" && ! grep -qF "$WORKSPACE_DIR:" "$COMPOSE_FILE"; then
  echo "⚠️  $WORKSPACE_DIR does not match the bind mount in $COMPOSE_FILE."
  echo "   Update the volume there or set WORKSPACE_DIR to the same path."
fi

# 1. Pull latest code
if [ -d .git ]; then
  echo ""
  echo "📦 Pulling latest changes from git..."
  git pull
else
  echo ""
  echo "⚠️  Not a git repository, skipping git pull"
fi

# 2. Rebuild Docker image.
#    Uses BuildKit layer cache + npm download cache (--mount=type=cache in the
#    Dockerfile), so rebuilds are fast unless package-lock.json or source change.
export DOCKER_BUILDKIT=1
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
