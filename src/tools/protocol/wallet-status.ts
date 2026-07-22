import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { formatUnits, isAddress, type Address } from 'viem';
import { clientForNetwork, ERC20_ABI, type Network } from '../../rpc.js';
import { requireTier } from '../../tiers.js';
import { logger } from '../../logger.js';

// ============================================================================
// check_wallet_status — Layer A read tool (Phase 1.5).
//
// Returns a structured snapshot of a wallet's readiness to participate in
// Gavel: native gas balance, relevant ERC-20 balances, current allowances,
// and a precomputed `readiness.blockers` array that tells the calling LLM
// what's stopping the user from acting (so the LLM doesn't have to reason
// about raw balances itself).
//
// This is the one read tool that talks to chain directly rather than through
// api.thegavel.io — eth_getBalance and ERC20 view calls have no business
// logic to centralise, so the thin-wrapper principle doesn't apply.
// ============================================================================

// Per-network token registry. Mirrors get_protocol_reference; deliberately
// duplicated here as separate truth so this tool can be invoked without
// fetching the reference first (saves a round-trip from the LLM's POV).
const NETWORK_TOKENS: Record<Network, Array<{ symbol: string; address: Address; decimals: number; roles: string[] }>> = {
  'arbitrum-one': [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, roles: ['loan'] },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, roles: ['loan'] },
    { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, roles: ['collateral'] },
  ],
  'arbitrum-sepolia': [
    { symbol: 'USDC', address: '0x7873E00010f5f1a28AC9470048b175baB8dcB60D', decimals: 6, roles: ['loan'] },
    { symbol: 'USDT', address: '0x31BdCE6Ba62F8FC466f8aBC7c29d884d2A82de62', decimals: 6, roles: ['loan'] },
    { symbol: 'WBTC', address: '0x967dd019bFaa7AC83BB508Ee33cDF6660e181e8D', decimals: 8, roles: ['collateral'] },
  ],
};

const PROTOCOL_SPENDERS: Record<Network, { LoanProtocol: Address; ListingService: Address }> = {
  'arbitrum-one': {
    LoanProtocol: '0xFCDd6Ef75638D8D19ad634004C234Ad18751fEf2',
    ListingService: '0x22B2C327Ed73da9e32a3eEB9DcBaa9AEBD8BD0d8',
  },
  'arbitrum-sepolia': {
    LoanProtocol: '0xB15336ba21410181AF1B8751Ee88aB4AFc9F1c26',
    ListingService: '0xd1C6073d550E1C0A588081087E30B3091c635B6e',
  },
};

// Heuristic gas cost for a typical Gavel transaction at recent Arbitrum gas prices.
// Arbitrum gas is cheap; ~0.0003 ETH covers a typical placeBid including L1 calldata cost.
// Used to derive the `estimated_txs_remaining` field — for UX hints, not a hard limit.
const GAS_PER_TYPICAL_TX_ETH = 0.0003;
const SUFFICIENT_GAS_THRESHOLD_ETH = 0.001; // ~3 typical txs in reserve

const BIG_BID_ALLOWANCE_THRESHOLD = 100n * 10n ** 6n; // 100 USDC — anything below this is effectively no allowance

