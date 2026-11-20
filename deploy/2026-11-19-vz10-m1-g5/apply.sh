#!/usr/bin/env bash
# VZ10 row M1, G5 — deploy the testnet MCP server (gavel-testnet profile) at https://mcp-testnet.thegavel.io/mcp.
# Run as root on gavel-btc from /root/scratch-vz10-m1/g5 (this directory, copied there). One step per invocation,
# each on the operator's word, in this order:
#
#   bash apply.sh survey     # read-only: free port, node, the testnet API on loopback, DNS, nginx site names, room
#   bash apply.sh checkout   # clone gavel-mcp main into /root/gavel-mcp-testnet, pinned to $EXPECT; npm ci; build; profile check
#   bash apply.sh env        # write /root/gavel-mcp-testnet/.env (0600); prints key names only
#   bash apply.sh unit       # install and start gavel-mcp-testnet.service; loopback /health
#   bash apply.sh nginx      # install the mcp-testnet.thegavel.io site (HTTP); nginx -t; reload
#   bash apply.sh tls        # certbot --nginx for mcp-testnet.thegavel.io (needs the DNS record to point here)
#   bash apply.sh sign-url   # once /sign is live on the testnet site: GAVEL_TESTNET_SIGN_URL; restart this unit only
#   bash apply.sh check      # the live check: every tool over the public endpoint, and the chain-log fallback
#   bash apply.sh undo       # stop and remove this unit and site; the checkout is moved to /root/backups, not deleted
#
# Touches only: /root/gavel-mcp-testnet, /root/scratch-vz10-m1 (also this kit's npm cache),
# /etc/systemd/system/gavel-mcp-testnet.service and its multi-user.target.wants link,
# /etc/nginx/sites-{available,enabled}/mcp-testnet.thegavel.io, /var/log/nginx/mcp-testnet.*.log, that name's
# certificate, and /root/backups (undo). Never /root/gavel-mcp (its origin URL is read, nothing else), gavel-mcp.service,
# gavel-mcp-observatory.service, mm-auction or mm-bid. Prints no env value.
set -euo pipefail
export HOME=/root
KIT=$(cd "$(dirname "$0")" && pwd)
DIR=/root/gavel-mcp-testnet
UNIT=gavel-mcp-testnet
SITE=mcp-testnet.thegavel.io
EXPECT=0c7b49207bb4e7112b93d89442e69b29b5f46b67    # gavel-mcp main: the merge of VZ10 M1 G4 (Gate X passed 2026-11-19)
PORT=${PORT:-3005}                                  # confirmed free by survey before checkout
# Once .env exists its PORT is the port: every later step reads it, so the site cannot proxy elsewhere.
if [ -f /root/gavel-mcp-testnet/.env ]; then PORT=$(sed -n 's/^PORT=//p' /root/gavel-mcp-testnet/.env); fi
API=${API:-http://127.0.0.1:4011}                   # gavel-api-testnet on loopback (gavel-ops manifest)
SIGN_URL=https://testnet.thegavel.io/sign
CHECK_REF=${CHECK_REF:-origin/vz10/m1-g5}         # the check scripts (vz10/m1-g5 until merged; CHECK_REF=<sha> pins); its src/ must equal EXPECT's
export npm_config_cache=/root/scratch-vz10-m1/npm-cache

window() {
  local hm; hm=$(TZ=Europe/Paris date +%H%M)
  if [ "$hm" -ge 0710 ] && [ "$hm" -lt 1010 ]; then echo "refused: $(TZ=Europe/Paris date +%H:%M) Paris is inside 07:10-10:10 (no restart or reload)" >&2; exit 3; fi
}
hostips() { hostname -I | tr ' ' '\n' | grep -v '^$'; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
health() { curl -s --max-time 5 "http://127.0.0.1:$PORT/health" | sed -E 's/"time":"[^"]*",?//'; }

case "${1:-}" in
  survey)
    echo "== survey (read-only)"
    echo "-- port $PORT: $(ss -ltnH "( sport = :$PORT )" | grep -q . && echo 'IN USE' || echo free)"
    echo "-- listening on 3000-3099: $(ss -ltnH | awk '{print $4}' | grep -oE ':30[0-9]{2}$' | sort -u | tr '\n' ' ')"
    echo "-- node: $(command -v node) $(node -v); npm $(npm -v)"
    echo "-- testnet API on loopback: /v1/core/v2/deployment $(code "$API/v1/core/v2/deployment")"
    echo "-- $DIR: $([ -e "$DIR" ] && echo EXISTS || echo absent); unit $UNIT: $(systemctl is-active "$UNIT" 2>/dev/null || true)"
    echo "-- nginx sites enabled: $(ls /etc/nginx/sites-enabled | tr '\n' ' ')"
    echo "-- nginx listen lines in use: $(grep -ho 'listen [^;]*' /etc/nginx/sites-enabled/* | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
    echo "-- DNS $SITE: $(getent ahostsv4 "$SITE" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)(this host: $(hostips | tr '\n' ' '))"
    echo "-- certbot: $(command -v certbot || echo absent)"
    echo "-- the testnet site's /sign: $(code https://testnet.thegavel.io/sign)"
    echo "-- memory: $(free -m | awk '/Mem:/{print $7" MB available of "$2}'); disk /: $(df -h / | awk 'NR==2{print $4" free"}')"
    echo "-- Paris time $(TZ=Europe/Paris date +%H:%M) (unit, nginx, tls and sign-url refused 07:10-10:10)"
    echo "== next: bash apply.sh checkout";;

  checkout)
    [ -e "$DIR" ] && { echo "refused: $DIR exists" >&2; exit 4; }
    ORIGIN=$(git -C /root/gavel-mcp remote get-url origin)   # read only; the live checkout is not changed
    git clone -q --branch main "$ORIGIN" "$DIR"
    HEAD=$(git -C "$DIR" rev-parse HEAD)
    if [ "$HEAD" != "$EXPECT" ]; then
      git -C "$DIR" merge-base --is-ancestor "$EXPECT" HEAD || { echo "refused: main $HEAD does not contain $EXPECT" >&2; exit 5; }
      git -C "$DIR" checkout -q --detach "$EXPECT"
    fi
    echo "== $DIR at $(git -C "$DIR" log -1 --format='%h %s' | cut -c1-90)"
    ( cd "$DIR" && nice -n 10 npm ci --no-audit --no-fund --loglevel=error && nice -n 10 npm run -s build && node scripts/check-profiles.mjs 2>&1 | tail -2 ) | sed 's/^/  /'
    echo "  dist/http.js: $([ -f "$DIR/dist/http.js" ] && echo built || echo MISSING)"
    echo "== next: bash apply.sh env";;

  env)
    [ -d "$DIR/dist" ] || { echo "refused: run checkout first" >&2; exit 4; }
    [ -e "$DIR/.env" ] && { echo "refused: $DIR/.env exists" >&2; exit 4; }
    ss -ltnH "( sport = :$PORT )" | grep -q . && { echo "refused: port $PORT is in use" >&2; exit 4; }
    umask 077
    cat > "$DIR/.env" <<EOF
