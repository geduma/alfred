#!/usr/bin/env bash
# alfred-doctor — read-only health check for Alfred installs.
#
# Works on native Linux (systemd), Docker, or manual starts. Detects
# capabilities (systemctl, journalctl, /dev/tcp, log file) instead of
# branching per OS. Makes NO changes (never restarts or edits anything).
#
# Usage:
#   bash scripts/alfred-doctor.sh
#   SERVICE_NAME=alfred WORKSPACE_DIR=~/.alfred PORT=18789 SINCE="30 min ago" bash scripts/alfred-doctor.sh
#
# Exit codes: 0 = ok, 1 = warnings, 2 = failures.
set -Euo pipefail

SERVICE_NAME="${SERVICE_NAME:-alfred}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.alfred}"
PORT="${PORT:-18789}"
SINCE="${SINCE:-30 min ago}"
CONFIG_PATH="${CONFIG_PATH:-$WORKSPACE_DIR/config/alfred.json}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

OK=0
WARNINGS=0
FAILURES=0

ok()   { OK=$((OK + 1)); printf '  ✅ %s\n' "$*"; }
warn() { WARNINGS=$((WARNINGS + 1)); printf '  ⚠️  %s\n' "$*" >&2; }
fail() { FAILURES=$((FAILURES + 1)); printf '  ❌ %s\n' "$*" >&2; }
skip() { printf '  ➖ %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }
has_systemctl() { command -v systemctl >/dev/null 2>&1; }
is_docker() { [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER:-}" ]; }

scan_log_text() {
  LOGS="$1"
  ERRORS="$(printf '%s' "$LOGS" | grep -cE '"level":(40|50)' || true)"
  [ "$ERRORS" -gt 0 ] && warn "$ERRORS warn/error log lines found" || ok "no warn/error (level 40/50) lines found"
  for pat in "Invalid web allowlist" "CLI channel closed" "CLI channel disabled" "Failed to start" "Failed to initialize" "Health alert logged" "Telegram"; do
    n="$(printf '%s' "$LOGS" | grep -cF "$pat" || true)"
    [ "$n" -gt 0 ] && printf '  … %sx %s\n' "$n" "$pat"
  done
  printf '%s' "$LOGS" | grep -E '"level":(40|50)' | tail -5 | cut -c1-220
}

section "1/8 service ($SERVICE_NAME)"
if ! has_systemctl; then
  if is_docker; then
    skip "no systemctl in container (check with: docker logs / quick action Doctor)"
  else
    skip "no systemctl (manual start? check with: ps aux | grep node, curl port $PORT)"
  fi
else
  STATE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
  [ "$STATE" = "active" ] && ok "service is active" || fail "service state: ${STATE:-unknown}"
  NRESTARTS="$(systemctl show "$SERVICE_NAME" -p NRestarts --value 2>/dev/null || echo '?')"
  MAINPID="$(systemctl show "$SERVICE_NAME" -p MainPID --value 2>/dev/null || echo 0)"
  STARTED="$(systemctl show "$SERVICE_NAME" -p ActiveEnterTimestamp --value 2>/dev/null || echo '?')"
  printf '  service: restarts=%s mainpid=%s started=%s\n' "$NRESTARTS" "$MAINPID" "$STARTED"
  if [ "${NRESTARTS:-0}" != "?" ] && [ "${NRESTARTS:-0}" -gt 3 ] 2>/dev/null; then
    warn "high restart count ($NRESTARTS): check for a crash loop (e.g. CLI channel on stdin close)"
  fi
  if systemctl cat "$SERVICE_NAME" 2>/dev/null | grep -q 'ALFRED_NO_CLI=1'; then
    ok "unit sets ALFRED_NO_CLI=1 (CLI prompt disabled under systemd)"
  else
    warn "unit lacks ALFRED_NO_CLI=1 (deploy-native.sh installs it; old units predate the fix)"
  fi
fi

section "2/8 code ($REPO_ROOT)"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then ok "node $NODE_V (>= 22)"; else fail "node $NODE_V (< 22 required)"; fi
else
  fail "node not found in PATH"
fi
[ -f "$REPO_ROOT/dist/index.js" ] && ok "dist/index.js present" || fail "dist/index.js missing (run npm ci && npm run build)"
if git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
  printf '  git: %s %s\n' "$(git -C "$REPO_ROOT" rev-parse --short HEAD)" "$(git -C "$REPO_ROOT" status -sb 2>/dev/null | head -1)"
fi

section "3/8 gateway port ($PORT)"
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/" 2>/dev/null || true)"
[ -z "$HTTP_CODE" ] && HTTP_CODE="???"
TCP_OK=0
if command -v timeout >/dev/null 2>&1 && timeout 1 bash -c "</dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; then
  TCP_OK=1
fi
if [ "$TCP_OK" = "1" ]; then
  ok "gateway reachable on 127.0.0.1:$PORT"
elif [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "404" ]; then
  ok "gateway responding (http $HTTP_CODE; TCP probe unavailable, using HTTP)"
else
  fail "gateway NOT reachable on 127.0.0.1:$PORT"
fi
printf '  http / -> %s (200/403 = gateway up; connection refused = gateway down)\n' "$HTTP_CODE"

section "4/8 config ($CONFIG_PATH)"
if [ ! -f "$CONFIG_PATH" ]; then
  fail "config not found: $CONFIG_PATH"
else
  if python3 -m json.tool "$CONFIG_PATH" >/dev/null 2>&1; then
    ok "valid JSON"
  else
    fail "invalid JSON (validate with: python3 -m json.tool $CONFIG_PATH)"
  fi
  python3 - "$CONFIG_PATH" <<'EOF' || warn "config inspection failed"
import json, sys
d = json.load(open(sys.argv[1]))
ch = d.get('channels', {})
for name in ('telegram', 'cli', 'web'):
    c = ch.get(name, {})
    print(f"  channel {name}: enabled={c.get('enabled')} type={c.get('type')}")
web = ch.get('web', {}).get('permissions', {})
print(f"  web allow_from={web.get('allow_from')} trusted_proxies={web.get('trusted_proxies')}")
tg = ch.get('telegram', {})
tok = ((tg.get('config') or {}).get('bot_token')) or ''
print(f"  telegram bot_token={'missing' if not tok or 'CHANGE' in tok else 'set (' + str(len(tok)) + ' chars)'} allow_from={tg.get('permissions', {}).get('allow_from')}")
EOF
  if python3 -c "import json,sys; d=json.load(open('$CONFIG_PATH')); print(' '.join(d.get('channels',{}).get('web',{}).get('permissions',{}).get('allow_from') or []))" 2>/dev/null | grep -q '192\.168\.\|10\.\|172\.\(1[6-9]\|2[0-9]\|3[01]\)\.'; then
    ok "web allow_from covers a LAN range (CIDR like 192.168.10.0/24)"
  else
    warn "web allow_from has no LAN CIDR: LAN/nginx clients will get 403 (use 192.168.10.0/24)"
  fi
  if python3 -c "import json; d=json.load(open('$CONFIG_PATH')); ch=d.get('channels',{}).get('cli',{}); exit(0 if ch.get('enabled') else 1)" 2>/dev/null; then
    if has_systemctl; then
      warn "channels.cli is enabled: harmless since the no-TTY guard, but prefer enabled=false on systemd hosts"
    else
      skip "channels.cli is enabled (fine for docker/manual; disable on systemd hosts)"
    fi
  else
    ok "channels.cli is disabled (recommended for systemd)"
  fi
  if grep -q 'YOUR_' "$CONFIG_PATH" 2>/dev/null; then
    warn "config still contains placeholder(s) (YOUR_...): set trusted_proxies and telegram allow_from to real values"
  fi
fi

section "5/8 recent errors (logs since $SINCE)"
LOGS=""
LOGS_SRC=""
if command -v journalctl >/dev/null 2>&1; then
  LOGS="$(journalctl -u "$SERVICE_NAME" --since "$SINCE" --no-pager -o cat 2>/dev/null || true)"
  [ -n "$LOGS" ] && LOGS_SRC="journalctl"
fi
if [ -z "$LOGS_SRC" ] && [ -f "$WORKSPACE_DIR/logs/alfred.log" ]; then
  LOGS="$(tail -n 2000 "$WORKSPACE_DIR/logs/alfred.log" 2>/dev/null || true)"
  [ -n "$LOGS" ] && LOGS_SRC="log file (tail 2000)"
fi
if [ -z "$LOGS_SRC" ]; then
  skip "no journal entries and no log file ($WORKSPACE_DIR/logs/alfred.log)"
elif [ -z "$LOGS" ]; then
  warn "no log entries found ($LOGS_SRC)"
else
  printf '  source: %s\n' "$LOGS_SRC"
  scan_log_text "$LOGS"
fi

section "6/8 workspace sizes"
for d in db memory logs skills/custom; do
  if [ -d "$WORKSPACE_DIR/$d" ]; then
    printf '  %-14s %s\n' "$d" "$(du -sh "$WORKSPACE_DIR/$d" 2>/dev/null | cut -f1)"
  else
    printf '  %-14s (missing)\n' "$d"
  fi
done
[ -f "$WORKSPACE_DIR/config/alfred.json" ] && printf '  alfred.json    %s\n' "$(du -h "$WORKSPACE_DIR/config/alfred.json" | cut -f1)"

section "7/8 token budget + preferences"
if [ -f "$CONFIG_PATH" ] && (cd "$REPO_ROOT" && node -e "require('better-sqlite3')" 2>/dev/null); then
  node -e "
const b = require('$REPO_ROOT/node_modules/better-sqlite3');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$CONFIG_PATH', 'utf-8'));
const lim = cfg.llm && cfg.llm.spending_limits;
const db = b('$WORKSPACE_DIR/db/alfred.db', { readonly: true });
const monthStart = new Date(); monthStart.setDate(1);
const m = monthStart.toISOString().slice(0, 7) + '-01';
const today = new Date().toISOString().slice(0, 10);
const q = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return null; } };
const day = q('SELECT COALESCE(SUM(tokens_used),0) AS t, COUNT(*) AS n FROM token_usage_log WHERE date = ?', today);
const mon = q('SELECT COALESCE(SUM(tokens_used),0) AS t, COUNT(*) AS n FROM token_usage_log WHERE date >= ?', m);
console.log('  today: ' + (day ? day.t + ' tok / ' + day.n + ' calls' : 'n/a'));
console.log('  month: ' + (mon ? mon.t + ' tok / ' + mon.n + ' calls' : 'n/a'));
if (lim && lim.enabled) {
  console.log('  limits: daily ' + lim.daily_token_limit + ' / monthly ' + lim.monthly_token_limit + ' (' + lim.on_limit_reached + ')');
  if (day && lim.daily_token_limit > 0 && day.t >= lim.daily_token_limit) console.log('  BLOCKED: daily limit reached');
  else if (mon && lim.monthly_token_limit > 0 && mon.t >= lim.monthly_token_limit) console.log('  BLOCKED: monthly limit reached');
}
try {
  const rows = db.prepare('SELECT source, SUM(tokens_used) AS t FROM token_usage_log WHERE date >= ? GROUP BY source ORDER BY t DESC').all(m);
  if (rows.length) console.log('  by source: ' + rows.map(r => (r.source || 'interactive') + '=' + r.t).join(', '));
} catch (e) { /* pre-source DBs */ }
" 2>/dev/null || warn "budget query failed (db locked or missing)"
else
  warn "budget query skipped (config or better-sqlite3 missing)"