export function registerWalletStatusTool(server: McpServer): void {
  server.registerTool(
    'check_wallet_status',
    {
      title: 'Check Wallet Readiness',
      description:
        `Returns a structured readiness report for the given wallet address: ` +
        `native ETH balance for gas, relevant ERC-20 balances (USDC, USDT, WBTC), ` +
        `current allowances against the Gavel LoanProtocol and ListingService, ` +
        `and a precomputed list of blockers (what's stopping the wallet from ` +
        `placing bids or creating auctions).\n\n` +
        `Useful for: onboarding flows where an LLM agent needs to verify a user's ` +
        `wallet is funded and approved before walking them through a transaction. ` +
        `The 'readiness.blockers' field is the high-leverage answer to "what's ` +
        `next?" — the LLM can quote it directly without reasoning from raw balances.\n\n` +
        `This tool reads the Arbitrum chain directly via RPC. It does not require ` +
        `any signed authorisation from the wallet owner — addresses and balances ` +
        `are public on-chain data.\n\n` +
        `Returns: { address, network, native_gas, tokens, active_positions, readiness }.`,
      inputSchema: {
        address: z
          .string()
          .describe(`The EOA or smart-account address to inspect. Any valid Ethereum address. The wallet does not need to be the caller — anyone can check anyone's balance, this is public chain data.`),
        network: z
          .enum(['arbitrum-one', 'arbitrum-sepolia'])
          .default('arbitrum-one')
          .describe(`Network to inspect. Default 'arbitrum-one' (mainnet, live protocol).`),
      },
    },
    async ({ address, network }) => {
      requireTier('anonymous');

      if (!isAddress(address)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid address: '${address}'. Must be a 42-character hex string starting with 0x.`
        );
      }
      const checksumAddress = address as Address;

      const client = clientForNetwork(network);
      const tokens = NETWORK_TOKENS[network];
      const spenders = PROTOCOL_SPENDERS[network];

      let nativeBalanceWei: bigint;
      try {
        nativeBalanceWei = await client.getBalance({ address: checksumAddress });
      } catch (err) {
        logger.error({ err: String(err), address, network }, 'RPC getBalance failed');
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read native balance from ${network} RPC: ${err instanceof Error ? err.message : 'unknown error'}`
        );
      }

      const nativeBalanceEth = parseFloat(formatUnits(nativeBalanceWei, 18));
      const txsRemaining = Math.floor(nativeBalanceEth / GAS_PER_TYPICAL_TX_ETH);
      const sufficientForTypicalTx = nativeBalanceEth >= GAS_PER_TYPICAL_TX_ETH;

      // Parallel ERC20 reads. Each token: balance + allowance for both spenders.
      const tokenResults = await Promise.all(
        tokens.map(async (token) => {
          const calls = [
            client.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [checksumAddress] }),
            client.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'allowance', args: [checksumAddress, spenders.LoanProtocol] }),
            client.readContract({ address: token.address, abi: ERC20_ABI, functionName: 'allowance', args: [checksumAddress, spenders.ListingService] }),
          ];
          try {
            const [balance, allowLP, allowLS] = (await Promise.all(calls)) as [bigint, bigint, bigint];
            return {
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
              roles: token.roles,
              balance_units: balance.toString(),
              balance_formatted: formatUnits(balance, token.decimals),
              allowances: {
                LoanProtocol: {
                  raw: allowLP.toString(),
                  formatted: formatUnits(allowLP, token.decimals),
                  covers_typical_bid: allowLP >= BIG_BID_ALLOWANCE_THRESHOLD,
                },
                ListingService: {
                  raw: allowLS.toString(),
                  formatted: formatUnits(allowLS, token.decimals),
                },
              },
            };
          } catch (err) {
            logger.warn({ err: String(err), symbol: token.symbol }, 'ERC20 read failed; returning zeros');
            return {
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
              roles: token.roles,
              balance_units: '0',
              balance_formatted: '0',
              allowances: {
                LoanProtocol: { raw: '0', formatted: '0', covers_typical_bid: false },
                ListingService: { raw: '0', formatted: '0' },
              },
              warning: 'Token read failed; values may be stale',
            };
          }
        })
      );

      // Compute readiness blockers — what's stopping common actions.
      const usdc = tokenResults.find((t) => t.symbol === 'USDC');
      const wbtc = tokenResults.find((t) => t.symbol === 'WBTC');

      const blockers: string[] = [];
      const canPlaceBid =
        sufficientForTypicalTx &&
        !!usdc && BigInt(usdc.balance_units) > 0n &&
        !!usdc && BigInt(usdc.allowances.LoanProtocol.raw) > 0n;
      const canCreateAuction =
        sufficientForTypicalTx &&
        !!wbtc && BigInt(wbtc.balance_units) > 0n &&
        !!wbtc && BigInt(wbtc.allowances.LoanProtocol.raw) > 0n;

      if (!sufficientForTypicalTx) {
        blockers.push(
          `Insufficient ETH for gas (have ${nativeBalanceEth.toFixed(5)} ETH; need at least ${GAS_PER_TYPICAL_TX_ETH} per transaction). ` +
          `Acquire a small amount of ETH on Arbitrum One — typically 0.001-0.005 ETH is enough for several transactions.`
        );
      }
      if (usdc && BigInt(usdc.balance_units) === 0n) {
        blockers.push(`No USDC balance — fund the wallet with USDC on ${network} before bidding. See recommend_fiat_onramp for options.`);
      }
      if (usdc && BigInt(usdc.balance_units) > 0n && BigInt(usdc.allowances.LoanProtocol.raw) === 0n) {
        blockers.push(`USDC balance present but no allowance granted to LoanProtocol — will require an ERC20.approve transaction before bidding.`);
      }
      if (wbtc && BigInt(wbtc.balance_units) === 0n) {
        blockers.push(`No WBTC balance — would be required to create auctions as a borrower. Bidding (lender role) does not require WBTC.`);
      }

      const response = {
        address: checksumAddress,
        network,
        native_gas: {
          symbol: 'ETH',
          balance_wei: nativeBalanceWei.toString(),
          balance_eth: nativeBalanceEth.toFixed(6),
          sufficient_for_typical_tx: sufficientForTypicalTx,
          sufficient_for_buffer: nativeBalanceEth >= SUFFICIENT_GAS_THRESHOLD_ETH,
          estimated_txs_remaining: txsRemaining,
          gas_per_typical_tx_eth: GAS_PER_TYPICAL_TX_ETH,
        },
        tokens: tokenResults,
        active_positions: {
          note: 'This snapshot does not include open Gavel positions. Call get_user_positions for a full lifecycle view (not yet implemented; coming in the next Phase 1.5 release).',
        },
        readiness: {
          can_place_bid: canPlaceBid,
          can_create_auction: canCreateAuction,
          blockers,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    }
  );
}
