#!/usr/bin/env node
/**
 * check-v2-live — VZ10 row M1, G5: the deployed gavel-testnet server, called as a client calls it.
 *
 *   node scripts/check-v2-live.mjs <mcp endpoint> [--sign-url <url>] [--fallback] [--json]
 *
 *   1. Identity. initialize over Streamable HTTP: the server's instructions are the generated testnet
 *      instructions; tools/list is exactly the gavel-testnet profile's tools (no more, no fewer); the
 *      build-outlines resource is listed and reads as JSON.
 *   2. Write tools. Every prepare_* tool is called once with arguments built from the deployment's own
 *      records and an address taken from the testnet API's tape. Each must answer with either a
 *      blueprint or a refusal that states its reason (MCP InvalidParams). A blueprint must carry the
 *      regulatory notice verbatim, chain 421614, value 0, and every transaction (prerequisites too)
 *      must lie inside the signing surface /sign relays. With --sign-url, each blueprint's
 *      wallet_agnostic_url must start with it; without it, none may carry one. A transport error, an
 *      internal error or an unreadable RPC is a finding. Many calls refuse on a live chain (the
 *      address holds no position): the check states which answered and how, and asserts only that
 *      every tool decides.
 *   3. --fallback: loan terms from the chain's logs. A bid tool's expected terms are rebuilt from the
 *      opening transaction, found first through the indexer and then through Arbitrum Sepolia's logs
 *      (src/tools/v2/write-tools.ts openingTerms). Per product:
 *      - where the indexer lists an OPEN loan, the bid tool is called on a profile built in memory with NO
 *        testnet API host (so only the log scan can find the opening transaction), and its expected-terms
 *        hash must equal the live server's, which found it through the indexer;
 *      - where it lists none, a bid is refused on the loan's state before its terms are looked up, so no
 *        tool can reach the scan. The scan is then run directly, as openingTerms runs it (the product's
 *        LoanOpened event, deployment block to head, newest first, 100,000-block windows; without the
 *        loanId topic filter, so every opening is counted): every window must answer, and the count must
 *        equal the loans the indexer lists for that product. This proves the RPC answers every window the
 *        fallback would request; the fallback's own logic rests on G3's fork proof until a loan is opened.
 *      Reads only: eth_getLogs, eth_getTransaction, eth_call.
 *
 * Nothing is signed or sent. Paced under the server's anonymous limit. The endpoint and the API host are
 * printed as given on the command line only; no env value is printed.
 * Exit 0 clean, 1 on any finding, 2 when it cannot run.
 */
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.MCP_PROFILE = 'gavel-testnet';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const ENDPOINT = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
const SIGN_URL = (opt('--sign-url') || '').replace(/\/$/, '');
const FALLBACK = argv.includes('--fallback');
const asJson = argv.includes('--json');
if (!ENDPOINT) { console.error('usage: node scripts/check-v2-live.mjs <mcp endpoint> [--sign-url <url>] [--fallback] [--json]'); process.exit(2); }

