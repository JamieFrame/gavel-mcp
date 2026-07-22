import { createHash } from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getContext } from './context.js';
import { logger } from './logger.js';

/**
 * Aletheia product tiers. Sequence is significant — each tier implies access
 * to everything at lower indices.
 *
 * R18 / MD1: this ladder is deliberately IDENTICAL to the product's
 * (gavel-indexer/lib/tiers.js) and to what Stripe sells. The Phase 1 scaffold
 * invented a parallel `anonymous / developer / professional / enterprise`
 * ladder; two vocabularies for one entitlement is exactly the second
 * source-of-truth this series exists to avoid. `anonymous` maps to `free`.
 */
export const TIERS = ['free', 'pro', 'enterprise'] as const;
export type Tier = typeof TIERS[number];

const TIER_RANK: Record<Tier, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as readonly string[]).includes(v);
}

/**
 * R18 / MD2 — enforcement is authored but dormant.
 *
 * Monetisation is gated until Gate B (D16–D18): "do not build a paywall until
 * someone has asked to pay". Runbook A2 withdrew the commercial surface, and
 * www.thegavel.io/pricing currently states that data access is free and open.
 * Refusing a tool and pointing the user at a page that denies tiers exist
 * would be a self-refuting user journey — so the whole resolution path runs
 * and is logged, but nothing is refused until this flag is turned on.
 *
 * Flipping it belongs to Gate B / Runbook A3, not here. Whoever flips it must
 * first settle which model they are switching on — see MD2.
 */
const ENFORCEMENT_ENABLED =
  (process.env.MCP_TIER_ENFORCEMENT || 'false').toLowerCase() === 'true';

export function enforcementEnabled(): boolean {
  return ENFORCEMENT_ENABLED;
}

/**
 * Throws if the current request's tier does not satisfy `minimumTier` — unless
 * enforcement is off, in which case it records what *would* have been refused
 * and allows the call. Tools declare their requirement as the first line of
 * the handler body:
 *
 *     async (args) => {
 *       requireTier('pro');
 *       // ... rest of handler ...
 *     }
 */
export function requireTier(minimumTier: Tier): void {
  const { tier } = getContext();
  if (TIER_RANK[tier] >= TIER_RANK[minimumTier]) return;

  if (!ENFORCEMENT_ENABLED) {
    // The signal that tells us what a paywall *would* cost before we charge
    // for anything — and the evidence for M6, the "has anyone asked to pay?"
    // gate condition. Deliberately info-level, not debug.
    logger.info(
      { tier, required: minimumTier, enforcement: 'off' },
      'tier requirement not met — allowed because enforcement is disabled'
    );
    return;
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    `This tool requires the '${minimumTier}' tier; your key resolves to '${tier}'. ` +
      `See https://www.thegavel.io/pricing and pass your key as ` +
      `'Authorization: Bearer <key>' to mcp.thegavel.io.`
  );
}

// ── Key → tier resolution ───────────────────────────────────────────────────
//
// MD5: gavel-indexer/lib/api-keys.js is THE implementation of "what tier is
// this key?". The MCP asks it over loopback rather than opening a second DB
// pool, so there is exactly one resolve path and one schema owner.
//
// The endpoint is loopback-only (it refuses any request carrying an
// X-Forwarded-For), so this must be the internal address, never the public
// api.thegavel.io hostname that upstream.ts uses.

const INTERNAL_URL = (
  process.env.GAVEL_API_INTERNAL_URL || 'http://127.0.0.1:4012'
).replace(/\/$/, '');
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || '';
const RESOLVE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  tier: Tier;
  expiresAt: number;
}

// Keyed by a hash of the token, never the token itself — this map is long-lived
// and shows up in heap dumps.
const tierCache = new Map<string, CacheEntry>();

function cacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function pruneCache(now: number): void {
  if (tierCache.size < 1_000) return;
  for (const [k, v] of tierCache) {
    if (v.expiresAt <= now) tierCache.delete(k);
  }
}

/**
 * Resolves a bearer token to the caller's product tier.
 *
 * FAILS OPEN to 'free' on every error path — unreachable endpoint, timeout,
 * non-200, malformed body, missing shared secret. A data MCP that 500s
 * because the key database hiccuped is worse than one that briefly serves
 * anonymous; and since enforcement is currently off (MD2), failing open costs
 * nothing today. Every failure is logged so a silent degradation to free is
 * visible rather than invisible.
 */
export async function resolveTier(token: string | null): Promise<Tier> {
  if (!token) return 'free';

  const now = Date.now();
  const key = cacheKey(token);
  const hit = tierCache.get(key);
  if (hit && hit.expiresAt > now) return hit.tier;

  if (!INTERNAL_SECRET) {
    logger.warn(
      'INTERNAL_API_SECRET unset — cannot resolve key tiers, treating every caller as free'
    );
    return 'free';
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RESOLVE_TIMEOUT_MS);

  try {
    const res = await fetch(`${INTERNAL_URL}/internal/resolve-tier`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      signal: abort.signal,
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'tier resolve returned non-200 — failing open to free');
      return 'free';
    }

    const body = (await res.json()) as { tier?: unknown; reason?: unknown };
    if (!isTier(body.tier)) {
      logger.error({ body }, 'tier resolve returned an unrecognised tier — failing open to free');
      return 'free';
    }

    tierCache.set(key, { tier: body.tier, expiresAt: now + CACHE_TTL_MS });
    pruneCache(now);
    return body.tier;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'tier resolve failed — failing open to free');
    return 'free';
  } finally {
    clearTimeout(timer);
  }
}
