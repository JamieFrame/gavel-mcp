import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, RawContractError, decodeErrorResult, encodeFunctionData, getAddress, isAddress, type Abi, type Hex } from 'viem';
import { testnetClient } from '../rpc.js';
import { buildEnvelope, fromBaseUnits, toBaseUnits, type Deeplinks, type Envelope, type Prerequisite, type TxBlueprint } from '../factory/envelope.js';
import { V2_DEPLOYMENT } from './deployment.generated.js';
import { TESTNET_DISCLOSURE } from './read.js';
import * as ABI from './abi.generated.js';

// ============================================================================
// VZ10 row M1, G3 — the write layer of the gavel-testnet profile (G1 §3, §4).
//
// Aletheia builds; the user signs. Nothing here holds a key, signs or sends: viem is used to
// encode calldata, and to READ the chain (eth_call) for the checks a blueprint needs. The one
// "send-like" call is eth_call simulation from the user's address, which changes nothing.
//
// Every blueprint is on Arbitrum Sepolia (421614), to an address from the generated deployment
// table, with value 0 (no V2 function is payable). Prerequisites are emitted only when the chain
// says the user is short, each in the exact amount (G1 §3.1).
// ============================================================================

export const CHAIN_ID = V2_DEPLOYMENT.chainId;
type Addr = `0x${string}`;

const ALL_ERRORS: Abi = (Object.values(ABI) as unknown[])
  .filter((v): v is Abi => Array.isArray(v))
  .flatMap((a) => a.filter((x) => x.type === 'error'))
  // one entry per selector-defining signature
  .filter((x, i, arr) => arr.findIndex((y) => JSON.stringify(y) === JSON.stringify(x)) === i);

// ── addresses and tokens: from the generated table only ──

export function contract(name: string): Addr {
  const hits = V2_DEPLOYMENT.contracts.filter((c) => c.name === name && !c.superseded);
  if (hits.length !== 1) throw new Error(`deployment table: ${hits.length} live contracts named ${name}`);
  return getAddress(hits[0].address) as Addr;
}

export interface Token { symbol: string; address: Addr; decimals: number }
const TOKENS: Token[] = V2_DEPLOYMENT.tokens.map((t) => ({ symbol: t.symbol, address: getAddress(t.address) as Addr, decimals: t.decimals }));

/** A test token by symbol (mWBTC) or address; nothing outside the record's mocks. */
export function token(input: string, field = 'token'): Token {
  const t = TOKENS.find((x) => x.symbol.toLowerCase() === input.toLowerCase() || x.address.toLowerCase() === input.toLowerCase());
  if (!t) refuse(`${field} '${input}' is not one of this deployment's test tokens: ${TOKENS.map((x) => x.symbol).join(', ')}.`);
  return t;
}
export const tokenByAddress = (a: string): Token | undefined => TOKENS.find((x) => x.address.toLowerCase() === a.toLowerCase());

export function address(input: string, field: string): Addr {
  if (!isAddress(input, { strict: false })) refuse(`${field} '${input}' is not an address.`);
  const a = getAddress(input) as Addr;
  if (a === '0x0000000000000000000000000000000000000000') refuse(`${field} is the zero address.`);
  return a;
}

/** The Vault's key for an ERC-20: 0x01 ‖ 11 zero bytes ‖ token (AssetKey.erc20Key). */
export function assetKey(tokenAddr: string): Hex {
  return `0x01${'00'.repeat(11)}${tokenAddr.slice(2).toLowerCase()}` as Hex;
}
export const tokenOfKey = (key: string): Addr => getAddress(`0x${key.slice(-40)}`) as Addr;

export function amount(input: string, t: Token, field: string): bigint {
  let v: bigint;
  try { v = toBaseUnits(input, t.decimals); } catch (e) { refuse(`${field}: ${(e as Error).message}`); }
  if (v === 0n) refuse(`${field} must be above zero.`);
  return v;
}
export const show = (raw: bigint, t: Token) => `${fromBaseUnits(raw, t.decimals)} ${t.symbol}`;

// ── refusals: a hard error is thrown before anything is encoded ──

export function refuse(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}
/** A revert the chain would raise, named as the contract names it. */
export function wouldRevert(contractName: string, error: string, why: string): never {
  throw new McpError(ErrorCode.InvalidParams, `Would revert with ${contractName}.${error}: ${why}`);
}

// ── chain reads (eth_call only) ──

export async function read<T>(to: Addr, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await testnetClient.readContract({ address: to, abi, functionName, args } as never)) as T;
}

// ── encoding ──