const findings = [];
const fail = (rule, detail) => findings.push({ rule, detail });
const log = (...m) => { if (!asJson) console.log(...m); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const viem = await import('viem');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { PROFILES } = await import('../dist/profiles.js');
const { GAVEL_TESTNET_INSTRUCTIONS } = await import('../dist/v2/instructions.generated.js');
const { V2_DEPLOYMENT } = await import('../dist/v2/deployment.generated.js');
const { REGULATORY_NOTICE } = await import('../dist/factory/envelope.js');
const ABI = await import('../dist/v2/abi.generated.js');
const SURFACE = await import('../dist/v2/sign-surface.js');

const profile = PROFILES['gavel-testnet'];
const want = new Set(profile.tools.map((t) => (typeof t === 'string' ? t : t.name)));

// ── 1. identity ──
const client = new Client({ name: 'check-v2-live', version: '1' });
try { await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT))); }
catch (e) { console.error(`could not connect to ${ENDPOINT}: ${e.message}`); process.exit(2); }
const served = client.getInstructions?.() ?? '';
if (served !== GAVEL_TESTNET_INSTRUCTIONS) fail('instructions', `the served instructions differ from the generated testnet instructions (${served.length} vs ${GAVEL_TESTNET_INSTRUCTIONS.length} characters)`);
const listed = (await client.listTools()).tools;
const names = new Set(listed.map((t) => t.name));
for (const n of want) if (!names.has(n)) fail('tools_list', `${n} is in the profile but not served`);
for (const n of names) if (!want.has(n)) fail('tools_list', `${n} is served but not in the gavel-testnet profile`);
const res = (await client.listResources()).resources.map((r) => r.uri);
const outlines = res.find((u) => /build-outlines/.test(u));
if (!outlines) fail('resources', 'build-outlines is not listed');
else {
  const r = await client.readResource({ uri: outlines });
  try { JSON.parse(r.contents?.[0]?.text ?? ''); } catch { fail('resources', 'build-outlines does not read as JSON'); }
}
log(`identity: ${names.size} tools served (profile ${want.size}); instructions ${served === GAVEL_TESTNET_INSTRUCTIONS ? 'match' : 'DIFFER'}; resources ${res.length}`);

// ── calls ──
const call = async (c, name, args) => {
  await pause(c === client ? 1100 : 0);
  let r;
  try { r = await c.callTool({ name, arguments: args }); } catch (e) { return { kind: 'transport', text: e.message }; }
  const text = r.content?.[0]?.text ?? '';
  if (!r.isError) { try { return { kind: 'answer', body: JSON.parse(text), text }; } catch { return { kind: 'answer', body: null, text }; } }
  // The one error shape: { error: { code, message, retryable } }. A decision about the caller's arguments or the
  // chain's state is a refusal; an unreadable upstream or RPC, a rate limit or an internal error is not a decision.
  let e = null;
  try { e = JSON.parse(text).error; } catch { /* not the error shape */ }
  if (!e) return { kind: 'error', text };
  if (/could not be read/.test(e.message ?? '')) return { kind: 'internal', text: e.message };
  if (['invalid_argument', 'not_found', 'not_available', 'nothing_to_draw'].includes(e.code)) return { kind: 'refusal', text: e.message ?? '' };
  return { kind: e.code === 'internal_error' ? 'internal' : 'error', text: `${e.code}: ${e.message ?? ''}` };
};

// An address from the testnet's own tape (an account that has traded here), else the Vault's address (calls then refuse).
const tape = await call(client, 'get_tape', { limit: 1 });
if (tape.kind !== 'answer') fail('reads', `get_tape: ${tape.kind}: ${String(tape.text).slice(0, 160)}`);
const who = viem.getAddress(tape.body?.data?.rows?.[0]?.address ?? tape.body?.data?.[0]?.address ?? V2_DEPLOYMENT.contracts.find((c) => c.name === 'Vault').address);
const pair = V2_DEPLOYMENT.spot.pairs[0];
const [base, quote] = pair.name.split('/');
const loanTok = V2_DEPLOYMENT.tokens.find((t) => t.symbol === quote) ? quote : V2_DEPLOYMENT.tokens[0].symbol;
const collTok = V2_DEPLOYMENT.tokens.find((t) => t.symbol === base) ? base : V2_DEPLOYMENT.tokens[1].symbol;
const product = SURFACE.consumerAddresses()[0];

// A loan id per product from the indexer, when one was ever opened.
const loans = await call(client, 'list_bullet_loans', { view: 'loans', limit: 500 });
if (loans.kind !== 'answer') fail('reads', `list_bullet_loans: ${loans.kind}: ${String(loans.text).slice(0, 160)}`);
const opened = loans.body?.data?.loans ?? [];
// The indexer's rows carry side ('request' | 'offer') and status ('OPEN' | 'ORIGINATED' | 'ENDED'); only an OPEN loan can be bid on.
const loanOf = (side) => opened.find((l) => l.side === side && l.status === 'OPEN') ?? null;
const reqLoan = loanOf('request'), offLoan = loanOf('offer');
const id = (l) => String(l?.loanId ?? '1');

