// ============================================================================
// x402.ts — agents pay per tool call on the observatory MCP (MN1 Phase 3; operator
// G2-1..G2-3, P3-1..P3-4, Gate 3 2026-10-20). The MCP half of gavel-indexer lib/x402.js:
// the same price list, the same free cases, the same test mode.
//
// A priced call (class snapshot or history, src/meter.ts classOf) past the day's free
// allowance answers the x402 MCP transport's payment-required tool result
// (structuredContent: PaymentRequired; isError). A client that pays sends the payment in
// _meta["x402/payment"]; the answer is the free answer (MN-D5) with the settlement in
// _meta["x402/payment-response"]. Settled through the Coinbase CDP facilitator to the
// operator's address; no wallet of ours signs.
//
// OFF unless X402_MODE=on or test. Test mode: only a request carrying X-X402-Test equal to
// X402_TEST_KEY is priced (from its first call, no exemption); everyone else is free.
// It refuses to switch on, logged, without the price list (X402_PRICE_LIST, default the
// indexer's on this host: one home of prices, MN-D3), the CDP keys or the packages.
//
// Never refused: catalogue and reading tools; a keyed caller; a call made on this machine
// (no X-Forwarded-For); an anonymous caller's first `allowance_per_day` successful priced
// calls of the UTC day, per daily /64 pseudonym (src/meter.ts), counted on entry and
// refunded when the call fails. The allowance is this door's own: the REST door counts its
// own (gavel-indexer lib/x402.js).
// What the facilitator says never reaches the caller: only a code (lower case, digits,
// underscores) survives in a payment result.
//
// LG2 Phase 2 (O-1, counsel C6, 2026-11-12): paid access is moving to identified accounts
// (aletheia-docs runbooks/IN_PROGRESS/runbook_LG2_stack_identified_paid_access_v1.md LG2-D1).
// Until the account gate is built, X402_REQUIRE_ACCOUNT (on unless set to 'off') closes
// settlement, as on the REST door: a priced call with sellable units past the allowance
// answers an isError result with code `account_required`, offers no payment, and neither
// @x402/mcp nor the facilitator is called. Test mode is not affected.
//
// LG2 Phase 3 (LG2-D1, D2): the account gate, as on the REST door (gavel-indexer lib/x402.js).
// X402_REQUIRE_ACCOUNT=gate (explicit; the default stays closed) settles only for a wallet bound to an
// active, verified account that has accepted the major versions of the terms in force. The payer is
// read from the payment in _meta["x402/payment"] (authorization.from, or permit2Authorization.from) and
// asked of the API (GET /internal/x402-payer, loopback + secret, lib/accounts.js) before @x402/mcp is
// called; an uncleared payer answers an isError result `account_required` or `terms_acceptance_required`
// (with the versions), no payment offered, nothing verified or settled. The same question is asked again
// in the resource server's beforeVerify and beforeSettle hooks. A call without a payment gets the usual
// offer, with `account_url`. Each receipt names the account, the cost class and the terms in force.
// Staging (LG2-D16): network, asset, pay_to and facilitator are overridden by environment only in a
// process marked STACK_STAGING=on and only to a testnet (x402Settings below, the MCP half of gavel-indexer
// lib/stack-staging.js); a process not marked staging that carries an override refuses to start.
// ============================================================================

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tryGetContext } from './context.js';
import { logger } from './logger.js';
import { pseudonym, unitsOf } from './meter.js';
import type { CostClass } from './content/cost-classes.js';

const require = createRequire(import.meta.url);

type Ctx = { bearerToken?: string | null; keyResolved?: boolean; viaProxy?: boolean; ip?: string; x402Test?: boolean } | null;
type Result = { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> };
type Run = () => Promise<Result>;

