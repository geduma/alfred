#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.alfred}"
SERVICE_NAME="${SERVICE_NAME:-alfred}"
PORT="${PORT:-18789}"
HEALTH_WAIT="${HEALTH_WAIT_SECONDS:-60}"

OS="$(uname -s)"
if [ "$OS" != "Linux" ]; then
  echo ""
  echo "❌ Native deploy supports Linux only (detected: $OS)."
  echo "   On Windows/macOS, use the Docker deploy instead:"
  echo "     ./deploy.sh --docker"
  exit 1
fi

fail() {
  echo ""
  echo "❌ $*"
  exit 1
}

warn() {
  echo "⚠️  $*"
}

echo "╔═══════════════════════════════════════════╗"
echo "║     Alfred — Deploy Script (Native)       ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "   Repo:      $SCRIPT_DIR"
echo "   Workspace: $WORKSPACE_DIR"

echo ""
echo "🔍 Checking prerequisites..."
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node.js >= 22 (e.g. via nodesource) and retry."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js >= 22 required, found $(node --version). Upgrade Node.js and retry."
fi
command -v npm >/dev/null 2>&1 || fail "npm not found. Install npm >= 10 and retry."
echo "   ✅ node $(node --version), npm $(npm --version)"

if [ -d "$SCRIPT_DIR/.git" ]; then
  echo ""
  echo "📦 Pulling latest changes from git..."
  if ! git -C "$SCRIPT_DIR" pull; then
    warn "git pull failed (offline?). Continuing with local code."
  fi
else
  warn "Not a git repository, skipping git pull."
fi

echo ""
echo "📥 Installing dependencies (npm ci)..."
if ! (cd "$SCRIPT_DIR" && npm ci); then
  echo ""
  echo "   npm ci failed. On ARM this usually means missing build tools for better-sqlite3."
  echo "   Install them and retry: sudo apt-get install -y python3 make g++"
  exit 1
fi

echo ""
echo "🔨 Building (npm run build)..."
(cd "$SCRIPT_DIR" && npm run build)

echo ""
echo "📁 Ensuring workspace directory..."
mkdir -p "$WORKSPACE_DIR"

echo ""
echo "♻️  Syncing bundled skills (db/, config/ and memory/ stay untouched)..."
DRY_RUN="${DRY_RUN:-0}" WORKSPACE_DIR="$WORKSPACE_DIR" ALFRED_UID="$(id -u)" \
  bash "$SCRIPT_DIR/scripts/sync-bundled-skills.sh"

if ! command -v systemctl >/dev/null 2>&1; then
  echo ""
  echo "✅ Install complete (code + workspace ready)."
  warn "systemctl not found: service not installed."
  echo "   Start Alfred manually from the repo root:"
  echo "     WORKSPACE=\"$WORKSPACE_DIR\" node dist/index.js"
  echo "   Then edit $WORKSPACE_DIR/config/alfred.json with your providers/channels."
  exit 0
fi

echo ""
echo "⚙️  Installing systemd service ($SERVICE_NAME)..."
NODE_BIN="$(command -v node)"
SVC_USER="$(id -un)"
UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT
sed -e "s|@USER@|${SVC_USER}|g" \
    -e "s|@REPO_ROOT@|${SCRIPT_DIR}|g" \
    -e "s|@WORKSPACE_DIR@|${WORKSPACE_DIR}|g" \
    -e "s|@NODE_BIN@|${NODE_BIN}|g" \
  "$SCRIPT_DIR/system/alfred.service" > "$UNIT_TMP"

if [ "$(id -u)" -eq 0 ]; then
  install -m 644 "$UNIT_TMP" "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
elif command -v sudo >/dev/null 2>&1; then
  echo "   (sudo will prompt once to install the service)"
  sudo install -m 644 "$UNIT_TMP" "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
else
  echo ""
  echo "✅ Install complete (code + workspace ready)."
  warn "Cannot install systemd service: neither root nor sudo available."
  echo "   Install manually as root:"
  echo "     cp \"$SCRIPT_DIR/system/alfred.service\" /etc/systemd/system/${SERVICE_NAME}.service"
  echo "     (edit User/WorkingDirectory/Environment lines first)"
  echo "     systemctl daemon-reload && systemctl enable --now $SERVICE_NAME"
  echo "   Or start Alfred manually: WORKSPACE=\"$WORKSPACE_DIR\" node dist/index.js"
  exit 0
fi
trap - EXIT
rm -f "$UNIT_TMP"

echo ""
echo "🩺 Running post-deploy healthcheck (port $PORT)..."
HEALTH_OK=0
for i in $(seq 1 "$HEALTH_WAIT"); do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  echo "   waiting for gateway on 127.0.0.1:${PORT} (${i}/${HEALTH_WAIT})..."
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo ""
  echo "❌ Healthcheck failed: gateway did not open port ${PORT} within ${HEALTH_WAIT}s."
  echo "   Check logs: journalctl -u $SERVICE_NAME -n 100"
  exit 1
fi

echo "   ✅ Gateway reachable on 127.0.0.1:${PORT}"
echo ""
echo "🔁 Final restart (service $SERVICE_NAME)..."
if [ "$(id -u)" -eq 0 ]; then
  systemctl restart "$SERVICE_NAME"
else
  sudo systemctl restart "$SERVICE_NAME"
fi

echo ""
echo "🩺 Verifying gateway after final restart (port $PORT)..."
HEALTH_OK=0
FINAL_WAIT=30
for i in $(seq 1 "$FINAL_WAIT"); do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; then
    HEALTH_OK=1
    break
  fi
  echo "   waiting for gateway on 127.0.0.1:${PORT} (${i}/${FINAL_WAIT})..."
  sleep 1
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo ""
  echo "❌ Healthcheck failed after final restart: gateway did not open port ${PORT} within ${FINAL_WAIT}s."
  echo "   Check logs: journalctl -u $SERVICE_NAME -n 100"
  exit 1
fi

echo "   ✅ Gateway reachable on 127.0.0.1:${PORT} after restart"
echo ""
echo "✅ Deploy complete! Alfred is running."
echo "   Workspace: $WORKSPACE_DIR"
echo "   1. Edit providers/channels: $WORKSPACE_DIR/config/alfred.json"
echo "      Secrets template:        $WORKSPACE_DIR/config/secrets.env"
echo "   2. Get the web token:  journalctl -u $SERVICE_NAME -n 50 | grep 'Token de acceso'"
echo "   3. Apply config:       sudo systemctl restart $SERVICE_NAME"
echo "   Logs:                  journalctl -u $SERVICE_NAME -f"
