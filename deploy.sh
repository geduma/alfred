#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  echo "Usage: ./deploy.sh [--native|--docker]"
  echo ""
  echo "  (no args)  Native deploy on this machine (default)"
  echo "  --native   Native deploy: npm ci + build + skills sync + systemd + healthcheck"
  echo "  --docker   Docker deploy: pull + build image + recreate container + healthcheck"
  echo "  -h|--help  Show this help"
}

MODE="native"
for arg in "$@"; do
  case "$arg" in
    --native) MODE="native" ;;
    --docker) MODE="docker" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

exec bash "$SCRIPT_DIR/deploy-${MODE}.sh"
