#!/usr/bin/env node
/**
 * check-v2-reads — VZ10 row M1, G2: do the gavel-testnet read tools read what they advertise,
 * and answer in the shape G1 §2.1 promises?
 *
 *   1. Routes (what the server CONSUMES). Every route template a read tool declares
 *      (V2_READ_ROUTES) is called on the live testnet API with ids taken from the API itself.
 *      Each must answer 200 with the V2 envelope: indexedTo, source, abiCommit, ownAccount.
 *      The templates are the 26 routes G1 §2.2 wrapped (the indexer's 27 at G1 except /logs) and the six
 *      state views of VZ9 row I4 that replaced M1's structured absences (VZ10 M1g). An id route for which the
 *      testnet has no id yet (no lien exists) is reported as skipped, not failed.
 *   2. Tools (what the server SERVES). The gavel-testnet profile is built in memory and every
 *      read tool is called. Each answer must be a non-error with provenance (chain 421614, the
 *      deployment's record hashes, its routes), sample, data and the testnet disclosure. Each
 *      tool must refuse an argument it does not take, by name.
 *
 * Usage:  npm run build && GAVEL_API_TESTNET_BASE_URL=<testnet API origin> node scripts/check-v2-reads.mjs [--endpoint <mcp url>] [--json]
 *         (--endpoint, G5: the tools are called on the deployed server rather than built in memory)
 * Exit 0 clean, 1 on any finding, 2 when the API base is not set. The base is never printed.
 */
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.MCP_PROFILE = 'gavel-testnet';

const ORIGIN = (process.env.GAVEL_API_TESTNET_BASE_URL || '').replace(/\/$/, '');
if (!ORIGIN) {
  console.error('GAVEL_API_TESTNET_BASE_URL is not set. Refusing to run: a check that cannot reach the API would report false passes.');
  process.exit(2);
}
const BASE = `${ORIGIN}/v1/core/v2`;
const asJson = process.argv.includes('--json');
const ENDPOINT = (() => { const i = process.argv.indexOf('--endpoint'); return i >= 0 ? process.argv[i + 1] : undefined; })();
const findings = [];
const fail = (rule, detail) => findings.push({ rule, detail });

const { V2_READ_ROUTES, V2_READ_TOOLS } = await import('../dist/tools/v2/read-tools.js');
const { V2_DEPLOYMENT } = await import('../dist/v2/deployment.generated.js');

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { Accept: 'application/json' } });
  return { status: r.status, body: r.ok ? await r.json() : null };
};

// ── ids from the API itself ──
const tape = (await get('/tape?limit=1')).body;
const closed = (await get('/auctions?state=closed&limit=1')).body;
// M1g: G-2 ids from the indexer's own events (a set and its first obligation; a lien, if any exists).
const byName = (n) => V2_DEPLOYMENT.contracts.find((c) => c.name === n && !c.superseded)?.address;
const setRow = (await get(`/events?contract=${byName('Obligation')}&event=SetCreated&limit=1`)).body?.rows?.[0];
const lienRow = (await get(`/events?contract=${byName('Lien')}&event=LienCreated&limit=1`)).body?.rows?.[0];
const setId = setRow?.args?.setId ?? null;
const oblId = setId ? ((await get(`/sets/${setId}`)).body?.obligationIds?.[0] ?? null) : null;
const lienId = lienRow?.args?.lienId ?? null;
const ids = {
  address: tape?.rows?.[0]?.address ?? V2_DEPLOYMENT.contracts.find((c) => c.name === 'Vault').address,
  engine: closed?.rows?.[0]?.engine ?? V2_DEPLOYMENT.spot.engine,
  auctionId: closed?.rows?.[0]?.auctionId ?? '1',
  market: V2_DEPLOYMENT.spot.pairs[0].spotMarket,
  secondary: V2_DEPLOYMENT.contracts.find((c) => c.name === 'ClaimLotMarket').address,
  k: String(V2_DEPLOYMENT.spot.billSeries[0].k),
  id: { '/obligations/:id': oblId, '/sets/:id': setId, '/liens/:id': lienId },
};
const fill = (t) =>
  t.replace(':address', ids.address).replace(':engine', ids.engine).replace(':k', ids.k)
    .replace(/^\/secondary\/:market/, `/secondary/${ids.secondary}`).replace(':market', ids.market).replace(':auctionId', ids.auctionId);