fi
PREFS="$WORKSPACE_DIR/memory/personality/preferences.md"
if [ -f "$PREFS" ]; then
  printf '  preferences.md mtime: %s\n' "$(stat -c '%y' "$PREFS" 2>/dev/null || stat -f '%Sm' "$PREFS" 2>/dev/null)"
  grep -E '^(user_name|language):' "$PREFS" | sed 's/^/  /'
  grep -q '^user_name: unknown' "$PREFS" && warn "user_name is still 'unknown' — tell Alfred your name or set it via web UI" || ok "user_name is set"
else
  warn "preferences.md missing: $PREFS"
fi

section "8/8 host resources"
printf '  %s\n' "$(uptime)"
if command -v free >/dev/null 2>&1; then
  free -h | head -2 | sed 's/^/  /'
else
  vm_stat 2>/dev/null | head -4 | sed 's/^/  /' || skip "memory info unavailable (no free/vm_stat)"
fi
df -h / /home 2>/dev/null | sed 's/^/  /'
if [ -n "${MAINPID:-}" ] && [ "$MAINPID" != "0" ] && [ -d "/proc/$MAINPID" ]; then
  printf '  alfred: %s\n' "$(ps -o pid,rss,vsz,%cpu,%mem,etime,cmd -p "$MAINPID" --no-headers 2>/dev/null || echo '(ps unavailable)')"
fi
if command -v vcgencmd >/dev/null 2>&1; then
  printf '  temp: %s\n' "$(vcgencmd measure_temp 2>/dev/null)"
elif [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  printf '  temp: %.1f°C\n' "$(awk '{printf $1/1000}' /sys/class/thermal/thermal_zone0/temp)"
fi

printf '\n—— summary: %d ok, %d warnings, %d failures ——\n' "$OK" "$WARNINGS" "$FAILURES"
if [ "$FAILURES" -gt 0 ]; then exit 2; fi
if [ "$WARNINGS" -gt 0 ]; then exit 1; fi
exit 0