const MODE = process.env.X402_MODE;
const ON = MODE === 'on' || MODE === 'test';
export const TEST_MODE = MODE === 'test';
const PRICED = new Set(['snapshot', 'history']);
const CODE = /^[a-z0-9_]{1,64}$/;
const MAX_CALLERS = 200_000;
const ACCOUNT_REQUIRED = 'Paid access is moving to identified professional accounts. Calls past the free allowance are refused until account opening; no payment is taken.';
/** Whether settlement waits for an identified account (LG2 O-1): on unless X402_REQUIRE_ACCOUNT=off. */
export function requiresAccount(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.X402_REQUIRE_ACCOUNT ?? '').trim().toLowerCase() !== 'off';
}
/** LG2 Phase 3: 'closed' (the default), 'gate' (X402_REQUIRE_ACCOUNT=gate) or 'open' (X402_REQUIRE_ACCOUNT=off). */
export function accountMode(env: Record<string, string | undefined> = process.env): 'closed' | 'gate' | 'open' {
  const v = String(env.X402_REQUIRE_ACCOUNT ?? '').trim().toLowerCase();
  return v === 'off' ? 'open' : v === 'gate' ? 'gate' : 'closed';
}
const MODE_ACCOUNT = TEST_MODE ? 'open' : accountMode();
const REQUIRE_ACCOUNT = MODE_ACCOUNT === 'closed';

