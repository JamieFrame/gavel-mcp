# gavel-mcp-server

Aletheia Analytics MCP server — agent-native interface over the Gavel data product.

Thin TypeScript wrapper around `api.thegavel.io`. Exposes Gavel credit data
and Bitcoin on-chain indicators as MCP tools so LLM-driven agents (Claude
Desktop, IDE clients, custom agents) can read the data product without
hand-rolling REST glue.

## Status

All three layers of the AI concierge spec (`aletheia-docs`
`data/specs/mcp/ai_concierge.md`) are live, plus the indicator surface and
real key→tier resolution. Delivered by **Runbook R18** and governed by the
decisions note `data/specs/mcp/tier_and_scope_decisions_v1.md` (MD1–MD12).

**Layer A — read state**

| Tool | Upstream |
|---|---|
| `check_wallet_status` | direct RPC (balances, allowances, readiness blockers) |
| `find_auctions_matching_criteria` | `/v1/auctions` |
| `get_user_positions` | `/v1/user/:address/positions` |
| `get_loan_status` | `/v1/loans/:id/status` |

**Layer B — factory model** (unsigned blueprints; the user signs)

| Tool | Encodes |
|---|---|
| `prepare_bid_calldata` | `placeBid` + approval when allowance is short |
| `prepare_create_auction_calldata` | `createAuction` + collateral approval |
| `prepare_repay_loan_calldata` | `repayLoan` + repayment approval |
| `prepare_claim_collateral_calldata` | `claimCollateral` |
| `prepare_claim_refund_calldata` | `claimRefund` |

**Layer C — catalogues**

| Tool | Notes |
|---|---|
| `list_wallet_options` | static catalogue, no ranking |
| `recommend_fiat_onramp` | static catalogue; carries the two-purchase gas requirement |

**Data surface**

| Tool | Upstream |
|---|---|
| `list_gavel_indicators` | static catalogue of 32 indicators |
| `get_gavel_indicator` | `/v1/credit/*`, `/v1/onchain/*`, `/v1/market/*` |
| `get_yield_curve` | `/v1/yield-curve` |
| `get_mvrv` | `/v1/onchain/mvrv` |
| `get_protocol_reference` | static — addresses, signatures, conventions |
| `list_onchain_indicators` | static catalogue |

### The invariant

**Aletheia builds; the user signs.** There is no signing surface in this
codebase — no wallet client, no account, no key material. `viem` is imported
for `encodeFunctionData` only. That is what makes "Aletheia never signs" an
architectural fact rather than a policy promise, and it must stay that way.

Equally load-bearing: **no tool ranks, scores, or selects on the user's
behalf.** Filtering by user-supplied criteria is an information service;
ranking by an internal model is investment advice. `find_auctions_matching_criteria`
is named as it is deliberately, and the naming is not cosmetic.

## Architecture

```
LLM Client → mcp.thegavel.io (this server) → api.thegavel.io (REST) → PostgreSQL
              [tool catalog, descriptions,        [authoritative endpoints]
               response shaping, auth, limits]
```

Single source of truth: the REST API. The MCP server **never** queries
Postgres directly. Tools shape responses for LLM consumption (JSON-stringified
text content) but never re-implement business logic. When the REST API
upgrades, MCP inherits the upgrade automatically.

## Local development

```bash
# Install deps (Node 20+)
npm install

# Copy and edit env file
cp .env.example .env
nano .env  # set GAVEL_API_BASE_URL etc.

# Dev mode (tsx watch)
npm run dev

# Type check
npm run typecheck

# Build to dist/
npm run build
```

Point a development MCP client (MCP Inspector, Claude Desktop with an HTTP
connector) at `http://localhost:3002/mcp` to exercise tools.

## Deployment

Target: `gavel-btc` Hetzner host, alongside `gavel-api`.

```bash
# Local — build and stage
npm install
npm run build

# Copy to server
scp -r dist/ package.json package-lock.json deployment/ \
    root@gavel-btc:/root/gavel-mcp/

# On server — install runtime deps (not the full dev set)
ssh root@gavel-btc
cd /root/gavel-mcp
npm install --omit=dev

# Configure
cp .env.example .env
nano .env
# Set:
#   GAVEL_API_BASE_URL=https://api.thegavel.io  (public API, for tool reads)
#   GAVEL_API_INTERNAL_URL=http://127.0.0.1:4012  (loopback, for tier lookup)
#   INTERNAL_API_SECRET=<must match gavel-indexer/.env.mainnet>
#   PORT=3002
#   NODE_ENV=production

# Install systemd unit
cp deployment/gavel-mcp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable gavel-mcp.service
systemctl start gavel-mcp.service

# Verify
journalctl -u gavel-mcp -n 50 --no-pager
curl http://localhost:3002/health

# Reverse proxy
cp deployment/nginx-mcp.conf /etc/nginx/sites-available/mcp.thegavel.io
ln -s /etc/nginx/sites-available/mcp.thegavel.io \
      /etc/nginx/sites-enabled/mcp.thegavel.io
nginx -t && systemctl reload nginx

# TLS (Let's Encrypt)
certbot --nginx -d mcp.thegavel.io

# End-to-end check
curl https://mcp.thegavel.io/health
```

## Configuration

