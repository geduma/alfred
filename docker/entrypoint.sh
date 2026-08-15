#!/bin/sh
set -e

# Alfred runs as the 'node' user (UID 1000). The /workspace volume is mounted
# from the host (~/.alfred) and keeps the host's ownership, so on first boot it
# may be owned by root or another UID, blocking writes to preferences, sessions,
# logs, uploads, etc. Align ownership once when it is wrong, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /workspace 2>/dev/null)" != "1000" ]; then
    echo "Fixing /workspace ownership for UID 1000 (node)..."
    chown -R node:node /workspace
  fi
  exec su-exec node "$@"
fi

exec "$@"
