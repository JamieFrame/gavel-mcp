#!/usr/bin/env bash
# BH1 Phase 4 — the MCP tool get_balance_sheet (gavel-mcp bh1/phase4-mcp, one commit on the live head mn1/mcp-x402
# d94d05e). Run as root. Gate 3 signed off by the operator 2026-10-21.
#
#   bash apply.sh            # preflight: writes nothing to the live checkout (the build in a scratch worktree)
#   bash apply.sh --apply    # move the live checkout to the branch, build dist/, restart gavel-mcp and gavel-mcp-observatory,
#                            # and check the public server lists get_balance_sheet
#
# Refused between 07:10 and 10:10 Paris (the restart rule). The live checkout must already be contained in the branch
# (a fast-forward, or local merges whose content the branch has); otherwise it stops.
set -euo pipefail
export HOME=/root
MCP=/root/gavel-mcp
BR=bh1/phase4-mcp
UNITS=(gavel-mcp gavel-mcp-observatory)

window() {
  local hm; hm=$(TZ=Europe/Paris date +%H%M)
  if [ "$hm" -ge 0710 ] && [ "$hm" -lt 1010 ]; then echo "refused: $(TZ=Europe/Paris date +%H:%M) Paris is inside 07:10-10:10 (no restart)" >&2; exit 3; fi
}
contained() {
  git -C "$MCP" merge-base --is-ancestor HEAD "origin/$BR" && return 0
  local merged; merged=$(git -C "$MCP" merge-tree --write-tree "origin/$BR" HEAD 2>/dev/null | head -1) || true
  [ "$merged" = "$(git -C "$MCP" rev-parse "origin/$BR^{tree}")" ]
}

case "${1:-}" in
  "")
    git -C "$MCP" fetch -q origin "$BR"
    OUT=$(mktemp -d /tmp/bh1-p4-mcp.XXXX)
    echo "== preflight (the live checkout is not touched; scratch $OUT)"
    echo "  live: $(git -C "$MCP" branch --show-current) $(git -C "$MCP" rev-parse --short HEAD); dirty: $(git -C "$MCP" status --short | wc -l) file(s)"
    contained && echo "  the live checkout is contained in origin/$BR $(git -C "$MCP" rev-parse --short "origin/$BR")" || echo "  STOP: the live checkout has content origin/$BR lacks"
    echo "  incoming: $(git -C "$MCP" log --format='%h %s' "HEAD..origin/$BR" | cut -c1-90 | tr '\n' ';')"
    git -C "$MCP" worktree add -q --detach "$OUT/wt" "origin/$BR"
    ln -s "$MCP/node_modules" "$OUT/wt/node_modules"
    ( cd "$OUT/wt" && npm run -s build && node scripts/check-profiles.mjs 2>&1 | tail -2 && grep -c "get_balance_sheet" dist/tools/series/series-tools.js | sed 's/^/  get_balance_sheet in the build: /' ) 2>&1 | sed 's/^/  /'
    git -C "$MCP" worktree remove --force "$OUT/wt"; rm -rf "$OUT"
    echo "-- services: $(for u in "${UNITS[@]}"; do printf '%s=%s ' "$u" "$(systemctl is-active "$u")"; done)"
    echo "-- Paris time now $(TZ=Europe/Paris date +%H:%M) (restarts refused 07:10-10:10)"
    echo "== next: bash apply.sh --apply";;

  --apply)
    window
    git -C "$MCP" fetch -q origin "$BR"
    contained || { echo "refused: the live checkout has content origin/$BR lacks" >&2; exit 8; }
    OUT=/root/backups/bh1-p4-mcp-$(date +%Y%m%d-%H%M%S); mkdir -p "$OUT"
    git -C "$MCP" rev-parse HEAD > "$OUT/head_before"
    [ -d "$MCP/dist" ] && cp -a "$MCP/dist" "$OUT/dist.before"
    if git -C "$MCP" merge-base --is-ancestor HEAD "origin/$BR"; then git -C "$MCP" merge -q --ff-only "origin/$BR"; else git -C "$MCP" reset -q --keep "origin/$BR"; fi
    echo "== --apply -> $OUT; live now $(git -C "$MCP" rev-parse --short HEAD)"
    ( cd "$MCP" && npm run -s build ) || { echo "build failed — restoring" >&2; git -C "$MCP" reset -q --keep "$(cat "$OUT/head_before")"; rm -rf "$MCP/dist"; cp -a "$OUT/dist.before" "$MCP/dist"; exit 6; }
    systemctl restart "${UNITS[@]}" && echo "  restarted ${UNITS[*]} at $(TZ=Europe/Paris date +%H:%M:%S) Paris"
    sleep 5
    for u in "${UNITS[@]}"; do echo "  $u: $(systemctl is-active "$u")"; done
    echo "-- the public server's tools"
    ( cd "$MCP" && timeout 60 node scripts/check-surface.mjs https://mcp.bitcoincreditstack.com/mcp 2>&1 | tail -4 | sed 's/^/  /' ) || true
    ( cd "$MCP" && timeout 60 node -e "
      const u='https://mcp.bitcoincreditstack.com/mcp', h={'content-type':'application/json',accept:'application/json, text/event-stream'};
      (async()=>{let r=await fetch(u,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'bh1-check',version:'1'}}})});
      const sid=r.headers.get('mcp-session-id'); if(sid) h['mcp-session-id']=sid;
      await fetch(u,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
      r=await fetch(u,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})}); const t=await r.text();
      console.log('  get_balance_sheet listed by the public server:', /get_balance_sheet/.test(t));})().catch(e=>console.log('  tools/list check failed:',e.message));" ) || true
    echo "== done. Undo: git -C $MCP reset --keep \$(cat $OUT/head_before) && rm -rf $MCP/dist && cp -a $OUT/dist.before $MCP/dist && systemctl restart ${UNITS[*]}";;

  *) echo "usage: bash apply.sh [--apply]" >&2; exit 2;;
esac
