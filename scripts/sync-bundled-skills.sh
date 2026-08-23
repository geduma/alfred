#!/usr/bin/env bash
# Sync bundled skills from system/skills-custom/ into the workspace skills dir.
#
# Guarantees:
#   - Only overwrites files whose names exist in the bundle (system/skills-custom/*.md).
#   - Never touches user-authored skills outside the bundle.
#   - Backs up any differing/previous version under skills/backups/<ts>/ before writing.
#   - Keeps a manifest (skills/.bundled-manifest) of managed files; files that leave
#     the bundle are moved to backups/orphans/, never deleted outright.
#   - db/, config/, memory/ are NEVER touched by this script.
#
# Environment:
#   WORKSPACE_DIR   workspace root (default ~/.alfred)
#   SRC_DIR         bundle source dir (default <repo>/system/skills-custom)
#   ALFRED_UID      target file owner UID (default 1000)
#   DRY_RUN=1       print actions without modifying anything
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.alfred}"
SRC_DIR="${SRC_DIR:-$REPO_ROOT/system/skills-custom}"
ALFRED_UID="${ALFRED_UID:-1000}"
DRY_RUN="${DRY_RUN:-0}"

SKILLS_CUSTOM="$WORKSPACE_DIR/skills/custom"
MANIFEST="$WORKSPACE_DIR/skills/.bundled-manifest"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
BACKUP_ROOT="$WORKSPACE_DIR/skills/backups/$TIMESTAMP"

COUNT_ADDED=0
COUNT_UPDATED=0
COUNT_UNCHANGED=0
COUNT_ORPHANS=0

log_info() { printf '[sync-skills] %s\n' "$*"; }
log_warn() { printf '[sync-skills] WARN: %s\n' "$*" >&2; }

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[dry-run] Would execute: $*"
    return 0
  fi
  "$@"
}

get_file_uid() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1"
}

# Best-effort ownership alignment; never fails the deploy over it.
ensure_owner() {
  local -r target="$1"
  [[ -e "$target" ]] || return 0

  local cur_uid
  cur_uid="$(get_file_uid "$target")" || return 0

  [[ "$cur_uid" == "$ALFRED_UID" ]] && return 0
  [[ "$DRY_RUN" == "1" ]] && { log_info "[dry-run] Would chown ${ALFRED_UID}:${ALFRED_UID} $target"; return 0; }

  if [[ "$(id -u)" -eq 0 ]]; then
    chown "$ALFRED_UID:$ALFRED_UID" "$target" 2>/dev/null \
      || log_warn "Could not chown $target (continuing)"
  elif sudo -n true 2>/dev/null; then
    sudo -n chown "$ALFRED_UID:$ALFRED_UID" "$target" 2>/dev/null \
      || log_warn "Could not chown $target via sudo (continuing)"
  else
    log_warn "File $target owned by UID $cur_uid, cannot chown to $ALFRED_UID without root (continuing)"
  fi
  return 0
}

if [[ ! -d "$SRC_DIR" ]]; then
  log_warn "Bundle source dir not found: $SRC_DIR — nothing to sync"
  exit 0
fi

if [[ ! -d "$SKILLS_CUSTOM" ]]; then
  run_cmd mkdir -p "$SKILLS_CUSTOM"
fi

# Load previous manifest (one filename per line) into an array.
declare -a OLD_MANIFEST=()
if [[ -f "$MANIFEST" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && OLD_MANIFEST+=("$line")
  done < "$MANIFEST"
fi

declare -a NEW_MANIFEST=()

# 1. Copy/update bundled skills.
while IFS= read -r -d '' src; do
  name="$(basename -- "$src")"
  dest="$SKILLS_CUSTOM/$name"
  NEW_MANIFEST+=("$name")

  if [[ ! -e "$dest" ]]; then
    log_info "Adding bundled skill: $name"
    run_cmd cp -- "$src" "$dest"
    ensure_owner "$dest"
    COUNT_ADDED=$((COUNT_ADDED + 1))
  elif ! cmp -s -- "$src" "$dest"; then
    log_info "Updating bundled skill: $name (previous version backed up)"
    run_cmd mkdir -p "$BACKUP_ROOT"
    run_cmd cp -- "$dest" "$BACKUP_ROOT/$name"
    run_cmd cp -- "$src" "$dest"
    ensure_owner "$dest"
    COUNT_UPDATED=$((COUNT_UPDATED + 1))
  else
    COUNT_UNCHANGED=$((COUNT_UNCHANGED + 1))
  fi
done < <(find "$SRC_DIR" -maxdepth 1 -type f -name '*.md' -print0 | LC_ALL=C sort -z)

# 2. Handle orphans: previously-managed files that left the bundle.
#    (${ARR[@]+...} guards empty-array expansion under set -u on bash 3.2.)
for name in ${OLD_MANIFEST[@]+"${OLD_MANIFEST[@]}"}; do
  found_in_bundle=0
  for current in "${NEW_MANIFEST[@]}"; do
    if [[ "$current" == "$name" ]]; then
      found_in_bundle=1
      break
    fi
  done

  if [[ "$found_in_bundle" -eq 0 && -e "$SKILLS_CUSTOM/$name" ]]; then
    log_info "Bundled skill removed upstream: $name (moved to backups/orphans)"
    run_cmd mkdir -p "$BACKUP_ROOT/orphans"
    run_cmd mv -- "$SKILLS_CUSTOM/$name" "$BACKUP_ROOT/orphans/$name"
    COUNT_ORPHANS=$((COUNT_ORPHANS + 1))
  fi
done

# 3. Atomically rewrite the manifest.
if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[dry-run] Would write manifest: $MANIFEST (${#NEW_MANIFEST[@]} entries)"
else
  mkdir -p "$(dirname -- "$MANIFEST")"
  manifest_tmp="$(mktemp "$(dirname -- "$MANIFEST")/.bundled-manifest.XXXXXX")"
  trap 'rm -f -- "$manifest_tmp"' EXIT
  : > "$manifest_tmp"
  if [[ ${#NEW_MANIFEST[@]} -gt 0 ]]; then
    printf '%s\n' "${NEW_MANIFEST[@]}" >> "$manifest_tmp"
  fi
  mv -f -- "$manifest_tmp" "$MANIFEST"
  trap - EXIT
fi

log_info "Sync complete: ${COUNT_ADDED} added, ${COUNT_UPDATED} updated, ${COUNT_UNCHANGED} unchanged, ${COUNT_ORPHANS} orphaned."
[[ "$DRY_RUN" == "1" ]] || [[ $((COUNT_ADDED + COUNT_UPDATED)) -eq 0 ]] || \
  log_info "Backups (if any) under: $BACKUP_ROOT"
exit 0