export function encode(to: Addr, abi: Abi, functionName: string, args: readonly unknown[]): TxBlueprint {
  return { to, data: encodeFunctionData({ abi, functionName, args } as never), value: '0', chain_id: CHAIN_ID };
}

/** G1 §4: EIP-681 only where every argument is a scalar; the sign page link only once it is live. */
export function deeplinks(tx: TxBlueprint, fn: string, scalars: Array<{ type: string; value: string }> | null): Deeplinks {
  const base = (process.env.GAVEL_TESTNET_SIGN_URL || '').replace(/\/$/, '');
  return {
    eip681: scalars ? `ethereum:${tx.to}@${tx.chain_id}/${fn}${scalars.length ? `?${scalars.map((p) => `${p.type}=${p.value}`).join('&')}` : ''}` : null,
    ...(scalars ? {} : { eip681_unavailable: 'this call takes bytes or a struct, which an EIP-681 link cannot carry; use transaction.data' }),
    wallet_agnostic_url: base
      ? `${base}?${new URLSearchParams({ to: tx.to, data: tx.data, value: tx.value, chainId: String(tx.chain_id) }).toString()}`
      : null,
    ...(base ? {} : { wallet_agnostic_url_unavailable: 'the testnet sign page is not live yet; sign transaction.data from your own wallet' }),
  };
}

// ── prerequisites, each only when the chain says the user is short, each exact ──

const ERC20 = ABI.MockERC20_ABI as unknown as Abi;
const VAULT = ABI.Vault_ABI as unknown as Abi;

export async function balanceOf(t: Token, who: Addr): Promise<bigint> {
  return read<bigint>(t.address, ERC20, 'balanceOf', [who]);
}
export async function vaultFree(who: Addr, t: Token, vault: Addr = contract('Vault')): Promise<bigint> {
  return read<bigint>(vault, VAULT, 'balance', [who, assetKey(t.address)]);
}

/** approve(spender, need) when the allowance is below need. Never unlimited. */
export async function erc20Approval(t: Token, owner: Addr, spender: Addr, spenderName: string, need: bigint): Promise<Prerequisite | null> {
  if (need === 0n) return null;
  const allowance = await read<bigint>(t.address, ERC20, 'allowance', [owner, spender]);
  if (allowance >= need) return null;
  const tx = encode(t.address, ERC20, 'approve', [spender, need]);
  return {
    type: 'erc20_approval',
    rationale: `Allow the ${spenderName} (${spender}) to take exactly ${show(need, t)} from your wallet; the allowance now is ${show(allowance, t)}. Exact, never unlimited.`,
    transaction: tx,
    deeplinks: deeplinks(tx, 'approve', [{ type: 'address', value: spender }, { type: 'uint256', value: need.toString() }]),
  };
}

/**
 * The Vault must hold `need` of t free for `who`. Emits, when short: the ERC-20 approval to the
 * Vault for the shortfall, then Vault.deposit(who, key, shortfall, 0x). A wallet short of the
 * shortfall is a hard error (the deposit would revert ERC20InsufficientBalance).
 */
export async function vaultFunding(who: Addr, t: Token, need: bigint, purpose: string, vault: Addr = contract('Vault')): Promise<Prerequisite[]> {
  const free = await vaultFree(who, t, vault);
  if (free >= need) return [];
  const short = need - free;
  const wallet = await balanceOf(t, who);
  if (wallet < short) {
    wouldRevert('Vault', 'InsufficientBalance', `${purpose} needs ${show(need, t)} free in the Vault; ${show(free, t)} is free there and the wallet holds ${show(wallet, t)}, short of the ${show(short, t)} to deposit. ` +
      `On this testnet prepare_test_token_mint mints test tokens.`);
  }
  const approval = await erc20Approval(t, who, vault, 'Vault', short);
  const tx = encode(vault, VAULT, 'deposit', [who, assetKey(t.address), short, '0x']);
  const dep: Prerequisite = {
    type: 'vault_deposit',
    rationale: `${purpose} draws on your free Vault balance: ${show(free, t)} is free; deposit the ${show(short, t)} short. Vault.deposit pulls it from your wallet.`,
    transaction: tx,
    deeplinks: deeplinks(tx, 'deposit', null),
  };
  return [...(approval ? [approval] : []), dep];
}

/**
 * The user must have approved `product` as a Vault consumer; governance must have authorised it.
 * Unauthorised is a hard error (no user action fixes it); unapproved emits approveConsumer.
 */
