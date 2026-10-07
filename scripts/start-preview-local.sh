#!/bin/bash
# WorkDSH preview launcher.
#
# Why this does not simply call `pnpm preview`:
# dsh derives the "runtime version" that gates every profile bundle from
# @deepseek-ai/dsh-app-boot's OWN package.json. A bundle is skipped SILENTLY
# unless its peerDependencies satisfy that version.
#   - The repo's pnpm tree pins every @deepseek-ai/dsh* to 0.1.7-alpha.1
#     (pnpm.overrides), so its app-boot reports 0.1.7-alpha.1.
#   - A globally `npm install -g @deepseek-ai/dsh` resolves the
#     `^0.1.7-alpha.1` range up to 0.1.7-rc.2, so ITS app-boot reports
#     0.1.7-rc.2 and every WorkDSH plugin (peers pinned to 0.1.7-alpha.1)
#     is dropped from the composed tree with nothing printed.
# Therefore: always launch through the repo's own pnpm-installed CLI, from the
# repo root, and keep the preview profile pinned to the same version.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDSH_DIR="$SCRIPT_DIR/.."
PREVIEW_HOME="$WORKDSH_DIR/.test-runtime/preview"
PROFILE_DIR="$PREVIEW_HOME/profiles/preview"
PORT=${PORT:-18989}
LOG_DIR="$PREVIEW_HOME/logs"
CLI="$WORKDSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── stop any previous instance ────────────────────────────────────────────────
pkill -9 -f "dsh.*--profile preview" 2>/dev/null
pkill -9 -f "dsh/bin.js.*--profile preview" 2>/dev/null
sleep 2

# ── repo dependencies (the CLI comes from here) ───────────────────────────────
if [ ! -f "$CLI" ]; then
    log "Installing WorkDSH dependencies ..."
    (cd "$WORKDSH_DIR" && corepack pnpm install --frozen-lockfile) || die "pnpm install failed"
fi

if [ ! -f "$WORKDSH_DIR/packages/bundle/dist/client.js" ]; then
    log "Building WorkDSH packages ..."
    (cd "$WORKDSH_DIR" && corepack pnpm build) || die "pnpm build failed"
fi

# ── preview profile ───────────────────────────────────────────────────────────
if [ ! -d "$PROFILE_DIR/node_modules/@deepseek-ai/dsh" ]; then
    log "Installing preview profile (first run, this takes a while) ..."
    (cd "$WORKDSH_DIR" && corepack pnpm preview:install) || die "preview:install failed"
fi

# Guard the one invariant the bundle gate depends on: the profile must resolve
# the SAME dsh version as the repo, otherwise every workdsh-* bundle is dropped.
REPO_DSH=$(python3 -c "import json;print(json.load(open('$WORKDSH_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null)
PROFILE_DSH=$(python3 -c "import json;print(json.load(open('$PROFILE_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null)
if [ -z "$REPO_DSH" ] || [ -z "$PROFILE_DSH" ]; then
    die "cannot read dsh versions (repo='$REPO_DSH' profile='$PROFILE_DSH')"
fi
if [ "$REPO_DSH" != "$PROFILE_DSH" ]; then
    die "dsh version mismatch: repo=$REPO_DSH profile=$PROFILE_DSH
Run:  cd $WORKDSH_DIR && corepack pnpm preview:install"
fi

# Keep the user patch layer minimal: bundle layers already insert every
# workdsh-* row, and hand-written id-targeted rows here would emit
# 'patch: entry ... not found' instead of registering anything.
mkdir -p "$PROFILE_DIR" "$LOG_DIR"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" << 'YAML'
packages:
  - .
  - ../..
nodeLinker: hoisted
autoInstallPeers: false
strictDepBuilds: true
allowBuilds:
  node-pty: true
  koffi: true
  fs-ext: true
  "@deepseek-ai/dsh-subprocess-local": true
  "@google/genai": false
  protobufjs: false
  node-addon-require-builtin: false
YAML

if ! grep -q welcomeNoticeVersion "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
    cat > "$PROFILE_DIR/cordis.patch.yml" << 'YAML'
- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: '2026-08-13.1'
YAML
fi

# dsh-app-boot keeps `bootstrapIncludes`, the WeakMap holding the root Include
# entry, in MODULE state. Live settings writes (e.g. adding an LLM provider)
# reload the profile through whichever app-boot copy they resolve; if that is
# not the same physical file the CLI booted with, the map is empty and the
# write fails with "profile reload requires the root Include entry".
# Point the profile's copy at the CLI's so both share one module instance.
BOOT_TARGET=$(node -e "
const {createRequire}=require('module');
const {realpathSync}=require('fs');
const r=createRequire(realpathSync('$CLI'));
process.stdout.write(r.resolve('@deepseek-ai/dsh-app-boot'));
" 2>/dev/null)
if [ -n "$BOOT_TARGET" ]; then
    BOOT_DIR=$(dirname "$BOOT_TARGET")
    PROFILE_BOOT="$PROFILE_DIR/node_modules/@deepseek-ai/dsh-app-boot"
    if [ ! -L "$PROFILE_BOOT" ] || [ "$(readlink -f "$PROFILE_BOOT")" != "$BOOT_DIR" ]; then
        rm -rf "$PROFILE_BOOT"
        ln -s "$BOOT_DIR" "$PROFILE_BOOT"
    fi
else
    die "cannot resolve @deepseek-ai/dsh-app-boot from the repo CLI"
fi

# ── launch ────────────────────────────────────────────────────────────────────
LOG_FILE="$LOG_DIR/server-$(date +%Y%m%d-%H%M%S).log"

log "Starting WorkDSH preview on port $PORT (dsh $REPO_DSH) ..."
(
    cd "$WORKDSH_DIR" || exit 1
    DSH_HOME="$PREVIEW_HOME" \
    DSH_AGENTS_HOME="${DSH_AGENTS_HOME:-$HOME/.agents}" \
    exec node --max-old-space-size=8192 "$CLI" \
        --profile preview --host 127.0.0.1 --port "$PORT" --no-open
) > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null

# ── wait for the URL, then report ─────────────────────────────────────────────
URL=""
for _ in $(seq 1 40); do
    if grep -q "dsh web:" "$LOG_FILE" 2>/dev/null; then
        URL=$(grep -oP 'http://\S+' "$LOG_FILE" | head -1)
        break
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
done

if [ -z "$URL" ]; then
    log "Server did not report a URL. Last log lines:"
    tail -30 "$LOG_FILE" >&2
    die "startup failed (log: $LOG_FILE)"
fi

FAILED=$(grep -c "did not activate" "$LOG_FILE" 2>/dev/null); FAILED=${FAILED:-0}
log ""
log "========================================"
log "  WorkDSH: $URL"
log "========================================"
log "  PID: $SERVER_PID"
log "  Log: $LOG_FILE"
if [ "$FAILED" -gt 0 ] 2>/dev/null; then
    log "  WARNING: $FAILED entries failed to activate - see log."
fi
log ""

command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 &
exit 0