import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// find_auctions_matching_criteria — Layer A read tool (Phase 1.5).
//
// Returns auctions filtered by user-supplied criteria. The tool name is
// deliberately *find_auctions_matching_criteria*, never *recommend_*  or
// *find_best_*, because the filter is driven by the caller's stated
// preferences — pure information, not investment advice.
// ============================================================================

interface UpstreamAuction {
  auction_id?: number;
  pair?: string;
  loan_amount_usd?: number;
  loan_amount?: number;
  collateral_btc?: number;
  collateral_amount?: number;
  ltv?: number;
  duration_days?: number;
  status?: string;
  implied_apr?: number;
  current_best_repayment?: number;
  bid_count?: number;
  created_at?: string;
  finalized_at?: string;
  auction_ends_at?: string;
}

interface UpstreamAuctionsResponse {
  auctions?: UpstreamAuction[];
  total?: number;
  has_more?: boolean;
}

export function registerFindAuctionsTool(server: McpServer): void {
  server.registerTool(
    'find_auctions_matching_criteria',
    {
      title: 'Find Auctions Matching Criteria',
      description:
        `Returns Gavel auctions filtered by the criteria you supply. Does not ` +
        `rank, score, or recommend a specific auction — only filters by the ` +
        `parameters provided. The user chooses what to act on.\n\n` +
        `Useful for: an agent helping a user narrow a long auction list down to ` +
        `the subset matching their stated yield, duration, and LTV preferences.\n\n` +
        `All filter parameters are optional. Unspecified parameters mean "no ` +
        `constraint on that dimension". When status is omitted, defaults to 'open' ` +
        `(actionable auctions only).\n\n` +
        `Returns: { matches: Auction[], match_count, total_inspected, criteria_echoed }.`,
      inputSchema: {
        min_rate_pct: z.number().optional().describe(`Minimum implied APR in percent (e.g. 5.5 means at least 5.5%). Omit for no lower bound.`),
        max_rate_pct: z.number().optional().describe(`Maximum implied APR in percent. Omit for no upper bound.`),
        min_duration_days: z.number().int().optional().describe(`Minimum loan duration in days. Omit for no lower bound.`),
        max_duration_days: z.number().int().optional().describe(`Maximum loan duration in days. Omit for no upper bound.`),
        min_ltv: z.number().optional().describe(`Minimum LTV (loan-to-value), as decimal 0.0-1.0. Omit for no lower bound.`),
        max_ltv: z.number().optional().describe(`Maximum LTV. Omit for no upper bound.`),
        pair: z.string().optional().describe(`Collateral/loan pair (e.g. 'WBTC/USDC'). Omit for any pair.`),
        status: z.enum(['open', 'completed', 'all']).default('open').describe(`Auction lifecycle filter. 'open' = actionable (default), 'completed' = settled, 'all' = both.`),
        min_remaining_hours: z.number().optional().describe(`Only return auctions with at least this many hours left before close. Useful for bidders who need time to act. Ignored when status != 'open'.`),
        limit: z.number().int().min(1).max(100).default(20).describe(`Maximum results to return. Caps at 100.`),
      },
    },
    async (args) => {
      requireTier('anonymous');

      const upstream = await upstreamGet<UpstreamAuctionsResponse>('/v1/auctions', {
        query: {
          pair: args.pair,
          status: args.status === 'all' ? undefined : args.status,
          limit: '100', // fetch a wide page; we filter locally below
        },
      });

      const all = upstream.auctions ?? [];

      const now = Date.now();
      const minRemainingMs = args.min_remaining_hours != null ? args.min_remaining_hours * 3_600_000 : null;

      const matches = all.filter((a) => {
        if (args.min_rate_pct != null && (a.implied_apr ?? -Infinity) < args.min_rate_pct) return false;
        if (args.max_rate_pct != null && (a.implied_apr ?? Infinity) > args.max_rate_pct) return false;
        if (args.min_duration_days != null && (a.duration_days ?? -Infinity) < args.min_duration_days) return false;
        if (args.max_duration_days != null && (a.duration_days ?? Infinity) > args.max_duration_days) return false;
        if (args.min_ltv != null && (a.ltv ?? -Infinity) < args.min_ltv) return false;
        if (args.max_ltv != null && (a.ltv ?? Infinity) > args.max_ltv) return false;
        if (minRemainingMs != null && a.auction_ends_at) {
          const endsAtMs = Date.parse(a.auction_ends_at);
          if (!Number.isNaN(endsAtMs) && endsAtMs - now < minRemainingMs) return false;
        }
        return true;
      });

      const trimmed = matches.slice(0, args.limit);

      const response = {
        matches: trimmed,
        match_count: trimmed.length,
        total_inspected: all.length,
        criteria_echoed: {
          min_rate_pct: args.min_rate_pct,
          max_rate_pct: args.max_rate_pct,
          min_duration_days: args.min_duration_days,
          max_duration_days: args.max_duration_days,
          min_ltv: args.min_ltv,
          max_ltv: args.max_ltv,
          pair: args.pair,
          status: args.status,
          min_remaining_hours: args.min_remaining_hours,
        },
        notes: trimmed.length === 0
          ? 'No auctions matched the supplied criteria. Try widening one or more bounds, or change status to "all".'
          : `${trimmed.length} of ${all.length} auctions match the supplied criteria.`,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
