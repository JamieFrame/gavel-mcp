import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { OBSERVATORY_DISCLOSURE } from '../../profiles.js';

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
const CRITERIA_SPEC_VERSION = 'venue_reliability_criteria_v1 (v1.0)';

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
  const out: Record<string, Record<string, unknown>> = {};
  for (const [pillar, columns] of Object.entries(PILLARS)) {
    const cells: Record<string, unknown> = {};
    for (const col of columns) {
      const cell = attrs[col];
      cells[col] =
        cell && cell.value !== null && cell.value !== undefined
          ? { value: cell.value, source: cell.source }
          : { value: 'unknown', source: null, reason: 'not researched yet' };
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
        `the venue.`,
      inputSchema: {
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
    async ({ venue_type, status, chain_id, complete_attributes_only, limit }) => {
      requireTier('free');
      const data = (await upstreamGet('/v1/market/venues', {})) as {
        venues?: VenueRow[];
        count?: number;
        [k: string]: unknown;
      };
      const all = data.venues ?? [];
      const filtered = all.filter((v) => {
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
        ...envelope,
        criteria_spec_version: CRITERIA_SPEC_VERSION,
        filters_you_supplied: { venue_type, status, chain_id, complete_attributes_only, limit: cap },
        count_in_registry: all.length,
        count_matching_filters: filtered.length,
        count_returned: rows.length,
        truncated: filtered.length > rows.length,
        ordering: 'registry order. Not sorted by rate, and no venue is floated.',
        is_not: 'Not a ranking, not a shortlist, and not a statement that any listed venue is available to the reader.',
        observatory_disclosure: OBSERVATORY_DISCLOSURE,
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
        `are never conflated.`,
      inputSchema: {
        venue_id: z
          .string()
          .describe(`Registry id, e.g. 'aave_v3_arbitrum'. Call list_venues to discover valid ids.`),
      },
    },
    async ({ venue_id }) => {
      requireTier('free');
      const row = (await upstreamGet(`/v1/market/venues/${encodeURIComponent(venue_id)}`, {})) as VenueRow;
      return json({
        ...row,
        criteria_spec_version: CRITERIA_SPEC_VERSION,
        pillars: buildPillars(row),
        observatory_disclosure: OBSERVATORY_DISCLOSURE,
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
      inputSchema: {
        tenor_days: z.number().positive().optional().describe(`Loan term in days to compare at.`),
        ltv: z.number().min(0).max(1).optional().describe(`Loan-to-value as a decimal 0–1, not a percentage.`),
        collateral: z.string().optional().describe(`Collateral asset symbol, e.g. 'BTC'.`),
        denomination: z.string().optional().describe(`Loan denomination, e.g. 'USD'.`),
      },
    },
    async ({ tenor_days, ltv, collateral, denomination }) => {
      requireTier('free');
      const data = (await upstreamGet('/v1/venues/compare', {
        query: { tenor_days, ltv, collateral, denomination },
      })) as Record<string, unknown>;
      // Passed through untouched — ordering, comparison_caveat, is_not and the
      // concentration note are built upstream and are the compliance surface.
      return json({ ...data, criteria_spec_version: CRITERIA_SPEC_VERSION, observatory_disclosure: OBSERVATORY_DISCLOSURE });
    }
  );
}