// ── LG2-D16: the staging switch (the MCP half of gavel-indexer lib/stack-staging.js) ──
const OVERRIDES = ['X402_NETWORK', 'X402_ASSET_ADDRESS', 'X402_PAY_TO', 'X402_FACILITATOR_URL'];
const TESTNETS = new Set(['eip155:84532']);
type X402Cfg = { network?: string; pay_to?: string; asset_address?: string };
export type Settings = { network: string; asset_address: string; pay_to: string; facilitator_url: string | null; staging: boolean };
/** The x402 settings of this process; throws on an override outside a staging process, or a staging process off a testnet. */
export function x402Settings(cfg: X402Cfg = {}, env: Record<string, string | undefined> = process.env): Settings {
  const set = OVERRIDES.filter((k) => String(env[k] ?? '').trim() !== '');
  const staging = String(env.STACK_STAGING ?? '').trim().toLowerCase() === 'on';
  if (!staging) {
    if (set.length) throw new Error(`[stack-staging] refused: ${set.join(', ')} set in a process not marked staging (STACK_STAGING=on)`);
    return { network: String(cfg.network ?? ''), asset_address: String(cfg.asset_address ?? ''), pay_to: String(cfg.pay_to ?? ''), facilitator_url: null, staging: false };
  }
  const network = String(env.X402_NETWORK ?? '').trim();
  const asset = String(env.X402_ASSET_ADDRESS ?? '').trim();
  const payTo = String(env.X402_PAY_TO ?? '').trim();
  const fac = String(env.X402_FACILITATOR_URL ?? '').trim() || null;
  if (!TESTNETS.has(network)) throw new Error(`[stack-staging] refused: a staging process needs X402_NETWORK set to a testnet; got '${network || 'unset'}'`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) throw new Error('[stack-staging] refused: a staging process needs X402_ASSET_ADDRESS');
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('[stack-staging] refused: a staging process needs X402_PAY_TO');
  if (cfg.pay_to && payTo.toLowerCase() === String(cfg.pay_to).toLowerCase()) throw new Error('[stack-staging] refused: X402_PAY_TO is production\'s pay_to');
  if (fac && !/^https?:\/\//.test(fac)) throw new Error('[stack-staging] refused: X402_FACILITATOR_URL is not a URL');
  return { network, asset_address: asset, pay_to: payTo, facilitator_url: fac, staging: true };
}
// A production process with an override does not start (thrown at import, before anything is served).
x402Settings({}, process.env);
let S: Settings | null = null;

// ── LG2 Phase 3: the gate ──
type Lookup = { decision: 'ok' | 'account_required' | 'terms_acceptance_required' | 'unavailable'; why?: string; account_id?: string;
  account_status?: string | null; terms?: unknown[]; terms_in_force?: Record<string, unknown> };
const GATE_TEXT = {
  not_bound: 'This wallet is not bound to an identified professional account, so no payment is taken. Open an account and bind this wallet: {account_url}. The free allowance is unaffected.',
  not_active: 'The account this wallet is bound to is not active (verification pending, suspended or closed), so no payment is taken. Details: {account_url}.',
  terms: 'A new major version of the terms applies and the account this wallet is bound to has not accepted it, so no payment is taken. The versions are listed in `terms`; accept them at {account_url}.',
};
/** The payer of an x402 `exact` EVM payment (EIP-3009 or Permit2), lower case, or null. */
export function payerOf(payment: unknown): string | null {
  const p = (payment as { payload?: { authorization?: { from?: string }; permit2Authorization?: { from?: string } } } | null)?.payload ?? {};
  const from = p.authorization?.from || p.permit2Authorization?.from || '';
  return /^0x[0-9a-fA-F]{40}$/.test(from) ? from.toLowerCase() : null;
}
/** The site's /account page, from the price list's legal_url. */
export function accountUrlOf(list: { x402?: { legal_url?: string } } | null): string {
  return new URL('/account', list?.x402?.legal_url || 'https://www.bitcoincreditstack.com').href;
}
/** The gate's refusal: an isError result in our words, no payment offered. */
export function gateResult(r: Lookup, accountUrl: string): Result {
  const text = r.decision === 'terms_acceptance_required' ? GATE_TEXT.terms : r.why === 'not_bound' || r.why === 'no_payer' ? GATE_TEXT.not_bound : GATE_TEXT.not_active;
  const error: Record<string, unknown> = { code: r.decision, message: text.replace(/\{account_url\}/g, accountUrl), account_url: accountUrl, retryable: false };
  if (r.account_status) error.account_status = r.account_status;
  if (r.terms) error.terms = r.terms;
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}
async function lookupPayer(payer: string): Promise<Lookup> {
  const base = (process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/internal/x402-payer?payer=${encodeURIComponent(payer)}`, { headers: { 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) { logger.error({ status: r.status }, '[x402] /internal/x402-payer refused; nothing is settled'); return { decision: 'unavailable' }; }
    return (await r.json()) as Lookup;
  } catch (e) { logger.error({ err: String(e) }, '[x402] /internal/x402-payer failed; nothing is settled'); return { decision: 'unavailable' }; }
}
const UNAVAILABLE = 'Paid calls are unavailable just now. Try again later; the free allowance is unaffected.';

type PriceList = { version?: string; classes: Record<string, { price?: number }>; as_known_on_multiplier: number; allowance_per_day: number;
  x402?: { network?: string; pay_to?: string; description?: string; asset_address?: string; legal_url?: string; account_required_message?: string } };
let gateOn = false;   // MODE_ACCOUNT 'gate' and the payment path mounted

// A settled payment leaves a receipt in the API's x402_receipts (ingest 264), through its loopback
// /internal/receipt; a refusal is logged in full so the receipt can be rebuilt.
async function postReceipt(rec: Record<string, unknown>): Promise<void> {
  const base = (process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/internal/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' },
      body: JSON.stringify(rec), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) logger.error({ status: r.status, receipt: rec }, '[x402-receipt] UNRECORDED');
  } catch (e) { logger.error({ err: String(e), receipt: rec }, '[x402-receipt] UNRECORDED'); }
}
let PL: PriceList | null = null;
let server: unknown = null;
let wrap: ((rs: unknown, cfg: unknown) => (h: (a: Record<string, unknown>) => Promise<Result>) => (a: Record<string, unknown>, extra: unknown) => Promise<Result>) | null = null;
let ready = false;
// Which tools rest only on sources that may be sold (the API's /internal/x402-terms, from the price
// list's mcp_tool_providers and the provider register): an answer without a licence block is sold
// only when its tool is in this set (operator, LG1 Gate 2: the same rules on both doors).
let sellableTools: Record<string, boolean> = {};
async function loadTerms(): Promise<boolean> {
  const base = (process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/internal/x402-terms`, { headers: { 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' }, signal: AbortSignal.timeout(5_000) });
    if (r.ok) { sellableTools = ((await r.json()) as { tools?: Record<string, boolean> }).tools ?? {}; return true; }
    logger.error({ status: r.status }, '[x402] /internal/x402-terms refused; tools without a licence block are not sold');
  } catch (e) { logger.error({ err: String(e) }, '[x402] /internal/x402-terms failed; tools without a licence block are not sold'); }
  return false;
}
// Loaded at start and hourly; after a failure, tried again each minute until it answers (HX1).
async function keepTerms(): Promise<void> {
  const ok = await loadTerms();
  setTimeout(() => { void keepTerms(); }, ok ? 3_600_000 : 60_000).unref?.();
}

function fill(t?: string, list: PriceList | null = PL): string {
  return String(t || '').replace(/\{allowance\}/g, String(list?.allowance_per_day ?? ''))
    .replace(/\{legal_url\}/g, String(list?.x402?.legal_url || 'https://www.bitcoincreditstack.com/legal'));
}

if (ON) {
  try {
    PL = JSON.parse(readFileSync(process.env.X402_PRICE_LIST || '/root/gavel-indexer/pricing/price-list.json', 'utf8')) as PriceList;
    S = x402Settings(PL.x402 ?? {}, process.env);
    if (!/^0x[0-9a-fA-F]{40}$/.test(S.pay_to) || !S.network) throw new Error('price list has no x402.pay_to / network');
    if (MODE === 'test' && String(process.env.X402_TEST_KEY || '').length < 32) throw new Error('X402_MODE=test needs X402_TEST_KEY (32+ characters)');
    if (!S.facilitator_url && (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET)) throw new Error('CDP_API_KEY_ID / CDP_API_KEY_SECRET unset');
    const core = require('@x402/core/server');
    const evm = require('@x402/evm/exact/server');
    const mcp = require('@x402/mcp');
    const facilitator = new core.HTTPFacilitatorClient({ ...(S.facilitator_url ? { url: S.facilitator_url } : require('@coinbase/x402').facilitator), timeoutMs: 25_000 });
    server = new core.x402ResourceServer(facilitator).register(S.network, new evm.ExactEvmScheme());
    if (MODE_ACCOUNT === 'gate') {
      // LG2 Phase 3: the gate again inside the library, before the facilitator verifies or settles.
      const guard = async (ctx: { paymentPayload?: unknown }): Promise<{ abort: true; reason: string; message: string } | undefined> => {
        const payer = payerOf(ctx?.paymentPayload);
        const r: Lookup = payer ? await lookupPayer(payer) : { decision: 'account_required' };
        return r.decision === 'ok' ? undefined : { abort: true, reason: r.decision === 'unavailable' ? 'payment_unavailable' : r.decision, message: r.decision };
      };
      (server as { onBeforeVerify: (h: typeof guard) => unknown }).onBeforeVerify(guard);
      (server as { onBeforeSettle: (h: typeof guard) => unknown }).onBeforeSettle(guard);
      gateOn = true;
    }
    wrap = mcp.createPaymentWrapper;
    const init = (): void => {
      (server as { initialize: () => Promise<void> }).initialize()
        .then(() => { ready = true; logger.info({ network: S!.network, payTo: S!.pay_to, test: TEST_MODE, accountRequired: REQUIRE_ACCOUNT, accountGate: gateOn, staging: S!.staging }, '[x402] ready'); })
        .catch((e: unknown) => { logger.error({ err: String(e) }, '[x402] facilitator not ready; retry in 300 s'); setTimeout(init, 300_000).unref?.(); });
    };
    init();
    void keepTerms();
    if (REQUIRE_ACCOUNT) logger.info('[x402] account required (X402_REQUIRE_ACCOUNT): a priced call past the allowance answers account_required; nothing is settled');
    if (gateOn) logger.info('[x402] account gate (X402_REQUIRE_ACCOUNT=gate): only a wallet bound to an active account that has accepted the terms in force is settled');
  } catch (e) {
    logger.error({ err: String(e) }, '[x402] NOT switched on');
    PL = null;
  }
}

/** The price in USD of a priced call: the class's price x the sellable units, x2 for a dated as_known_on. */
export function priceUsd(cls: string, args: Record<string, unknown>, units: number, list: PriceList | null = PL): number {
  const p = list?.classes?.[cls]?.price ?? 0;
  const dated = /^\d{4}-\d{2}-\d{2}/.test(String(args.as_known_on || ''));   // as the REST door's asKnownOn
  return p * units * (dated ? (list?.as_known_on_multiplier ?? 2) : 1);
}

/**
 * Only what may be sold is priced (MN1 G0-2, G1-6; LG1 G0-L15): the sellable units of the
 * answer itself, from the licences it carries (src/meter.ts unitsOf). An answer that carries
 * no licence is not sellable (strict, as the REST door's credit tree).
 */
export function sellableUnits(cls: string, r: Result, tool = '', tools: Record<string, boolean> = sellableTools): number {
  if (!r || r.isError) return 0;
  let body: unknown = null;
  try { body = JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? 'null'); } catch { return 0; }
  const u = unitsOf(cls as CostClass, body);
  if (u.sellable !== null) return u.sellable;   // the answer's own licences decide
  return tools[tool] ? u.list : 0;              // otherwise the tool's sources (strict when unknown)
}

// ── the day's allowance per anonymous caller: taken on entry, refunded on failure ──
let day = ''; let used = new Map<string, number>(); let per48 = new Map<string, number>();
const PER_48 = 256;   // /64 callers per IPv6 /48 per day, as the REST door
function slash48(ip: string): string | null {
  const a = ip.replace(/^::ffff:/, '');
  if (!a.includes(':')) return null;
  let g: string[];
  if (a.includes('::')) { const [h, t] = a.split('::'); const hh = h ? h.split(':') : []; const tt = t ? t.split(':') : []; g = [...hh, ...Array(Math.max(0, 8 - hh.length - tt.length)).fill('0'), ...tt]; } else g = a.split(':');
  return g.slice(0, 3).map((x) => (parseInt(x || '0', 16) || 0).toString(16)).join(':');
}
function take(caller: string, ip = ''): (() => void) | null {
  const d = new Date().toISOString().slice(0, 10);
  if (day !== d) { day = d; used = new Map(); per48 = new Map(); }
  if (!used.has(caller) && used.size >= MAX_CALLERS) return null;
  if (!used.has(caller)) {
    const net = slash48(ip);
    if (net) { const n = per48.get(net) ?? 0; if (n >= PER_48) return null; per48.set(net, n + 1); }
  }
  const n = used.get(caller) ?? 0;
  if (n >= (PL?.allowance_per_day ?? 0)) return null;
  used.set(caller, n + 1);
  return () => { if (day === d) used.set(caller, Math.max(0, (used.get(caller) ?? 1) - 1)); };
}

/** Takes a facilitator's words out of a payment result; only codes survive. */
export function scrubResult(r: Result): Result {
  try {
    const clean = (o: Record<string, unknown> | undefined): void => {
      if (!o || typeof o !== 'object') return;
      if ('error' in o && !CODE.test(String(o.error)) && String(o.error) !== 'Payment required to access this tool') o.error = 'payment_not_accepted';
      if ('errorReason' in o && !CODE.test(String(o.errorReason))) o.errorReason = 'settlement_failed';
      if ('errorMessage' in o) delete o.errorMessage;
    };
    clean(r.structuredContent as Record<string, unknown>);
    clean(r._meta?.['x402/payment-response'] as Record<string, unknown>);
    if (r.structuredContent && r.content?.[0]?.type === 'text') r.content[0].text = JSON.stringify(r.structuredContent);
  } catch { /* leave as is */ }
  return r;
}

/** LG2 O-1: the answer past the allowance while settlement waits for identified accounts. No payment is offered. */
export function accountRequiredResult(list: PriceList | null = PL): Result {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'account_required', message: fill(list?.x402?.account_required_message, list) || ACCOUNT_REQUIRED, retryable: false } }) }], isError: true };
}