const QUERY = {
  '/events': `?contract=${V2_DEPLOYMENT.spot.pairs[0].spotMarket}&event=SlotCleared&limit=1`,
  '/liquidation-cover/accounts': `?owner=${ids.address}`,
};
const WHOLE = new Set(['/deployment', '/curve', '/tape/figures', '/bond/listing', '/accounts/:address/balances', '/obligations/:id', '/sets/:id', '/liens/:id']);

// ── 1. routes ──
const templates = [...new Set(Object.values(V2_READ_ROUTES).flat())];
const G1_WRAPPED = 26, I4_STATE_VIEWS = 6;
if (templates.length !== G1_WRAPPED + I4_STATE_VIEWS) fail('route_coverage', `the read tools declare ${templates.length} routes; G1 wrapped ${G1_WRAPPED} and M1g adds I4's ${I4_STATE_VIEWS} state views`);
if (templates.includes('/logs')) fail('route_coverage', '/logs is declared; G1 leaves it to the site');
const routeResults = [];
for (const t of templates) {
  if (t.includes(':id') && !ids.id[t]) { routeResults.push({ route: t, status: null, envelope: null, skipped: 'no id of this kind on the testnet yet' }); continue; }
  const p = fill(t).replace(':id', ids.id[t] ?? '') + (QUERY[t] ?? (t.includes('?') ? '' : WHOLE.has(t) || t.startsWith('/calendar') ? '' : '?limit=1'));
  const { status, body } = await get(p);
  const ok = status === 200 && body && 'indexedTo' in body && 'source' in body && 'abiCommit' in body && body.ownAccount && 'available' in body.ownAccount;
  routeResults.push({ route: t, status, envelope: !!ok });
  if (!ok) fail('route_answers', `${t}: status ${status}${status === 200 ? ', envelope incomplete' : ''}`);
}

