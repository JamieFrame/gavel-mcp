#!/usr/bin/env bash
# VZ10 follow-up M1g — move the testnet MCP server (gavel-testnet profile, https://mcp-testnet.thegavel.io/mcp) from
# M1's pin to the merge that replaces its structured absences with VZ9 row I4's routes. Run as root on gavel-btc from
# /root/scratch-vz10-m1g/kit (this directory, copied there). One step per invocation, each on the operator's word:
#
#   EXPECT=<merge sha> bash apply.sh survey    # read-only: the checkout's pin and state, the unit, what EXPECT carries
#   EXPECT=<merge sha> bash apply.sh backup    # the current pin and dist/ to /root/scratch-vz10-m1g/backup-<time>
#   EXPECT=<merge sha> bash apply.sh update    # fetch, detach at EXPECT, npm ci only if the lockfile changed, build, profile check
#   EXPECT=<merge sha> bash apply.sh restart   # restart gavel-mcp-testnet only; loopback /health
#   EXPECT=<merge sha> bash apply.sh check     # the live check (reads, identity, writes, fallback) over the public endpoint
#                      bash apply.sh undo      # back to the backed-up pin: detach there, restore its dist/, restart
#
# Touches only /root/gavel-mcp-testnet (its git HEAD, dist/ and, if the lockfile changed, node_modules), the unit
# gavel-mcp-testnet (restart only; the unit file and .env are not edited), and /root/scratch-vz10-m1g. Never
# /root/gavel-mcp, gavel-mcp.service, gavel-mcp-observatory.service, the indexers or APIs, the fleet, mm-auction or
# mm-bid. Prints no env value.
set -euo pipefail
export HOME=/root
DIR=/root/gavel-mcp-testnet
UNIT=gavel-mcp-testnet
SITE=mcp-testnet.thegavel.io
SCR=/root/scratch-vz10-m1g
PIN_M1=0c7b49207bb4e7112b93d89442e69b29b5f46b67     # M1's G5 pin, the expected starting point
export npm_config_cache=$SCR/npm-cache
PORT=$(sed -n 's/^PORT=//p' "$DIR/.env")

