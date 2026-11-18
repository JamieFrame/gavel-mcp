#!/usr/bin/env node
/**
 * check-v2-writes — VZ10 row M1, G3: each wave-1 write tool proven on an anvil fork (G1 §3.5).
 *
 *   npm run build && node scripts/check-v2-writes.mjs [--upstream <Arbitrum Sepolia RPC>] [--port 8547] [--json]
 *
 * It starts its own anvil fork of Arbitrum Sepolia, points the tools' chain reads at it, and calls
 * every tool through the in-memory gavel-testnet server. Each blueprint — prerequisites first — is
 * then signed INSIDE THIS SCRIPT ONLY by one of anvil's public test accounts and sent TO THE FORK.
 * The test asserts the state change the blueprint's summary states, and that the hard errors refuse.
 *
 * Nothing is ever sent to Sepolia: the only signing transport is the local fork, and the script
 * refuses to run if the tools' RPC is anything other than that fork. The upstream URL is never printed.
 * Exit 0 clean, 1 on any finding.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const UPSTREAM = opt('--upstream', process.env.V2_FORK_UPSTREAM || 'https://sepolia-rollup.arbitrum.io/rpc');
const PORT = Number(opt('--port', '8547'));
const FORK = `http://127.0.0.1:${PORT}`;
const asJson = args.includes('--json');

// The tools read the fork, and nothing else: set before the server's modules load.
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.MCP_PROFILE = 'gavel-testnet';
process.env.ARBITRUM_SEPOLIA_RPC_URL = FORK;
delete process.env.GAVEL_API_TESTNET_BASE_URL; // loan terms come from the fork's own logs
delete process.env.GAVEL_TESTNET_SIGN_URL;

const findings = [];
const results = [];
const fail = (rule, detail) => { findings.push({ rule, detail }); };
const log = (...m) => { if (!asJson) console.log(...m); };

// ── anvil ──
const anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--silent', '--chain-id', '421614'], { stdio: 'ignore' });
const stop = () => { try { anvil.kill(); } catch { /* gone */ } };
process.on('exit', stop);

const viem = await import('viem');
const { arbitrumSepolia } = await import('viem/chains');
const { privateKeyToAccount } = await import('viem/accounts');
const transport = viem.http(FORK, { timeout: 60_000 });
const pub = viem.createPublicClient({ chain: arbitrumSepolia, transport });
for (let i = 0; ; i++) {
  try { await pub.getChainId(); break; } catch { if (i > 120) { console.error('anvil did not start'); process.exit(1); } await new Promise((r) => setTimeout(r, 500)); }
}
if ((await pub.getChainId()) !== 421614) { console.error('the fork is not Arbitrum Sepolia'); stop(); process.exit(1); }
const forkBlock = await pub.getBlockNumber();

// Anvil's public, well-known test accounts (funded with ether on the fork only).
const KEYS = {
  borrower: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  lender: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  trader: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdfc365a', // funded below with anvil_setBalance
};
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, pk]) => [k, privateKeyToAccount(pk)]));
const wallet = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, viem.createWalletClient({ account: a, chain: arbitrumSepolia, transport })]));
const A = Object.fromEntries(Object.entries(acct).map(([k, a]) => [k, a.address]));
// Ether for gas, on the fork only.
for (const a of Object.values(A)) await pub.request({ method: 'anvil_setBalance', params: [a, '0x56BC75E2D63100000'] });

