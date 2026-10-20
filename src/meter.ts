// ============================================================================
// meter.ts — the MCP half of the shadow meter (MN1 Phase 2; operator SM-1..SM-4).
// Spec: aletheia-docs data/specs/shadow_meter_v1.md.
//
// Each observatory tool call is counted once, here, and posted in batches to the
// API's /internal/meter (loopback + the internal secret), which applies the price
// list (gavel-indexer pricing/price-list.json, the one home of prices). The API's
// REST meter skips the calls this server makes to it, so nothing counts twice.
//
// No IP leaves this process: an anonymous caller is a daily pseudonym, an HMAC of
// the IP's /64 (or /32) under a key held only in memory and replaced at each UTC
// midnight. A keyed caller is a hash of its key. Nothing is charged.
// FAIL SILENT: metering never fails or slows a tool call.
// ============================================================================

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { COST_CLASS, type CostClass } from './content/cost-classes.js';
import { tryGetContext } from './context.js';
import { logger } from './logger.js';

const INTERNAL_URL = (process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012').replace(/\/$/, '');
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';
const FLUSH_MS = 60_000;
const SELLABLE = new Set(['own', 'attributed']);

type Rec = {
  day: string; item: string; cost_class: CostClass; as_known_on: boolean; caller_class: 'key' | 'anon' | 'internal' | 'payer';
  caller: string; agent: string; indicator_id?: string; calls: number; bytes: number; units_list: number; units_sellable: number | null;
};
let pending = new Map<string, Rec>();

let dayKey: { day: string; key: Buffer } = { day: '', key: Buffer.alloc(0) };
/** The /64 (or the IPv4 address), with '::' expanded first, as gavel-indexer api-gate.js anonKeyForIp. */
function netOf(ip: string): string {
  const a = ip.replace(/^::ffff:/, '');
  if (!a.includes(':')) return a;
  let g: string[];
  if (a.includes('::')) {
    const [h, t] = a.split('::'); const hh = h ? h.split(':') : []; const tt = t ? t.split(':') : [];
    g = [...hh, ...Array(Math.max(0, 8 - hh.length - tt.length)).fill('0'), ...tt];
  } else g = a.split(':');
  return g.slice(0, 4).map((x) => (parseInt(x || '0', 16) || 0).toString(16)).join(':') + '::/64';
}
export function pseudonym(ip: string): string {
  const day = new Date().toISOString().slice(0, 10);
  if (dayKey.day !== day) dayKey = { day, key: randomBytes(32) }; // never written anywhere
  const net = netOf(ip);
  return `anon:${createHmac('sha256', dayKey.key).update(net).digest('hex').slice(0, 16)}`;
}

const AGENTS: Array<[RegExp, string]> = [
  [/claude|anthropic/i, 'claude'], [/chatgpt|openai/i, 'chatgpt'], [/cursor/i, 'cursor'],
  [/python|aiohttp|httpx|requests/i, 'python'], [/node|undici|axios|got\b/i, 'node'],
  [/curl|wget/i, 'curl'], [/mozilla|chrome|safari|firefox/i, 'browser'],
];
function agentOf(ua: string | null | undefined): string {
  if (!ua) return 'none';
  for (const [re, name] of AGENTS) if (re.test(ua)) return name;
  return 'other';
}

// The class a call actually falls in: an argument that asks for depth moves it up (MR1 §6).
export function classOf(tool: string, args: Record<string, unknown>): CostClass | null {
  const base = COST_CLASS[tool];
  if (!base) return null;
  if (tool === 'get_indicator' && args.include_history) return 'history';
  if (tool === 'get_liquidation_map' && args.history === true) return 'history';
  if (tool === 'get_venue' && Array.isArray(args.include) && args.include.length) return 'snapshot';
  return base;
}

// Units from the answer: a series answer counts its series and their licences; any other
// priced answer is one unit, its sellability left to the price list's tool providers
// (units_sellable null) unless the answer carries its own licence.
function unitsOf(cls: CostClass, body: unknown): { list: number; sellable: number | null } {
  if (cls === 'catalogue' || cls === 'reading') return { list: 0, sellable: 0 };
  const b = body as { series?: Array<{ error?: unknown; licence?: { status?: string } }>; licence?: { status?: string } } | null;
  if (Array.isArray(b?.series) && b!.series.some((s) => s && 'licence' in s)) {
    const ok = b!.series.filter((s) => s && !s.error);
    return { list: ok.length, sellable: ok.filter((s) => SELLABLE.has(String(s.licence?.status))).length };
  }
  if (b?.licence?.status) return { list: 1, sellable: SELLABLE.has(b.licence.status) ? 1 : 0 };
  return { list: 1, sellable: null };
}

/** Count one finished tool call. Never throws. */
export function meterToolCall(tool: string, args: unknown, result: unknown): void {
  try {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
    if (!r || r.isError) return;
    const cls = classOf(tool, a);
    if (!cls) return;
    const text = r.content?.find((c) => c.type === 'text' && typeof c.text === 'string')?.text ?? '';
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (body && typeof body === 'object' && 'error' in (body as object)) return; // an error answer is not counted
    const ctx = tryGetContext() as (ReturnType<typeof tryGetContext> & { userAgent?: string | null; viaProxy?: boolean; x402Test?: boolean }) | null;
    const internal = !!ctx && ctx.viaProxy === false;
    // MN1 Phase 3: a paid call names its payer (x402 settlement in _meta); a test payment is ours.
    const settled = (result as { _meta?: Record<string, { success?: boolean; payer?: string }> } | null)?._meta?.['x402/payment-response'];
    const payer = settled?.success !== false && /^0x[0-9a-fA-F]{40}$/.test(String(settled?.payer || '')) ? String(settled!.payer).toLowerCase() : null;
    const caller_class: Rec['caller_class'] = ctx?.bearerToken ? 'key' : payer && ctx?.x402Test ? 'internal' : payer ? 'payer' : internal ? 'internal' : 'anon';
    const caller = caller_class === 'key' ? `key:${createHash('sha256').update(ctx!.bearerToken!).digest('hex').slice(0, 16)}`
      : payer && ctx?.x402Test ? `x402-test:${payer}` : payer ? `payer:${payer}`
      : caller_class === 'internal' ? 'internal' : pseudonym(ctx?.ip ?? 'unknown');
    const u = unitsOf(cls, body);
    const rec: Rec = {
      day: new Date().toISOString().slice(0, 10), item: tool, cost_class: cls, as_known_on: !!a.as_known_on,
      caller_class, caller, agent: agentOf(ctx?.userAgent), calls: 1, bytes: Buffer.byteLength(text),
      units_list: u.list, units_sellable: u.sellable,
      ...(tool === 'get_indicator' && typeof a.id === 'string' ? { indicator_id: a.id } : {}),
    };
    const k = [rec.day, rec.item, rec.cost_class, rec.as_known_on, rec.caller, rec.agent, rec.indicator_id ?? '', rec.units_sellable === null].join('\t');
    const cur = pending.get(k);
    if (!cur) pending.set(k, rec);
    else {
      cur.calls += 1; cur.bytes += rec.bytes; cur.units_list += rec.units_list;
      if (cur.units_sellable !== null && rec.units_sellable !== null) cur.units_sellable += rec.units_sellable;
    }
  } catch { /* never let the meter break a call */ }
}

async function flush(): Promise<void> {
  if (!pending.size || !INTERNAL_SECRET) { pending = new Map(); return; }
  const records = [...pending.values()];
  pending = new Map();
  try {
    const res = await fetch(`${INTERNAL_URL}/internal/meter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_SECRET },
      body: JSON.stringify({ records }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) logger.warn({ status: res.status, records: records.length }, 'meter flush refused; these counts are dropped');
  } catch (e) {
    logger.warn({ err: String(e), records: records.length }, 'meter flush failed; these counts are dropped');
  }
}

const timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
timer.unref?.();
