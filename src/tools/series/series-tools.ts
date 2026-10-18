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
 *   get_fund_holdings          -> GET /v1/market/holders/funds          (snapshot; BH1 Phase 1)
 *   get_desk_rates             -> GET /v1/market/cefi-rates            (snapshot)
 *   get_debt_by_collateral     -> GET /v1/market/debt-by-collateral    (snapshot)
 *   get_events                 -> GET /v1/market/events                (reading; EV1 Phase 2, free)
 *   get_event_post_kit         -> GET /v1/market/events?id=            (reading; EV1 EV-D13, free)
 * The chart plan is the API's (one home, G0-2): panels by unit, two at most, the explorer's refusals in its
 * words, ether and bitcoin never on one panel, and the /explore link that draws the same chart. No image.
 * Values are identities on observed data: no forecast, no ranking, no characterisation.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISCLAIMER =
  'Informational. Aletheia Analytics SASU operates this interface and data product. No guarantee of ' +
  'accuracy, and nothing here is a recommendation.';
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });
// The two corporate snapshots are sent unindented: their default answers sit near the snapshot budget (CA1 Phase 4).
const compact = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
type Row = Record<string, unknown> & { issuer_id?: string; attribution?: Record<string, unknown> | null };
// CA1 Phase 4: get_debt_by_collateral carries the corporate class totals; the rows for each company are
// get_corporate_instruments' (one home).
const COMPANIES_SERVED_BY =
  "The rows for each company are served by get_corporate_instruments; pass issuer for one company's debt lines.";
// CA1 Phase 4: each company's attribution, without its debt lines, balance sheet and currencies. The full
// attribution is get_corporate_instruments with issuer.
const ATTRIBUTION_DETAIL =
  "Each company's attribution is summarised here. get_corporate_instruments with issuer returns that company's " +
  'instruments and its full attribution: every debt line with its security and source, the balance sheet and the currencies.';
