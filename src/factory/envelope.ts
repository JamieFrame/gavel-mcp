import { encodeFunctionData, type Abi } from 'viem';
import { MAINNET_CONTRACTS, TESTNET_CONTRACTS, type ContractAddresses } from '../tools/protocol/reference.js';
import type { Network } from '../rpc.js';

// ============================================================================
// R18 Phase 5 — the factory model (ai_concierge.md §5 Layer B, §7).
//
// THE INVARIANT, in one line: Aletheia builds; the user signs.
//
// Nothing in this directory holds a key, signs anything, or broadcasts
// anything. There is no signing surface in the code, by design — that is what
// makes "Aletheia never signs" an architectural fact rather than a policy
// promise. `viem` is imported for encodeFunctionData ONLY; no wallet client,
// no account, no private key ever enters this process.
//
// If you are adding a tool here, the boundary that matters is in
// ai_concierge.md §4:
//
//   returning unsigned calldata          -> information service   BUILD
//   returning a catalogue of options     -> information service   BUILD
//   filtering by USER-SUPPLIED criteria  -> information service   BUILD
//   ranking / scoring / "the best X"     -> investment advice     NEVER
//   signing, holding keys, routing       -> CASP                  NEVER
//
// MD12 makes three of these build requirements rather than commentary:
//   1. REGULATORY_NOTICE ships verbatim in every prepare_* description.
//   2. `intent` and `context` echo parameters back as USER-SUPPLIED.
//   3. No ranking/scoring/selection primitive exists anywhere in this module.
//
// Reason: a third-party LLM sits between the user and these tools and may
// itself select an auction, a size or a tenor before calling one. We cannot
// bind the client — so the blueprint is built to read, to an auditor, as a
// record of what the user specified.
// ============================================================================

/**
 * ai_concierge.md §12 — non-negotiable. Any deviation that softens this must
 * be reviewed before deployment. Appended verbatim to every factory tool's
 * description string.
 */
export const REGULATORY_NOTICE =
  'Returns an unsigned transaction blueprint for the requested intent. ' +
  'The user is responsible for reviewing, signing, and broadcasting via ' +
  'their own wallet. Aletheia does not hold keys or dispatch transactions.';

export const CHAIN_IDS: Record<Network, number> = {
  'arbitrum-one': 42161,
  'arbitrum-sepolia': 421614,
};

export function contractsFor(network: Network): ContractAddresses {
  return network === 'arbitrum-sepolia' ? TESTNET_CONTRACTS : MAINNET_CONTRACTS;
}

// Minimal ABI fragments — only what we encode. Signatures are the canonical
// ones from get_protocol_reference's KEY_FUNCTIONS; keep them in step.
export const LOAN_PROTOCOL_ABI = [
  {
    name: 'createAuction',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'collateralAmount', type: 'uint256' },
      { name: 'loanToken', type: 'address' },
      { name: 'loanAmount', type: 'uint256' },
      { name: 'maxRepayment', type: 'uint256' },
      { name: 'loanDuration', type: 'uint256' },
      { name: 'auctionDuration', type: 'uint256' },
      { name: 'bidStep', type: 'uint256' },
    ],
    outputs: [{ name: 'auctionId', type: 'uint256' }],
  },
  {
    name: 'placeBid',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'auctionId', type: 'uint256' },
      { name: 'repaymentAmount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'repayLoan',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claimCollateral',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'loanId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'claimRefund',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
] as const satisfies Abi;

export const ERC20_APPROVE_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

export interface TxBlueprint {
  to: string;
  data: string;
  value: string;
  chain_id: number;
}

export interface Prerequisite {
  type: 'erc20_approval';
  rationale: string;
  transaction: TxBlueprint;
  deeplinks: Deeplinks;
}

export interface Deeplinks {
  eip681: string;
  wallet_agnostic_url: string;
}

/**
 * EIP-681 (§7). Supports simple scalar types only — uint256, address, bytes32.
 * Every call in the current surface is scalar-only, so this is sufficient; a
 * future tool taking an array or struct must fall back to the on-site signer
 * rather than emit a malformed URI.
 */
export function eip681(
  to: string,
  chainId: number,
  fnName: string,
  params: Array<{ type: string; value: string }>
): string {
  const qs = params.map((p) => `${p.type}=${p.value}`).join('&');
  return `ethereum:${to}@${chainId}/${fnName}${qs ? `?${qs}` : ''}`;
}

export function walletAgnosticUrl(tx: TxBlueprint): string {
  const q = new URLSearchParams({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    chainId: String(tx.chain_id),
  });
  return `https://thegavel.io/sign?${q.toString()}`;
}

export function deeplinksFor(
  tx: TxBlueprint,
  fnName: string,
  params: Array<{ type: string; value: string }>
): Deeplinks {
  return {
    eip681: eip681(tx.to, tx.chain_id, fnName, params),
    wallet_agnostic_url: walletAgnosticUrl(tx),
  };
}

/** Decimal string -> base units, without float rounding. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Amount '${amount}' is not a positive decimal number`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new Error(
      `Amount '${amount}' has ${frac.length} decimal places but this token allows ${decimals}. ` +
        `Round it before encoding — silently truncating a user's amount is not acceptable.`
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

export function fromBaseUnits(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function encodeApproval(
  token: string,
  spender: string,
  amount: bigint,
  chainId: number
): TxBlueprint {
  return {
    to: token,
    data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender as `0x${string}`, amount] }),
    value: '0',
    chain_id: chainId,
  };
}

export function encodeLoanProtocolCall(
  contract: string,
  functionName: 'createAuction' | 'placeBid' | 'repayLoan' | 'claimCollateral' | 'claimRefund',
  args: readonly unknown[],
  chainId: number
): TxBlueprint {
  return {
    to: contract,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: encodeFunctionData({ abi: LOAN_PROTOCOL_ABI, functionName, args: args as any }),
    value: '0',
    chain_id: chainId,
  };
}

/**
 * How long a blueprint should be treated as current. Auction state moves, so
 * a blueprint generated and signed ten minutes apart may no longer be valid;
 * ai_concierge.md §11.6 settles this as warn at 5 minutes, regenerate at 10.
 */
export const BLUEPRINT_TTL_MS = 10 * 60_000;

export function expiresAt(now = Date.now()): string {
  return new Date(now + BLUEPRINT_TTL_MS).toISOString();
}

export interface Envelope {
  intent: string;
  summary_for_user: string;
  parameters_you_supplied: Record<string, unknown>;
  context: Record<string, unknown>;
  prerequisites: Prerequisite[];
  transaction: TxBlueprint;
  deeplinks: Deeplinks;
  warnings: string[];
  expires_at: string;
  disclosure: string;
}

/**
 * Builds the standard envelope. `parameters_you_supplied` is a required field,
 * not an optional nicety — it is MD12 mitigation 2, the record that these
 * terms came from the user rather than from an Aletheia model.
 */
export function buildEnvelope(args: {
  intent: string;
  summaryForUser: string;
  parametersYouSupplied: Record<string, unknown>;
  context: Record<string, unknown>;
  prerequisites?: Prerequisite[];
  transaction: TxBlueprint;
  deeplinks: Deeplinks;
  warnings?: string[];
}): Envelope {
  return {
    intent: args.intent,
    summary_for_user: args.summaryForUser,
    parameters_you_supplied: args.parametersYouSupplied,
    context: args.context,
    prerequisites: args.prerequisites ?? [],
    transaction: args.transaction,
    deeplinks: args.deeplinks,
    warnings: args.warnings ?? [],
    expires_at: expiresAt(),
    disclosure: REGULATORY_NOTICE,
  };
}