/**
 * What happens to a priced call with sellable units that the allowance does not cover:
 * 'account_required' (LG2 O-1; never reaches @x402/mcp or the facilitator), 'unavailable'
 * (the facilitator is not ready) or 'pay' (the x402 payment path).
 */
export function pastAllowance(o: { requireAccount: boolean; ready: boolean }): 'account_required' | 'unavailable' | 'pay' {
  if (o.requireAccount) return 'account_required';
  return o.ready ? 'pay' : 'unavailable';
}

/** LG2 Phase 3: a payment-required result names the account page (`account_url`) beside the offer. */
export function withAccountUrl(r: Result, accountUrl: string): Result {
  const sc = r?.structuredContent as Record<string, unknown> | undefined;
  if (r?.isError && sc && Array.isArray(sc.accepts)) {
    sc.account_url = accountUrl;
    if (r.content?.[0]?.type === 'text') r.content[0].text = JSON.stringify(sc);
  }
  return r;
}

const unavailable = (): Result => ({ content: [{ type: 'text', text: JSON.stringify({ error: { code: 'payment_unavailable', message: UNAVAILABLE, retryable: true } }) }], isError: true });

/**
 * Runs one observatory tool call through x402. `cls` is the call's cost class
 * (src/meter.ts classOf); `run` serves the free answer.
 */
