import { createPublicClient, http, type PublicClient } from 'viem';
import { arbitrum, arbitrumSepolia } from 'viem/chains';

// ============================================================================
// Arbitrum RPC clients.
//
// Used by the Layer A read tools (check_wallet_status, etc.) that need direct
// chain reads which can't go through api.thegavel.io. These calls are pure
// chain RPCs (eth_getBalance, eth_call for ERC20 views) — there's no
// business logic to centralise, so the thin-wrapper principle doesn't apply.
//
// Override defaults via env:
//   ARBITRUM_RPC_URL          — Arbitrum One RPC endpoint
//   ARBITRUM_SEPOLIA_RPC_URL  — Arbitrum Sepolia RPC endpoint
//
// The defaults are public RPCs — fine for development and light traffic, but
// production should point at a paid Alchemy/Infura/QuickNode endpoint to
// avoid rate limits.
// ============================================================================

const MAINNET_RPC = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const TESTNET_RPC = process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';

export const mainnetClient: PublicClient = createPublicClient({
  chain: arbitrum,
  transport: http(MAINNET_RPC, { timeout: 8_000 }),
});

export const testnetClient: PublicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(TESTNET_RPC, { timeout: 8_000 }),
});

export type Network = 'arbitrum-one' | 'arbitrum-sepolia';

export function clientForNetwork(network: Network): PublicClient {
  return network === 'arbitrum-sepolia' ? testnetClient : mainnetClient;
}

// Standard ERC20 ABI fragment — just the views we need. Keeping this minimal
// avoids pulling in a heavier ABI dependency for the small set of calls we
// make.
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;
