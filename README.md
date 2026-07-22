# gavel-mcp-server

Aletheia Analytics MCP server — agent-native interface over the Gavel data product.

Thin TypeScript wrapper around `api.thegavel.io`. Exposes Gavel credit data
and Bitcoin on-chain indicators as MCP tools so LLM-driven agents (Claude
Desktop, IDE clients, custom agents) can read the data product without
hand-rolling REST glue.

## Status

Phase 1 Week 1 scaffold — implements the bootstrap, transport, auth, tier,
and rate-limit layers from `Aletheia_MCP_Implementation_Spec_v1_0.md`, plus
three tools as the working sample:

| Tool | Status | Upstream |
|---|---|---|
| `list_onchain_indicators` | live | none — static catalog |
| `get_yield_curve`         | live | `/v1/yield-curve` |
| `get_mvrv`                | pending | `/v1/onchain/mvrv` (404 until UTXO parser ships) |

Week 2 fills out the rest of §7 of the spec — all 19 on-chain tools plus
credit, protocol, pairing, and triangulation surfaces.

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
#   GAVEL_API_BASE_URL=http://localhost:3001   (local API)
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

## Tier model

Per `Aletheia_Data_Product_Free_Tier_Strategy_v1_0.md`:

- **anonymous** — no auth header; rate-limited by IP; on-chain commodity
  indicators and current-snapshot credit data
- **developer** — any bearer token (Phase 1 placeholder); credit surface,
  history depth, real-time feeds
- **professional** — defined in the enum, gated by `requireTier`; real
  per-key resolution lands in Phase 1.5
- **enterprise** — same

Tools call `requireTier('anonymous' | 'developer' | ...)` at the top of
their handler. Phase 1 resolves all bearer tokens to `developer`; real
validation against `api_keys` arrives with the paid-tier rollout.

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