const WRITE_ARGS = {
  prepare_test_token_mint: { token: loanTok, to: who, amount: '1' },
  prepare_vault_deposit: { account: who, token: loanTok, amount: '1' },
  prepare_vault_withdraw: { account: who, token: loanTok, amount: '1' },
  prepare_vault_product_approval: { account: who, product: product.name, approved: true },
  prepare_spot_order: { account: who, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000000' },
  prepare_spot_cancel: { account: who, market: pair.name, order_id: '1' },
  prepare_bullet_request_open: { account: who, loan_token: loanTok, amount: '1000', max_repayment: '1100', term_days: 7, auction_hours: 24, collateral: [{ token: collTok, amount: '0.1' }], mode: 'one', bid_step: '10' },
  prepare_bullet_request_bid: { account: who, loan_id: id(reqLoan), repayment: '1050' },
  prepare_bullet_offer_open: { account: who, loan_token: loanTok, principal: '500', min_loan: '500', max_loan: '500', collateral_token: collTok, loan_per_collateral: '50000', floor_rate: '1.01', term_days: 7, auction_hours: 24, mode: 'one' },
  prepare_bullet_offer_bid: { account: who, loan_id: id(offLoan), loan_size: '500', repayment: '505' },
  prepare_bullet_cancel: { account: who, product: 'request', loan_id: id(reqLoan) },
  prepare_bullet_entry_release: { account: who, product: 'request', entry_id: '1' },
  prepare_bullet_finalise: { account: who, product: 'request', loan_id: id(reqLoan) },
  prepare_obligation_pay: { account: who, obligation_id: '1', source: 'vault' },
  prepare_lien_payoff: { account: who, lien_id: '1', source: 'vault' },
  prepare_lien_release: { account: who, lien_id: '1' },
  prepare_lien_claim: { account: who, lien_id: '1' },
  prepare_obligation_collect: { account: who, obligation_id: '1' },
  prepare_obligation_redeem: { account: who, obligation_id: '1' },
};

const KIND_ABI = { TestToken: 'MockERC20', Vault: 'Vault', SpotMarket: 'SpotMarket', BulletLoanRequest: 'BulletLoanRequest', BulletLoanOffer: 'BulletLoanOffer', Obligation: 'Obligation', Lien: 'Lien' };
function inSurface(tx, where) {
  const kind = SURFACE.kindOf(tx.to);
  if (!kind) return fail('surface', `${where}: ${tx.to} is not in the signing surface`);
  let d;
  try { d = viem.decodeFunctionData({ abi: ABI[`${KIND_ABI[kind]}_ABI`], data: tx.data }); } catch { return fail('surface', `${where}: calldata does not decode against ${kind}`); }
  if (!SURFACE.SIGN_CALLS[kind].includes(d.functionName)) fail('surface', `${where}: ${kind}.${d.functionName} is not in the signing surface`);
}
function checkBlueprint(name, env) {
  if (env.disclosure !== REGULATORY_NOTICE) fail('envelope', `${name}: the regulatory notice is not verbatim`);
  const txs = [...(env.prerequisites ?? []).map((p, i) => [p.transaction, `${name} prerequisite ${i}`]), [env.transaction, name]];
  for (const [tx, where] of txs) {
    if (!tx || tx.chain_id !== 421614 || tx.value !== '0') { fail('envelope', `${where}: chain or value wrong`); continue; }
    inSurface(tx, where);
  }
  for (const [x, where] of [[env, name], ...(env.prerequisites ?? []).map((p, i) => [p, `${name} prerequisite ${i}`])]) {
    const url = x.deeplinks?.wallet_agnostic_url ?? null;
    if (SIGN_URL && !(url && url.startsWith(`${SIGN_URL}?`))) fail('sign_url', `${where}: wallet_agnostic_url ${url ? 'points elsewhere' : 'is missing'}`);
    if (!SIGN_URL && url) fail('sign_url', `${where}: carries a wallet_agnostic_url though no sign URL was expected`);
  }
}

const writes = [];
for (const name of [...want].filter((n) => n.startsWith('prepare_'))) {
  const args = WRITE_ARGS[name];
  if (!args) { fail('write_args', `${name}: this check has no arguments for it`); continue; }
  const r = await call(client, name, args);
  const row = { tool: name, outcome: r.kind === 'answer' ? 'blueprint' : r.kind, detail: r.kind === 'answer' ? `${(r.body?.prerequisites ?? []).length} prerequisite(s)` : r.text.slice(0, 160) };
  if (r.kind === 'answer') { if (r.body?.transaction) checkBlueprint(name, r.body); else fail('write_answers', `${name}: an answer with no transaction`); }
  else if (r.kind !== 'refusal') fail('write_answers', `${name}: ${r.kind}: ${r.text.slice(0, 200)}`);
  writes.push(row);
  log(`  ${r.kind === 'answer' ? 'blueprint' : r.kind.padEnd(9)} ${name.padEnd(32)} ${row.detail}`);
}
if (!writes.some((w) => w.outcome === 'blueprint')) fail('write_answers', 'no write tool returned a blueprint');

// ── 3. the chain-log fallback ──
let fallback = null;
if (FALLBACK) {
  delete process.env.GAVEL_API_TESTNET_BASE_URL; // the indexer step cannot answer; only the chain's logs can
  const { buildServer } = await import('../dist/server.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { requestContext } = await import('../dist/context.js');
  const server = buildServer(profile);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mem = new Client({ name: 'check-v2-live-fallback', version: '1' });
  await mem.connect(b);
  const ctx = { tier: 'free', ip: '127.0.0.1', bearerToken: null, requestId: 'check-v2-live-fallback' };
  const memCall = (name, args) => requestContext.run(ctx, () => call(mem, name, args));
  const { testnetClient } = await import('../dist/rpc.js');
  fallback = [];
  for (const [name, loan, kind] of [['prepare_bullet_request_bid', reqLoan, 'BulletLoanRequest'], ['prepare_bullet_offer_bid', offLoan, 'BulletLoanOffer']]) {
    const t0 = Date.now();
    if (loan) {
      // An open loan: the terms rebuilt from the logs (no API host) must be the ones the live server rebuilt through the indexer.
      // The bidder is the Vault's address (never the loan's opener, so PrincipalCannotBid cannot stop it first), and a zero
      // expected-terms hash makes the tool stop with TermsChanged straight after the lookup, naming the hash it rebuilt.
      const vault = V2_DEPLOYMENT.contracts.find((x) => x.name === 'Vault').address;
      const args = { ...WRITE_ARGS[name], account: vault, expected_terms: `0x${'0'.repeat(64)}` };
      const r = await memCall(name, args);
      const liveR = await call(client, name, args);
      const h = (x) => x.text?.match(/opening transaction \((0x[0-9a-f]{64})\)/i)?.[1] ?? null;
      const row = { tool: name, loan: id(loan), path: 'tool', outcome: r.kind, fromLogs: h(r), fromIndexer: h(liveR), seconds: (Date.now() - t0) / 1000 };
      row.match = row.fromLogs !== null && row.fromIndexer !== null && row.fromLogs === row.fromIndexer;
      // Both refused identically before the lookup (the chain's state moved past the indexer's OPEN, or the product is paused):
      // the lookup was not reached, which is not a fault in it; the scan below runs instead.
      const before = row.fromLogs === null && row.fromIndexer === null && r.kind === 'refusal' && liveR.kind === 'refusal' && r.text === liveR.text;
      if (r.kind === 'internal' || r.kind === 'transport') fail('fallback', `${name} loan ${row.loan}: ${r.text.slice(0, 200)}`);
      else if (before) row.note = `refused before the lookup: ${r.text.slice(0, 160)}`;
      else if (row.fromLogs === null || row.fromIndexer === null) fail('fallback', `${name} loan ${row.loan}: no rebuilt hash to compare (logs: ${r.text.slice(0, 120)} | indexer: ${String(liveR.text).slice(0, 120)})`);
      else if (!row.match) fail('fallback', `${name} loan ${row.loan}: the terms rebuilt from the logs differ from the live server's`);
      fallback.push(row);
      log(`  fallback ${name.padEnd(28)} loan ${row.loan}: ${before ? row.note : `terms from the logs ${row.match ? 'match the indexer path' : 'DIFFER'}`} (${row.seconds.toFixed(1)} s)`);
      if (!before) continue;
    }
    // No open loan on this product: a bid is refused on the loan's state before its terms are looked up, so the tool cannot
    // reach the scan. The scan itself is run here as openingTerms runs it (the product's LoanOpened event, from its
    // deployment block to the head, newest first, in 100,000-block windows) against the same RPC client the tools use;
    // every window must answer, and the events found must agree with the indexer's count.
    const c = V2_DEPLOYMENT.contracts.find((x) => x.name === kind && !x.superseded);
    const event = ABI[`${kind}_ABI`].find((x) => x.type === 'event' && x.name === 'LoanOpened');
    const from = BigInt(c.block), latest = await testnetClient.getBlockNumber(), WINDOW = 100_000n;
    let windows = 0, events = 0, error = null;
    try {
      for (let to = latest; to >= from; to -= WINDOW) {
        const fromBlock = to - WINDOW + 1n > from ? to - WINDOW + 1n : from;
        events += (await testnetClient.getLogs({ address: viem.getAddress(c.address), event, fromBlock, toBlock: to })).length;
        windows++;
        if (fromBlock === from) break;
      }
    } catch (e) { error = e.shortMessage ?? e.message; }
    const side = kind === 'BulletLoanRequest' ? 'request' : 'offer';
    const indexed = opened.filter((l) => l.side === side).length;
    const row = { tool: name, loan: null, path: 'scan', blocks: `${from}-${latest}`, windows, events, indexed, error, seconds: (Date.now() - t0) / 1000 };
    if (error) fail('fallback', `${kind}: the log scan failed after ${windows} window(s): ${error}`);
    else if (events !== indexed && !loans.body?.sample?.loans?.truncated) fail('fallback', `${kind}: the chain's logs hold ${events} LoanOpened event(s), the indexer lists ${indexed}`);
    fallback.push(row);
    log(`  fallback ${name.padEnd(28)} no open loan, so the tool cannot reach the scan; scan run directly: ${windows} windows over blocks ${row.blocks}, ${events} LoanOpened (indexer ${indexed})${error ? `, ERROR ${error}` : ''} (${row.seconds.toFixed(1)} s)`);
  }
  await mem.close();
}
await client.close();

const summary = { endpoint: ENDPOINT, tools: names.size, writes, fallback, findings };
if (asJson) console.log(JSON.stringify(summary, null, 2));
else console.log(findings.length ? findings.map((f) => `[RED] ${f.rule}: ${f.detail}`).join('\n') : `check-v2-live: clean (${names.size} tools; ${writes.filter((w) => w.outcome === 'blueprint').length} blueprints, ${writes.filter((w) => w.outcome === 'refusal').length} refusals with reasons${fallback ? `; fallback: ${fallback.map((f) => (f.path === 'tool' ? `${f.tool} ${f.note ? 'refused before the lookup' : `terms ${f.match ? 'match' : 'differ'}`}` : `${f.windows} windows scanned, ${f.events} LoanOpened`)).join('; ')}` : ''})`);
process.exit(findings.length ? 1 : 0);