All knobs live in `.env`:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP listen port |
| `NODE_ENV` | — | `production` for JSON logs |
| `LOG_LEVEL` | `info` | pino level (`trace`/`debug`/`info`/`warn`/`error`) |
| `GAVEL_API_BASE_URL` | `http://localhost:3001` | Upstream REST base URL |
| `RATE_LIMIT_ANONYMOUS_PER_MINUTE` | `60` | Anonymous bucket size |
| `RATE_LIMIT_PAID_PER_MINUTE` | `300` | Paid bucket size |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated; empty = no CORS |
| `HEALTH_CHECK_SECRET` | empty | If set, `/health` requires `?secret=...` |
| `GAVEL_API_INTERNAL_URL` | `http://127.0.0.1:4012` | Key→tier lookup. Must be the **loopback** address — `/internal/resolve-tier` refuses any request carrying an `X-Forwarded-For`, so the public `api.thegavel.io` host will not work |
| `INTERNAL_API_SECRET` | empty | Shared secret for the tier lookup. Must match `gavel-indexer/.env.mainnet`. Unset ⇒ every caller resolves to `free` |
| `MCP_TIER_ENFORCEMENT` | `false` | Enforce per-tool tiers. Leave `false` until Gate B — see *Tier model* |
| `ARBITRUM_RPC_URL` | public RPC | Chain reads for Layer A/B. Point at a paid endpoint in production |
| `ARBITRUM_SEPOLIA_RPC_URL` | public RPC | Testnet equivalent |

## Tier model

The ladder is `free / pro / enterprise` — **identical** to the product's
(`gavel-indexer/lib/tiers.js`) and to what Stripe sells. The scaffold's
original `anonymous / developer / professional / enterprise` was a second
vocabulary for one entitlement and is retired (MD1).

`gavel-indexer/lib/api-keys.js` is **the** authority on what tier a key is.
The MCP does not open its own database pool; it asks
`GET /internal/resolve-tier` over loopback, caches the answer for 60 s, and
**fails open to `free`** on any error. A data MCP that 500s because the key
database hiccuped is worse than one that briefly serves anonymous.

### Enforcement is authored but OFF

`MCP_TIER_ENFORCEMENT` defaults to `false`, and that is the correct state
today. Monetisation is gated until Gate B (D16–D18): *do not build a paywall
until someone has asked to pay*. Runbook A2 withdrew the commercial surface,
and `www.thegavel.io/pricing` currently states that data access is free and
open — so refusing a tool and pointing the user at a page which denies tiers
exist would be a self-refuting journey.

With the flag off, `requireTier` still resolves the caller's real tier and
**logs what it would have refused**. That log is the evidence for M6, the
"has anyone actually asked to pay?" gate condition.

**Before flipping it on**, read MD2. There are two incompatible readings of
what a paid MCP means — whole-surface-paid (`lib/tiers.js` carries
`mcp: false` on free) versus depth-paid (MD3, the endorsed one). They are
very different products.

### What is free, and why

Per MD3, inheriting the D5 route/depth map: raw on-chain state, auction
discovery, wallet status, commodity on-chain indicators, the **current**
value of any Gavel-derived assessment, and **history** are all free. History
is free because D9 retired the 30-day REST cap, and the MCP must not
reintroduce a fence the surface it mirrors has abandoned. The paid boundary
is **bulk delivery**, which this server does not offer.

Participation is never gated (D3). Every Layer A/B/C tool is `free`: a
would-be bidder must never meet a paywall between deciding to bid and being
able to.

Rate limits are infrastructure protection, not a billing meter (D2), and
apply irrespective of the enforcement flag.

## Redeploying a change

```bash
npm run build            # tsc -> dist/ ; must be clean
systemctl restart gavel-mcp
systemctl is-active gavel-mcp
journalctl -u gavel-mcp -n 30 --no-pager
```

**This service is systemd, not pm2.** pm2 on this host carries
`quorum-mcp-testnet`, a different service — `pm2 restart gavel-mcp` is a
no-op that looks like a successful deploy. R18 v1 had this wrong; it is
recorded in that runbook's §8.

The service runs `dist/`, not `src/`, so a change that is not built is a
change that is not deployed.

## Adding a tool

1. Create `src/tools/<category>/<name>.ts`. Copy `credit/yield-curve.ts` as
   the template — it's the cleanest worked example.
2. Define a Zod schema for inputs with `.describe()` on every field; that
   description is what the LLM sees during tool discovery.
3. Write the tool description as a multi-line string. Lead with what the
   indicator is, give interpretive context (without recommending anything),
   and document the response shape. The MCP SDK uses this verbatim in the
   catalog.
4. Body: `requireTier(...)` → `upstreamGet(...)` → return
   `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`.
5. Register the tool in `src/tools/index.ts`.
6. Add an entry to `src/tools/discovery/list-onchain.ts` (or the equivalent
   discovery catalog for that domain).

## Testing manually

```bash
# 1. Health
curl -s http://localhost:3002/health | jq

# 2. MCP Inspector
npx @modelcontextprotocol/inspector
# Connect to http://localhost:3002/mcp
# Verify: tools/list returns 3 tools, get_yield_curve returns live data,
# get_mvrv returns a structured McpError "not found".
```

## License

Proprietary © 2026 Aletheia Analytics SASU. All rights reserved.
