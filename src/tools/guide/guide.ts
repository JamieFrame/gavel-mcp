import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { activeProfile } from '../../profiles.js';
import { INDICATORS, catalogueFor, isAnchored } from '../indicators/catalogue.js';
import { LENSES } from '../../prompts/lenses.js';

// ============================================================================
// get_guide — what this server covers, counted when asked (MR1 Phase 2).
//
// aletheia-docs runbooks/PLANNED/runbook_MR1_stack_mcp_refinement_v1.md, MR-D3
// and Gate 0 G0-5. The server's self-description stated no count at all (SA1
// rubric gap 2), and the counts that did appear in tool descriptions were typed
// and had gone stale ("the other 161", "~160 rows", "8 of 8", "four classes").
// design_system.md §1 binds this server as it binds the site: a number in prose
// is read from the data, or it is not written.
//
// So the descriptions keep no counts, and this tool reads every count from the
// same routes the tools read, each with a sentence saying what it counts —
// because the registry, the comparison and the credit-state reading each count
// a different set of venues, and a bare number does not say which (H-12, H-17).
//
// Phase 5 adds the standard questions to this same tool (G0-5).
// ============================================================================

const SITE = 'https://www.bitcoincreditstack.com';
const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; body: Record<string, unknown> } | null = null;

type Venue = { venue_id: string; venue_type?: string; status?: string; scope?: string; collateral_set?: string[] };

function tally<T>(rows: T[], key: (r: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) ?? 'none';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function scope(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  const profile = activeProfile();

  const [registry, compare, state, series] = await Promise.all([
    upstreamGet('/v1/market/venues', { query: { scope: 'all' } }) as Promise<{ venues?: Venue[] }>,
    upstreamGet('/v1/venues/compare', {}) as Promise<{ result?: { rows?: Array<{ venue_id: string; class?: string | null }> } }>,
    upstreamGet('/v1/market/credit-state', {}) as Promise<{ snapshot_date?: string; coverage?: { venues_in_universe?: number; venues_contributing?: number; venues_absent?: unknown[] } }>,
    upstreamGet('/v1/onchain/series', {}) as Promise<{ count?: number; series?: unknown[] }>,
  ]);

  const all = registry.venues ?? [];
  const btc = all.filter((v) => v.scope === 'bitcoin_collateral');
  const rows = compare.result?.rows ?? [];
  const served = catalogueFor(profile.id);
  const tools = profile.tools.map((t) => profile.renames[t] ?? t);

  const body = {
    about:
      'What this server covers, counted from the data when you ask (cached for ten minutes). ' +
      'Each count says what it counts: the registry, the rate comparison and the credit-state reading each count a different set of venues.',
    read_at: new Date().toISOString(),
    server: {
      name: profile.serverName,
      version: profile.serverVersion,
      tools,
      tool_count: tools.length,
      write_tools: 0,
      counted: 'the tools this server lists in tools/list; none of them signs, submits or prepares a transaction',
    },
    venues: {
      registry: {
        count: all.length,
        by_scope: tally(all, (v) => v.scope),
        counted:
          'every venue the registry holds, by scope: bitcoin_collateral are the venues that take bitcoin as collateral, ' +
          'the set the Stack\'s bitcoin figures are measured over; no_bitcoin_collateral take none',
      },
      bitcoin_scope_by_venue_type: {
        counts: tally(btc, (v) => v.venue_type),
        counted: 'the bitcoin-scope venues by how each is built (list_venues venue_type)',
      },
      bitcoin_scope_by_status: {
        counts: tally(btc, (v) => v.status),
        counted: 'the bitcoin-scope venues by registry status (list_venues status)',
      },
      by_credit_class: {
        count: rows.length,
        counts: tally(rows, (r) => r.class),
        without_class: rows.filter((r) => !r.class).map((r) => r.venue_id),
        counted:
          'the venues in the rate comparison (compare_venues) by how their rate is set — the classes the Stack\'s pages use. ' +
          'A venue in "none" has no credit class',
      },
      credit_state_coverage: {
        as_of: state.snapshot_date ?? null,
        venues_in_universe: state.coverage?.venues_in_universe ?? null,
        venues_contributing: state.coverage?.venues_contributing ?? null,
        venues_absent: Array.isArray(state.coverage?.venues_absent) ? state.coverage!.venues_absent!.length : null,
        counted:
          'the credit-state reading (get_credit_state). Its universe is the bitcoin-scope venues that are not defunct or retired; ' +
          'contributing are those whose figures entered the latest reading; the absent ones are named, with why, in that reading',
      },
      taking_ether: {
        count: all.filter((v) => Array.isArray(v.collateral_set) && v.collateral_set.includes('eth')).length,
        counted: "venues whose registry row lists ether among the collateral they take (list_venues with collateral: 'eth')",
      },
    },
    indicators: {
      served: served.filter((i) => i.live).length,
      retired: served.filter((i) => !i.live).map((i) => i.id),
      withheld: INDICATORS.filter(isAnchored).map((i) => i.id),
      not_published: INDICATORS.filter((i) => !isAnchored(i) && i.stack).map((i) => i.id),
      counted:
        'served: the indicators get_indicator answers here. retired: kept in the catalogue, answered with why. ' +
        "withheld: indicators that measure one venue against the market, served by that venue's own server. " +
        'not_published: retired, held or merged on the Stack, answered with why (list_indicators names each)',
    },
    series: {
      chain_series: series.count ?? (Array.isArray(series.series) ? series.series.length : null),
      counted: 'the chain, miner, price and exchange-rate series list_chain_series serves, each readable as known on a past date',
    },
    lenses: {
      count: LENSES.length,
      counted: 'reading procedures get_lens serves; each names the tools it uses',
    },
    two_vocabularies: {
      venue_type: 'how a venue is built: on-chain pool, isolated market, CDP, custodial desk, broker, corporate issuer, auction',
      credit_class: 'how its rate is set: algorithmic, minted, posted-card, auction, corporate. The Stack\'s pages are organised by class',
    },
    absences:
      'A figure that is not there is returned with its kind and the reason, never as a zero: a point whose kind begins ' +
      '"absent:" names why it is missing; a criterion that could not be established is "unknown" with its reason; a question ' +
      'that does not apply to a venue is "not_applicable".',
    collateral: 'Bitcoin by default. Ether is measured the same way and never added to bitcoin; tools that read it take collateral: \'eth\', and the others refuse it.',
    on_the_site: {
      home: SITE,
      methodology: `${SITE}/methodology`,
      connect: `${SITE}/connect`,
    },
  };
  cache = { at: Date.now(), body };
  return body;
}

export async function guideScope(): Promise<Record<string, unknown>> {
  return scope();
}

export function registerGuideTool(server: McpServer): void {
  server.registerTool(
    'get_guide',
    {
      title: 'What this server covers',
      description:
        `What does this server cover, and how much of it? The tools; the venues by registry scope, ` +
        `venue type, status and credit class; the credit-state reading's coverage; the indicators served, ` +
        `retired and not published here; the series; and the lenses — every count read from the data ` +
        `when asked, each with a sentence saying what it counts. Also the two venue vocabularies ` +
        `(venue type and credit class), how absences are returned, and where the methodology is.\n\n` +
        `Call this first when you need to say how much the Stack covers. It ranks nothing and ` +
        `describes no venue's quality.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return { content: [{ type: 'text' as const, text: JSON.stringify(await scope()) }] };
    }
  );
}
