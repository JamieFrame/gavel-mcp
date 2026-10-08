import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { collateralInput, COLLATERAL_DESCRIPTION, etherAbsent, ETHER_USD_LIMITATION } from './collateral.js';

// ============================================================================
// The observatory's venue tools — OB1 §1.3.
//
// Thin wrappers over the credit-market surface the indexer already serves:
//   list_venues     -> GET /v1/market/venues
//   get_venue       -> GET /v1/market/venues/:venue_id
//   compare_venues  -> GET /v1/venues/compare        (E5)
//
// The no-ranking rule is enforced UPSTREAM and must stay there: /v1/venues/compare
// sorts alphabetically by venue_id, refuses to float the Gavel row, and ships
// `ordering`, `comparison_caveat` and `is_not` in every payload. Nothing here
// re-sorts, scores or weights. VC-D2: no composite score, ever.
//
// These wrappers do not reshape upstream payloads (the D17 failure). `get_venue`
// ADDS a `pillars` view required by venue_reliability_criteria_v1 §4 and carries
// the original `attributes` object through untouched alongside it, so no cell
// acquires a second home. `list_venues` filters rows by caller-supplied criteria
// and echoes what it filtered — it never silently truncates.
//
// OB1 §0.1: no tool here names Gavel. The Gavel Protocol appears only as one row
// (`gavel_arbitrum`) produced by the same pipeline as every other row (VC-D3),
// and in the operator disclosure, which criteria §0.4 requires to travel with
// every row.
// ============================================================================

/** venue_reliability_criteria_v1. Rides in every payload (spec §4). */
const CRITERIA_SPEC_VERSION = 'venue_reliability_criteria_v1 (v1.2)';

/**
 * Why an unpopulated cell is unpopulated (criteria v1.1 §0.7, the research floor).
 * On a venue the upstream row marks `listed`, this dataset has DECIDED not to
 * research the criteria — the venue is aggregator-sourced and under the floor —
 * and saying "not researched yet" there would promise work nobody intends.
 */
function unresearchedReason(row: VenueRow): string {
  const t = row.research_tier;
  if (t?.tier === 'listed') {
    const floor = typeof t.floor_usd === 'number' ? `$${(t.floor_usd / 1e6).toFixed(0)}m` : 'the';
    return `below the research floor (criteria v1.1 §0.7): read only through an aggregator, and its 30-day book has not reached ${floor} in the last ${t.window_days ?? 90} days — listed, not researched`;
  }
  return 'not researched yet';
}

/**
 * Criteria spec §1–§3 — which pillar each RW12 attribute column belongs to.
 * A pillar view, not a re-scoring: every cell keeps its upstream {value, source}
 * verbatim, and a column the venue has not had researched stays absent rather
 * than becoming a null that could read as "none".
 */
const PILLARS: Record<'price' | 'quality' | 'composition', readonly string[]> = {
  price: ['rate_mechanism', 'term_certainty', 'rate_certainty'],
  quality: ['oracle_dependency', 'liquidation_mechanism', 'custody_model', 'recourse'],
  composition: ['collateral_asset'],
};

interface VenueRow {
  venue_id: string;
  venue_type?: string | null;
  status?: string | null;
  chain_id?: number | null;
  attributes?: Record<string, { value: unknown; source: unknown }> | null;
  attributes_complete?: number | null;
  attributes_total?: number | null;
  coverage?: Record<string, { level?: string | null }> | null;
  research_tier?: { tier?: string | null; basis?: string | null; floor_usd?: number | null; window_days?: number | null } | null;
  [k: string]: unknown;
}

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Build the three pillar objects from a venue row. Cells are copied by
 * reference from the upstream `attributes` map — value and source unaltered.
 * `unknown` is a value (criteria §0.3): a column upstream has not populated is
 * reported as not_researched with that named as the reason, never guessed.
 */
function buildPillars(row: VenueRow) {
  const attrs = row.attributes ?? {};
  const reason = unresearchedReason(row);
  const out: Record<string, Record<string, unknown>> = {};
  for (const [pillar, columns] of Object.entries(PILLARS)) {
    const cells: Record<string, unknown> = {};
    for (const col of columns) {
      const cell = attrs[col];
      cells[col] =
        cell && cell.value !== null && cell.value !== undefined
          ? { value: cell.value, source: cell.source }
          : { value: 'unknown', source: null, reason };
    }
    out[pillar] = cells;
  }
  // Coverage is the observability half of Composition — what the data can
  // support — and is reported beside it rather than folded into it.
  out.composition.coverage = row.coverage ?? null;
  return out;
}

