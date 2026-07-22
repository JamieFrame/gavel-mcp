import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

// R18 Phase 4 — Layer A completion (ai_concierge.md §6.2, §6.3).
//
// These answer the three questions a user actually asks after they have acted:
// "did my bid win?", "has the borrower repaid?", "what do I do now?". The
// upstream endpoints precompute `next_action_available` and a
// `lifecycle_summary` so the LLM narrates rather than infers — inference from
// raw state is where a concierge invents a repayment that never happened.
//
// Both are `free`: participation is never gated (D3).

interface PositionsResponse {
  address?: string;
  network?: string;
  positions?: unknown[];
  count?: number;
  settled_hidden?: number;
  notes?: string;
}

export function registerPositionTools(server: McpServer): void {
  server.registerTool(
    'get_user_positions',
    {
      title: 'Gavel Positions for an Address',
      description:
        `Returns every Gavel position an address holds — as borrower, as ` +
        `winning lender, or as a bidder on an auction that has not closed.\n\n` +
        `Each position carries its lifecycle state (auction_open, bid_placed, ` +
        `bid_lost, active, matured_unclaimed, repaid, defaulted), the maturity ` +
        `date and time remaining, the counterparty, and ` +
        `'next_action_available' — the one thing this address can do next ` +
        `(nothing, repay, claim_collateral, claim_repayment, claim_refund). ` +
        `'lifecycle_summary' is a plain-English sentence you can quote to the ` +
        `user directly.\n\n` +
        `Reads public chain data via the Aletheia indexer; no signed ` +
        `authorisation is needed and anyone can query any address. The chain ` +
        `is authoritative — a transaction in the current block may not be ` +
        `indexed yet.\n\n` +
        `Returns: { address, network, positions[], count, settled_hidden }.`,
      inputSchema: {
        address: z
          .string()
          .describe(`The address to inspect. Any valid Ethereum address; it need not be the caller.`),
        include_settled: z
          .boolean()
          .default(false)
          .describe(`Include finished positions (repaid, defaulted, lost bids). Default false — only what is still live.`),
      },
    },
    async ({ address, include_settled }) => {
      requireTier('free');

      const data = await upstreamGet<PositionsResponse>(
        `/v1/user/${encodeURIComponent(address)}/positions`,
        { query: { include_settled: include_settled ? 'true' : 'false' } }
      );

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'get_loan_status',
    {
      title: 'Gavel Loan Status',
      description:
        `Returns the current state of a single Gavel loan and what action, if ` +
        `any, is available to whom. Designed to be re-called during a long ` +
        `conversation so lifecycle changes can be surfaced to the user.\n\n` +
        `'next_actions' is an array of {actor, action, calldata_tool} tuples ` +
        `naming the tool that prepares each transaction, so the next step can ` +
        `be taken without guessing. 'lifecycle_summary' gives the borrower's ` +
        `and lender's view in plain English.\n\n` +
        `This is descriptive data; no recommendation is provided. Verify ` +
        `on-chain before acting on a reported maturity or default.\n\n` +
        `Returns: { loan_id, state, borrower, lender, principal, repayment, ` +
        `apr, matures_at, time_remaining_seconds, outcome, next_actions }.`,
      inputSchema: {
        loan_id: z
          .number()
          .int()
          .describe(`The loan id. For v1 auctions this equals the auction id — see get_user_positions.`),
      },
    },
    async ({ loan_id }) => {
      requireTier('free');

      const data = await upstreamGet<Record<string, unknown>>(`/v1/loans/${loan_id}/status`);

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );
}
