import { z } from 'zod';

// ============================================================================
// The collateral dimension — EC1 Phase 4 (ec1_api_mcp_collateral_v1.md §5;
// operator 2026-10-07 A3: an input on the existing tools, not new tools).
//
// Bitcoin is the default and the default does not move: a call WITHOUT
// `collateral` reaches exactly the route it reached before and returns exactly
// what it returned. An explicit `collateral: 'btc'` returns the same payload
// plus a top-level `collateral: 'btc'`.
//
// ⚠ WHERE ETHER LIVES (operator 2026-10-08: route in the MCP). The ether figures
// are served on the tree routes (/v1/market/tree, /tree-history and
// /venue-headline with ?collateral=eth), not on credit-state, composition or
// /v1/venues/compare, which describe bitcoin only. So `collateral: 'eth'` routes
// to the tree; a tool whose surface has no ether figure returns a STRUCTURED
// ABSENCE that says so and names where the ether figures are — never the
// bitcoin payload under an ether label, and never an empty success.
//
// Ether is never added to bitcoin. Nothing here sums across the two.
// ============================================================================

export type Collateral = 'btc' | 'eth';

export const COLLATERAL_DESCRIPTION =
  `Bitcoin by default; pass collateral: 'eth' for credit secured by ether ` +
  `(ether, staking and restaking tokens at their own contract rates), measured the ` +
  `same way and never added to bitcoin.`;

export const collateralInput = z.enum(['btc', 'eth']).optional().describe(COLLATERAL_DESCRIPTION);

/** The sentence every ether payload carries about its dollars. */
export const ETHER_USD_LIMITATION =
  'USD here is the on-chain basket dollar; ether tokens count at their contract rate, ' +
  'the market peg published beside it. Credit secured by ether is never added to credit ' +
  'secured by bitcoin.';

/** A tool whose surface has no ether figure says so, and where to look instead. */
export function etherAbsent(what: string, instead: string) {
  return {
    collateral: 'eth' as const,
    absent: `no ether figure is served for ${what}`,
    instead,
  };
}

/**
 * The ether tree without its lower levels. The full payload is ~600 KB (every
 * family and venue node with its children); an agent asking for the market
 * gets the market, its secured view and its classes, each with the same six
 * figures, books and limitations as served, and is told how to go deeper.
 */
export function etherTreeTop(tree: Record<string, any>) {
  const strip = (n: any) => {
    if (!n || typeof n !== 'object') return n;
    const { children, ...rest } = n;
    return { ...rest, children_ids: Array.isArray(children) ? children : undefined };
  };
  const { families, venues, market, market_secured, classes, ...envelope } = tree;
  return {
    ...envelope,
    market: strip(market),
    market_secured: strip(market_secured),
    classes: Object.fromEntries(Object.entries(classes ?? {}).map(([k, c]) => [k, strip(c)])),
    lower_levels: {
      families: Object.keys(families ?? {}).length,
      venues: Object.keys(venues ?? {}).length,
      venue_ids: Object.keys(venues ?? {}),
      how_to_read: "Each venue's ether figures: get_venue with collateral: 'eth'.",
    },
    usd_limitation: ETHER_USD_LIMITATION,
  };
}