export function registerVenueTools(server: McpServer): void {
  // ── list_venues ───────────────────────────────────────────────────────────
  server.registerTool(
    'list_venues',
    {
      title: 'Credit venues covered',
      description:
        `Which credit venues does this dataset cover, and what is known about each? ` +
        `Returns the registry rows matching the filters you supply.\n\n` +
        `One row per venue across four classes — on-chain protocols, CeFi desks, the ` +
        `corporate layer, and auction venues — each carrying its coverage state per ` +
        `pillar and how many of its criteria cells have been researched. Does not ` +
        `rank, score or order by any rate: rows are returned in the registry's own ` +
        `order. All filters are optional and unspecified means no constraint.\n\n` +
        `⚠ A venue's presence is not a statement about it. Coverage 'none' means ` +
        `nothing is ingested yet, which is a declared gap, not an observation about ` +
        `the venue.\n\n` +
        `${COLLATERAL_DESCRIPTION} With collateral: 'eth' only the venues that take ` +
        `ether as collateral are returned (a venue taking both appears under both).`,
      inputSchema: {
        collateral: collateralInput,
        venue_type: z
          .string()
          .optional()
          .describe(`Restrict to one class, e.g. 'onchain_pooled', 'cefi_desk', 'corporate_debt', 'auction'.`),
        status: z
          .string()
          .optional()
          .describe(`Restrict by registry status: 'live', 'ingesting', 'registered', 'unresolved', 'defunct'.`),
        chain_id: z.number().int().optional().describe(`Restrict to venues on one EVM chain id.`),
        complete_attributes_only: z
          .boolean()
          .optional()
          .describe(`Only venues whose criteria cells are fully researched (8 of 8). Default false.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Cap the rows returned. Default 50. The response always states the unfiltered total.`),
      },
    },
    async ({ collateral, venue_type, status, chain_id, complete_attributes_only, limit }) => {
      requireTier('free');
      // The route lists the bitcoin-scope venues by default; venues that take
      // only ether (Liquity, …) are outside that scope, so ether reads them all.
      const data = (await upstreamGet('/v1/market/venues', collateral === 'eth' ? { query: { scope: 'all' } } : {})) as {
        venues?: VenueRow[];
        count?: number;
        [k: string]: unknown;
      };
      const all = data.venues ?? [];
      // Which venues take the collateral asked for. The registry's own
      // collateral_set decides where rows carry it (A1); until they do, the
      // venues of the ether tree are the ones that take ether.
      let takes: ((v: VenueRow) => boolean) | null = null;
      let collateralBasis: string | undefined;
      if (collateral) {
        if (all.some((v) => Array.isArray(v.collateral_set))) {
          takes = (v) => Array.isArray(v.collateral_set) && (v.collateral_set as string[]).includes(collateral);
          collateralBasis = 'the registry row\'s collateral_set';
        } else if (collateral === 'eth') {
          const tree = (await upstreamGet('/v1/market/tree', { query: { collateral: 'eth' } })) as { venues?: Record<string, unknown> };
          const ids = new Set(Object.keys(tree.venues ?? {}));
          takes = (v) => ids.has(v.venue_id);
          collateralBasis = 'the venues of the ether tree (/v1/market/tree?collateral=eth); registry rows do not carry collateral_set yet';
        } else {
          collateralBasis = 'bitcoin: every registry row, as without the input';
        }
      }
      const filtered = all.filter((v) => {
        if (takes && !takes(v)) return false;
        if (venue_type && v.venue_type !== venue_type) return false;
        if (status && v.status !== status) return false;
        if (chain_id !== undefined && v.chain_id !== chain_id) return false;
        if (complete_attributes_only && v.attributes_complete !== v.attributes_total) return false;
        return true;
      });
      const cap = limit ?? 50;
      const rows = filtered.slice(0, cap);
      // Everything the envelope carried, minus the row array we are replacing.
      const { venues: _replaced, ...envelope } = data;
      return json({
        ...(collateral ? { collateral, collateral_basis: collateralBasis } : {}),
        ...envelope,
        criteria_spec_version: CRITERIA_SPEC_VERSION,
        filters_you_supplied: collateral
          ? { collateral, venue_type, status, chain_id, complete_attributes_only, limit: cap }
          : { venue_type, status, chain_id, complete_attributes_only, limit: cap },
        count_in_registry: all.length,
        count_matching_filters: filtered.length,
        count_returned: rows.length,
        truncated: filtered.length > rows.length,
        ordering: 'registry order. Not sorted by rate, and no venue is floated.',
        is_not: 'Not a ranking, not a shortlist, and not a statement that any listed venue is available to the reader.',
        venues: rows,
      });
    }
  );

  // ── get_venue ─────────────────────────────────────────────────────────────
  server.registerTool(
    'get_venue',
    {
      title: 'One venue against the published criteria',
      description:
        `What is known about this venue, criterion by criterion? The three pillars — ` +
        `Price, Quality, Composition — each cell with its value and the source it ` +
        `came from.\n\n` +
        `The criteria are published and versioned before any venue is measured ` +
        `against them, applied evenly to every row, and the spec version rides in ` +
        `this payload. There is no composite score, no stars and no reliability ` +
        `index: a reader weighs the criteria, and this server does not weigh them ` +
        `for the reader.\n\n` +
        `⚠ 'unknown' is a value, not an omission — a criterion that cannot be ` +
        `established from public sources says so with its reason. A class-specific ` +
        `'not_applicable' and an unresearched 'unknown' are different answers and ` +
        `are never conflated.\n\n` +
        `${COLLATERAL_DESCRIPTION} With collateral: 'eth' the criteria come with ` +
        `the venue's ether figures (the six tiles and books); a venue that does not ` +
        `take ether says so.`,
      inputSchema: {
        venue_id: z
          .string()
          .describe(`Registry id, e.g. 'aave_v3_arbitrum'. Call list_venues to discover valid ids.`),
        collateral: collateralInput,
      },
    },
    async ({ venue_id, collateral }) => {
      requireTier('free');
      const row = (await upstreamGet(`/v1/market/venues/${encodeURIComponent(venue_id)}`, {})) as VenueRow;
      if (collateral !== 'eth') {
        return json({
          ...(collateral === 'btc' ? { collateral: 'btc' } : {}),
          ...row,
          criteria_spec_version: CRITERIA_SPEC_VERSION,
          pillars: buildPillars(row),
        });
      }
      const head = (await upstreamGet('/v1/market/venue-headline', {
        query: { venue: venue_id, collateral: 'eth' },
      })) as { venues?: Array<Record<string, unknown>>; [k: string]: unknown };
      const figures = (head.venues ?? []).find((v) => v.venue_id === venue_id) ?? null;
      return json({
        collateral: 'eth',
        ...row,
        criteria_spec_version: CRITERIA_SPEC_VERSION,
        pillars: buildPillars(row),
        ...(figures
          ? {
              ether: {
                as_of: head.as_of,
                eth_rate: head.eth_rate,
                figures,
                usd_limitation: ETHER_USD_LIMITATION,
              },
            }
          : {
              ether: {
                absent: 'venue does not take eth',
                collateral_set: Array.isArray(row.collateral_set) ? row.collateral_set : undefined,
              },
            }),
      });
    }
  );

  // ── compare_venues (E5) ───────────────────────────────────────────────────
  // Description quoted UNALTERED from the copy pack §2.1 E5 row.
  server.registerTool(
    'compare_venues',
    {
      title: 'Credit cost across venues',
      description:
        `What does credit at this tenor and LTV cost across every venue Aletheia ` +
        `covers? One row per venue in coverage-matrix order — no ranking, no default ` +
        `sort, no "best".`,
      // ⚠ RW1, 2026-09-11. This schema offered `collateral` and `denomination`,
      // which the upstream route has never read — a filter that silently does
      // nothing is a false affordance to a model building its call — and did
      // not expose `side` or `venues`, which the spec (§4 E5) defines and the
      // route honours. The inputs below are exactly the ones upstream reads.
      inputSchema: {
        tenor_days: z.number().positive().optional().describe(`Loan term in days to compare at.`),
        ltv: z.number().min(0).max(1).optional().describe(`Loan-to-value as a decimal 0–1, not a percentage.`),
        side: z.enum(['borrow', 'lend']).optional().describe(`'borrow' (what a borrower pays, the default) or 'lend' (what a capital provider earns).`),
        venues: z.string().optional().describe(`Comma-separated registry ids to restrict the rows to, e.g. 'aave_v3_ethereum,cefi_ledn'.`),
        class: z.enum(['algorithmic', 'minted', 'auction', 'posted-card', 'corporate']).optional()
          .describe(`Restrict to one credit class. The full matrix is ~160 rows; one class is far lighter.`),
        // ⚠ RW1 above: this input is read. 'eth' returns a structured absence
        // naming where the ether figures are, never the bitcoin matrix.
        collateral: collateralInput,
      },
    },
    async ({ tenor_days, ltv, side, venues, class: cls, collateral }) => {
      requireTier('free');
      if (collateral === 'eth') {
        return json({
          ...etherAbsent(
            'a tenor and LTV comparison: /v1/venues/compare prices bitcoin-secured credit only',
            "Each venue's ether rates and LTV: get_venue with collateral: 'eth'; the ether market by class: get_credit_state with collateral: 'eth'.",
          ),
          criteria_spec_version: CRITERIA_SPEC_VERSION,
        });
      }
      const data = (await upstreamGet('/v1/venues/compare', {
        query: { tenor_days, ltv, side, venues, class: cls },
      })) as Record<string, unknown>;
      // Passed through untouched — ordering, comparison_caveat, is_not and the
      // concentration note are built upstream and are the compliance surface.
      return json({ ...(collateral === 'btc' ? { collateral: 'btc' } : {}), ...data, criteria_spec_version: CRITERIA_SPEC_VERSION});
    }
  );
}