export async function consumerApproval(who: Addr, product: Addr, productName: string, vault: Addr = contract('Vault')): Promise<Prerequisite | null> {
  const authorised = await read<boolean>(vault, VAULT, 'isAuthorisedConsumer', [product]);
  if (!authorised) wouldRevert('Vault', 'ConsumerNotAuthorised', `the ${productName} (${product}) is not an authorised Vault consumer on this deployment.`);
  if (await read<boolean>(vault, VAULT, 'isUserApproved', [who, product])) return null;
  const tx = encode(vault, VAULT, 'approveConsumer', [product, true]);
  return {
    type: 'vault_consumer_approval',
    rationale: `Approve the ${productName} (${product}) as a consumer of your Vault account, so it can reserve or lock your balance for this action. Revocable with prepare_vault_product_approval.`,
    transaction: tx,
    deeplinks: deeplinks(tx, 'approveConsumer', [{ type: 'address', value: product }, { type: 'bool', value: 'true' }]),
  };
}

// ── simulation: eth_call from the user, when nothing must land first ──

export interface Simulated { ran: boolean; result?: unknown; note?: string }

/**
 * Simulate the call from `from` with eth_call. With prerequisites outstanding the call would fail
 * for that reason alone, so it is not run and the answer says so. A revert is a hard error,
 * decoded to the contract's own error name.
 */
export async function simulate(tx: TxBlueprint, from: Addr, abi: Abi, fn: string, contractName: string, prerequisites: Prerequisite[], gas?: bigint): Promise<Simulated> {
  if (prerequisites.length) return { ran: false, note: 'Not simulated: the prerequisites must land first. Each check above was read from the chain.' };
  try {
    const r = await testnetClient.call({ account: from, to: tx.to as Addr, data: tx.data as Hex, ...(gas ? { gas } : {}) });
    let result: unknown;
    try {
      const { decodeFunctionResult } = await import('viem');
      result = r.data ? decodeFunctionResult({ abi, functionName: fn, data: r.data } as never) : undefined;
    } catch { result = undefined; }
    return { ran: true, result: plain(result) };
  } catch (err) {
    if (!isRevert(err)) chainUnavailable(err);
    wouldRevert(contractName, ...revertName(err));
  }
}

/** True when the error is the chain reverting, not the RPC failing. */
export function isRevert(err: unknown): boolean {
  if (findRevertData(err)) return true;
  if (err instanceof BaseError) {
    return !!err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError || e instanceof RawContractError);
  }
  return false;
}

/** The RPC could not be read: nothing was decided, so say so rather than name a revert. */
export function chainUnavailable(err: unknown): never {
  const msg = err instanceof BaseError ? err.shortMessage : String(err);
  throw new McpError(ErrorCode.InternalError, `The Arbitrum Sepolia RPC could not be read (${msg}). Nothing was checked or built; call again.`);
}

/** JSON-safe: bigints as decimal strings, through arrays and objects. */
export function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function revertName(err: unknown): [string, string] {
  const data = findRevertData(err);
  if (data && data !== '0x') {
    try {
      const d = decodeErrorResult({ abi: ALL_ERRORS, data });
      const args = (d.args ?? []).map((a) => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ');
      return [d.errorName, `simulated from your address, the call reverts ${d.errorName}(${args}).`];
    } catch { /* unknown selector */ }
    return ['UnknownError', `simulated from your address, the call reverts with data ${data.slice(0, 10)}.`];
  }
  const msg = err instanceof BaseError ? err.shortMessage : String(err);
  return ['Revert', `simulated from your address, the call reverts: ${msg}`];
}

function findRevertData(err: unknown): Hex | undefined {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError || (typeof (e as { data?: unknown }).data === 'string'));
    const d = (r as { data?: unknown; raw?: unknown } | null)?.raw ?? (r as { data?: unknown } | null)?.data;
    if (typeof d === 'string' && d.startsWith('0x')) return d as Hex;
  }
  const d = (err as { data?: unknown })?.data;
  return typeof d === 'string' && d.startsWith('0x') ? (d as Hex) : undefined;
}

// ── the answer ──

/** The envelope (G1 §3.1), as one compact JSON text with the testnet disclosure beside it. */
export function blueprint(e: Parameters<typeof buildEnvelope>[0] & { simulation: Simulated }) {
  const { simulation, ...rest } = e;
  const env: Envelope & Record<string, unknown> = { ...buildEnvelope(rest), simulation, network: { chainId: CHAIN_ID, name: 'arbitrum-sepolia', testnet: true } };
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ...env, testnet: TESTNET_DISCLOSURE }) }] };
}

export { ABI };