// ── 2. tools ──
// G5: --endpoint <url> calls the deployed server over Streamable HTTP instead of the profile built in memory,
// paced under its anonymous limit; the routes above are still read from the API host the env names.
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const client = new Client({ name: 'check-v2-reads', version: '1' });
let call;
if (ENDPOINT) {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)));
  call = async (params) => { await new Promise((r) => setTimeout(r, 1100)); return client.callTool(params); };
} else {
  const { PROFILES } = await import('../dist/profiles.js');
  const { buildServer } = await import('../dist/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = buildServer(PROFILES['gavel-testnet']);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  // The tools run inside a request context, as over HTTP: a free-tier caller with no key.
  const { requestContext } = await import('../dist/context.js');
  const ctx = { tier: 'free', ip: '127.0.0.1', bearerToken: null, requestId: 'check-v2-reads' };
  call = (params) => requestContext.run(ctx, () => client.callTool(params));
}

const ARGS = {
  get_deployment: {},
  get_tape: { limit: 5 },
  get_account: { address: ids.address, limit: 5 },
  get_contract_events: { contract: ids.market, event: 'SlotCleared', limit: 3 },
  list_auctions: { state: 'closed', limit: 5 },
  get_auction_bids: { engine: ids.engine, auction_id: String(ids.auctionId) },
  list_bullet_loans: { limit: 5 },
  get_curve: {},
  list_spot_markets: { last: true },
  get_spot_market: { market: V2_DEPLOYMENT.spot.pairs[0].name, limit: 5, pages: true },
  list_future_offers: {},
  list_futures: { limit: 5 },
  list_cover_offers: { open: true },
  list_policies: { limit: 5 },
  get_bill_series: { k: Number(ids.k) },
  list_secondary_sales: { limit: 5 },
  get_secondary_sale_bids: { market: ids.secondary, auction_id: '1' },
  get_calendar: {},
  get_obligation: oblId ? { obligation_id: String(oblId) } : { set_id: String(setId ?? '1') },
};
const listed = (await client.listTools()).tools.map((t) => t.name);
const toolResults = [];
for (const name of V2_READ_TOOLS) {
  if (!listed.includes(name)) { fail('tool_listed', `${name} is not in tools/list`); continue; }
  const r = await call({ name, arguments: ARGS[name] });
  const text = r.content?.[0]?.text ?? '';
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const row = { tool: name, isError: !!r.isError, bytes: text.length };
  if (r.isError || !j) { fail('tool_answers', `${name}: ${text.slice(0, 200)}`); toolResults.push(row); continue; }
  const p = j.provenance;
  if (!p || p.chain?.id !== 421614) fail('tool_provenance', `${name}: no provenance on chain 421614`);
  if (p && !(typeof p.indexedTo === 'number' || (p.indexedTo === null && p.source === 'scenario-file'))) fail('tool_provenance', `${name}: indexedTo ${p.indexedTo}`);
  if (p && p.deployment?.docsCommit !== V2_DEPLOYMENT.docs.commit) fail('tool_provenance', `${name}: provenance does not name the deployment's docs commit`);
  if (!Array.isArray(p?.routes) || !p.routes.length || !p.routes.every((x) => x.startsWith('/v1/core/v2/'))) fail('tool_provenance', `${name}: routes not recorded, or outside /v1/core/v2`);
  if (!('sample' in j) || !('data' in j)) fail('tool_shape', `${name}: missing sample or data`);
  if (!/Arbitrum Sepolia test network/.test(j.disclosure || '')) fail('tool_disclosure', `${name}: no testnet disclosure`);
  row.indexedTo = p?.indexedTo ?? null;
  row.rows = j.sample?.rows ?? null;
  row.absences = (text.match(/"absent":/g) || []).length;
  // Refusal of an argument the tool does not take.
  const bad = await call({ name, arguments: { ...ARGS[name], sort_by: 'rate' } });
  const bt = bad.content?.[0]?.text ?? '';
  if (!bad.isError || !/does not take that argument/.test(bt)) fail('tool_strict', `${name}: an unknown argument was not refused by name`);
  toolResults.push(row);
}
// Arguments a mode would ignore are refused, not dropped (G2 review finding 8).
for (const [name, args, why] of [
  ['get_tape', { figures: true, limit: 5 }, 'limit with figures'],
  ['get_tape', { as_of: 1794412132 }, 'as_of without figures'],
  ['list_bullet_loans', { view: 'loans', owner: ids.address }, "owner with view 'loans'"],
  ['list_bullet_loans', { view: 'entries', opener: ids.address }, "opener with view 'entries'"],
  ['list_policies', { role: 'seller' }, 'role without account'],
  ['get_obligation', {}, 'no id'],
  ['get_obligation', { obligation_id: '1', set_id: '1' }, 'two ids'],
]) {
  const r = await call({ name, arguments: args });
  if (!r.isError) fail('tool_refuses_ignored', `${name}: ${why} was answered, not refused`);
}
// M1g: an id the indexer has not seen is refused in the indexer's words, not the client's generic 404 text.
{
  const r = await call({ name: 'get_obligation', arguments: { obligation_id: '999999999999' } });
  const t = r.content?.[0]?.text ?? '';
  if (!r.isError || !/as at block \d+/.test(t) || /may not be live yet/.test(t)) fail('tool_not_seen', `get_obligation: an unseen id answered ${r.isError ? 'an error not in the indexer words' : 'without an error'}: ${t.slice(0, 160)}`);
}
await client.close();

const summary = { ids: Object.keys(ids), routes: routeResults, tools: toolResults, findings };
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  const skipped = routeResults.filter((r) => r.skipped);
  console.log(`routes: ${routeResults.filter((r) => r.envelope).length}/${routeResults.length - skipped.length} answer 200 with the V2 envelope${skipped.length ? `; skipped: ${skipped.map((r) => `${r.route} (${r.skipped})`).join(', ')}` : ''}`);
  for (const t of toolResults) console.log(`  ${t.isError ? 'ERR ' : 'ok  '} ${t.tool.padEnd(24)} rows=${t.rows ?? '-'} absences=${t.absences ?? '-'} indexedTo=${t.indexedTo ?? '-'} bytes=${t.bytes}`);
  console.log(findings.length ? findings.map((f) => `[RED] ${f.rule}: ${f.detail}`).join('\n') : `check-v2-reads: clean (0 findings; ${toolResults.length} tools, ${routeResults.length} routes)`);
}
process.exit(findings.length ? 1 : 0);
