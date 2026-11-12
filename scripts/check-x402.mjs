// check-x402.mjs — MN1 Phase 3, the MCP door: only sellable units are priced; a facilitator's
// words never reach the caller. Pure functions on the build (npm run build first). No network.
import assert from 'node:assert';
const { priceUsd, sellableUnits, scrubResult, requiresAccount, pastAllowance, accountRequiredResult } = await import('../dist/x402.js');
const PL = { classes: { snapshot: { price: 0.01 }, history: { price: 0.02 } }, as_known_on_multiplier: 2, allowance_per_day: 100 };
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });

assert.strictEqual(priceUsd('history', {}, 2, PL), 0.04);
assert.strictEqual(priceUsd('snapshot', { as_known_on: '2026-10-01' }, 1, PL), 0.02);
assert.strictEqual(priceUsd('snapshot', { as_known_on: 'yes' }, 1, PL), 0.01, 'as_known_on must name a date');

const series = (...st) => text({ series: st.map((s, i) => ({ id: `s${i}`, licence: { status: s } })) });
assert.strictEqual(sellableUnits('history', series('own', 'attributed', 'free_attributed_only')), 2, 'two of three sellable');
assert.strictEqual(sellableUnits('history', series('free_attributed_only', 'unknown_terms')), 0, 'none sellable: free');
assert.strictEqual(sellableUnits('snapshot', text({ licence: { status: 'own' } })), 1);
assert.strictEqual(sellableUnits('snapshot', text({ venues: [] })), 0, 'no licence carried: not sellable (strict)');
assert.strictEqual(sellableUnits('snapshot', text({ instruments: [] }), 'get_corporate_instruments', { get_corporate_instruments: true }), 1, 'no licence block, but the tool rests on sellable sources');
assert.strictEqual(sellableUnits('snapshot', text({ venues: [] }), 'compare_venues', { compare_venues: false }), 0, 'the tool rests on unsellable sources');
assert.strictEqual(sellableUnits('snapshot', { ...text({ licence: { status: 'own' } }), isError: true }), 0, 'an error is never priced');

const r = scrubResult({ structuredContent: { x402Version: 2, error: 'Facilitator verify failed (500): cdp text', accepts: [] }, content: [{ type: 'text', text: '' }],
  _meta: { 'x402/payment-response': { success: false, errorReason: 'Facilitator settle failed: x', errorMessage: 'y' } } });
assert.strictEqual(r.structuredContent.error, 'payment_not_accepted');
assert.ok(!/cdp text/.test(r.content[0].text));
assert.deepStrictEqual(r._meta['x402/payment-response'], { success: false, errorReason: 'settlement_failed' });
assert.strictEqual(scrubResult({ structuredContent: { error: 'insufficient_funds' }, content: [{ type: 'text', text: '' }] }).structuredContent.error, 'insufficient_funds');

// LG2 Phase 2 (O-1): X402_REQUIRE_ACCOUNT, on unless 'off'. While on, a call past the allowance is
// account_required whatever the facilitator's state: the payment path ('pay', the only one that calls
// @x402/mcp and so the facilitator's verify and settle) is never taken, and no payment is offered.
assert.strictEqual(requiresAccount({}), true, 'on by default');
assert.strictEqual(requiresAccount({ X402_REQUIRE_ACCOUNT: 'on' }), true);
assert.strictEqual(requiresAccount({ X402_REQUIRE_ACCOUNT: ' Off ' }), false, 'off restores the open settlement');
assert.strictEqual(pastAllowance({ requireAccount: true, ready: true }), 'account_required');
assert.strictEqual(pastAllowance({ requireAccount: true, ready: false }), 'account_required');
assert.strictEqual(pastAllowance({ requireAccount: false, ready: true }), 'pay');
assert.strictEqual(pastAllowance({ requireAccount: false, ready: false }), 'unavailable');
const acc = accountRequiredResult({ ...PL, x402: { legal_url: 'https://www.bitcoincreditstack.com/legal',
  account_required_message: 'The free allowance of {allowance} priced calls today is used. Details: {legal_url}.' } });
assert.strictEqual(acc.isError, true);
assert.strictEqual(acc.structuredContent, undefined, 'no PaymentRequired: no payment is offered');
assert.strictEqual(acc._meta, undefined);
const accBody = JSON.parse(acc.content[0].text);
assert.deepStrictEqual(accBody, { error: { code: 'account_required', message: 'The free allowance of 100 priced calls today is used. Details: https://www.bitcoincreditstack.com/legal.', retryable: false } });
const accDefault = JSON.parse(accountRequiredResult(null).content[0].text);
assert.strictEqual(accDefault.error.code, 'account_required');
assert.match(accDefault.error.message, /identified professional accounts/);
console.log('check-x402 (mcp): ok');