// ── the server, in memory ──
const { PROFILES } = await import('../dist/profiles.js');
const { buildServer } = await import('../dist/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { requestContext } = await import('../dist/context.js');
const { testnetClient } = await import('../dist/rpc.js');
const { V2_DEPLOYMENT } = await import('../dist/v2/deployment.generated.js');
const ABI = await import('../dist/v2/abi.generated.js');
const { REGULATORY_NOTICE } = await import('../dist/factory/envelope.js');
// Guard: the tools' chain client must be the fork.
if (!String(testnetClient.transport.url ?? '').startsWith('http://127.0.0.1')) { console.error('refusing: the tools are not reading the local fork'); stop(); process.exit(1); }

const server = buildServer(PROFILES['gavel-testnet']);
const [ta, tb] = InMemoryTransport.createLinkedPair();
await server.connect(ta);
const client = new Client({ name: 'check-v2-writes', version: '1' });
await client.connect(tb);
const ctx = { tier: 'free', ip: '127.0.0.1', bearerToken: null, requestId: 'check-v2-writes' };
const tool = async (name, a) => {
  const r = await requestContext.run(ctx, () => client.callTool({ name, arguments: a }));
  const text = r.content?.[0]?.text ?? '';
  let j = null; try { j = JSON.parse(text); } catch { /* text */ }
  return r.isError ? { error: j?.error?.message ?? text } : j;
};

// ── signing on the fork ──
async function send(who, tx) {
  const hash = await wallet[who].sendTransaction({ to: tx.to, data: tx.data, value: 0n, ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`reverted on the fork: ${hash}`);
  return rc;
}
/** Sign every prerequisite, then the transaction; return the main receipt. */
async function execute(who, env) {
  for (const p of env.prerequisites) await send(who, p.transaction);
  return send(who, env.transaction);
}

const abi = (n) => ABI[`${n}_ABI`];
const C = (name) => viem.getAddress(V2_DEPLOYMENT.contracts.find((c) => c.name === name && !c.superseded).address);
const TOK = (s) => V2_DEPLOYMENT.tokens.find((t) => t.symbol === s);
const key = (t) => `0x01${'00'.repeat(11)}${t.address.slice(2).toLowerCase()}`;
const read = (address, a, functionName, args = []) => pub.readContract({ address, abi: a, functionName, args });
const vaultFree = (who, t) => read(C('Vault'), abi('Vault'), 'balance', [who, key(t)]);
const bal = (t, who) => read(t.address, abi('MockERC20'), 'balanceOf', [who]);
const warp = async (secs) => { await pub.request({ method: 'evm_increaseTime', params: [secs] }); await pub.request({ method: 'evm_mine', params: [] }); };
const eventArg = (rc, contractAbi, name, field) => {
  for (const l of rc.logs) { try { const d = viem.decodeEventLog({ abi: contractAbi, data: l.data, topics: l.topics }); if (d.eventName === name) return d.args[field]; } catch { /* other */ } }
  return undefined;
};

/** Run one step: a proof (the tool answers, the blueprint lands, the assertion holds) or a refusal. */
async function prove(id, name, who, a, check) {
  const env = await tool(name, a);
  if (env.error) { fail('tool_refused', `${id} ${name}: ${env.error}`); results.push({ id, name, ok: false }); return null; }
  if (env.disclosure !== REGULATORY_NOTICE) fail('disclosure', `${id}: the envelope does not carry the regulatory notice verbatim`);
  if (env.transaction?.chain_id !== 421614 || env.transaction?.value !== '0') fail('envelope', `${id}: chain or value wrong`);
  let rc;
  try { rc = await execute(who, env); } catch (e) { fail('reverted', `${id} ${name}: ${e.message}`); results.push({ id, name, ok: false }); return null; }
  let ok = true;
  try { const r = await check(rc, env); if (r === false) ok = false; } catch (e) { ok = false; fail('assertion', `${id} ${name}: ${e.message}`); }
  if (!ok && !findings.some((f) => f.detail.startsWith(`${id} `))) fail('assertion', `${id} ${name}: state after the send is not what the summary states`);
  results.push({ id, name, ok, prerequisites: env.prerequisites.map((p) => p.type) });
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(5)} ${name.padEnd(32)} prereqs=[${env.prerequisites.map((p) => p.type).join(',')}]`);
  return { rc, env };
}
async function refuses(id, name, a, re) {
  const env = await tool(name, a);
  const ok = !!env.error && re.test(env.error);
  if (!ok) fail('hard_error', `${id} ${name}: expected ${re}, got ${env.error ?? 'a blueprint'}`);
  results.push({ id, name, ok, refusal: true });
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${id.padEnd(5)} ${name.padEnd(32)} refuses ${re}`);
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} ≠ ${b}`); return true; };

log(`fork of Arbitrum Sepolia at block ${forkBlock} (local, port ${PORT})`);
const WBTC = TOK('mWBTC'), USDC = TOK('mUSDC');
const u = (n) => BigInt(Math.round(n * 1e6));   // mUSDC raw
const w = (n) => BigInt(Math.round(n * 1e8));   // mWBTC raw

// ── W1 mint ──
for (const [who, t, amt] of [['borrower', WBTC, '1'], ['lender', USDC, '50000'], ['trader', WBTC, '1'], ['trader', USDC, '50000'], ['borrower', USDC, '5000']]) {
  const before = await bal(t, A[who]);
  await prove('W1', 'prepare_test_token_mint', who, { token: t.symbol, to: A[who], amount: amt }, async () => eq(await bal(t, A[who]) - before, viem.parseUnits(amt, t.decimals), 'minted'));
}
await refuses('W1x', 'prepare_test_token_mint', { token: 'WETH', to: A.borrower, amount: '1' }, /not one of this deployment's test tokens/);

// ── W2 deposit, W3 withdraw, W4 product approval ──
let f0 = await vaultFree(A.lender, USDC);
await prove('W2', 'prepare_vault_deposit', 'lender', { account: A.lender, token: 'mUSDC', amount: '20000' }, async () => eq(await vaultFree(A.lender, USDC) - f0, u(20000), 'vault free'));
await refuses('W2x', 'prepare_vault_deposit', { account: A.lender, token: 'mUSDC', amount: '999999999' }, /ERC20InsufficientBalance/);
f0 = await vaultFree(A.lender, USDC);
const w0 = await bal(USDC, A.lender);
await prove('W3', 'prepare_vault_withdraw', 'lender', { account: A.lender, token: 'mUSDC', amount: '1000' }, async () =>
  eq(f0 - await vaultFree(A.lender, USDC), u(1000), 'vault free') && eq(await bal(USDC, A.lender) - w0, u(1000), 'wallet'));
await refuses('W3x', 'prepare_vault_withdraw', { account: A.lender, token: 'mUSDC', amount: '99999999' }, /Vault\.InsufficientBalance/);
await refuses('W3y', 'prepare_vault_withdraw', { account: A.lender, token: 'mUSDC', amount: '1', destination: C('Vault') }, /InvalidAddress/);
await prove('W4', 'prepare_vault_product_approval', 'lender', { account: A.lender, product: 'BulletLoanRequest', approved: true }, async () =>
  eq(await read(C('Vault'), abi('Vault'), 'isUserApproved', [A.lender, C('BulletLoanRequest')]), true, 'approved'));
await refuses('W4x', 'prepare_vault_product_approval', { account: A.lender, product: 'NotAProduct', approved: true }, /not a V2 product/);

// ── W5 spot order, W6 cancel ──
const pair = V2_DEPLOYMENT.spot.pairs.find((p) => p.name === 'mWBTC/mUSDC');
let orderId;
{
  const before = await vaultFree(A.trader, WBTC);
  const r = await prove('W5', 'prepare_spot_order', 'trader', { account: A.trader, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000000' }, async (rc) => {
    orderId = eventArg(rc, abi('BatchAuction'), 'OrderPlaced', 'orderId');
    const o = await read(viem.getAddress(pair.spotMarket), abi('SpotMarket'), 'getOrder', [orderId]);
    return eq(viem.getAddress(o.owner), A.trader, 'order owner') && eq(await vaultFree(A.trader, WBTC), before, 'deposit then reserve nets to zero free');
  });
  if (r && !r.env.prerequisites.some((p) => p.type === 'vault_deposit')) fail('prerequisite', 'W5: no vault_deposit emitted for an empty Vault');
}
await refuses('W5x', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'sell', amount: '0.00000001', limit_price: '1000000' }, /OrderBelowMinSize/);
await refuses('W5y', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'sell', amount: '0.01', limit_price: '0' }, /InvalidPrice/);
await refuses('W5z', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000', expires_at_slot: 1 }, /ExpiresAtNotInFuture/);
await refuses('W5w', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'buy', amount: '0.001', limit_price: '0.01' }, /OrderBelowMinQuote/);
if (orderId !== undefined) {
  await prove('W6', 'prepare_spot_cancel', 'trader', { account: A.trader, market: pair.name, order_id: String(orderId) }, async () => {
    const o = await read(viem.getAddress(pair.spotMarket), abi('SpotMarket'), 'getOrder', [orderId]);
    const rec = await read(viem.getAddress(pair.spotMarket), abi('SpotMarket'), 'getOrderRecord', [orderId]);
    if (o.status !== 4 && !rec[2]) throw new Error(`order status ${o.status}, released ${rec[2]}: neither queued nor released`);
    return true;
  });
  await refuses('W6x', 'prepare_spot_cancel', { account: A.lender, market: pair.name, order_id: String(orderId) }, /NotOrderOwner/);
  await refuses('W6y', 'prepare_spot_cancel', { account: A.trader, market: pair.name, order_id: '999999999999' }, /OrderNotFound/);
}

// ── W7 request (one), W8 bid, W13 finalise; then W14 pay, W16 release, W17 claim, W18 collect, W19 redeem ──
const REQ = C('BulletLoanRequest'), OFF = C('BulletLoanOffer');
let reqLoan, origin;
{
  const lock0 = await bal(WBTC, A.borrower);
  const r = await prove('W7', 'prepare_bullet_request_open', 'borrower', {
    account: A.borrower, loan_token: 'mUSDC', amount: '1000', max_repayment: '1100', term_days: 7, auction_hours: 24,
    collateral: [{ token: 'mWBTC', amount: '0.1' }], mode: 'one', bid_step: '10',
  }, async (rc) => {
    reqLoan = eventArg(rc, abi('BulletLoanRequest'), 'LoanOpened', 'loanId');
    const [, , state] = await read(REQ, abi('BulletLoanRequest'), 'loanOf', [reqLoan]);
    return eq(state, 1, 'loan OPEN') && eq(lock0 - await bal(WBTC, A.borrower), w(0.1), 'collateral pulled from the wallet');
  });
  if (r && !r.env.prerequisites.some((p) => p.type === 'erc20_approval')) fail('prerequisite', 'W7: no exact approval for the wallet-pulled leg');
}
await refuses('W7x', 'prepare_bullet_request_open', {
  account: A.borrower, loan_token: 'mUSDC', amount: '1000', max_repayment: '900', term_days: 7, auction_hours: 24, collateral: [{ token: 'mWBTC', amount: '0.1' }], mode: 'one', bid_step: '10',
}, /InvalidTerms\(2\)/);
{
  const base = { account: A.borrower, loan_token: 'mUSDC', amount: '1000', max_repayment: '1100', term_days: 7, auction_hours: 24, collateral: [{ token: 'mWBTC', amount: '0.1' }], mode: 'one', bid_step: '10' };
  await refuses('W7y', 'prepare_bullet_request_open', { ...base, term_days: 3 }, /InvalidTerms\(10\)/);
  await refuses('W7z', 'prepare_bullet_request_open', { ...base, auction_hours: 2 }, /InvalidTerms\(11\)/);
  await refuses('W7w', 'prepare_bullet_request_open', { ...base, bid_step: '500' }, /InvalidTerms\(5\)/);
  const { bid_step, ...manyBase } = base; void bid_step;
  await refuses('W7v', 'prepare_bullet_request_open', { ...manyBase, mode: 'many', min_amount: '2000' }, /InvalidTerms\(6\)/);
}
if (reqLoan !== undefined) {
  const free0 = await vaultFree(A.lender, USDC);
  await prove('W8', 'prepare_bullet_request_bid', 'lender', { account: A.lender, loan_id: String(reqLoan), repayment: '1050' }, async () =>
    eq(free0 - await vaultFree(A.lender, USDC), u(1000), 'principal reserved'));
  await refuses('W8x', 'prepare_bullet_request_bid', { account: A.lender, loan_id: String(reqLoan), repayment: '1200' }, /InvalidTerms\(21\)/);
  await refuses('W8y', 'prepare_bullet_request_bid', { account: A.borrower, loan_id: String(reqLoan), repayment: '1040' }, /PrincipalCannotBid/);
  await refuses('W8z', 'prepare_bullet_request_bid', { account: A.trader, loan_id: String(reqLoan), repayment: '1045' }, /StepNotMet/);
  await refuses('W8w', 'prepare_bullet_request_bid', { account: A.trader, loan_id: String(reqLoan), repayment: '900' }, /InvalidTerms\(20\)/);
  await refuses('W13x', 'prepare_bullet_finalise', { account: A.trader, product: 'request', loan_id: String(reqLoan) }, /AuctionNotEnded/);
  await warp(24 * 3600 + 60);
  await prove('W13', 'prepare_bullet_finalise', 'trader', { account: A.trader, product: 'request', loan_id: String(reqLoan) }, async () => {
    const [, , state] = await read(REQ, abi('BulletLoanRequest'), 'loanOf', [reqLoan]);
    const [setId, obligationId, principal, repayment, , lienId] = await read(REQ, abi('BulletLoanRequest'), 'originationOf', [reqLoan]);
    origin = { setId, obligationId, lienId, principal, repayment };
    return eq(state, 3, 'loan ORIGINATED') && eq(principal, u(1000), 'principal') && eq(repayment, u(1050), 'repayment')
      && eq(await vaultFree(A.borrower, USDC), u(1000), 'principal in the borrower\'s free Vault balance');
  });
}
if (reqLoan !== undefined) await refuses('W8v', 'prepare_bullet_request_bid', { account: A.trader, loan_id: String(reqLoan), repayment: '1000' }, /WrongState/);
if (origin) {
  const O = C('Obligation'), L = C('Lien');
  await refuses('W16x', 'prepare_lien_release', { account: A.trader, lien_id: String(origin.lienId) }, /SetNotDischarged/);
  await refuses('W15x', 'prepare_lien_payoff', { account: A.borrower, lien_id: String(origin.lienId), source: 'wallet' }, /SetNotBreached/);
  await refuses('W19x', 'prepare_obligation_redeem', { account: A.lender, obligation_id: String(origin.obligationId) }, /NotFinal/);
  await refuses('W14x', 'prepare_obligation_pay', { account: A.borrower, obligation_id: '999999999', source: 'vault' }, /InvalidStatus/);
  // The borrower repays 1050 from the Vault: 1000 principal is there; deposit the rest first.
  const d0 = await vaultFree(A.borrower, USDC);
  await prove('W2b', 'prepare_vault_deposit', 'borrower', { account: A.borrower, token: 'mUSDC', amount: '50' }, async () => eq(await vaultFree(A.borrower, USDC) - d0, u(50), 'vault free'));
  await prove('W14', 'prepare_obligation_pay', 'borrower', { account: A.borrower, obligation_id: String(origin.obligationId), source: 'vault' }, async () => {
    const o = await read(O, abi('Obligation'), 'getObligation', [origin.obligationId]);
    return eq(o.status, 1, 'obligation DISCHARGED');
  });
  await prove('W16', 'prepare_lien_release', 'trader', { account: A.trader, lien_id: String(origin.lienId) }, async () =>
    eq((await read(L, abi('Lien'), 'getLien', [origin.lienId]))[4], 1, 'lien RELEASED'));
  await refuses('W17x', 'prepare_lien_claim', { account: A.trader, lien_id: String(origin.lienId) }, /NotPositionOwner/);
  const c0 = await vaultFree(A.borrower, WBTC);
  await prove('W17', 'prepare_lien_claim', 'borrower', { account: A.borrower, lien_id: String(origin.lienId) }, async () =>
    eq(await vaultFree(A.borrower, WBTC) - c0, w(0.1), 'collateral back in the free Vault balance'));
  const l0 = await bal(USDC, A.lender);
  await prove('W18', 'prepare_obligation_collect', 'lender', { account: A.lender, obligation_id: String(origin.obligationId) }, async () =>
    eq(await bal(USDC, A.lender) - l0, u(1050), 'repayment collected to the wallet'));
  await refuses('W18x', 'prepare_obligation_collect', { account: A.lender, obligation_id: String(origin.obligationId) }, /InvalidAmount/);
  await refuses('W18y', 'prepare_obligation_collect', { account: A.lender, obligation_id: String(origin.obligationId), destination: C('Obligation') }, /InvalidAddress/);
  await prove('W19', 'prepare_obligation_redeem', 'lender', { account: A.lender, obligation_id: String(origin.obligationId) }, async () =>
    eq(await read(O, abi('Obligation'), 'balanceOf', [A.lender, origin.obligationId]), 0n, 'claim units burned'));
  await refuses('W19y', 'prepare_obligation_redeem', { account: A.borrower, obligation_id: String(origin.obligationId) }, /InvalidUnits/);
}

// ── W9 offer (one), W10 bid, W11 cancel, W12 release; W15 lien payoff after a breach ──
const offerArgs = (principal) => ({
  account: A.lender, loan_token: 'mUSDC', principal, min_loan: principal, max_loan: principal, collateral_token: 'mWBTC',
  loan_per_collateral: '50000', floor_rate: '1.01', term_days: 7, auction_hours: 24, mode: 'one',
});
const openOffer = async (id, principal) => {
  let loanId;
  const free0 = await vaultFree(A.lender, USDC);
  await prove(id, 'prepare_bullet_offer_open', 'lender', offerArgs(principal), async (rc) => {
    loanId = eventArg(rc, abi('BulletLoanOffer'), 'LoanOpened', 'loanId');
    return eq(free0 - await vaultFree(A.lender, USDC), viem.parseUnits(principal, 6), 'principal reserved');
  });
  return loanId;
};
await refuses('W9x', 'prepare_bullet_offer_open', { ...offerArgs('500'), floor_rate: '0.9' }, /InvalidTerms\(5\)/);
await refuses('W9y', 'prepare_bullet_offer_open', { ...offerArgs('500'), min_loan: '600' }, /InvalidTerms\(2\)/);
await refuses('W9z', 'prepare_bullet_offer_open', { ...offerArgs('500'), max_loan: '400', min_loan: '100' }, /InvalidTerms\(3\)/);
await refuses('W9w', 'prepare_bullet_offer_open', { ...offerArgs('500'), loan_per_collateral: '0' }, /InvalidTerms\(4\)/);
await refuses('W9v', 'prepare_bullet_offer_open', { ...offerArgs('500'), ceiling_rate: '1.001' }, /InvalidTerms\(6\)/);
await refuses('W9u', 'prepare_bullet_offer_open', { ...offerArgs('500'), mode: 'many' }, /InvalidTerms\(7\)/);
await refuses('W9t', 'prepare_bullet_offer_open', { ...offerArgs('500'), term_days: 3 }, /InvalidTerms\(10\)/);
await refuses('W9s', 'prepare_bullet_offer_open', { ...offerArgs('500'), auction_hours: 200 }, /InvalidTerms\(11\)/);
// W11: open and cancel before any bid.
const cancelled = await openOffer('W9', '500');
if (cancelled !== undefined) {
  const free0 = await vaultFree(A.lender, USDC);
  await prove('W11', 'prepare_bullet_cancel', 'lender', { account: A.lender, product: 'offer', loan_id: String(cancelled) }, async () =>
    eq((await read(OFF, abi('BulletLoanOffer'), 'loanOf', [cancelled]))[2], 4, 'loan ENDED') && eq(await vaultFree(A.lender, USDC) - free0, u(500), 'principal released'));
  await refuses('W11x', 'prepare_bullet_cancel', { account: A.lender, product: 'offer', loan_id: String(cancelled) }, /WrongState/);
  await refuses('W13z', 'prepare_bullet_finalise', { account: A.trader, product: 'offer', loan_id: String(cancelled) }, /WrongState/);
}
// W10 then W12: a bid, the auction left to stall past its deadline, the won entry released.
const stalled = await openOffer('W9b', '500');
if (stalled !== undefined) await refuses('W11y', 'prepare_bullet_cancel', { account: A.borrower, product: 'offer', loan_id: String(stalled) }, /NotApprovedOperator/);
if (stalled !== undefined) {
  let entry;
  const c0 = await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC);
  await prove('W10', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(stalled), loan_size: '500', repayment: '510' }, async (rc) => {
    entry = eventArg(rc, abi('BulletLoanOffer'), 'EntryRecorded', 'entryId');
    return eq(c0 - (await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC)), w(0.01), 'collateral locked (500 ÷ 50,000)');
  });
  await refuses('W10x', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(stalled), loan_size: '500', repayment: '500' }, /InvalidTerms\(30\)/);
  await refuses('W10y', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(stalled), loan_size: '400', repayment: '450' }, /QuantityOutOfRange/);
  await refuses('W10z', 'prepare_bullet_offer_bid', { account: A.trader, loan_id: String(stalled), loan_size: '500', repayment: '501' }, /BeyondLimit/);
  await refuses('W10w', 'prepare_bullet_offer_bid', { account: A.trader, loan_id: String(stalled), loan_size: '500', repayment: '510' }, /StepNotMet/);
  await refuses('W10v', 'prepare_bullet_offer_bid', { account: A.lender, loan_id: String(stalled), loan_size: '500', repayment: '520' }, /PrincipalCannotBid/);
  if (entry !== undefined) {
    await refuses('W12x', 'prepare_bullet_entry_release', { account: A.borrower, product: 'offer', entry_id: String(entry) }, /NotReleasable/);
    const [, deadline] = await read(OFF, abi('BulletLoanOffer'), 'deadlineOf', [stalled]);
    const ts = (await pub.getBlock()).timestamp;
    await warp(Number(deadline - ts) + 60);
    await refuses('W13y', 'prepare_bullet_finalise', { account: A.trader, product: 'offer', loan_id: String(stalled) }, /Stalled/);
    await refuses('W11z', 'prepare_bullet_cancel', { account: A.lender, product: 'offer', loan_id: String(stalled) }, /CancelNotAllowed/);
    await refuses('W10u', 'prepare_bullet_offer_bid', { account: A.trader, loan_id: String(stalled), loan_size: '500', repayment: '600' }, /NotLive/);
    const f1 = await vaultFree(A.borrower, WBTC);
    await prove('W12', 'prepare_bullet_entry_release', 'borrower', { account: A.borrower, product: 'offer', entry_id: String(entry) }, async () =>
      eq((await read(OFF, abi('BulletLoanOffer'), 'entryOf', [entry]))[1], 4, 'entry RELEASED') && eq(await vaultFree(A.borrower, WBTC) - f1, w(0.01), 'collateral back in the Vault'));
  }
}
// W15: an offer loan made, left unpaid past due and grace, marked breached (a keeper action), paid off through the Lien.
const breached = await openOffer('W9c', '500');
if (breached !== undefined) {
  await prove('W10b', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(breached), loan_size: '500', repayment: '510' }, async (rc) =>
    eq(eventArg(rc, abi('BulletLoanOffer'), 'EntryRecorded', 'repayment'), u(510), 'entry recorded at the repayment bid'));
  await warp(24 * 3600 + 60);
  let o;
  await prove('W13b', 'prepare_bullet_finalise', 'trader', { account: A.trader, product: 'offer', loan_id: String(breached) }, async () => {
    const [, , state] = await read(OFF, abi('BulletLoanOffer'), 'loanOf', [breached]);
    return eq(state, 3, 'loan ORIGINATED');
  });
  const entryIds = await pub.getContractEvents({ address: OFF, abi: abi('BulletLoanOffer'), eventName: 'LoanOriginated', args: { loanId: breached }, fromBlock: forkBlock });
  const ref = entryIds[0]?.args.ref;
  if (ref !== undefined) {
    const [setId, obligationId, , , dueAt, lienId] = await read(OFF, abi('BulletLoanOffer'), 'originationOf', [ref]);
    o = { setId, obligationId, lienId };
    const ts = (await pub.getBlock()).timestamp;
    await warp(Number(dueAt - ts) + 8 * 24 * 3600);
    // Test-only keeper action: markBreached is not a user tool.
    const mb = viem.parseAbi(['function markBreached(uint256 obligationId)']);
    await send('trader', { to: C('Obligation'), data: viem.encodeFunctionData({ abi: mb, functionName: 'markBreached', args: [obligationId] }) });
    await refuses('W14y', 'prepare_obligation_pay', { account: A.borrower, obligation_id: String(obligationId), source: 'wallet' }, /prepare_lien_payoff/);
    await refuses('W17y', 'prepare_lien_claim', { account: A.borrower, lien_id: String(lienId) }, /InvalidStatus/);
    await refuses('W16y', 'prepare_lien_release', { account: A.trader, lien_id: String(lienId) }, /SetNotDischarged/);
    await refuses('W15y', 'prepare_lien_payoff', { account: A.borrower, lien_id: String(lienId), source: 'wallet', max_amount: '1' }, /PayoffAboveMax/);
    const b0 = await bal(USDC, A.borrower);
    await prove('W15', 'prepare_lien_payoff', 'borrower', { account: A.borrower, lien_id: String(lienId), source: 'wallet' }, async () =>
      eq((await read(C('Lien'), abi('Lien'), 'getLien', [lienId]))[4], 2, 'lien PAID_OFF') && eq(b0 - await bal(USDC, A.borrower), u(510), 'the debt paid from the wallet'));
  } else fail('assertion', 'W13b: no LoanOriginated event for the offer loan');
}

// ── many mode (the GroupAuction path): a shared request and a shared offer, each with a bid ──
{
  let manyReq;
  await prove('W7m', 'prepare_bullet_request_open', 'borrower', {
    account: A.borrower, loan_token: 'mUSDC', amount: '2000', max_repayment: '2200', term_days: 7, auction_hours: 24,
    collateral: [{ token: 'mWBTC', amount: '0.1' }], mode: 'many', min_amount: '1000',
  }, async (rc) => { manyReq = eventArg(rc, abi('BulletLoanRequest'), 'LoanOpened', 'loanId'); return eq((await read(REQ, abi('BulletLoanRequest'), 'loanOf', [manyReq]))[1], 1, 'REQUEST_MANY'); });
  if (manyReq !== undefined) {
    await refuses('W8m-x', 'prepare_bullet_request_bid', { account: A.lender, loan_id: String(manyReq), quantity: '10', repayment: '11' }, /QuantityOutOfRange/);
    await refuses('W8m-y', 'prepare_bullet_request_bid', { account: A.lender, loan_id: String(manyReq), quantity: '800', repayment: '850', min_fill: '900' }, /MinFillOutOfRange/);
    const free0 = await vaultFree(A.lender, USDC);
    await prove('W8m', 'prepare_bullet_request_bid', 'lender', { account: A.lender, loan_id: String(manyReq), quantity: '800', repayment: '850' }, async () =>
      eq(free0 - await vaultFree(A.lender, USDC), u(800), 'quantity reserved'));
  }
  let manyOff;
  await prove('W9m', 'prepare_bullet_offer_open', 'lender', { ...offerArgs('1000'), min_loan: '100', max_loan: '500', mode: 'many', max_fills: 5 },
    async (rc) => { manyOff = eventArg(rc, abi('BulletLoanOffer'), 'LoanOpened', 'loanId'); return eq((await read(OFF, abi('BulletLoanOffer'), 'loanOf', [manyOff]))[1], 3, 'OFFER_MANY'); });
  if (manyOff !== undefined) {
    const c0 = await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC);
    await prove('W10m', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(manyOff), loan_size: '200', repayment: '205' }, async () =>
      eq(c0 - (await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC)), w(0.004), 'collateral locked (200 ÷ 50,000)'));
  }
}

// ── coverage: every coded refusal reachable on a fork, and the success paths not proven above ──
{
  // An account with ether for gas and no tokens: the shortfall refusals.
  const { generatePrivateKey } = await import('viem/accounts');
  const emptyAcct = privateKeyToAccount(generatePrivateKey());
  const E = emptyAcct.address;
  await pub.request({ method: 'anvil_setBalance', params: [E, '0x56BC75E2D63100000'] });
  // Owner actions on the fork only (pause, de-authorise): impersonate the contract's owner.
  const OWN = viem.parseAbi(['function owner() view returns (address)', 'function pause()', 'function unpause()', 'function setAuthorisedConsumer(address consumer, bool authorised)']);
  const asOwner = async (target, functionName, args = []) => {
    const owner = await read(target, OWN, 'owner');
    await pub.request({ method: 'anvil_impersonateAccount', params: [owner] });
    await pub.request({ method: 'anvil_setBalance', params: [owner, '0x56BC75E2D63100000'] });
    const hash = await pub.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: target, data: viem.encodeFunctionData({ abi: OWN, functionName, args }) }] });
    const rc = await pub.waitForTransactionReceipt({ hash });
    await pub.request({ method: 'anvil_stopImpersonatingAccount', params: [owner] });
    if (rc.status !== 'success') throw new Error(`${functionName} as owner reverted`);
  };
  const SPOT = viem.getAddress(pair.spotMarket);
  const reqBase = { account: A.borrower, loan_token: 'mUSDC', amount: '1000', max_repayment: '1100', term_days: 7, auction_hours: 24, collateral: [{ token: 'mWBTC', amount: '0.05' }], mode: 'one', bid_step: '10' };

  // W3 to another destination; W4 revoke.
  const t0 = await bal(USDC, A.trader);
  await prove('W3d', 'prepare_vault_withdraw', 'lender', { account: A.lender, token: 'mUSDC', amount: '1', destination: A.trader }, async () => eq(await bal(USDC, A.trader) - t0, u(1), 'sent to the destination'));
  // W5 buy side: the quote reservation at the quote vault, in quote decimals.
  {
    const q0 = await vaultFree(A.trader, USDC);
    await prove('W5b', 'prepare_spot_order', 'trader', { account: A.trader, market: pair.name, side: 'buy', amount: '0.001', limit_price: '50000' }, async (rc) => {
      const id = eventArg(rc, abi('BatchAuction'), 'OrderPlaced', 'orderId');
      const reserved = await read(C('Vault'), abi('Vault'), 'reservedBalance', [SPOT, A.trader, key(USDC), id]);
      return eq(reserved, u(50), 'quote reserved: 0.001 × 50,000') && eq(await vaultFree(A.trader, USDC) - q0, 0n, 'deposit then reserve nets to zero free');
    });
  }
  // Shortfalls, from the empty account.
  await refuses('W5e', 'prepare_spot_order', { account: E, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000' }, /Vault\.InsufficientBalance/);
  await refuses('W7e', 'prepare_bullet_request_open', { ...reqBase, account: E }, /ERC20InsufficientBalance/);
  await refuses('W7d', 'prepare_bullet_request_open', { ...reqBase, collateral: [{ token: 'mWBTC', amount: '0.01' }, { token: 'mWBTC', amount: '0.01' }] }, /twice/);
  await refuses('W9e', 'prepare_bullet_offer_open', { ...offerArgs('500'), account: E }, /Vault\.InsufficientBalance/);

  // Fresh loans for this section: a request to one, a shared request, offers (one with a ceiling, a shared one, and three to originate).
  const openReq = async (id, args) => { let l; await prove(id, 'prepare_bullet_request_open', 'borrower', args, async (rc) => { l = eventArg(rc, abi('BulletLoanRequest'), 'LoanOpened', 'loanId'); return l !== undefined; }); return l; };
  const r1 = await openReq('W7c', reqBase);
  const rm = await openReq('W7n', { ...reqBase, amount: '2000', max_repayment: '2200', mode: 'many', bid_step: undefined, min_amount: '1000' });
  const ceil = await (async () => { let l; await prove('W9d', 'prepare_bullet_offer_open', 'lender', { ...offerArgs('500'), ceiling_rate: '1.02' }, async (rc) => { l = eventArg(rc, abi('BulletLoanOffer'), 'LoanOpened', 'loanId'); return l !== undefined; }); return l; })();
  let om;
  await prove('W9n', 'prepare_bullet_offer_open', 'lender', { ...offerArgs('1000'), min_loan: '100', max_loan: '500', mode: 'many', max_fills: 5 }, async (rc) => { om = eventArg(rc, abi('BulletLoanOffer'), 'LoanOpened', 'loanId'); return om !== undefined; });
  const oPay = await openOffer('W9p', '500');   // repaid from the wallet (W14), collected and redeemed to the Vault (W18, W19)
  const oVault = await openOffer('W9q', '500'); // breached and paid off from the Vault (W15)

  // Bids, refusals and amendments while the auctions are live.
  await refuses('W8e', 'prepare_bullet_request_bid', { account: E, loan_id: String(rm), quantity: '1000', repayment: '1050' }, /Vault\.InsufficientBalance/);
  await refuses('W10e', 'prepare_bullet_offer_bid', { account: E, loan_id: String(om), loan_size: '200', repayment: '205' }, /ERC20InsufficientBalance/);
  await refuses('W10c', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(ceil), loan_size: '500', repayment: '520' }, /BeyondBound/);
  await refuses('W10s', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(cancelled), loan_size: '500', repayment: '510' }, /WrongState/);
  await refuses('W10f', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(om), loan_size: '200', repayment: '205', min_fill: '300' }, /MinFillOutOfRange/);
  await refuses('W8t', 'prepare_bullet_request_bid', { account: A.lender, loan_id: String(r1), repayment: '1050', expected_terms: `0x${'ab'.repeat(32)}` }, /TermsChanged/);
  // Tie-break on an offer to one: the same rate, a larger loan, stands. The ceiling offer runs 100 to 500.
  {
    let tieOffer;
    await prove('W9T', 'prepare_bullet_offer_open', 'lender', { ...offerArgs('500'), principal: '500', min_loan: '100', max_loan: '500' }, async (rc) => { tieOffer = eventArg(rc, abi('BulletLoanOffer'), 'LoanOpened', 'loanId'); return true; });
    if (tieOffer !== undefined) {
      await prove('W10t', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(tieOffer), loan_size: '200', repayment: '206' }, async () => true);
      await prove('W10T', 'prepare_bullet_offer_bid', 'trader', { account: A.trader, loan_id: String(tieOffer), loan_size: '300', repayment: '309' }, async (rc) =>
        eq(eventArg(rc, abi('BulletLoanOffer'), 'EntryRecorded', 'size'), u(300), 'the larger loan at the same rate stands'));
    }
  }
  // Amendments of shared bids: only the increase is reserved; the same size keeps its lock.
  {
    await prove('W8n', 'prepare_bullet_request_bid', 'lender', { account: A.lender, loan_id: String(rm), quantity: '1000', repayment: '1080' }, async () => true);
    await refuses('W8i', 'prepare_bullet_request_bid', { account: A.lender, loan_id: String(rm), quantity: '1000', repayment: '1090' }, /NotImprovement/);
    const f = await vaultFree(A.lender, USDC);
    const r = await prove('W8a', 'prepare_bullet_request_bid', 'lender', { account: A.lender, loan_id: String(rm), quantity: '1100', repayment: '1150' }, async () =>
      eq(f - await vaultFree(A.lender, USDC), u(100), 'only the increase is reserved'));
    if (r && r.env.prerequisites.some((p) => p.type === 'vault_deposit')) fail('prerequisite', 'W8a: a deposit was asked for although the increase is free');
    await prove('W10n', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(om), loan_size: '200', repayment: '205' }, async () => true);
    await refuses('W10i', 'prepare_bullet_offer_bid', { account: A.borrower, loan_id: String(om), loan_size: '200', repayment: '204' }, /NotImprovement/);
    const c = await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC);
    const r2 = await prove('W10a', 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(om), loan_size: '200', repayment: '206' }, async () =>
      eq(c - (await bal(WBTC, A.borrower) + await vaultFree(A.borrower, WBTC)), 0n, 'the same size keeps its lock'));
    if (r2 && r2.env.prerequisites.some((p) => p.type === 'erc20_approval')) fail('prerequisite', 'W10a: an approval was asked for although the lock is kept');
  }
  // Bids that make loans: the request to one, and the two offers.
  await prove('W8c', 'prepare_bullet_request_bid', 'lender', { account: A.lender, loan_id: String(r1), repayment: '1050' }, async () => true);
  for (const [id, loan] of [['W10p', oPay], ['W10q', oVault]]) {
    await prove(id, 'prepare_bullet_offer_bid', 'borrower', { account: A.borrower, loan_id: String(loan), loan_size: '500', repayment: '510' }, async () => true);
  }

  // Pause (the owner, on the fork): every tool that checks it refuses, then the products are unpaused.
  await asOwner(REQ, 'pause');
  await refuses('W7P', 'prepare_bullet_request_open', reqBase, /EnforcedPause/);
  await refuses('W8P', 'prepare_bullet_request_bid', { account: A.trader, loan_id: String(r1), repayment: '1000' }, /EnforcedPause/);
  await refuses('W11P', 'prepare_bullet_cancel', { account: A.borrower, product: 'request', loan_id: String(r1) }, /EnforcedPause/);
  await refuses('W13P', 'prepare_bullet_finalise', { account: A.trader, product: 'request', loan_id: String(r1) }, /EnforcedPause/);
  await asOwner(REQ, 'unpause');
  await asOwner(OFF, 'pause');
  await refuses('W9P', 'prepare_bullet_offer_open', offerArgs('500'), /EnforcedPause/);
  await refuses('W10P', 'prepare_bullet_offer_bid', { account: A.trader, loan_id: String(om), loan_size: '200', repayment: '210' }, /EnforcedPause/);
  await asOwner(OFF, 'unpause');
  await asOwner(SPOT, 'pause');
  await refuses('W5P', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000' }, /EnforcedPause/);
  await asOwner(SPOT, 'unpause');
  // An unauthorised consumer (the Vault's owner withdraws BulletLoanOffer's authorisation on the fork), then restored.
  await asOwner(C('Vault'), 'setAuthorisedConsumer', [OFF, false]);
  await refuses('W4u', 'prepare_vault_product_approval', { account: A.trader, product: 'BulletLoanOffer', approved: true }, /ConsumerNotAuthorised/);
  await refuses('W9a', 'prepare_bullet_offer_open', offerArgs('500'), /ConsumerNotAuthorised/);
  await asOwner(C('Vault'), 'setAuthorisedConsumer', [OFF, true]);

  // The auctions end: a bid is no longer live, an entry not yet releasable.
  await warp(24 * 3600 + 60);
  await refuses('W8l', 'prepare_bullet_request_bid', { account: A.trader, loan_id: String(r1), repayment: '1000' }, /NotLive/);
  const lenderEntry = await read(REQ, abi('BulletLoanRequest'), 'liveEntryOf', [r1, A.lender]);
  await refuses('W12w', 'prepare_bullet_entry_release', { account: A.lender, product: 'request', entry_id: String(lenderEntry) }, /NotReleasable/);
  for (const [id, kind, loan] of [['W13c', 'request', r1], ['W13p', 'offer', oPay], ['W13q', 'offer', oVault]]) {
    await prove(id, 'prepare_bullet_finalise', 'trader', { account: A.trader, product: kind, loan_id: String(loan) }, async () =>
      eq((await read(kind === 'request' ? REQ : OFF, abi(kind === 'request' ? 'BulletLoanRequest' : 'BulletLoanOffer'), 'loanOf', [loan]))[2], 3, 'ORIGINATED'));
  }
  await refuses('W12o', 'prepare_bullet_entry_release', { account: A.lender, product: 'request', entry_id: String(lenderEntry) }, /NotReleasable/);
  const originOf = async (loan) => {
    const ev = await pub.getContractEvents({ address: OFF, abi: abi('BulletLoanOffer'), eventName: 'LoanOriginated', args: { loanId: loan }, fromBlock: forkBlock });
    const [setId, obligationId, , , dueAt, lienId] = await read(OFF, abi('BulletLoanOffer'), 'originationOf', [ev[0].args.ref]);
    return { setId, obligationId, dueAt, lienId };
  };
  const P = await originOf(oPay);
  const Q = await originOf(oVault);
  // W14 shortfalls (anyone may pay), then a wallet repayment; W18 and W19 to the Vault.
  await refuses('W14e', 'prepare_obligation_pay', { account: E, obligation_id: String(P.obligationId), source: 'wallet' }, /ERC20InsufficientBalance/);
  await refuses('W14v', 'prepare_obligation_pay', { account: E, obligation_id: String(P.obligationId), source: 'vault' }, /Vault\.InsufficientBalance/);
  const bw = await bal(USDC, A.borrower);
  await prove('W14w', 'prepare_obligation_pay', 'borrower', { account: A.borrower, obligation_id: String(P.obligationId), source: 'wallet' }, async (rc, env) =>
    eq((await read(C('Obligation'), abi('Obligation'), 'getObligation', [P.obligationId])).status, 1, 'DISCHARGED') && eq(bw - await bal(USDC, A.borrower), u(510), 'paid from the wallet')
    && eq(env.prerequisites.filter((p) => p.type === 'erc20_approval').length, 1, 'one exact approval'));
  const lv = await vaultFree(A.lender, USDC);
  await prove('W18v', 'prepare_obligation_collect', 'lender', { account: A.lender, obligation_id: String(P.obligationId), to_vault: true }, async () =>
    eq(await vaultFree(A.lender, USDC) - lv, u(510), 'collected into the Vault'));
  await prove('W19v', 'prepare_obligation_redeem', 'lender', { account: A.lender, obligation_id: String(P.obligationId), to_vault: true }, async () =>
    eq(await read(C('Obligation'), abi('Obligation'), 'balanceOf', [A.lender, P.obligationId]), 0n, 'units burned'));
  await prove('W16r', 'prepare_lien_release', 'trader', { account: A.trader, lien_id: String(P.lienId) }, async () => true);
  await refuses('W16s', 'prepare_lien_release', { account: A.trader, lien_id: String(P.lienId) }, /InvalidStatus/);
  // W15 from the Vault after a breach; shortfalls first; then a second payoff is refused.
  const ts = (await pub.getBlock()).timestamp;
  await warp(Number(Q.dueAt - ts) + 8 * 24 * 3600);
  const mb = viem.parseAbi(['function markBreached(uint256 obligationId)']);
  await send('trader', { to: C('Obligation'), data: viem.encodeFunctionData({ abi: mb, functionName: 'markBreached', args: [Q.obligationId] }) });
  await refuses('W15e', 'prepare_lien_payoff', { account: E, lien_id: String(Q.lienId), source: 'wallet' }, /ERC20InsufficientBalance/);
  await refuses('W15v', 'prepare_lien_payoff', { account: E, lien_id: String(Q.lienId), source: 'vault' }, /Vault\.InsufficientBalance/);
  await prove('W2q', 'prepare_vault_deposit', 'borrower', { account: A.borrower, token: 'mUSDC', amount: '600' }, async () => true);
  const vq = await vaultFree(A.borrower, USDC);
  await prove('W15q', 'prepare_lien_payoff', 'borrower', { account: A.borrower, lien_id: String(Q.lienId), source: 'vault' }, async () =>
    eq((await read(C('Lien'), abi('Lien'), 'getLien', [Q.lienId]))[4], 2, 'PAID_OFF') && eq(vq - await vaultFree(A.borrower, USDC), u(510), 'paid from the Vault'));
  await refuses('W15s', 'prepare_lien_payoff', { account: A.borrower, lien_id: String(Q.lienId), source: 'vault' }, /InvalidStatus/);

  // The order cancelled at W6 (PENDING_CANCEL): days have passed, so a repeat cancel releases it at once; then a third is refused.
  if (orderId !== undefined) {
    const before = await vaultFree(A.trader, WBTC);
    await prove('W6r', 'prepare_spot_cancel', 'trader', { account: A.trader, market: pair.name, order_id: String(orderId) }, async () =>
      eq((await read(SPOT, abi('SpotMarket'), 'getOrderRecord', [orderId]))[2], true, 'released') && eq(await vaultFree(A.trader, WBTC) - before, w(0.01), 'the reservation returned'));
    await refuses('W6s', 'prepare_spot_cancel', { account: A.trader, market: pair.name, order_id: String(orderId) }, /already released/);
  }
  // The order cap: fill the trader's open orders to the cap directly (test-only), then W5 refuses.
  {
    const cap = await read(SPOT, abi('SpotMarket'), 'MAX_OPEN_ORDERS_PER_USER');
    const minBase = await read(SPOT, abi('SpotMarket'), 'MIN_ORDER_SIZE_BASE');
    await prove('W2c', 'prepare_vault_deposit', 'trader', { account: A.trader, token: 'mWBTC', amount: '0.5' }, async () => true);
    const price = 10n ** 21n * 1000n; // far from the book
    while ((await read(SPOT, abi('SpotMarket'), 'openOrdersByUser', [A.trader])) < cap) {
      const hint = await read(SPOT, abi('SpotMarket'), 'findHint', [1, price, 0n, 1000n]);
      await send('trader', { to: SPOT, data: viem.encodeFunctionData({ abi: abi('SpotMarket'), functionName: 'placeOrder', args: [1, minBase, price, 0n, hint] }) });
    }
    await refuses('W5c', 'prepare_spot_order', { account: A.trader, market: pair.name, side: 'sell', amount: '0.01', limit_price: '1000' }, /UserOrderCapReached/);
  }
  // W4 revoke.
  await prove('W4r', 'prepare_vault_product_approval', 'lender', { account: A.lender, product: 'BulletLoanRequest', approved: false }, async () =>
    eq(await read(C('Vault'), abi('Vault'), 'isUserApproved', [A.lender, REQ]), false, 'revoked'));
}

await client.close();
stop();

const tools = [...new Set(results.filter((r) => !r.refusal && r.ok).map((r) => r.name))];
const refusals = results.filter((r) => r.refusal && r.ok).length;
const summary = { forkBlock: Number(forkBlock), proven: tools.length, refusals, results, findings };
if (asJson) console.log(JSON.stringify(summary, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
else console.log(findings.length
  ? findings.map((f) => `[RED] ${f.rule}: ${f.detail}`).join('\n')
  : `check-v2-writes: clean (0 findings; ${tools.length} tools proven on the fork, ${refusals} hard errors refused)`);
process.exit(findings.length ? 1 : 0);