function summarise(a: Record<string, unknown> | null | undefined) {
  if (!a) return a ?? null;
  return {
    unencumbered_share: a.unencumbered_share, unencumbered_share_absent_because: a.unencumbered_share_absent_because,
    total_assets_today_usd: a.total_assets_today_usd, total_assets_today_absent_because: a.total_assets_today_absent_because,
    excluded_from_class: a.excluded_from_class, carried_in_class_usd: a.carried_in_class_usd,
    periods: a.periods, periods_differ: a.periods_differ,
    debt_lines: Array.isArray(a.lines) ? a.lines.length : 0,
  };
}
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
        `issuer with no lien on its bitcoin, except where the issuer has pledged bitcoin against a facility.\n\n` +
        `btc_backing also carries the debt attributed to bitcoin, beside the filed debt: for each company holding at least ` +
        `100 BTC (a subsidiary counted at its parent), bitcoin-pledged debt counts in full (no more than the pledged coins' ` +
        `value where the line states them), debt secured by other assets at zero, and unsecured debt and preferred stock at ` +
        `the company's unencumbered share of assets. It is a stated convention applied to filed figures, not a measurement; ` +
        `total assets, each debt line and its security are served beside it, and a company whose figure cannot be ` +
        `attributed says why. Income in the returns is what the terms accrue, not ` +
        `what was confirmed paid (returns_convention says so). Prices are IEX's, credited in the answer's ` +
        `attribution.\n\n` +
        `Without issuer, every instrument is returned and each company's attribution is summarised: its unencumbered ` +
        `share, total assets, the dates of its balance sheet and debt lines, and how many debt lines it has. Pass ` +
        `issuer (e.g. 'strategy') for that company's instruments and its full attribution, every debt line with its ` +
        `security and source.`,
      inputSchema: {
        issuer: z.string().optional().describe(`A corporate issuer id (e.g. 'strategy'): its instruments and its full attribution, debt line by debt line`),
      },
    },
    async ({ issuer }) => {
      requireTier('free');
      const data = await upstreamGet<{ instruments?: Row[]; btc_backing?: { issuers?: Row[]; [k: string]: unknown }; [k: string]: unknown }>('/v1/market/corporate/instruments');
      const issuers = data.btc_backing?.issuers ?? [];
      if (!issuer) {
        return compact({ ...data, btc_backing: { ...data.btc_backing, issuers: issuers.map((r) => ({ ...r, attribution: summarise(r.attribution) })), attribution_detail: ATTRIBUTION_DETAIL }, disclaimer: DISCLAIMER });
      }
      const row = issuers.find((r) => r.issuer_id === issuer);
      if (!row && !(data.instruments ?? []).some((r) => r.issuer_id === issuer)) {
        throw new Error(`no issuer '${issuer}' in the registry; issuers: ${[...new Set(issuers.map((r) => String(r.issuer_id)))].sort().join(', ')}`);
      }
      // a parent's consolidated subsidiaries come with it (their bitcoin and debt are counted at the parent)
      const ids = new Set([issuer, ...((row?.attribution?.subsidiaries as string[] | undefined) ?? [])]);
      return compact({ ...data,
        instruments: (data.instruments ?? []).filter((r) => ids.has(String(r.issuer_id))),
        btc_backing: { ...data.btc_backing, issuers: issuers.filter((r) => ids.has(String(r.issuer_id))) },
        issuer_filter: issuer, disclaimer: DISCLAIMER });
    }
  );

  // BH1 Phase 1: the bitcoin spot funds state they hold. Description wording: operator approval pending.
  server.registerTool(
    'get_fund_holdings',
    {
      title: 'Bitcoin held by spot funds',
      description:
        `Lists the spot bitcoin funds and the bitcoin each states it holds, as read from the fund's own ` +
        `SEC filing (10-Q or 10-K), its daily holdings file, or its periodic report, each figure with its date, ` +
        `its source and a quote. A fund's headline is its latest-dated figure; the other figures are served ` +
        `beside it. Custodians and the fund's lending statement are quoted as filed; "lending not stated" means ` +
        `no statement was found, not that the fund lends. A fund without a figure says why, never zero. Fund ` +
        `shares held by another fund or a public body are listed and not added, so each coin is counted once. ` +
        `Totals are given per date, and across dates only with the earliest and latest date they cover. ` +
        `Funds are listed by name; nothing is ranked. Returns the route's payload as served.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return text({ ...(await upstreamGet<Record<string, unknown>>('/v1/market/holders/funds')), disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_events',
    {
      title: 'Credit-market events (dated facts)',
      description:
        `Returns the credit-market events the Stack has recorded, newest first: a venue's debt, collateral or ` +
        `borrow rate moving past its rule from one daily reading to the next, a figure crossing a fixed level (each ` +
        `power of ten, and twice and five times it), a company filing a purchase, sale or total of the coin it holds, an indicator (bsbs, bcsi, ` +
        `the collateral share, the weekly matched change, a wrapper's reserve coverage) crossing a fixed level or moving past its threshold, and a venue first read or ` +
        `wound down. Each event: one sentence, the figures and their dates, the rule it met in words, and its ` +
        `source (the daily readings and their dates, or the filing with its link and the sentence that holds the figure). ` +
        `A change caused by coverage or method (a reader or pool change, a restatement, a price-only move) is not ` +
        `an event and is not returned. Bitcoin by default; collateral: 'eth' returns the ether events, never added ` +
        `to bitcoin's. Gavel's own book is included with its own-account disclosure. Descriptive: no cause, ` +
        `forecast or ranking. Paged: 20 events by default (limit up to 500); pass the returned \`next\` as cursor.`,
      inputSchema: {
        collateral: z.enum(['btc', 'eth']).optional().describe('Events of credit secured by bitcoin (default) or by ether; never added together'),
        type: z.array(z.enum(['debt_move', 'collateral_move', 'rate_move', 'level_cross', 'filing', 'coverage_enter', 'coverage_exit', 'indicator_level', 'indicator_move'])).optional()
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

  // EV1 EV-D13 (operator 2026-10-15): what a reader needs to post an event on X, tailored by the assistant. The
  // suggested chart is the site's (bitcoin-credit-stack-frontend src/lib/eventChart.js, its one home; kept the same here).
  const SITE = 'https://www.bitcoincreditstack.com';
  const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
  type Ev = { id: number; date: string; type: string; collateral: string; text: string; subject?: { level?: string; id?: string; name?: string }; figure?: { name?: string } };
  const suggested = (e: Ev): { ids: string[]; from: string } | null => {
    const s = e.subject ?? {}; const eth = e.collateral === 'eth';
    if (e.type === 'filing') return !eth && s.level === 'issuer' ? { ids: [`corporate.issuer.${s.id}.btc_held`], from: daysBefore(e.date, 183) } : null;
    if (s.level === 'indicator' && s.id) return { ids: [s.id], from: daysBefore(e.date, 183) };
    if (!['venue', 'family'].includes(s.level ?? '')) return null;
    const name = e.figure?.name ?? ''; const coll = eth ? 'collateral_eth' : 'collateral_btc';
    const metric = e.type === 'level_cross' ? (/debt/.test(name) ? 'debt_usd' : /collateral/.test(name) ? coll : null)
      : e.type === 'collateral_move' ? coll : e.type === 'debt_move' ? 'debt_usd' : e.type === 'rate_move' ? 'borrow_rate' : null;
    return metric ? { ids: [`credit.${s.level}.${s.id}.${eth ? 'coll_eth.' : ''}${metric}`], from: daysBefore(e.date, 183) } : null;
  };
  // Other series a post can set beside the event, by subject (ids as list_series serves them).
  const context = (e: Ev): Array<{ ids: string[]; what: string }> => {
    const s = e.subject ?? {}; const eth = e.collateral === 'eth'; const c = eth ? 'coll_eth.' : '';
    if (s.level === 'issuer' && !eth) return [
      { ids: [`corporate.issuer.${s.id}.btc_held`], what: 'the company\'s bitcoin as filed, over any window (from= sets it)' },
      // not credit.class.corporate.collateral_btc: the tree's corporate series keeps the registry figure on the live
      // days to 2026-10-14 (the break of 2026-10-15) and would draw a fall the filings do not show
    ];
    if (s.level === 'venue' || s.level === 'family') return [
      { ids: [`credit.${s.level}.${s.id}.${c}debt_usd`, `credit.${s.level}.${s.id}.${c}${eth ? 'collateral_eth' : 'collateral_btc'}`], what: 'its debt and its collateral, on two panels' },
      { ids: [`credit.${s.level}.${s.id}.${c}borrow_rate`], what: 'its borrow rate' },
      { ids: [`credit.market.${c}debt_usd`], what: 'the whole market\'s debt, for scale' },
    ];
    return [];
  };
  const chartLinks = (c: { ids: string[]; from: string }) => ({
    ids: c.ids, from: c.from,
    page: `${SITE}/chart?ids=${c.ids.join(',')}&from=${c.from}`,
    svg: `${PUBLIC_API}/v1/series/chart.svg?ids=${c.ids.join(',')}&from=${c.from}&size=post`,
  });

  server.registerTool(
    'get_event_post_kit',
    {
      title: 'What to post an event on X with (text, link, chart)',
      description:
        `For one credit-market event (an id from get_events; without one, the newest events to choose from): ` +
        `its sentence, the link to post (X shows it as a card with the event's chart), the suggested chart and ` +
        `other series to set beside it (each with a page that saves it as a PNG to attach), and the rules a post ` +
        `follows. The assistant drafts the post from these; nothing is posted by this server. A post stays ` +
        `descriptive: the event's figures and dates, no forecast, no advice, no ranking and no cause the data ` +
        `does not state; the rules give X's length limit and how a link counts against it.`,
      inputSchema: {
        id: z.number().int().min(1).optional().describe('An event id from get_events'),
      },
    },
    async ({ id }) => {
      requireTier('free');
      if (id == null) {
        const latest = await upstreamGet<{ events?: Ev[] }>('/v1/market/events', { query: { limit: 5 } });
        const eth = await upstreamGet<{ events?: Ev[] }>('/v1/market/events', { query: { collateral: 'eth', limit: 3 } });
        return text({ choose: 'Ask again with one of these ids.', events: [...(latest.events ?? []), ...(eth.events ?? [])].map((e) => ({ id: e.id, date: e.date, collateral: e.collateral, text: e.text })), disclaimer: DISCLAIMER });
      }
      let e: Ev | undefined;
      try { e = (await upstreamGet<{ events?: Ev[] }>('/v1/market/events', { query: { id } })).events?.[0]; } catch { e = undefined; }
      if (!e) return text({ error: { code: 'not_found', message: `no published event has id ${id}; get_events lists them`, retryable: false } });
      const c = suggested(e);
      return text({
        event: e,
        post: {
          text: e.text,
          link: `${SITE}/e/${e.id}`,
          link_note: 'X shows this link as a large card: the sentence, the suggested chart and the source. A reader who follows it lands on the event.',
          event_page: `${SITE}/activity?event=${e.id}`,
        },
        suggested_chart: c ? chartLinks(c) : null,
        suggested_chart_note: c ? null : 'No chart for this event (an ether company has no holdings series; a coverage event, a class or the market have none suggested).',
        context_series: context(e).map((x) => ({ ...chartLinks({ ids: x.ids, from: c?.from ?? daysBefore(e!.date, 183) }), what: x.what })),
        custom_chart: `${SITE}/chart?ids=<ids from list_series, comma-separated>&from=YYYY-MM-DD (to=, title= also taken); its page saves the chart as a PNG`,
        rules: [
          'Descriptive only: the figures, dates and source as served. No forecast, no advice, no ranking, no superlative ("record", "all-time") and no cause the data does not state.',
          'Up to 280 characters, the link counting as 23.',
          'The event\'s own sentence may be shortened, never changed in its figures or dates.',
          'A chart attached by hand replaces the card: attach one only when it says more than the suggested chart.',
        ],
        disclaimer: DISCLAIMER,
      });
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
        `window of the series it carries. The corporate part carries the class totals; the rows for each company ` +
        `are get_corporate_instruments'.`,
      inputSchema: {
        days: z.number().int().min(30).max(1500).optional().describe('Window in days, 30 to 1500 (default 30)'),
      },
    },
    async ({ days }) => {
      requireTier('free');
      const data = await upstreamGet<{ corporate?: { btc_backing?: { issuers?: Row[]; [k: string]: unknown }; [k: string]: unknown }; [k: string]: unknown }>('/v1/market/debt-by-collateral', { query: { days: days ?? 30 } });
      const bb = data.corporate?.btc_backing;
      if (!bb) return compact({ ...data, disclaimer: DISCLAIMER });

      const { issuers, ...cls } = bb;
      return compact({ ...data, corporate: { ...data.corporate, btc_backing: { ...cls, companies: issuers?.length ?? 0, companies_served_by: COMPANIES_SERVED_BY } }, disclaimer: DISCLAIMER });
    }
  );
}
