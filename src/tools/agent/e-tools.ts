import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

// ============================================================================
// The E-series decision endpoints on the MCP — AF-T day 5.
//
// Four of the nine: E4, E6, E8-free and E9. These are the ones that are pure
// re-presentations of chain state, so they are FREE by the founding rule and
// carry no freshness fence. E1/E2/E3/E5 and E7 need thresholds and the delayed
// tier and are not exposed here.
//
// Every description below is quoted UNALTERED from the copy pack
// (aletheia-docs commercial/operational/agent_listing_copy_v1.md §2.1). Each
// second sentence exists to satisfy a specific never-column row and must not
// be trimmed for brevity: E4's refuses to imply an aggregate, E6's states the
// privacy bound, E8's keeps the verdict with the reader, E9's refuses "deep
// book". A description that differs from the pack is a listing_copy_drift
// finding, not an improvement.
//
// These are thin wrappers. The envelope, the thresholds and the own-account
// attribution are computed upstream and passed through untouched — an MCP
// tool that reshaped a payload would create a second home for the disclosure,
// which is the D17 failure.
// ============================================================================

const networkArg = z
  .enum(['arbitrum-one', 'arbitrum-sepolia'])
  .optional()
  .describe(
    `Network. Default 'arbitrum-one' (mainnet). Use 'arbitrum-sepolia' for the ` +
      `testnet deployment, which carries a far deeper book — but note the two run ` +
      `different contract builds, so a testnet observation is not a mainnet fact.`
  );

const passthrough = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

export function registerETools(server: McpServer): void {
  // ── E4 ────────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_comparables',
    {
      title: 'Comparable settled auctions',
      description:
        `Which recent auctions resemble these parameters, and how did each clear? ` +
        `Returns the individual observations so the caller can reason from them ` +
        `directly.\n\n` +
        `Nearest-k settled auctions by normalised distance on loan amount, LTV and ` +
        `tenor. Every row carries its clearing APR, bid count, and whether its ` +
        `originator was Aletheia's own account. Below MIN_COMPARABLES the rows are ` +
        `still returned, with the threshold and the observed count named — no ` +
        `aggregate is computed over them.\n\n` +
        `⚠ The own-account flag is null, not false, wherever it cannot be computed. ` +
        `Read provenance.own_account_attribution before treating a null as a "no".`,
      inputSchema: {
        loan_amount: z.number().positive().optional().describe(`Loan size to match against, in loan-token units.`),
        ltv: z.number().min(0).max(1).optional().describe(`Loan-to-value at origination, as a decimal 0–1.`),
        tenor_days: z.number().positive().optional().describe(`Loan term in days. The protocol's minimum is 7.`),
        k: z.number().int().min(1).max(25).optional().describe(`How many comparables to return. Caps at 25; default 10.`),
        window_days: z.number().int().positive().optional().describe(`Only consider auctions settled within this many days.`),
        pair: z.string().optional().describe(`Collateral/loan pair. Default 'WBTC/USDC'.`),
        network: networkArg,
      },
    },
    async ({ loan_amount, ltv, tenor_days, k, window_days, pair, network }) => {
      requireTier('free');
      return passthrough(
        await upstreamGet('/v1/comparables', {
          network,
          query: { loan_amount, ltv, tenor_days, k, window_days, pair },
        })
      );
    }
  );

  // ── E6 ────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_address_history',
    {
      title: 'Address history on the protocol',
      description:
        `What has this address done on the protocol? Public chain events only, with ` +
        `no enrichment beyond them.\n\n` +
        `Auctions originated, bids placed, positions open and closed, and a summary ` +
        `of outcomes. No clustering, no labelling and no inferred identity: nothing ` +
        `in the response is not already public on-chain. Any address may be queried ` +
        `by anyone; no authorisation is needed.\n\n` +
        `This is the supervisor page's data source — the read a person uses to check ` +
        `what an agent they supervise has actually done.`,
      inputSchema: {
        address: z.string().describe(`The address to inspect. Any valid Ethereum address; it need not be the caller.`),
        network: networkArg,
      },
    },
    async ({ address, network }) => {
      requireTier('free');
      return passthrough(
        await upstreamGet(`/v1/address/${encodeURIComponent(address)}/history`, { network })
      );
    }
  );

  // ── E9 ────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_book',
    {
      title: 'The open book',
      description:
        `What is open right now — auctions, bids and positions listed? Current chain ` +
        `state, with counts rather than a characterisation of depth.\n\n` +
        `Open auctions with their best bid and time remaining, those closing within ` +
        `24 hours, and totals: open auction count, principal outstanding, collateral ` +
        `locked, and distinct lenders and borrowers over 30 days.\n\n` +
        `⚠ Fields that cannot be answered are null, not empty. positions_listed is ` +
        `null where marketplace listings are not indexed — an empty array would ` +
        `assert that nothing is listed.`,
      inputSchema: {
        pair: z.string().optional().describe(`Restrict to one collateral/loan pair. Omit for all.`),
        network: networkArg,
      },
    },
    async ({ pair, network }) => {
      requireTier('free');
      return passthrough(await upstreamGet('/v1/book', { network, query: { pair } }));
    }
  );

  // ── E8, free form ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_verification_bundle',
    {
      title: 'Verification bundle',
      description:
        `What can be checked about the contracts, and what did the last check ` +
        `return? Observations with their block heights; the verdict is the ` +
        `reader's.\n\n` +
        `Contract addresses and their implementations, the bytecode hash of each, ` +
        `the upgradeability position, the privileged-function map with whether each ` +
        `can touch user funds, the audit reference, and five structural promises — ` +
        `each with the check that would falsify it and what that check returned.\n\n` +
        `⚠ Read the fields, not the impression. 'match' is "unchecked" where ` +
        `Aletheia has not compared deployed bytecode against verified source; a ` +
        `promise that did not settle says so; and mainnet and testnet return ` +
        `different answers because they run different builds. There is no safety ` +
        `score, rating or verified badge in this payload, and none will be added.`,
      inputSchema: { network: networkArg },
    },
    async ({ network }) => {
      requireTier('free');
      return passthrough(
        await upstreamGet('/v1/verify/bundle', {
          network,
          // The bundle makes ~15 chain reads per contract on a cold cache.
          timeoutMs: 30_000,
          query: { network },
        })
      );
    }
  );
}
