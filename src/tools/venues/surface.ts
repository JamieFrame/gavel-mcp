import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { collateralInput, COLLATERAL_DESCRIPTION, etherAbsent, etherTreeTop, ETHER_USD_LIMITATION } from './collateral.js';

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
//   get_liquidation_map       -> GET /v1/market/liquidation-map(/history)  (HX1 Phase 4, 2026-10-08)
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
const CRITERIA_SPEC_VERSION = 'venue_reliability_criteria_v1 (v1.2)';

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
        `contributed are counted separately as unavailable.\n\n` +
        `${COLLATERAL_DESCRIPTION} With collateral: 'eth' this returns the ether ` +
        `market: the same six figures at market and class level, books per loan ` +
        `currency (ether lent against ether is its own book, outside the headline).`,
      inputSchema: { collateral: collateralInput },
    },
    async ({ collateral }) => {
      requireTier('free');
      if (collateral === 'eth') {
        const tree = (await upstreamGet('/v1/market/tree', { query: { collateral: 'eth' } })) as Record<string, unknown>;
        return withDisclosure(etherTreeTop(tree));
      }
      const data = await upstreamGet('/v1/market/credit-state', {});
      return withDisclosure(collateral === 'btc' ? { collateral: 'btc', ...(data as Record<string, unknown>) } : data);
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
        `per-point coverage is what distinguishes them.\n\n` +
        `${COLLATERAL_DESCRIPTION} The ether series starts on 2026-10-08 and runs ` +
        `forward; earlier ether history is not back-filled yet.`,
      inputSchema: {
        days: z.number().int().min(1).max(3650).optional()
          .describe(`How many days of history. Default 365, capped at 3650.`),
        collateral: collateralInput,
      },
    },
    async ({ days, collateral }) => {
      requireTier('free');
      if (collateral === 'eth') {
        const hist = (await upstreamGet('/v1/market/tree-history', { query: { collateral: 'eth' } })) as {
          points?: Array<{ date?: string }>;
          [k: string]: unknown;
        };
        // The route serves the whole series; `days` is applied here, as the bitcoin route applies it upstream.
        const window = days ?? 365;
        const from = new Date(Date.now() - window * 86_400_000).toISOString().slice(0, 10);
        const points = (hist.points ?? []).filter((p) => (p.date ?? '') >= from);
        return withDisclosure({
          ...hist,
          points,
          days: window,
          history_starts: '2026-10-08 (forward only; back-fill family by family later, each with its own check)',
          usd_limitation: ETHER_USD_LIMITATION,
        });
      }
      const data = await upstreamGet('/v1/market/credit-state/history', { query: { days } });
      return withDisclosure(collateral === 'btc' ? { collateral: 'btc', ...(data as Record<string, unknown>) } : data);
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
        `tool describes one venue family, not Bitcoin-collateralised credit.\n\n` +
        `${COLLATERAL_DESCRIPTION} No ether composition series is served yet; ` +
        `with collateral: 'eth' this says so and points to the ether figures.`,
      inputSchema: { collateral: collateralInput },
    },
    async ({ collateral }) => {
      requireTier('free');
      if (collateral === 'eth') {
        return withDisclosure(etherAbsent(
          'market composition (rate type, recourse, instrument): these series are computed from Morpho Blue bitcoin markets only',
          "The ether market by class (algorithmic, minted, posted card) and its native / staking / restaking split: get_credit_state with collateral: 'eth'.",
        ));
      }
      const data = await upstreamGet('/v1/market/composition', {});
      return withDisclosure(collateral === 'btc' ? { collateral: 'btc', ...(data as Record<string, unknown>) } : data);
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

  server.registerTool(
    'get_liquidation_map',
    {
      title: 'Where bitcoin-secured debt is liquidated',
      description:
        `How much bitcoin-secured dollar debt is liquidated at which bitcoin price, ` +
        `for the market, a class or a venue? An identity on observed positions: ` +
        `each bitcoin-only position at the price its OWN venue's rule liquidates ` +
        `it, summed into $1,000 buckets, with the debt within 10/20/30% of each ` +
        `venue's own mark, the debt already past its venue's test, and overflow.\n\n` +
        `It does not forecast what a fall in the price would do, it does not rank ` +
        `venues (they are listed by name) and it gives no verdict such as "at risk".\n\n` +
        `⚠ Read coverage and not_bucketed first. Only venues read position by ` +
        `position are in the map (the pooled venues, Morpho on Ethereum and Base, ` +
        `Sky); every other venue with debt is named with its reason and is never ` +
        `scaled up. With history=true the bands come as a daily series: Sky from ` +
        `2020-05-03, the rest from 2026-10-08 — a step there is coverage, not the market.`,
      inputSchema: {
        level: z.enum(['market', 'class', 'venue']).optional().describe('Default market.'),
        id: z.string().optional().describe('A class id (algorithmic, minted, ...) or a venue id; required below the market.'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('A day held; default the latest.'),
        history: z.boolean().optional().describe('Return the bands through time instead of one day\'s buckets.'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('With history: the first day.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('With history: the last day.'),
        as_known_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('With history: the bands as published at the end of that day (UTC).'),
      },
    },
    async ({ level, id, date, history, from, to, as_known_on }) => {
      requireTier('free');
      return withDisclosure(history
        ? await upstreamGet('/v1/market/liquidation-map/history', { query: { level, id, from, to, as_known_on } })
        : await upstreamGet('/v1/market/liquidation-map', { query: { level, id, date } }));
    }
  );
}
