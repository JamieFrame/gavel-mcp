import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

/**
 * OC1 Phase 4 (2026-10-09): the chain, miner, reference-price and FX series from the vintage store.
 * Each tool reads one /v1/onchain route (gavel-indexer onchain-series-routes.js) and returns it as served:
 *   list_chain_series  -> /v1/onchain/series
 *   get_chain_series   -> /v1/onchain/series/:id
 *   get_cost_basis     -> /v1/onchain/cost-basis
 * Values are identities on observed data: no forecast, no characterisation. Values priced before 2020-07-13
 * rest on CoinGecko's daily price; the upstream marks them and its `licence` block carries the attribution,
 * which these tools pass through unchanged.
 */

const ID = /^[a-z0-9_.]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISCLAIMER =
  'Informational. Aletheia Analytics SASU operates this interface and data product. No guarantee of ' +
  'accuracy, and nothing here is a recommendation.';
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });

export function registerChainSeriesTools(server: McpServer): void {
  server.registerTool(
    'list_chain_series',
    {
      title: 'Chain, miner and price series (catalogue)',
      description:
        `Lists every series served from Aletheia's vintage store: the chain series built from one pass over ` +
        `every Bitcoin block on Aletheia's own node (chain.cohort.*: supply, supply by age band, long- and ` +
        `short-term holder supply, BTC moved, coin-days destroyed, dormancy, realised cap and price, MVRV, ` +
        `SOPR, supply in profit and loss, cost-basis percentiles), the miner series (miner.*: blocks, ` +
        `transactions, subsidy, fees, difficulty, hashrate, hashprice), the on-chain BTC/ETH/TRX price fixings ` +
        `and staked-ether contract rates (price.*), and the Federal Reserve H.10 exchange rates (fx.*).\n\n` +
        `Returns: { count, series: [{ id, dataset, unit, kinds, first, last, latest_vintage, licence }] }. ` +
        `licence 'free_attributed_only' marks series with values priced from CoinGecko before 2020-07-13.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return text({ ...(await upstreamGet<Record<string, unknown>>('/v1/onchain/series')), disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_chain_series',
    {
      title: 'One chain, miner or price series through time',
      description:
        `Returns one series from Aletheia's vintage store, by id (see list_chain_series): every value with ` +
        `its date and kind, the series' unit, source and limitation, and the vintages the values came from. ` +
        `With as_known_on, returns the series exactly as the store held it at the end of that day (UTC), so a ` +
        `past answer can be reproduced.\n\n` +
        `Chain series reach back to 2009 and are day-granular. Priced values (realised value, MVRV, SOPR, ` +
        `hashprice in USD) value each coin at the price of the day it was created: Aletheia's on-chain fixing ` +
        `from 2020-07-13, CoinGecko's daily price before. Such points carry coingecko_share and price_today, ` +
        `and the response's licence block carries the attribution: show it with them. This tool returns data; ` +
        `it does not advise, forecast, or characterise the market.`,
      inputSchema: {
        id: z.string().describe('Series id, e.g. chain.cohort.supply_btc, chain.cohort.mvrv, miner.hpx_btc, price.btc_in_basket, fx.eur'),
        from: z.string().optional().describe('First date, YYYY-MM-DD'),
        to: z.string().optional().describe('Last date, YYYY-MM-DD'),
        as_known_on: z.string().optional().describe('YYYY-MM-DD: the series as the store held it at the end of that day (UTC)'),
      },
    },
    async ({ id, from, to, as_known_on }) => {
      requireTier('free');
      if (!ID.test(id)) throw new Error('id must be a series id such as chain.cohort.supply_btc (see list_chain_series)');
      for (const [k, v] of Object.entries({ from, to, as_known_on })) if (v != null && !DATE.test(v)) throw new Error(`${k} must be YYYY-MM-DD`);
      const qs = new URLSearchParams(Object.entries({ from, to, as_known_on }).filter(([, v]) => v != null) as [string, string][]).toString();
      const data = await upstreamGet<Record<string, unknown>>(`/v1/onchain/series/${id}${qs ? `?${qs}` : ''}`);
      return text({ ...data, disclaimer: DISCLAIMER });
    }
  );

  server.registerTool(
    'get_cost_basis',
    {
      title: 'Bitcoin supply by cost basis (one day)',
      description:
        `Returns Bitcoin's supply alive at the end of one UTC day, grouped by the BTC price on the day each ` +
        `coin was created, in logarithmic price buckets of a chosen width (ratio, default 1.02: each bucket ` +
        `spans 2%). Built from Aletheia's own node, block by block; day-granular.\n\n` +
        `Creation prices are Aletheia's on-chain fixing from 2020-07-13 and CoinGecko's daily price before; ` +
        `each bucket states how much of it is CoinGecko-priced (coingecko_btc), and the licence block carries ` +
        `the attribution. Coins created before 2010-07-17 have no price and form one bucket at 0. This tool ` +
        `returns data; it does not advise, forecast, or characterise the market.\n\n` +
        `Returns: { date, ratio, unit, buckets: [{ low_usd, high_usd, btc, coingecko_btc }], limitation, licence }.`,
      inputSchema: {
        date: z.string().describe('The day, YYYY-MM-DD (a complete day: up to the day before the latest)'),
        ratio: z.number().optional().describe('Bucket width as a price ratio, 1.005 to 2 (default 1.02)'),
      },
    },
    async ({ date, ratio }) => {
      requireTier('free');
      if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD');
      const qs = new URLSearchParams({ date, ...(ratio != null ? { ratio: String(ratio) } : {}) }).toString();
      return text({ ...(await upstreamGet<Record<string, unknown>>(`/v1/onchain/cost-basis?${qs}`)), disclaimer: DISCLAIMER });
    }
  );
}