need_expect() {
  [[ "${EXPECT:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: set EXPECT to the full 40-character sha of the M1g merge on gavel-mcp main" >&2; exit 2; }
}
window() {
  local hm; hm=$(TZ=Europe/Paris date +%H%M)
  if [ "$hm" -ge 0710 ] && [ "$hm" -lt 1010 ]; then echo "refused: $(TZ=Europe/Paris date +%H:%M) Paris is inside 07:10-10:10 (no restart)" >&2; exit 3; fi
}
health() { curl -s --max-time 5 "http://127.0.0.1:$PORT/health" | sed -E 's/"time":"[^"]*",?//'; }
latest_backup() { ls -1d "$SCR"/backup-* 2>/dev/null | tail -1; }

case "${1:-}" in
  survey)
    need_expect
    echo "== survey (read-only)"
    echo "-- $DIR HEAD: $(git -C "$DIR" rev-parse HEAD) ($(git -C "$DIR" log -1 --format='%h %s' | cut -c1-80))"
    echo "-- expected start $PIN_M1: $([ "$(git -C "$DIR" rev-parse HEAD)" = "$PIN_M1" ] && echo yes || echo NO)"
    echo "-- working tree: $(git -C "$DIR" status --porcelain --untracked-files=no | wc -l) tracked change(s) (expected 0)"
    echo "-- $UNIT: $(systemctl is-active "$UNIT"); restarts: $(systemctl show "$UNIT" -p NRestarts --value); loopback /health: $(health)"
    git -C "$DIR" fetch -q origin main
    if git -C "$DIR" cat-file -e "$EXPECT^{commit}" 2>/dev/null; then
      echo "-- EXPECT on origin/main: $(git -C "$DIR" merge-base --is-ancestor "$EXPECT" origin/main && echo yes || echo NO)"
      echo "-- EXPECT contains the current pin: $(git -C "$DIR" merge-base --is-ancestor HEAD "$EXPECT" && echo yes || echo NO)"
      echo "-- commits from the current pin to EXPECT (first parent):"
      git -C "$DIR" log --oneline --first-parent HEAD.."$EXPECT" | sed 's/^/     /'
      echo "-- files changed under src/: $(git -C "$DIR" diff --name-only HEAD "$EXPECT" -- src | tr '\n' ' ')"
      echo "-- lockfile changed: $(git -C "$DIR" diff --quiet HEAD "$EXPECT" -- package-lock.json && echo no || echo YES)"
    else
      echo "-- EXPECT $EXPECT: NOT FOUND after fetching origin main"
    fi
    echo "-- disk /: $(df -h / | awk 'NR==2{print $4" free"}'); Paris time $(TZ=Europe/Paris date +%H:%M) (restart refused 07:10-10:10)"
    echo "== next: bash apply.sh backup";;

  backup)
    need_expect
    mkdir -p "$SCR"
    B="$SCR/backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B"
    git -C "$DIR" rev-parse HEAD > "$B/pin"
    tar -C "$DIR" -czf "$B/dist.tgz" dist package-lock.json
    echo "== backup $B: pin $(cat "$B/pin"), dist.tgz $(du -h "$B/dist.tgz" | cut -f1) (dist/ and package-lock.json; .env is not copied and not changed)"
    echo "== next: bash apply.sh update";;

  update)
    need_expect
    B=$(latest_backup); [ -n "$B" ] && [ "$(cat "$B/pin")" = "$(git -C "$DIR" rev-parse HEAD)" ] || { echo "refused: no backup of the current pin; run backup first" >&2; exit 4; }
    [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || { echo "refused: $DIR has tracked changes" >&2; exit 4; }
    git -C "$DIR" fetch -q origin main
    git -C "$DIR" merge-base --is-ancestor "$EXPECT" origin/main || { echo "refused: $EXPECT is not on origin/main" >&2; exit 5; }
    OLD=$(git -C "$DIR" rev-parse HEAD)
    git -C "$DIR" checkout -q --detach "$EXPECT"
    echo "== $DIR at $(git -C "$DIR" log -1 --format='%h %s' | cut -c1-90)"
    if git -C "$DIR" diff --quiet "$OLD" HEAD -- package-lock.json; then
      echo "  lockfile unchanged: node_modules kept"
    else
      ( cd "$DIR" && nice -n 10 npm ci --no-audit --no-fund --loglevel=error ) | sed 's/^/  /'
    fi
    ( cd "$DIR" && nice -n 10 npm run -s build && node scripts/check-profiles.mjs 2>&1 | grep -E '^testnet:|lint' | cut -c1-160 ) | sed 's/^/  /'
    echo "  the running server is unchanged until restart"
    echo "== next: bash apply.sh restart";;

  restart)
    need_expect
    window
    [ "$(git -C "$DIR" rev-parse HEAD)" = "$EXPECT" ] || { echo "refused: $DIR is not at EXPECT; run update first" >&2; exit 4; }
    systemctl restart "$UNIT"; sleep 4
    echo "== $UNIT: $(systemctl is-active "$UNIT"); loopback /health: $(health)"
    # The startup line names the upstream (src/http.ts): redacted, as is any URL, so no env value is printed.
    journalctl -u "$UNIT" -n 5 --no-pager -o cat | sed -E 's/"upstream":"[^"]*"/"upstream":"<redacted>"/g; s#https?://[^" ]+#<url>#g' | cut -c1-200 | sed 's/^/  /'
    echo "== next: bash apply.sh check";;

  check)
    need_expect
    W=$SCR/check
    rm -rf "$W"; mkdir -p "$SCR"
    # Cloned into the scratch directory at EXPECT, so the deployed checkout is not touched.
    git clone -q --no-checkout "$(git -C "$DIR" remote get-url origin)" "$W"
    git -C "$W" checkout -q --detach "$EXPECT"
    ln -s "$DIR/node_modules" "$W/node_modules"
    ( cd "$W" && npm run -s build )
    SIGN=$(grep -q '^GAVEL_TESTNET_SIGN_URL=' "$DIR/.env" && echo "--sign-url https://testnet.thegavel.io/sign" || echo "")
    echo "== reads (routes on the testnet API, tools on https://$SITE/mcp)"
    set +e
    ( cd "$W" && set -a && . "$DIR/.env" && set +a && timeout 600 node scripts/check-v2-reads.mjs --endpoint "https://$SITE/mcp" > "$W/reads.out" 2>&1 ); R1=$?
    sed 's#https\?://[^ ]*#<url>#g; s/^/  /' "$W/reads.out"; echo "  exit $R1"
    echo "-- 65 s pause: the server's anonymous limit is 60 calls a minute per caller"
    sleep 65
    echo "== writes, identity and the chain-log fallback${SIGN:+ (sign URL expected)}"
    ( cd "$W" && timeout 900 node scripts/check-v2-live.mjs "https://$SITE/mcp" $SIGN --fallback > "$W/live.out" 2>&1 ); R2=$?
    sed 's/^/  /' "$W/live.out"; echo "  exit $R2"
    set -e
    echo "== reads exit $R1, live exit $R2 ($([ $R1 -eq 0 ] && [ $R2 -eq 0 ] && echo CLEAN || echo 'FINDINGS, see above')); $UNIT: $(systemctl is-active "$UNIT"); restarts: $(systemctl show "$UNIT" -p NRestarts --value)";;

  undo)
    window
    B=$(latest_backup); [ -n "$B" ] || { echo "refused: no backup in $SCR" >&2; exit 4; }
    P=$(cat "$B/pin")
    git -C "$DIR" checkout -q --detach "$P"
    rm -rf "$DIR/dist"; tar -C "$DIR" -xzf "$B/dist.tgz"
    git -C "$DIR" diff --quiet HEAD -- package-lock.json || { echo "warning: the lockfile differs from the pin's; run npm ci in $DIR before the restart" >&2; exit 6; }
    systemctl restart "$UNIT"; sleep 4
    echo "== undone: $DIR at $(git -C "$DIR" log -1 --format='%h %s' | cut -c1-80), dist/ restored from $B; $UNIT: $(systemctl is-active "$UNIT"); /health: $(health)";;

  *) echo "usage: EXPECT=<sha> bash apply.sh survey|backup|update|restart|check, or bash apply.sh undo" >&2; exit 2;;
esac
