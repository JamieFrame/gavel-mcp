// check-x402-gate.mjs — LG2 Phase 3 step 8, the MCP door: the account gate (X402_REQUIRE_ACCOUNT=gate) and the
// staging switch (LG2-D16), on the build (npm run build first). No network: the API's internal routes
// (/internal/x402-payer, /internal/receipt, /internal/x402-terms) and the facilitator are local stand-ins, and
// the process runs as a staging (STACK_STAGING=on, Base Sepolia) so the facilitator can be one of them.
// The account rules themselves (binding, nonces, smart wallets, versions, the terms sync) are the API's and are
// checked in gavel-indexer test/bcs_*.test.js; here: the MCP asks the API before paying and obeys it.
import assert from 'node:assert';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NET = 'eip155:84532';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const TX = `0x${'ab'.repeat(32)}`;
const BOUND = '0x' + '44'.repeat(20);
const NO_TERMS = '0x' + '55'.repeat(20);
const UNBOUND = '0x' + '66'.repeat(20);
const TERMS = { cgu: { version: '0.2', sha256: 'a'.repeat(64) }, cgv: { version: '0.2', sha256: 'b'.repeat(64) }, licence: { version: '0.2', sha256: 'c'.repeat(64) } };

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

// The API stand-in.
const asked = []; const receipts = [];
const api = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/internal/x402-terms') return res.end(JSON.stringify({ version: 't', tools: {} }));
  if (url.pathname === '/internal/receipt') { receipts.push(JSON.parse(await body(req))); return res.end('{"recorded":true}'); }
  if (url.pathname === '/internal/x402-payer') {
    const p = url.searchParams.get('payer'); asked.push(p);
    if (p === BOUND) return res.end(JSON.stringify({ decision: 'ok', account_id: '11111111-2222-4333-8444-555555555555', terms_in_force: TERMS }));
    if (p === NO_TERMS) return res.end(JSON.stringify({ decision: 'terms_acceptance_required', account_id: 'x', terms: [{ document: 'cgu', version: '1.0' }] }));
    return res.end(JSON.stringify({ decision: 'account_required', why: 'not_bound' }));
  }
  res.statusCode = 404; res.end('{}');
});
// The facilitator stand-in: verifies and settles everything, records each call.
const fac = [];
const facilitator = http.createServer(async (req, res) => {
  const b = await body(req); fac.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  const payer = (() => { try { return JSON.parse(b).paymentPayload.payload.authorization.from; } catch { return undefined; } })();
  if (req.url.startsWith('/supported')) return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }));
  if (req.url.startsWith('/verify')) return res.end(JSON.stringify({ isValid: true, payer }));
  if (req.url.startsWith('/settle')) return res.end(JSON.stringify({ success: true, transaction: TX, network: NET, payer }));
  res.statusCode = 404; res.end('{}');
});
const apiPort = await listen(api); const facPort = await listen(facilitator);
const dir = mkdtempSync(join(tmpdir(), 'x402gate-'));
const priceList = join(dir, 'price-list.json');
writeFileSync(priceList, JSON.stringify({ version: 'test.1', classes: { snapshot: { price: 0.01 }, history: { price: 0.02 } }, as_known_on_multiplier: 2, allowance_per_day: 2,
  x402: { network: 'eip155:8453', asset_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', pay_to: '0xbDEfBd78DE0314A881BC6A3EB59d2d6f1E043633', legal_url: 'https://www.bitcoincreditstack.com/legal', description: 'test' } }));

Object.assign(process.env, { X402_MODE: 'on', X402_REQUIRE_ACCOUNT: 'gate', X402_PRICE_LIST: priceList, GAVEL_API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, INTERNAL_API_SECRET: 's',
  STACK_STAGING: 'on', X402_NETWORK: NET, X402_ASSET_ADDRESS: USDC, X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: `http://127.0.0.1:${facPort}`, LOG_LEVEL: 'silent', NODE_ENV: 'production' });
const x = await import('../dist/x402.js');
for (let t = Date.now(); !fac.some((u) => u.startsWith('/supported')); ) { if (Date.now() - t > 5000) throw new Error('facilitator never asked'); await new Promise((r) => setTimeout(r, 20)); }
await new Promise((r) => setTimeout(r, 100));

const answer = { content: [{ type: 'text', text: JSON.stringify({ licence: { status: 'own' } }) }] };
const run = async () => JSON.parse(JSON.stringify(answer));
const call = (extra = {}) => x.x402Call('get_venue', 'snapshot', {}, extra, run);
const parse = (r) => JSON.parse(r.content[0].text);
const money = () => fac.filter((u) => /^\/(verify|settle)/.test(u));

// The free allowance (2 a day in this list) is unaffected, and a payment sent within it is not taken.
assert.strictEqual((await call()).isError, undefined, 'allowance call 1 free');
assert.strictEqual((await call({ _meta: { 'x402/payment': { x402Version: 2, payload: { authorization: { from: UNBOUND } } } } })).isError, undefined, 'allowance call 2 free, payment ignored');
assert.deepStrictEqual(money(), []);

// No payment: the offer, with the account page.
const offer = await call();
assert.strictEqual(offer.isError, true);
assert.ok(Array.isArray(offer.structuredContent.accepts), 'a PaymentRequired offer');
assert.strictEqual(offer.structuredContent.account_url, 'https://www.bitcoincreditstack.com/account');
assert.strictEqual(offer.structuredContent.accepts[0].network, NET, 'the staging network');
assert.strictEqual(offer.structuredContent.accepts[0].payTo, PAY_TO, 'the staging pay_to');
const pay = (from) => ({ _meta: { 'x402/payment': { x402Version: 2, resource: offer.structuredContent.resource, accepted: offer.structuredContent.accepts[0],
  payload: { signature: `0x${'11'.repeat(65)}`, authorization: { from, to: PAY_TO, value: offer.structuredContent.accepts[0].amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: `0x${'33'.repeat(32)}` } } } } });

// Unbound wallet: account_required, no settlement.
const unbound = await call(pay(UNBOUND));
assert.strictEqual(unbound.isError, true);
assert.strictEqual(unbound.structuredContent, undefined, 'no offer');
assert.strictEqual(parse(unbound).error.code, 'account_required');
assert.strictEqual(parse(unbound).error.account_url, 'https://www.bitcoincreditstack.com/account');
// Bound without the current acceptance: terms_acceptance_required, with the versions.
const noTerms = await call(pay(NO_TERMS));
assert.strictEqual(parse(noTerms).error.code, 'terms_acceptance_required');
assert.deepStrictEqual(parse(noTerms).error.terms, [{ document: 'cgu', version: '1.0' }]);
assert.deepStrictEqual(money(), [], 'zero verify / settle calls for the refused payers');

// Bound and accepted: the paid answer, and one receipt naming the account, the cost class and the terms.
const paid = await call(pay(BOUND));
assert.strictEqual(paid.isError, undefined, JSON.stringify(paid));
assert.strictEqual(paid._meta['x402/payment-response'].transaction, TX);
assert.deepStrictEqual(money().map((u) => u.split('?')[0]), ['/verify', '/settle']);
await new Promise((r) => setTimeout(r, 100));
assert.strictEqual(receipts.length, 1, 'one receipt');
assert.deepStrictEqual({ ...receipts[0] }, { item: 'get_venue', network: NET, asset: USDC, pay_to: PAY_TO, payer: BOUND, amount_units: '10000', units: 1, price_list_version: 'test.1',
  transaction: TX, test: false, account_id: '11111111-2222-4333-8444-555555555555', cost_class: 'snapshot', terms_in_force: TERMS });
assert.deepStrictEqual(asked.filter((p) => p === BOUND).length >= 2, true, 'asked before paying and again in the library\'s hooks');

// Pure functions.
assert.strictEqual(x.accountMode({}), 'closed', 'the default stays closed');
assert.strictEqual(x.accountMode({ X402_REQUIRE_ACCOUNT: ' Gate ' }), 'gate');
assert.strictEqual(x.accountMode({ X402_REQUIRE_ACCOUNT: 'off' }), 'open');
assert.strictEqual(x.payerOf({ payload: { permit2Authorization: { from: BOUND.toUpperCase().replace('0X', '0x') } } }), BOUND);
assert.strictEqual(x.payerOf({ payload: {} }), null);

// The staging switch: a process not marked staging that carries an override refuses to start; mainnet is refused in staging.
assert.throws(() => x.x402Settings({}, { X402_NETWORK: NET }), /not marked staging/);
assert.throws(() => x.x402Settings({}, { STACK_STAGING: 'on', X402_NETWORK: 'eip155:8453', X402_ASSET_ADDRESS: USDC, X402_PAY_TO: PAY_TO }), /testnet/);
assert.throws(() => x.x402Settings({ pay_to: PAY_TO }, { STACK_STAGING: 'on', X402_NETWORK: NET, X402_ASSET_ADDRESS: USDC, X402_PAY_TO: PAY_TO }), /production's pay_to/);
const dist = fileURLToPath(new URL('../dist/x402.js', import.meta.url));
const child = spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file:///' + dist.replace(/\\/g, '/'))}).then(() => console.log('STARTED'))`],
  { env: { PATH: process.env.PATH, X402_MODE: 'on', X402_NETWORK: NET, LOG_LEVEL: 'silent', NODE_ENV: 'production' }, encoding: 'utf8' });
assert.notStrictEqual(child.status, 0, 'a production process with an override does not start');
assert.ok(!/STARTED/.test(child.stdout) && /not marked staging/.test(child.stderr), child.stderr);

api.close(); facilitator.close();
console.log('check-x402-gate (mcp): ok');
process.exit(0);