MCP_PROFILE=gavel-testnet
PORT=$PORT
NODE_ENV=production
LOG_LEVEL=info
GAVEL_API_TESTNET_BASE_URL=$API
GAVEL_API_BASE_URL=$API
EOF
    echo "== $DIR/.env written ($(stat -c %a "$DIR/.env")): $(cut -d= -f1 "$DIR/.env" | tr '\n' ' ')"
    echo "  not set: GAVEL_TESTNET_SIGN_URL (the sign-url step), ARBITRUM_SEPOLIA_RPC_URL (the public Arbitrum Sepolia RPC is the default)"
    echo "== next: bash apply.sh unit";;

  unit)
    window
    [ -f "$DIR/.env" ] || { echo "refused: run env first" >&2; exit 4; }
    [ -e "/etc/systemd/system/$UNIT.service" ] && { echo "refused: the unit file exists" >&2; exit 4; }
    sed "s#__NODE__#$(command -v node)#" "$KIT/gavel-mcp-testnet.service" > "/etc/systemd/system/$UNIT.service"
    systemctl daemon-reload
    systemctl enable --now "$UNIT" 2>&1 | sed 's/^/  /'
    sleep 4
    echo "== $UNIT: $(systemctl is-active "$UNIT"); loopback /health: $(health)"
    # The startup line names the upstream (src/http.ts): redacted, as is any URL, so no env value is printed.
    journalctl -u "$UNIT" -n 5 --no-pager -o cat | sed -E 's/"upstream":"[^"]*"/"upstream":"<redacted>"/g; s#https?://[^" ]+#<url>#g' | cut -c1-200 | sed 's/^/  /'
    echo "== next: bash apply.sh nginx";;

  nginx)
    window
    [ "$(systemctl is-active "$UNIT")" = active ] || { echo "refused: $UNIT is not active" >&2; exit 4; }
    [ -e "/etc/nginx/sites-available/$SITE" ] && { echo "refused: the site exists" >&2; exit 4; }
    sed "s#__PORT__#$PORT#" "$KIT/nginx-mcp-testnet.conf" > "/etc/nginx/sites-available/$SITE"
    ln -s "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
    if ! nginx -t 2>&1 | sed 's/^/  /'; then rm -f "/etc/nginx/sites-enabled/$SITE" "/etc/nginx/sites-available/$SITE"; echo "nginx -t failed; the site was removed, nothing reloaded" >&2; exit 6; fi
    systemctl reload nginx
    echo "== nginx reloaded; http://$SITE/health through nginx on loopback: $(code -H "Host: $SITE" http://127.0.0.1/health)"
    echo "== next: the DNS record for $SITE (an A record to this host's public address; survey lists them), then bash apply.sh tls";;

  tls)
    window
    RESOLVED=$(getent ahostsv4 "$SITE" | awk '{print $1}' | sort -u || true)
    { [ -n "$RESOLVED" ] && echo "$RESOLVED" | grep -qxF -f <(hostips); } || { echo "refused: $SITE does not resolve to an address of this host yet" >&2; exit 7; }
    certbot --nginx -d "$SITE" --non-interactive --redirect 2>&1 | tail -6 | sed 's/^/  /'
    echo "== https://$SITE/health: $(code "https://$SITE/health")"
    echo "== next: bash apply.sh check (and sign-url once /sign is live)";;

  sign-url)
    window
    grep -q '^GAVEL_TESTNET_SIGN_URL=' "$DIR/.env" && { echo "refused: already set" >&2; exit 4; }
    # /sign must be the page this row built, not the site's fallback: its code carries the refusal attribute. The entry
    # bundle loads the testnet pages as a separate chunk (import("./TestnetApp-<hash>.js")), so the chunks it names are
    # fetched and searched too.
    S=/root/scratch-vz10-m1/sign-check; rm -rf "$S"; mkdir -p "$S"
    curl -s --max-time 10 -o "$S/sign.html" https://testnet.thegavel.io/sign || true
    JS=$(grep -oE '/assets/[^"]+\.js' "$S/sign.html" 2>/dev/null | head -1 || true)
    [ -n "$JS" ] || { echo "refused: https://testnet.thegavel.io/sign names no script bundle" >&2; exit 7; }
    curl -s --max-time 30 -o "$S/entry.js" "https://testnet.thegavel.io$JS" || true
    for C in $(grep -oE '[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js' "$S/entry.js" 2>/dev/null | sort -u || true); do
      curl -s --max-time 30 -o "$S/chunk-$C" "https://testnet.thegavel.io/assets/$C" || true
    done
    grep -lq 'data-refusal' "$S"/*.js 2>/dev/null || { echo "refused: the live testnet site does not carry /sign yet" >&2; exit 7; }
    echo "-- /sign found in the live site's code ($(grep -l 'data-refusal' "$S"/*.js | xargs -n1 basename | tr '\n' ' '))"
    echo "GAVEL_TESTNET_SIGN_URL=$SIGN_URL" >> "$DIR/.env"
    systemctl restart "$UNIT"; sleep 4
    echo "== GAVEL_TESTNET_SIGN_URL set to the testnet site's /sign; $UNIT restarted: $(systemctl is-active "$UNIT"); /health: $(health)";;

  check)
    W=/root/scratch-vz10-m1/g5-check
    rm -rf "$W"; mkdir -p /root/scratch-vz10-m1
    # Cloned from origin straight into the scratch directory: the deployed checkout is not touched.
    git clone -q --no-checkout "$(git -C "$DIR" remote get-url origin)" "$W"
    git -C "$W" fetch -q origin vz10/m1-g5 2>/dev/null || true
    git -C "$W" checkout -q --detach "$CHECK_REF"
    echo "-- check scripts from $(git -C "$W" log -1 --format="%h %s" | cut -c1-80)"
    git -C "$W" diff --quiet "$EXPECT" HEAD -- src || { echo "refused: the check commit's src/ differs from the deployed $EXPECT" >&2; exit 5; }
    ln -s "$DIR/node_modules" "$W/node_modules"
    ( cd "$W" && npm run -s build )
    SIGN=$(grep -q '^GAVEL_TESTNET_SIGN_URL=' "$DIR/.env" && echo "--sign-url $SIGN_URL" || echo "")
    echo "== reads (routes on the testnet API, tools on https://$SITE/mcp)"
    set +e
    ( cd "$W" && set -a && . "$DIR/.env" && set +a && timeout 600 node scripts/check-v2-reads.mjs --endpoint "https://$SITE/mcp" > "$W/reads.out" 2>&1 ); R1=$?
    sed 's/^/  /' "$W/reads.out"; echo "  exit $R1"
    echo "-- 65 s pause: the server's anonymous limit is 60 calls a minute per caller"
    sleep 65
    echo "== writes, identity and the chain-log fallback${SIGN:+ (sign URL expected)}"
    ( cd "$W" && timeout 900 node scripts/check-v2-live.mjs "https://$SITE/mcp" $SIGN --fallback > "$W/live.out" 2>&1 ); R2=$?
    sed 's/^/  /' "$W/live.out"; echo "  exit $R2"
    set -e
    echo "== reads exit $R1, live exit $R2 ($([ $R1 -eq 0 ] && [ $R2 -eq 0 ] && echo CLEAN || echo 'FINDINGS, see above')); $UNIT: $(systemctl is-active "$UNIT"); restarts: $(systemctl show "$UNIT" -p NRestarts --value)";;

  undo)
    window
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/$UNIT.service"; systemctl daemon-reload
    if [ -e "/etc/nginx/sites-enabled/$SITE" ] || [ -e "/etc/nginx/sites-available/$SITE" ]; then
      rm -f "/etc/nginx/sites-enabled/$SITE" "/etc/nginx/sites-available/$SITE"; nginx -t && systemctl reload nginx
    fi
    [ -e "$DIR" ] && { mkdir -p /root/backups; mv "$DIR" "/root/backups/gavel-mcp-testnet-$(date +%Y%m%d-%H%M%S)"; }
    # The certificate goes too: left behind, its renewal would fail twice a day once the site is gone.
    if certbot certificates 2>/dev/null | grep -q "Certificate Name: $SITE$"; then certbot delete --cert-name "$SITE" --non-interactive 2>&1 | tail -1 | sed 's/^/  /'; fi
    echo "== undone: unit, site and certificate removed; checkout moved to /root/backups.";;

  *) echo "usage: bash apply.sh survey|checkout|env|unit|nginx|tls|sign-url|check|undo" >&2; exit 2;;
esac
