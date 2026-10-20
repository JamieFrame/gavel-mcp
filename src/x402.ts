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
const UNAVAILABLE = 'Paid calls are unavailable just now. Try again later; the free allowance is unaffected.';

type PriceList = { classes: Record<string, { price?: number }>; as_known_on_multiplier: number; allowance_per_day: number;
  x402?: { network?: string; pay_to?: string; description?: string } };
let PL: PriceList | null = null;
let server: unknown = null;
let wrap: ((rs: unknown, cfg: unknown) => (h: (a: Record<string, unknown>) => Promise<Result>) => (a: Record<string, unknown>, extra: unknown) => Promise<Result>) | null = null;
let ready = false;
// Which tools rest only on sources that may be sold (the API's /internal/x402-terms, from the price
// list's mcp_tool_providers and the provider register): an answer without a licence block is sold
// only when its tool is in this set (operator, LG1 Gate 2: the same rules on both doors).
let sellableTools: Record<string, boolean> = {};
async function loadTerms(): Promise<void> {
  const base = (process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/internal/x402-terms`, { headers: { 'X-Internal-Secret': process.env.INTERNAL_API_SECRET || '' }, signal: AbortSignal.timeout(5_000) });
    if (r.ok) sellableTools = ((await r.json()) as { tools?: Record<string, boolean> }).tools ?? {};
    else logger.error({ status: r.status }, '[x402] /internal/x402-terms refused; tools without a licence block are not sold');
  } catch (e) { logger.error({ err: String(e) }, '[x402] /internal/x402-terms failed; tools without a licence block are not sold'); }
}

function fill(t?: string): string { return String(t || '').replace(/\{allowance\}/g, String(PL?.allowance_per_day ?? '')); }

if (ON) {
  try {
    PL = JSON.parse(readFileSync(process.env.X402_PRICE_LIST || '/root/gavel-indexer/pricing/price-list.json', 'utf8')) as PriceList;
    if (!/^0x[0-9a-fA-F]{40}$/.test(PL.x402?.pay_to || '') || !PL.x402?.network) throw new Error('price list has no x402.pay_to / network');
    if (MODE === 'test' && String(process.env.X402_TEST_KEY || '').length < 32) throw new Error('X402_MODE=test needs X402_TEST_KEY (32+ characters)');
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) throw new Error('CDP_API_KEY_ID / CDP_API_KEY_SECRET unset');
    const core = require('@x402/core/server');
    const evm = require('@x402/evm/exact/server');
    const mcp = require('@x402/mcp');
    const cdp = require('@coinbase/x402');
    const facilitator = new core.HTTPFacilitatorClient({ ...cdp.facilitator, timeoutMs: 25_000 });
    server = new core.x402ResourceServer(facilitator).register(PL.x402!.network, new evm.ExactEvmScheme());
    wrap = mcp.createPaymentWrapper;
    const init = (): void => {
      (server as { initialize: () => Promise<void> }).initialize()
        .then(() => { ready = true; logger.info({ network: PL!.x402!.network, payTo: PL!.x402!.pay_to, test: TEST_MODE }, '[x402] ready'); })
        .catch((e: unknown) => { logger.error({ err: String(e) }, '[x402] facilitator not ready; retry in 300 s'); setTimeout(init, 300_000).unref?.(); });
    };
    init();
    void loadTerms();
    setInterval(() => { void loadTerms(); }, 3_600_000).unref?.();
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
let day = ''; let used = new Map<string, number>();
function take(caller: string): (() => void) | null {
  const d = new Date().toISOString().slice(0, 10);
  if (day !== d) { day = d; used = new Map(); }
  if (!used.has(caller) && used.size >= MAX_CALLERS) return null;
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
  if (!TEST_MODE && take(pseudonym(ctx?.ip ?? 'unknown'))) return answer;
  if (!ready || !wrap) return unavailable();
  try {
    const accepts = await (server as { buildPaymentRequirements: (o: unknown) => Promise<unknown[]> }).buildPaymentRequirements({
      scheme: 'exact', network: PL.x402!.network, payTo: PL.x402!.pay_to, price: `$${priceUsd(cls, args, units).toFixed(4)}`,
    });
    const paid = wrap(server, { accepts, resource: { url: `mcp://tool/${tool}`, description: fill(PL.x402!.description) } });
    const r = scrubResult(await paid(async () => answer)(args, extra));
    // The library's own failure text ("Internal Server Error") becomes ours.
    if (r?.isError && !r.structuredContent && /Internal Server Error/.test(r.content?.[0]?.text ?? '')) return unavailable();
    return r;
  } catch (e) {
    logger.error({ tool, err: String(e) }, '[x402] paid call failed');
    return unavailable();
  }
}
