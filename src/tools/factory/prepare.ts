import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { clientForNetwork, ERC20_ABI, type Network } from '../../rpc.js';
import {
  CHAIN_IDS,
  REGULATORY_NOTICE,
  buildEnvelope,
  contractsFor,
  deeplinksFor,
  encodeApproval,
  encodeLoanProtocolCall,
  fromBaseUnits,
  toBaseUnits,
  type Prerequisite,
} from '../../factory/envelope.js';

// R18 Phase 5 — Layer B factory tools. Read src/factory/envelope.ts first:
// the invariants and the MD12 build requirements are documented there.
//
// Tier: all `free`. Participation is never gated (D3) — a would-be bidder must
// never hit a paywall between deciding to bid and being able to.

const NETWORK_ARG = z
  .enum(['arbitrum-one', 'arbitrum-sepolia'])
  .default('arbitrum-one')
  .describe(`Network. Default 'arbitrum-one' (mainnet, real funds).`);

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function requireAddress(label: string, value: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${label} must be a 0x-prefixed 20-byte address; got '${value}'.`);
  }
  return value as `0x${string}`;
}

interface TokenMeta { symbol: string; decimals: number }

// Token metadata is read from chain rather than a hardcoded table so a new
// whitelisted loan token works without a release.
async function tokenMeta(network: Network, token: `0x${string}`): Promise<TokenMeta> {
  const client = clientForNetwork(network);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
  ]);
  return { symbol, decimals: Number(decimals) };
}

async function allowanceOf(
  network: Network, token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`
): Promise<bigint> {
  const client = clientForNetwork(network);
  return client.readContract({
    address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender],
  }) as Promise<bigint>;
}

async function balanceOf(
  network: Network, token: `0x${string}`, owner: `0x${string}`
): Promise<bigint> {
  const client = clientForNetwork(network);
  return client.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner],
  }) as Promise<bigint>;
}

/**
 * Builds the ERC-20 approval prerequisite when the current allowance is short.
 *
 * Approves EXACTLY the amount needed, never MaxUint256. An unlimited approval
 * is more convenient and is what the frontend does, but a blueprint handed to
 * an agent should not quietly widen the user's risk surface beyond the action
 * they asked for.
 */
async function approvalPrerequisiteIfNeeded(args: {
  network: Network;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  needed: bigint;
  meta: TokenMeta;
}): Promise<Prerequisite[]> {
  const current = await allowanceOf(args.network, args.token, args.owner, args.spender);
  if (current >= args.needed) return [];

  const tx = encodeApproval(args.token, args.spender, args.needed, CHAIN_IDS[args.network]);
  return [
    {
      type: 'erc20_approval',
      rationale:
        `Your current ${args.meta.symbol} allowance to the protocol is ` +
        `${fromBaseUnits(current, args.meta.decimals)} — it must be at least ` +
        `${fromBaseUnits(args.needed, args.meta.decimals)} for the next transaction to succeed. ` +
        `This approves exactly that amount, not an unlimited allowance.`,
      transaction: tx,
      deeplinks: deeplinksFor(tx, 'approve', [
        { type: 'address', value: args.spender },
        { type: 'uint256', value: args.needed.toString() },
      ]),
    },
  ];
}

interface AuctionDetail {
  auction_id?: number;
  status?: string;
  borrower?: string;
  loan_token?: string;
  loan_amount?: number;
  max_repayment?: number;
  bid_step?: number;
  current_best_repayment?: number | null;
  duration_days?: number;
  auction_ends_at?: string | null;
  pair?: string;
}

