import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

// The yield-curve endpoint serves the canonical binned curve fitted across
// active Gavel loans. The response shape comes from
// Gavel_Database_API_Reference §8.2. We forward it largely intact, only
// flattening the top-level structure for cleaner LLM consumption.
interface YieldCurveResponse {
  pair?: string;
  computed_at?: string;
  fit?: {
    beta_0?: number; beta_1?: number; beta_2?: number;
    r_squared?: number; rmse?: number; data_point_count?: number;
  };
  rates?: Record<string, number | null>;
  points?: Array<{ duration_days: number; implied_apr: number; ltv: number; timestamp: string }>;
}

export function registerYieldCurveTool(server: McpServer): void {
  server.registerTool(
    'get_yield_curve',
    {
      title: 'Gavel Yield Curve',
      description:
        `Returns the current fitted Gavel yield curve for the requested ` +
        `collateral/loan pair. Rates are oracle-free, derived from completed ` +
        `auctions in The Gavel Protocol. The curve is a log-quadratic fit ` +
        `through bin midpoints; rates at tenors with no underlying bin data ` +
        `come back as null rather than extrapolated.\n\n` +
        `Useful for: comparing fixed-term BTC-collateralised borrow rates ` +
        `across maturities, deriving the term premium, sourcing the Gavel ` +
        `layer of the Bitcoin Credit Stack. This tool returns data; it does ` +
        `not advise.\n\n` +
        `Returns: { pair, computed_at, rates: {7d, 14d, 30d, 60d, 90d, 180d, 365d}, ` +
        `fit: {r_squared, rmse, data_point_count} }. Optional 'points' parameter ` +
        `returns raw scatter data backing the fit.`,
      inputSchema: {
        pair: z
          .string()
          .default('WBTC/USDC')
          .describe(`Collateral/loan pair. Default 'WBTC/USDC'. Currently the only live pair on mainnet.`),
        include_points: z
          .boolean()
          .default(false)
          .describe(`If true, include the underlying scatter points used to fit the curve. Larger response.`),
      },
    },
    async ({ pair, include_points }) => {
      requireTier('free');

      const data = await upstreamGet<YieldCurveResponse>('/v1/yield-curve', {
        query: { pair, points: include_points ? 'true' : undefined },
      });

      // Shape for LLM consumption: keep the meaningful structure, drop nothing,
      // attach a methodology pointer so curious models can read the spec.
      const shaped = {
        pair: data.pair ?? pair,
        computed_at: data.computed_at ?? null,
        rates: data.rates ?? {},
        fit: data.fit ?? null,
        ...(include_points ? { points: data.points ?? [] } : {}),
        methodology:
          'Log-quadratic fit through canonical-binned active-loan midpoints. ' +
          'See https://docs.thegavel.io/methodology/yield-curve for details.',
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }],
      };
    }
  );
}
