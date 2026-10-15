import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

/**
 * MR1 Phase 4 (operator, Gate 4a 2026-10-11; aletheia-docs data/specs/mcp_tool_disposition_v1.md §5).
 * The series layer and the three table tools. Each reads one gavel-indexer route and returns it as served:
 *   list_series                -> GET /v1/series                       (catalogue)
 *   get_series                 -> GET /v1/series/values                (history; as-known-on with as_known_on)
 *   get_corporate_instruments  -> GET /v1/market/corporate/instruments (snapshot)
 *   get_desk_rates             -> GET /v1/market/cefi-rates            (snapshot)
 *   get_debt_by_collateral     -> GET /v1/market/debt-by-collateral    (snapshot)
 *   get_events                 -> GET /v1/market/events                (reading; EV1 Phase 2, free)
 * The chart plan is the API's (one home, G0-2): panels by unit, two at most, the explorer's refusals in its
 * words, ether and bitcoin never on one panel, and the /explore link that draws the same chart. No image.
 * Values are identities on observed data: no forecast, no ranking, no characterisation.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISCLAIMER =
  'Informational. Aletheia Analytics SASU operates this interface and data product. No guarantee of ' +
  'accuracy, and nothing here is a recommendation.';
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
const GROUPS = ['Cost of credit', 'Size and leverage', 'Liquidation', 'Wrapped bitcoin', 'Holders and spending', 'Miners', 'Context'] as const;
const date = (what: string) => z.string().regex(DATE, `${what} must be YYYY-MM-DD`);
// The public address that serves the same chart get_chart returns (MN1 Phase 5).
const PUBLIC_API = (process.env.STACK_PUBLIC_API_BASE || 'https://api.bitcoincreditstack.com').replace(/\/$/, '');

export function registerSeriesTools(server: McpServer): void {
  server.registerTool(
    'list_series',
    {
      title: 'Every chartable series (catalogue)',
      description:
        `Lists the series the Stack serves, across every dataset: the credit tree at every level (market, ` +
        `class, family, venue) and figure, for bitcoin and, separately, for ether collateral; the liquidation ` +
        `map's bands; the credit x on-chain measures and their sub-series; the governed indices; wrapper reserve ` +
        `coverage; the chain, miner, on-chain price and FX series from Aletheia's own node; the Treasury curve ` +
        `(H.15); SOFR and the stablecoin total. Each row: id, label, unit, group, collateral, cadence, kinds, ` +
        `first and last date, licence, the site page that shows it, whether it can be charted (and why not), ` +
        `and whether the site's explorer draws it.\n\n` +
        `Paged: 100 rows by default (limit up to 500); pass the returned \`next\` as cursor. Narrow with dataset, ` +
        `group, collateral, prefix (e.g. 'credit.class.algorithmic.') or q (a word in the id or label). ` +
        `Then fetch values with get_series.`,
      inputSchema: {
        dataset: z.string().optional().describe(`A dataset from the answer's \`datasets\`, e.g. credit_tree, credit_tree_eth, cx, chain_series, macro`),
        group: z.enum(GROUPS).optional().describe('One of the explorer\'s picker groups'),
        collateral: z.enum(['btc', 'eth']).optional().describe('Series measured against bitcoin or against ether collateral; never added together'),
        prefix: z.string().optional().describe(`Series id prefix, e.g. 'credit.venue.aave_v3_ethereum.' or 'cx.market.'`),
        q: z.string().optional().describe('A word to find in the id or label'),
        chartable_only: z.boolean().optional().describe('Leave out series that cannot be drawn on a time chart'),
        limit: z.number().int().min(1).max(500).optional().describe('Rows per page, 1 to 500 (default 100)'),
        cursor: z.number().int().min(0).optional().describe('The `next` value of the previous page'),
      },
    },
    async ({ dataset, group, collateral, prefix, q, chartable_only, limit, cursor }) => {
      requireTier('free');
      const data = await upstreamGet<Record<string, unknown>>('/v1/series', {
        query: { dataset, group, collateral, prefix, q, chartable: chartable_only ? 'true' : undefined, limit: limit ?? 100, cursor },
      });
      return text({ ...data, disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_series',
    {
      title: 'Series through time, with a chart plan',
      description:
        `Returns 1 to 13 series (ids from list_series), each on its own dates, from Aletheia's vintage store: ` +
        `every value with its date and kind (an absence is a kind with its reason, never a zero), the unit, ` +
        `source, limitation and the vintages the values came from. Default window: the last 365 days to \`to\`; ` +
        `pass \`from\` for the full history. With as_known_on, each series is returned as the store held it at the ` +
        `end of that day (UTC), so a figure quoted then can be reproduced.\n\n` +
        `With the data comes a chart plan, as the site's explorer draws: panels by unit, two at most, a series ` +
        `joining the panel of its exact unit; a third unit is refused in the explorer's words; ether and bitcoin ` +
        `collateral are never drawn on one panel; each refusal names its reason. The plan carries the ` +
        `/explore link that draws the same chart on the site, and a text alternative per panel. plan: 'only' ` +
        `returns the plan without the values; plan: false the values without the plan.\n\n` +
        `Values resting on CoinGecko prices carry coingecko_share or price_today, and the answer's attribution ` +
        `names every source to credit: show them with the values. This tool returns data; it does not advise, ` +
        `forecast or characterise the market.`,
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(13).describe(`Series ids from list_series, e.g. ['cx.index.bsbs', 'cx.market.secured.borrow_spread_over_ust_3m']`),
        from: date('from').optional().describe('First date, YYYY-MM-DD (default: 365 days before `to`)'),
        to: date('to').optional().describe('Last date, YYYY-MM-DD (default: today)'),
        as_known_on: date('as_known_on').optional().describe('YYYY-MM-DD: every series as the store held it at the end of that day (UTC)'),
        plan: z.union([z.boolean(), z.literal('only')]).optional().describe(`true (default): values and the chart plan; false: values only; 'only': the plan only`),
      },
    },
    async ({ ids, from, to, as_known_on, plan }) => {
      requireTier('free');
      const data = await upstreamGet<Record<string, unknown>>('/v1/series/values', {
        query: { ids: ids.join(','), from, to, as_known_on, plan: plan == null ? undefined : String(plan) },
      });
      return text({ ...data, disclaimer: DISCLAIMER });
    }
  );

  // MN1 Phase 5 (operator 2026-10-12): the API is the one home of the house-style renderer
  // (gavel-indexer GET /v1/series/chart.svg); this tool hands its picture on. Free: a render is a
  // picture of a series, not the series (D8).
  server.registerTool(
    'get_chart',
    {
      title: 'A chart of series, drawn in the house style',
      description:
        `Draws the series get_series would return for the same request (ids from list_series, the same ` +
        `window and as_known_on) as an SVG image in the Stack's house style: exactly the chart plan's ` +
        `panels, one unit each; rate axes from zero; a refused series not drawn; an absence a gap, never a ` +
        `zero; coverage steps marked; the sources, span, number of values, any as-known-on date and every ` +
        `credit printed under the chart, with the link that draws it on the site. size: 'site' (default) or ` +
        `'post' (a social-post format); log: 'upper' or 'lower' draws that panel on a log axis where the ` +
        `plan offers one; title adds a heading.\n\n` +
        `Returns the SVG as an embedded resource (image/svg+xml) and the public URL that serves the same ` +
        `image, so it can be shown or linked. A request whose series the plan draws none of is refused with ` +
        `the plan's reasons. Show the credits with the chart. This tool draws data; it does not advise, ` +
        `forecast or characterise the market.`,
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(13).describe(`Series ids from list_series, e.g. ['cx.index.bsbs', 'cx.market.secured.borrow_spread_over_ust_3m']`),
        from: date('from').optional().describe('First date, YYYY-MM-DD (default: a year before `to`)'),
        to: date('to').optional().describe('Last date, YYYY-MM-DD (default: today)'),
        as_known_on: date('as_known_on').optional().describe('YYYY-MM-DD: every series as the store held it at the end of that day (UTC)'),
        size: z.enum(['site', 'post']).optional().describe(`'site' (default) or 'post'`),
        log: z.enum(['upper', 'lower']).optional().describe('Draw that panel on a log axis, where the plan offers one'),
        title: z.string().max(160).optional().describe('A heading for the chart'),
      },
    },
    async ({ ids, from, to, as_known_on, size, log, title }) => {
      requireTier('free');
      const query = { ids: ids.join(','), from, to, as_known_on, size, log, title };
      const svg = await upstreamGet<string>('/v1/series/chart.svg', { query, responseType: 'text' });
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null) as Array<[string, string]>);
      const url = `${PUBLIC_API}/v1/series/chart.svg?${qs}`;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ url, mime_type: 'image/svg+xml', note: 'The image is the resource below; the URL serves the same chart. Its sources and credits are printed in it.', disclaimer: DISCLAIMER }, null, 2) },
          { type: 'resource' as const, resource: { uri: url, mimeType: 'image/svg+xml', text: svg } },
        ],
      };
    }
  );

  server.registerTool(
    'get_corporate_instruments',
    {
      title: 'Corporate instruments (preferreds and debt)',
      description:
        `Lists the instruments of the corporate issuers in the registry (convertible notes, credit facilities, ` +
        `bonds, perpetual preferreds), one row per instrument, as the site's /instruments pages show them: ` +
        `terms, seniority, the yield a holder receives where a last regular-session trade prices it, returns, ` +
        `and the issuer's bitcoin holdings. The holding is the latest-dated figure read from a filing; ` +
        `btc_holdings_derived, beside it, is the last read plus the purchases filed since ("derived from filed ` +
        `purchases"), display only, never in backing_ratio, and confirmed or corrected by the next read. ` +
        `Corporate lending, not bitcoin-backed credit: a holder lends to the ` +
        `issuer unsecured, with no lien on its bitcoin. Income in the returns is what the terms accrue, not ` +
        `what was confirmed paid (returns_convention says so). Prices are IEX's, credited in the answer's ` +
        `attribution. Returns the route's payload as served.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return text({ ...(await upstreamGet<Record<string, unknown>>('/v1/market/corporate/instruments')), disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_events',
    {
      title: 'Credit-market events (dated facts)',
      description:
        `Returns the credit-market events the Stack has recorded, newest first: a venue's debt, collateral or ` +
        `borrow rate moving past its rule from one daily reading to the next, a figure crossing a fixed level (each ` +
        `power of ten, and twice and five times it), a company filing a purchase, sale or total of the coin it holds, and a venue first read or ` +
        `wound down. Each event: one sentence, the figures and their dates, the rule it met in words, and its ` +
        `source (the daily readings and their dates, or the filing with its link and the sentence that holds the figure). ` +
        `A change caused by coverage or method (a reader or pool change, a restatement, a price-only move) is not ` +
        `an event and is not returned. Bitcoin by default; collateral: 'eth' returns the ether events, never added ` +
        `to bitcoin's. Gavel's own book is included with its own-account disclosure. Descriptive: no cause, ` +
        `forecast or ranking. Paged: 20 events by default (limit up to 500); pass the returned \`next\` as cursor.`,
      inputSchema: {
        collateral: z.enum(['btc', 'eth']).optional().describe('Events of credit secured by bitcoin (default) or by ether; never added together'),
        type: z.array(z.enum(['debt_move', 'collateral_move', 'rate_move', 'level_cross', 'filing', 'coverage_enter', 'coverage_exit'])).optional()
          .describe('Only these event types'),
        subject: z.string().optional().describe(`A venue id (e.g. 'aave_v3_ethereum'), a tree node id or a corporate issuer id (e.g. 'strive')`),
        since: date('since').optional().describe('Events dated on or after this day'),
        until: date('until').optional().describe('Events dated on or before this day'),
        limit: z.number().int().min(1).max(500).optional().describe('Events per page (default 20)'),
        cursor: z.string().optional().describe('The `next` value of a previous page'),
      },
    },
    async ({ collateral, type, subject, since, until, limit, cursor }) => {
      requireTier('free');
      const data = await upstreamGet<Record<string, unknown>>('/v1/market/events', {
        query: { collateral, type: type?.length ? type.join(',') : undefined, subject, since, until, limit: limit ?? 20, cursor },
      });
      return text({ ...data, disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_desk_rates',
    {
      title: 'Posted rates of the custodial desks',
      description:
        `Returns the rate cards the custodial lending desks post (bitcoin collateral), one row per product: ` +
        `the representative APR and its range, term, maximum LTV, custody and liquidation model, and the card's ` +
        `effective date and source. Administered rates, not market-cleared; a card older than the stated ` +
        `staleness is marked. Pass desk to read one desk's cards. Returns the route's payload as served.`,
      inputSchema: {
        desk: z.string().optional().describe(`A desk id as the payload names it, e.g. 'ledn', 'xapo'`),
      },
    },
    async ({ desk }) => {
      requireTier('free');
      const data = await upstreamGet<{ desks?: Array<Record<string, unknown>>; [k: string]: unknown }>('/v1/market/cefi-rates');
      if (!desk) return text({ ...data, disclaimer: DISCLAIMER });
      const desks = (data.desks ?? []).filter((d) => String(d.desk ?? d.id ?? '').toLowerCase() === desk.toLowerCase());
      if (!desks.length) {
        const known = [...new Set((data.desks ?? []).map((d) => String(d.desk ?? d.id ?? '')))].filter(Boolean).sort();
        throw new Error(`no desk '${desk}' in the posted cards; desks: ${known.join(', ')}`);
      }
      return text({ ...data, count: desks.length, desks, desk_filter: desk, disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_debt_by_collateral',
    {
      title: 'How the dollar debt is backed',
      description:
        `What backs the dollar debt against bitcoin, by collateral and by venue type (pools, isolated markets, ` +
        `vaults, the auction, corporate, posted cards), as the site's "How these loans are backed" panel shows ` +
        `it, with each observer named and the collateral rule stated. days (30 to 1500, default 30) sets the ` +
        `window of the series it carries. Returns the route's payload as served.`,
      inputSchema: {
        days: z.number().int().min(30).max(1500).optional().describe('Window in days, 30 to 1500 (default 30)'),
      },
    },
    async ({ days }) => {
      requireTier('free');
      return text({ ...(await upstreamGet<Record<string, unknown>>('/v1/market/debt-by-collateral', { query: { days: days ?? 30 } })), disclaimer: DISCLAIMER });
    }
  );
}