export async function x402Call(tool: string, cls: string | null, args: Record<string, unknown>, extra: unknown, run: Run): Promise<Result> {
  if (!PL || !cls || !PRICED.has(cls)) return run();
  const ctx = tryGetContext() as Ctx;
  if (TEST_MODE ? !ctx?.x402Test : (ctx?.keyResolved || ctx?.viaProxy === false)) return run();
  // The answer first: it says what in it may be sold. Nothing sellable: served free, and it
  // spends no allowance (HX1 review). An error is never priced.
  const answer = await run();
  const units = sellableUnits(cls, answer, tool);
  if (!units) return answer;
  if (!TEST_MODE && take(pseudonym(ctx?.ip ?? 'unknown'), ctx?.ip ?? '')) return answer;
  const step = pastAllowance({ requireAccount: REQUIRE_ACCOUNT, ready: ready && !!wrap });
  if (step === 'account_required') return accountRequiredResult();
  if (step === 'unavailable' || !wrap) return unavailable();
  // LG2 Phase 3: a payment names its payer; it is cleared before @x402/mcp or the facilitator sees it.
  let cleared: Lookup | null = null;
  if (gateOn) {
    const payer = payerOf((extra as { _meta?: Record<string, unknown> } | null)?._meta?.['x402/payment']);
    if (payer) {
      cleared = await lookupPayer(payer);
      if (cleared.decision === 'unavailable') return unavailable();
      if (cleared.decision !== 'ok') return gateResult(cleared, accountUrlOf(PL));
    }
  }
  try {
    const accepts = await (server as { buildPaymentRequirements: (o: unknown) => Promise<unknown[]> }).buildPaymentRequirements({
      scheme: 'exact', network: S!.network, payTo: S!.pay_to, price: `$${priceUsd(cls, args, units).toFixed(4)}`,
    });
    const paid = wrap(server, { accepts, resource: { url: `mcp://tool/${tool}`, description: fill(PL.x402!.description) } });
    const r = scrubResult(await paid(async () => answer)(args, extra));
    if (gateOn) withAccountUrl(r, accountUrlOf(PL));
    const s = r?._meta?.['x402/payment-response'] as { success?: boolean; payer?: string; transaction?: string; network?: string } | undefined;
    if (s?.success !== false && s?.transaction && s?.payer) {
      void postReceipt({ item: tool, network: s.network || S!.network, asset: S!.asset_address, pay_to: S!.pay_to, payer: s.payer,
        amount_units: String(Math.round(priceUsd(cls, args, units) * 1e6)), units, price_list_version: PL.version, transaction: s.transaction, test: !!ctx?.x402Test,
        // LG2 O-13: the account, the cost class and the terms in force.
        account_id: cleared?.account_id ?? null, cost_class: cls, terms_in_force: cleared?.terms_in_force ?? null });
    }
    // The library's own failure text ("Internal Server Error") becomes ours.
    if (r?.isError && !r.structuredContent && /Internal Server Error/.test(r.content?.[0]?.text ?? '')) return unavailable();
    return r;
  } catch (e) {
    logger.error({ tool, err: String(e) }, '[x402] paid call failed');
    return unavailable();
  }
}
