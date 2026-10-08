#!/bin/bash
# WorkDSH preview bootstrap launcher.
#
# Why this exists instead of just `pnpm preview`:
# 1. Fresh-machine bootstrap. apps/web/scripts/start-preview.mjs refuses to run
#    until preview:install has migrated the CLI ("Preview runtime is missing"), so
#    it cannot be the first command on a clean checkout. This installs, builds
#    and installs the Profile, then hands off to it.
# 2. dsh derives the "runtime version" that gates every profile bundle from
#    @deepseek-ai/dsh-app-boot's OWN package.json, and a bundle is skipped
#    SILENTLY unless its peerDependencies satisfy that version. A globally
#    `npm install -g @deepseek-ai/dsh` resolves the `^0.1.7-alpha.1` range up to
#    0.1.7-rc.2, so ITS app-boot reports rc.2 and every WorkDSH bundle is
#    dropped with nothing printed. Always go through the workspace's own CLI.
# 3. dsh-app-boot keeps `bootstrapIncludes` in MODULE state, so live settings
#    writes reload through whichever app-boot copy they resolve. If the Profile's
#    copy is not the same physical file the CLI booted with, the map is empty
#    and the write fails with "profile reload requires the root Include entry".
#    Symlink the Profile's copy at the CLI's so both share one instance.
#
# The apps relocation moved the pnpm workspace to apps/web; the repository root
# is the Desktop carrier and uses yarn, so every pnpm step runs in apps/web.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDSH_DIR="$SCRIPT_DIR/.."
WEB_DIR="$WORKDSH_DIR/apps/web"
PREVIEW_HOME="$WEB_DIR/.test-runtime/preview"
PROFILE_DIR="$PREVIEW_HOME/profiles/preview"
LOG_DIR="$PREVIEW_HOME/logs"
export WORKDSH_PREVIEW_PORT=${WORKDSH_PREVIEW_PORT:-18989}
CLI="$WEB_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$WEB_DIR" ] || die "apps/web not found; this launcher expects the apps/web layout"

# ── stop any previous instance ────────────────────────────────────────────────
pkill -9 -f "dsh.*--profile preview" 2>/dev/null
pkill -9 -f "dsh/bin.js.*--profile preview" 2>/dev/null
pkill -9 -f "start-preview[.]mjs" 2>/dev/null
sleep 2

# ── workspace dependencies (the CLI comes from here) ───────────────────────────
if [ ! -d "$WEB_DIR/node_modules" ]; then
    log "Installing Web workspace dependencies ..."
    (cd "$WEB_DIR" && corepack pnpm install --no-frozen-lockfile) || die "pnpm install failed"
fi

if [ ! -f "$WORKDSH_DIR/packages/bundle/dist/client.js" ]; then
    log "Building WorkDSH packages ..."
    (cd "$WEB_DIR" && corepack pnpm build) || die "pnpm build failed"
fi

# ── preview profile ───────────────────────────────────────────────────────────
if [ ! -d "$PROFILE_DIR/node_modules/@deepseek-ai/dsh" ]; then
    log "Installing preview profile (first run, this takes a while) ..."
    (cd "$WEB_DIR" && corepack pnpm preview:install) || die "preview:install failed"
fi

# Guard the one invariant the bundle gate depends on: the Profile must resolve the
# SAME dsh version as the workspace, otherwise every workdsh-* bundle is dropped.
WEB_DSH=$(python3 -c "import json;print(json.load(open('$WEB_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null)
PROFILE_DSH=$(python3 -c "import json;print(json.load(open('$PROFILE_DIR/node_modules/@deepseek-ai/dsh/package.json'))['version'])" 2>/dev/null)
if [ -z "$WEB_DSH" ] || [ -z "$PROFILE_DSH" ]; then
    die "cannot read dsh versions (web='$WEB_DSH' profile='$PROFILE_DSH')"
fi
if [ "$WEB_DSH" != "$PROFILE_DSH" ]; then
    die "dsh version mismatch: web=$WEB_DSH profile=$PROFILE_DSH
Run:  cd $WEB_DIR && corepack pnpm preview:install"
fi

mkdir -p "$PROFILE_DIR" "$LOG_DIR"

# ── share one app-boot module instance with the Profile ────────────────────────
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
    die "cannot resolve @deepseek-ai/dsh-app-boot from the workspace CLI"
fi

# ── launch ────────────────────────────────────────────────────────────────────
# Hand the spawn itself to the workspace script so version parity, Profile
# normalisation and child supervision stay owned in one place.
log "Starting WorkDSH preview on port $WORKDSH_PREVIEW_PORT (dsh $WEB_DSH) ..."
(cd "$WEB_DIR" && exec node scripts/start-preview.mjs)