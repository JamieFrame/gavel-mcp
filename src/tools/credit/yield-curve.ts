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
  status?: string;
  shape?: string;
  total_loans?: number;
  active_loans?: number;
  data_point_count?: number;
  bins?: Array<{ tenor: number; label: string; count: number; meanRate: number }>;
  fit?: {
    beta_0?: number; beta_1?: number; beta_2?: number;
    r_squared?: number; rmse?: number; data_point_count?: number;
    model?: string; fitted_to?: string;
  };
  rates?: Record<string, number | null>;
  points?: Array<{ duration_days: number; implied_apr: number; ltv: number; timestamp: string }>;
  // D17 provenance. The REST surface carries this; it must reach agents too —
  // a curve seeded on own account is not an independent market assessment, and
  // an agent cannot weigh that unless it is told.
  provenance?: {
    observation_count?: number;
    distinct_counterparties?: number;
    distinct_external_counterparties?: number;
    external_share?: number;
    gate_a_threshold?: number;
    is_independent_assessment?: boolean;
    disclosure?: string;
  };
}

export function registerYieldCurveTool(server: McpServer): void {
  server.registerTool(
    'get_yield_curve',
    {
      title: 'Gavel Yield Curve',
      description:
        `Returns the current fitted Gavel yield curve for the requested ` +
        `collateral/loan pair. Rates are oracle-free, derived from auctions in ` +
        `The Gavel Protocol. The curve is a log-quadratic fit through binned ` +
        `midpoints.\n\n` +
        `IMPORTANT — every rate returned is an evaluation of the fitted curve, ` +
        `not an observed trade, and the published tenor set extends past the ` +
        `deepest observation. Tenors with no underlying bin data are returned ` +
        `as fitted values and listed in 'extrapolated_tenors'; treat those as ` +
        `model output only. Read 'provenance' before using the curve as a ` +
        `market reference: it carries the observation count, the number of ` +
        `distinct counterparties, the external share, and a disclosure stating ` +
        `whether this is yet an independent market assessment. Check ` +
        `fit.r_squared and fit.fitted_to — R-squared is measured against bin ` +
        `means, not raw scatter, so at low observation counts it reflects ` +
        `smoothness rather than goodness of fit.\n\n` +
        `Useful for: comparing fixed-term BTC-collateralised borrow rates ` +
        `across maturities, deriving the term premium, sourcing the Gavel ` +
        `layer of the Bitcoin Credit Stack. This tool returns data; it does ` +
        `not advise.\n\n` +
        `Returns: { pair, computed_at, status, rates, extrapolated_tenors, ` +
        `fit_observation_count, provenance, fit: {r_squared, rmse, model, ` +
        `fitted_to} }. Note 'fit_observation_count' counts only the loans the ` +
        `fit was computed over (binning is active-loans-only, so settled loans ` +
        `are excluded), whereas 'provenance.observation_count' counts the full ` +
        `scatter — they legitimately differ. Optional 'include_points' returns ` +
        `the raw scatter backing the fit.`,
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

      // Which published tenors have no observation behind them? `bins` omits
      // empty bins, so any rate key without a matching bin is a pure fit
      // evaluation beyond the data. We publish those rather than nulling them
      // (operator decision 2026-07-24) — but an extrapolated number that is not
      // labelled as one is indistinguishable from an observed one.
      const occupiedTenors = new Set((data.bins ?? []).map((b) => `${b.tenor}d`));
      const extrapolatedTenors = Object.keys(data.rates ?? {}).filter(
        (t) => !occupiedTenors.has(t)
      );

      // Shape for LLM consumption: keep the meaningful structure, attach a
      // methodology pointer, and carry the D17 provenance block through intact.
      const shaped = {
        pair: data.pair ?? pair,
        computed_at: data.computed_at ?? null,
        status: data.status ?? null,
        rates: data.rates ?? {},
        fit: data.fit ?? null,
        // Every rate above is an evaluation of the fit, not an observed trade —
        // including at tenors that do have observations. These ones have no
        // underlying bin data at all.
        extrapolated_tenors: extrapolatedTenors,
        // Deliberately distinct from provenance.observation_count. Binning is
        // active-loans-only, so the fit sample excludes settled loans, while
        // provenance counts the whole scatter. The two legitimately differ and
        // naming them the same thing reads as a contradiction.
        fit_observation_count: data.data_point_count ?? null,
        provenance: data.provenance ?? null,
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
