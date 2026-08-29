import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// The cross-venue market surface — OB1 §1.2's "surface, analytics".
//
// The draft disposition table listed these as "not yet built". That was wrong:
// the REST endpoints exist and have been serving the Gavel frontend's data
// section for some time. What did not exist was an MCP tool over them.
//
//   get_credit_state          -> GET /v1/market/credit-state
//   get_credit_state_history  -> GET /v1/market/credit-state/history
//   get_market_composition    -> GET /v1/market/composition
//   get_market_flows          -> GET /v1/market/flows
//
// ⚠ ONLY get_credit_state IS GENUINELY CROSS-VENUE (15 of 20 venues at the
// current reading, with the 5 absent ones named). /v1/market/composition and
// /v1/market/flows are computed from MORPHO BLUE ONLY and say so in their own
// `scope.statement`. Their tool descriptions must lead with that: a description
// is what an agent reads BEFORE the payload, so a description claiming
// "across venues" over a single-family payload is the lie, even when the
// payload underneath is honest.
//
// THIS IS WHERE GAVEL'S RATE LIVES ON THE OBSERVATORY. Operator ruling
// 2026-08-29 (D-A): `get_yield_curve` is Gavel-only, because a tool returning
// one venue's own curve under its own name is a surface no other venue gets.
// These payloads are computed ACROSS the venue universe — the current reading
// covers 15 of 20 venues and names the 5 absent ones — so Gavel appears in
// them the same way Aave, Morpho, Sky and the CeFi desks do: as a contributor,
// not as a heading.
//
// ⚠ NOT wrapped, deliberately: /v1/market/rates/comparison. Its payload carries
// `gavel_7d_rate`, `gavel_30d_rate` and `gavel_90d_rate` as named fields while
// every other venue gets a single `*_apy` field. That is a dashboard shape with
// one venue privileged, and on the observatory it would be the "Gavel-special"
// the gate forbids. If the Stack needs that comparison it needs a uniform
// per-venue row shape first — which is what /v1/venues/compare already is.
//
// Thin wrappers: coverage, absence and provenance are computed upstream and
// pass through untouched.
// ============================================================================

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/** criteria spec version rides in every observatory payload. */
const CRITERIA_SPEC_VERSION = 'venue_reliability_criteria_v1 (v1.0)';

const withDisclosure = (data: unknown) => json({
  ...(data as Record<string, unknown>),
  criteria_spec_version: CRITERIA_SPEC_VERSION,
});

export function registerSurfaceTools(server: McpServer): void {
  server.registerTool(
    'get_credit_state',
    {
      title: 'The Bitcoin credit surface, now',
      description:
        `What does Bitcoin-collateralised credit cost and how much of it is ` +
        `outstanding, across the venues this dataset covers? One reading ` +
        `aggregated over the venue universe, not any single venue's book.\n\n` +
        `Carries the term structure, outstanding quantity, valuation, collateral ` +
        `mix and quality composition, with the coverage block stating how many ` +
        `venues contributed and naming the ones that did not. No venue is ` +
        `weighted up, floated or reported under its own heading.\n\n` +
        `⚠ Read coverage before reading the figures. A venue absent from this ` +
        `reading is a declared gap, not a zero, and the rows it would have ` +
        `contributed are counted separately as unavailable.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return withDisclosure(await upstreamGet('/v1/market/credit-state', {}));
    }
  );

  server.registerTool(
    'get_credit_state_history',
    {
      title: 'The Bitcoin credit surface over time',
      description:
        `How has the Bitcoin credit surface moved? The same cross-venue reading ` +
        `as get_credit_state, as a daily series.\n\n` +
        `Each point carries the coverage that produced it, so a change in the ` +
        `series and a change in which venues were observable can be told apart. ` +
        `This is descriptive data; it does not forecast and it does not ` +
        `characterise a trend.\n\n` +
        `⚠ Coverage is not constant through the series. A move in a figure may be ` +
        `a move in the market or a venue entering or leaving observation — the ` +
        `per-point coverage is what distinguishes them.`,
      inputSchema: {
        days: z.number().int().min(1).max(3650).optional()
          .describe(`How many days of history. Default 365, capped at 3650.`),
      },
    },
    async ({ days }) => {
      requireTier('free');
      return withDisclosure(await upstreamGet('/v1/market/credit-state/history', { query: { days } }));
    }
  );

  server.registerTool(
    'get_market_composition',
    {
      title: 'What this credit market is made of',
      description:
        `What kinds of credit make up this market, and in what proportions? ` +
        `⚠ These series are computed from MORPHO BLUE ONLY, on Ethereum and ` +
        `Base. They are not market-wide.\n\n` +
        `Composition by rate type, recourse and instrument, reported as observed ` +
        `shares with the scope that produced them. There is no ranking of venues ` +
        `or instrument types and no judgement about which composition is ` +
        `preferable.\n\n` +
        `⚠ The scope block names the contributing venues and states why the ` +
        `others are absent — Aave v3 is mid-backfill, Compound v3 and Sky are not ` +
        `yet ingested. Read it before quoting any share. A percentage from this ` +
        `tool describes one venue family, not Bitcoin-collateralised credit.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return withDisclosure(await upstreamGet('/v1/market/composition', {}));
    }
  );

  server.registerTool(
    'get_market_flows',
    {
      title: 'Credit created and retired',
      description:
        `How much credit was created and retired, and over what period? Latest, ` +
        `trailing 30 days, and since inception. ⚠ These series are computed from ` +
        `MORPHO BLUE ONLY, on Ethereum and Base. They are not market-wide.\n\n` +
        `Counts and amounts as observed, with the scope, coverage and validation ` +
        `state that produced them. Not a forecast, not a momentum signal, and not ` +
        `a characterisation of demand.\n\n` +
        `⚠ Creation and retirement are GROSS and are never netted into one signed ` +
        `series: a day of heavy churn and a quiet day can net to the same number ` +
        `and are not the same market. USD-denominated debt only.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return withDisclosure(await upstreamGet('/v1/market/flows', {}));
    }
  );
}