export function registerFactoryTools(server: McpServer): void {
  // ── prepare_bid_calldata ─────────────────────────────────────────────────
  server.registerTool(
    'prepare_bid_calldata',
    {
      title: 'Prepare a Gavel Bid',
      description:
        `Builds an unsigned transaction blueprint for placing a bid on a Gavel ` +
        `auction, including the prerequisite ERC-20 approval when the current ` +
        `allowance is short.\n\n` +
        `You supply the auction and the repayment amount you are willing to ` +
        `accept; this tool validates them against live auction state and ` +
        `encodes the call. It does not choose an auction, a rate or a size for ` +
        `you — use find_auctions_matching_criteria to filter by your own ` +
        `criteria first.\n\n` +
        `Bidding on Gavel is a reverse auction: a LOWER repayment is a more ` +
        `competitive bid and a lower yield to you as lender. Each bid must ` +
        `undercut the current best by at least the auction's bid step.\n\n` +
        REGULATORY_NOTICE,
      inputSchema: {
        auction_id: z.number().int().describe(`The auction to bid on.`),
        lender_address: z.string().describe(`Your address — used to read your balance and current allowance.`),
        repayment_amount: z
          .string()
          .describe(`The total repayment you are bidding, as a decimal string in loan-token units, e.g. '5320.00'.`),
        network: NETWORK_ARG,
      },
    },
    async ({ auction_id, lender_address, repayment_amount, network }) => {
      requireTier('free');
      const lender = requireAddress('lender_address', lender_address);
      const chainId = CHAIN_IDS[network as Network];
      const contracts = contractsFor(network as Network);

      const auction = await upstreamGet<AuctionDetail>(`/v1/auctions/${auction_id}`);

      if (auction.status && auction.status !== 'OPEN') {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Auction #${auction_id} is '${auction.status}', not OPEN — it can no longer be bid on.`
        );
      }
      if (!auction.loan_token) {
        throw new McpError(ErrorCode.InternalError, `Auction #${auction_id} did not report a loan token.`);
      }

      const loanToken = requireAddress('loan_token', auction.loan_token);
      const meta = await tokenMeta(network as Network, loanToken);

      let repayment: bigint;
      try {
        repayment = toBaseUnits(repayment_amount, meta.decimals);
      } catch (e) {
        throw new McpError(ErrorCode.InvalidParams, e instanceof Error ? e.message : String(e));
      }

      // ── Validation. A blueprint that will revert is worse than an error:
      // the user pays gas to discover it.
      const warnings: string[] = [];
      const maxRepayment = auction.max_repayment != null ? toBaseUnits(String(auction.max_repayment), meta.decimals) : null;
      const currentBest = auction.current_best_repayment != null
        ? toBaseUnits(String(auction.current_best_repayment), meta.decimals) : null;
      const bidStep = auction.bid_step != null ? toBaseUnits(String(auction.bid_step), meta.decimals) : 0n;

      if (maxRepayment !== null && repayment > maxRepayment) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Your bid of ${repayment_amount} exceeds the auction's maximum repayment of ` +
            `${fromBaseUnits(maxRepayment, meta.decimals)} ${meta.symbol}. The borrower will not accept it.`
        );
      }
      if (currentBest !== null && repayment > currentBest - bidStep) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Your bid of ${repayment_amount} does not beat the current best of ` +
            `${fromBaseUnits(currentBest, meta.decimals)} ${meta.symbol} by the required bid step of ` +
            `${fromBaseUnits(bidStep, meta.decimals)}. Bid at most ` +
            `${fromBaseUnits(currentBest - bidStep, meta.decimals)} to be competitive.`
        );
      }

      // The lender funds the PRINCIPAL, not the repayment — that is what
      // leaves their wallet if they win.
      const principal = auction.loan_amount != null ? toBaseUnits(String(auction.loan_amount), meta.decimals) : 0n;

      // A repayment at or below the principal is a negative-yield loan: the
      // lender pays out more than they get back. The contract permits it and
      // the bid-step check does not catch it, so without this the tool will
      // happily encode a guaranteed loss — which is precisely the mistake a
      // first-time user makes by mistyping an amount.
      //
      // Warn rather than refuse. Stating the arithmetic is descriptive; the
      // bid is a legal action and it is not this tool's place to veto it.
      let yourAprPct: number | null = null;
      if (principal > 0n && auction.duration_days) {
        const p = Number(fromBaseUnits(principal, meta.decimals));
        const r = Number(fromBaseUnits(repayment, meta.decimals));
        yourAprPct = ((r - p) / p) * (365 / auction.duration_days) * 100;
      }
      if (principal > 0n && repayment <= principal) {
        warnings.push(
          `THIS BID LOSES MONEY. You would fund ${fromBaseUnits(principal, meta.decimals)} ${meta.symbol} ` +
            `and be repaid ${repayment_amount} ${meta.symbol} — a loss of ` +
            `${fromBaseUnits(principal - repayment, meta.decimals)} ${meta.symbol} if you win` +
            (yourAprPct !== null ? ` (${yourAprPct.toFixed(2)}% annualised)` : '') +
            `. Gavel is a reverse auction, so a lower repayment is a more competitive bid — but it must stay ` +
            `above the ${fromBaseUnits(principal, meta.decimals)} principal to earn anything. Check the amount before signing.`
        );
      }

      const balance = await balanceOf(network as Network, loanToken, lender);
      if (balance < principal) {
        warnings.push(
          `Your ${meta.symbol} balance (${fromBaseUnits(balance, meta.decimals)}) is below the ` +
            `${fromBaseUnits(principal, meta.decimals)} principal you would need to fund if this bid wins. ` +
            `The bid may be accepted but settlement would fail.`
        );
      }

      const prerequisites = await approvalPrerequisiteIfNeeded({
        network: network as Network,
        token: loanToken,
        owner: lender,
        spender: requireAddress('LoanProtocol', contracts.LoanProtocol),
        needed: principal > repayment ? principal : repayment,
        meta,
      });

      const tx = encodeLoanProtocolCall(contracts.LoanProtocol, 'placeBid', [BigInt(auction_id), repayment], chainId);

      const envelope = buildEnvelope({
        intent: `Place a bid of ${repayment_amount} ${meta.symbol} repayment on auction #${auction_id}`,
        summaryForUser:
          `You are bidding to lend ${auction.loan_amount ?? '?'} ${meta.symbol} on auction #${auction_id} ` +
          `(${auction.pair ?? 'unknown pair'}) on ${network}. If you win, you receive ${repayment_amount} ` +
          `${meta.symbol} at maturity in ${auction.duration_days ?? '?'} days` +
          (yourAprPct !== null ? ` — ${yourAprPct.toFixed(2)}% annualised` : '') + `. ` +
          (currentBest !== null
            ? `The current best bid is ${fromBaseUnits(currentBest, meta.decimals)} ${meta.symbol}; a lower repayment wins.`
            : `There are no competing bids yet.`),
        parametersYouSupplied: {
          auction_id,
          repayment_amount,
          lender_address: lender,
          network,
          note: 'These terms were supplied by you. Aletheia did not select this auction, rate or amount.',
        },
        context: {
          auction_id,
          pair: auction.pair ?? null,
          loan_amount: auction.loan_amount ?? null,
          loan_token_symbol: meta.symbol,
          max_repayment: auction.max_repayment ?? null,
          current_best_repayment: auction.current_best_repayment ?? null,
          bid_step: auction.bid_step ?? null,
          your_apr_pct: yourAprPct === null ? null : Number(yourAprPct.toFixed(4)),
          duration_days: auction.duration_days ?? null,
          auction_ends_at: auction.auction_ends_at ?? null,
        },
        prerequisites,
        transaction: tx,
        deeplinks: deeplinksFor(tx, 'placeBid', [
          { type: 'uint256', value: String(auction_id) },
          { type: 'uint256', value: repayment.toString() },
        ]),
        warnings,
      });

      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }
  );

  // ── prepare_create_auction_calldata ──────────────────────────────────────
  server.registerTool(
    'prepare_create_auction_calldata',
    {
      title: 'Prepare a Gavel Auction',
      description:
        `Builds an unsigned transaction blueprint for creating a borrow auction ` +
        `— you post collateral and ask lenders to compete to lend against it — ` +
        `including the prerequisite collateral approval.\n\n` +
        `Every term is yours to set: which collateral and how much, which loan ` +
        `token and how much, the maximum repayment you will accept, the loan ` +
        `duration, how long the auction runs, and the bid step. This tool ` +
        `encodes what you specify and warns about consequences; it does not ` +
        `propose terms, rates or a loan size.\n\n` +
        `Lenders bid DOWN from your maximum repayment, so max_repayment is your ` +
        `worst acceptable price — set it too low and the auction may attract no ` +
        `bids.\n\n` +
        REGULATORY_NOTICE,
      inputSchema: {
        borrower_address: z.string().describe(`Your address — used to read collateral balance and allowance.`),
        collateral_token: z.string().describe(`Collateral token address. See get_protocol_reference for whitelisted tokens.`),
        collateral_amount: z.string().describe(`Collateral to post, decimal string in token units, e.g. '0.05'.`),
        loan_token: z.string().describe(`Loan token address (what you want to borrow).`),
        loan_amount: z.string().describe(`Amount to borrow, decimal string, e.g. '2500.00'.`),
        max_repayment: z.string().describe(`The most you will repay at maturity, decimal string. Lenders bid below this.`),
        loan_duration_days: z.number().describe(`Loan term in days.`),
        auction_duration_hours: z.number().describe(`How long the auction accepts bids, in hours.`),
        bid_step: z.string().default('0').describe(`Minimum improvement between bids, decimal string in loan-token units.`),
        network: NETWORK_ARG,
      },
    },
    async (a) => {
      requireTier('free');
      const borrower = requireAddress('borrower_address', a.borrower_address);
      const collateralToken = requireAddress('collateral_token', a.collateral_token);
      const loanToken = requireAddress('loan_token', a.loan_token);
      const network = a.network as Network;
      const chainId = CHAIN_IDS[network];
      const contracts = contractsFor(network);

      const [colMeta, loanMeta] = await Promise.all([
        tokenMeta(network, collateralToken),
        tokenMeta(network, loanToken),
      ]);

      let collateralAmount: bigint, loanAmount: bigint, maxRepayment: bigint, bidStep: bigint;
      try {
        collateralAmount = toBaseUnits(a.collateral_amount, colMeta.decimals);
        loanAmount = toBaseUnits(a.loan_amount, loanMeta.decimals);
        maxRepayment = toBaseUnits(a.max_repayment, loanMeta.decimals);
        bidStep = toBaseUnits(a.bid_step, loanMeta.decimals);
      } catch (e) {
        throw new McpError(ErrorCode.InvalidParams, e instanceof Error ? e.message : String(e));
      }

      if (maxRepayment < loanAmount) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `max_repayment (${a.max_repayment}) is below loan_amount (${a.loan_amount}). ` +
            `No lender will lend ${a.loan_amount} to be repaid less than that.`
        );
      }
      if (a.loan_duration_days <= 0 || a.auction_duration_hours <= 0) {
        throw new McpError(ErrorCode.InvalidParams, `Durations must be positive.`);
      }

      const warnings: string[] = [];
      const colBalance = await balanceOf(network, collateralToken, borrower);
      if (colBalance < collateralAmount) {
        warnings.push(
          `Your ${colMeta.symbol} balance (${fromBaseUnits(colBalance, colMeta.decimals)}) is below the ` +
            `${a.collateral_amount} you are posting as collateral. This transaction will revert as it stands.`
        );
      }

      const impliedRate =
        Number(fromBaseUnits(maxRepayment, loanMeta.decimals)) / Number(fromBaseUnits(loanAmount, loanMeta.decimals));
      const impliedApr = (impliedRate - 1) * (365 / a.loan_duration_days) * 100;

      const prerequisites = await approvalPrerequisiteIfNeeded({
        network,
        token: collateralToken,
        owner: borrower,
        spender: requireAddress('LoanProtocol', contracts.LoanProtocol),
        needed: collateralAmount,
        meta: colMeta,
      });

      const tx = encodeLoanProtocolCall(
        contracts.LoanProtocol,
        'createAuction',
        [
          collateralToken,
          collateralAmount,
          loanToken,
          loanAmount,
          maxRepayment,
          BigInt(Math.round(a.loan_duration_days * 86400)),
          BigInt(Math.round(a.auction_duration_hours * 3600)),
          bidStep,
        ],
        chainId
      );

      const envelope = buildEnvelope({
        intent:
          `Create an auction borrowing ${a.loan_amount} ${loanMeta.symbol} against ` +
          `${a.collateral_amount} ${colMeta.symbol} for ${a.loan_duration_days} days`,
        summaryForUser:
          `You are posting ${a.collateral_amount} ${colMeta.symbol} as collateral to borrow ` +
          `${a.loan_amount} ${loanMeta.symbol} on ${network}. Lenders will bid for ` +
          `${a.auction_duration_hours} hours, competing to offer you the lowest repayment. ` +
          `You have capped repayment at ${a.max_repayment} ${loanMeta.symbol}, which at ` +
          `${a.loan_duration_days} days is about ${impliedApr.toFixed(2)}% annualised in the worst case — ` +
          `the winning bid should be better. If you do not repay by maturity, you lose the collateral.`,
        parametersYouSupplied: {
          collateral_token: collateralToken,
          collateral_amount: a.collateral_amount,
          loan_token: loanToken,
          loan_amount: a.loan_amount,
          max_repayment: a.max_repayment,
          loan_duration_days: a.loan_duration_days,
          auction_duration_hours: a.auction_duration_hours,
          bid_step: a.bid_step,
          network: a.network,
          note: 'Every term above was supplied by you. Aletheia did not propose or optimise any of them.',
        },
        context: {
          collateral_symbol: colMeta.symbol,
          loan_symbol: loanMeta.symbol,
          worst_case_implied_apr_pct: Number(impliedApr.toFixed(4)),
          loan_protocol: contracts.LoanProtocol,
        },
        prerequisites,
        transaction: tx,
        warnings,
        deeplinks: deeplinksFor(tx, 'createAuction', [
          { type: 'address', value: collateralToken },
          { type: 'uint256', value: collateralAmount.toString() },
          { type: 'address', value: loanToken },
          { type: 'uint256', value: loanAmount.toString() },
          { type: 'uint256', value: maxRepayment.toString() },
          { type: 'uint256', value: String(Math.round(a.loan_duration_days * 86400)) },
          { type: 'uint256', value: String(Math.round(a.auction_duration_hours * 3600)) },
          { type: 'uint256', value: bidStep.toString() },
        ]),
      });

      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }
  );

  // ── prepare_repay_loan_calldata ──────────────────────────────────────────
  server.registerTool(
    'prepare_repay_loan_calldata',
    {
      title: 'Prepare a Loan Repayment',
      description:
        `Builds an unsigned transaction blueprint for repaying a Gavel loan, ` +
        `including the prerequisite approval for the repayment amount.\n\n` +
        `Validates that the loan is live and that you are its borrower. Repay ` +
        `before maturity or the lender may claim your collateral.\n\n` +
        REGULATORY_NOTICE,
      inputSchema: {
        loan_id: z.number().int().describe(`The loan to repay. See get_user_positions.`),
        borrower_address: z.string().describe(`Your address — must match the loan's borrower.`),
        network: NETWORK_ARG,
      },
    },
    async ({ loan_id, borrower_address, network }) => {
      requireTier('free');
      const borrower = requireAddress('borrower_address', borrower_address);
      const net = network as Network;
      const contracts = contractsFor(net);

      const loan = await upstreamGet<Record<string, any>>(`/v1/loans/${loan_id}/status`);

      if (loan.outcome) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Loan #${loan_id} is already settled (${loan.outcome}). There is nothing to repay.`
        );
      }
      if (typeof loan.borrower === 'string' && loan.borrower.toLowerCase() !== borrower.toLowerCase()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Address ${borrower} is not the borrower on loan #${loan_id} (that is ${loan.borrower}). ` +
            `Only the borrower can repay.`
        );
      }

      const loanToken = requireAddress('loan_token', String(loan.loan_token));
      const meta = await tokenMeta(net, loanToken);
      const repayment = toBaseUnits(String(loan.repayment), meta.decimals);

      const warnings: string[] = [];
      const balance = await balanceOf(net, loanToken, borrower);
      if (balance < repayment) {
        warnings.push(
          `Your ${meta.symbol} balance (${fromBaseUnits(balance, meta.decimals)}) is below the ` +
            `${fromBaseUnits(repayment, meta.decimals)} required. Fund the wallet before signing.`
        );
      }
      if (typeof loan.time_remaining_seconds === 'number' && loan.time_remaining_seconds < 86400) {
        warnings.push(
          `Less than 24 hours remain before maturity (${loan.matures_at}). If it lapses the lender may claim your collateral.`
        );
      }

      const prerequisites = await approvalPrerequisiteIfNeeded({
        network: net, token: loanToken, owner: borrower,
        spender: requireAddress('LoanProtocol', contracts.LoanProtocol),
        needed: repayment, meta,
      });

      const tx = encodeLoanProtocolCall(contracts.LoanProtocol, 'repayLoan', [BigInt(loan_id)], CHAIN_IDS[net]);

      const envelope = buildEnvelope({
        intent: `Repay loan #${loan_id} in full`,
        summaryForUser:
          `You are repaying ${fromBaseUnits(repayment, meta.decimals)} ${meta.symbol} to close loan #${loan_id}. ` +
          `Your ${loan.collateral_symbol ?? 'collateral'} is released back to you on settlement.`,
        parametersYouSupplied: { loan_id, borrower_address: borrower, network },
        context: {
          loan_id,
          repayment: loan.repayment ?? null,
          loan_token_symbol: meta.symbol,
          matures_at: loan.matures_at ?? null,
          time_remaining_seconds: loan.time_remaining_seconds ?? null,
        },
        prerequisites,
        transaction: tx,
        warnings,
        deeplinks: deeplinksFor(tx, 'repayLoan', [{ type: 'uint256', value: String(loan_id) }]),
      });

      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }
  );

  // ── prepare_claim_collateral_calldata ────────────────────────────────────
  server.registerTool(
    'prepare_claim_collateral_calldata',
    {
      title: 'Prepare a Collateral Claim',
      description:
        `Builds an unsigned transaction blueprint for a lender to claim the ` +
        `collateral on a defaulted Gavel loan.\n\n` +
        `Validates that you are the lender and that the loan has passed ` +
        `maturity without repayment. Chain state is authoritative — a ` +
        `repayment in the current block may not be indexed yet, so this tool ` +
        `warns rather than asserts when the margin is thin.\n\n` +
        REGULATORY_NOTICE,
      inputSchema: {
        loan_id: z.number().int().describe(`The defaulted loan.`),
        lender_address: z.string().describe(`Your address — must match the loan's lender.`),
        network: NETWORK_ARG,
      },
    },
    async ({ loan_id, lender_address, network }) => {
      requireTier('free');
      const lender = requireAddress('lender_address', lender_address);
      const net = network as Network;
      const contracts = contractsFor(net);

      const loan = await upstreamGet<Record<string, any>>(`/v1/loans/${loan_id}/status`);

      if (loan.outcome === 'REPAID') {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Loan #${loan_id} was repaid on ${loan.resolved_at}. There is no collateral to claim.`
        );
      }
      if (typeof loan.lender === 'string' && loan.lender.toLowerCase() !== lender.toLowerCase()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Address ${lender} is not the lender on loan #${loan_id} (that is ${loan.lender}).`
        );
      }

      const warnings: string[] = [];
      if (typeof loan.time_remaining_seconds === 'number' && loan.time_remaining_seconds > 0) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Loan #${loan_id} has not matured — ${Math.ceil(loan.time_remaining_seconds / 3600)} hours remain ` +
            `(matures ${loan.matures_at}). Collateral cannot be claimed before maturity.`
        );
      }
      if (loan.outcome !== 'DEFAULTED') {
        warnings.push(
          `The indexer has not recorded a default for loan #${loan_id}; it is past maturity with no settlement seen. ` +
            `Verify on-chain before signing — a repayment may have landed too recently to be indexed.`
        );
      }

      const tx = encodeLoanProtocolCall(contracts.LoanProtocol, 'claimCollateral', [BigInt(loan_id)], CHAIN_IDS[net]);

      const envelope = buildEnvelope({
        intent: `Claim the collateral on defaulted loan #${loan_id}`,
        summaryForUser:
          `Loan #${loan_id} passed its maturity on ${loan.matures_at} without repayment. ` +
          `This claims the ${loan.collateral_amount ?? ''} ${loan.collateral_symbol ?? 'collateral'} into your wallet.`,
        parametersYouSupplied: { loan_id, lender_address: lender, network },
        context: {
          loan_id,
          collateral_symbol: loan.collateral_symbol ?? null,
          collateral_amount: loan.collateral_amount ?? null,
          matures_at: loan.matures_at ?? null,
          indexed_outcome: loan.outcome ?? null,
        },
        transaction: tx,
        warnings,
        deeplinks: deeplinksFor(tx, 'claimCollateral', [{ type: 'uint256', value: String(loan_id) }]),
      });

      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }
  );

  // ── prepare_claim_refund_calldata ────────────────────────────────────────
  server.registerTool(
    'prepare_claim_refund_calldata',
    {
      title: 'Prepare a Refund Claim',
      description:
        `Builds an unsigned transaction blueprint for reclaiming funds held by ` +
        `the protocol after a losing bid.\n\n` +
        `When you are outbid, your funds stay claimable rather than being ` +
        `pushed back automatically. This encodes the claim for a given token.\n\n` +
        REGULATORY_NOTICE,
      inputSchema: {
        token_address: z.string().describe(`The token to reclaim, e.g. the USDC address you bid with.`),
        claimant_address: z.string().describe(`Your address — used to check there is a pending refund.`),
        network: NETWORK_ARG,
      },
    },
    async ({ token_address, claimant_address, network }) => {
      requireTier('free');
      const token = requireAddress('token_address', token_address);
      const claimant = requireAddress('claimant_address', claimant_address);
      const net = network as Network;
      const contracts = contractsFor(net);
      const meta = await tokenMeta(net, token);

      const warnings: string[] = [];
      let pending: bigint | null = null;
      try {
        pending = (await clientForNetwork(net).readContract({
          address: requireAddress('LoanProtocol', contracts.LoanProtocol),
          abi: [
            {
              name: 'getPendingRefund', type: 'function', stateMutability: 'view',
              inputs: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }],
              outputs: [{ name: '', type: 'uint256' }],
            },
          ],
          functionName: 'getPendingRefund',
          args: [claimant, token],
        })) as bigint;
      } catch {
        warnings.push('Could not read the pending refund balance from chain; the claim may revert if there is nothing to claim.');
      }

      if (pending !== null && pending === 0n) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `No pending ${meta.symbol} refund for ${claimant} on ${net}. There is nothing to claim.`
        );
      }

      const tx = encodeLoanProtocolCall(contracts.LoanProtocol, 'claimRefund', [token], CHAIN_IDS[net]);

      const envelope = buildEnvelope({
        intent: `Claim pending ${meta.symbol} refund`,
        summaryForUser:
          pending !== null
            ? `You have ${fromBaseUnits(pending, meta.decimals)} ${meta.symbol} claimable from losing bids. This returns it to your wallet.`
            : `This claims any pending ${meta.symbol} refund held for you by the protocol.`,
        parametersYouSupplied: { token_address: token, claimant_address: claimant, network },
        context: {
          token_symbol: meta.symbol,
          pending_refund: pending !== null ? fromBaseUnits(pending, meta.decimals) : null,
        },
        transaction: tx,
        warnings,
        deeplinks: deeplinksFor(tx, 'claimRefund', [{ type: 'address', value: token }]),
      });

      return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }
  );
}
