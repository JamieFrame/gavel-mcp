import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, type Abi, type Hex } from 'viem';
import { requireTier } from '../../tiers.js';
import { REGULATORY_NOTICE, type Prerequisite } from '../../factory/envelope.js';
import { testnetClient } from '../../rpc.js';
import { V2_DEPLOYMENT } from '../../v2/deployment.generated.js';
import { v2Get } from '../../v2/read.js';
import {
  ABI, address, amount, assetKey, balanceOf, blueprint, chainUnavailable, consumerApproval, isRevert, contract, deeplinks, encode, erc20Approval, read, refuse,
  show, simulate, token, tokenByAddress, tokenOfKey, vaultFree, vaultFunding, wouldRevert, type Token,
} from '../../v2/write.js';
import { resolveMarket } from './read-tools.js';

// ============================================================================
// VZ10 row M1, G3 — wave 1 of the gavel-testnet write tools (G1 §3.2): the vault, spot and the
// bullet loan, with the obligation and lien actions a bullet loan leads to. Each returns an
// unsigned blueprint; the user's own wallet signs. Every revert the chain lets us foresee is a
// hard error naming the contract's own error; what may move before the send is a warning.
// ============================================================================

type Addr = `0x${string}`;
const A = {
  ERC20: ABI.MockERC20_ABI as unknown as Abi,
  VAULT: ABI.Vault_ABI as unknown as Abi,
  SPOT: ABI.SpotMarket_ABI as unknown as Abi,
  REQ: ABI.BulletLoanRequest_ABI as unknown as Abi,
  OFF: ABI.BulletLoanOffer_ABI as unknown as Abi,
  SINGLE: ABI.SingleAuction_ABI as unknown as Abi,
  GROUP: ABI.GroupAuction_ABI as unknown as Abi,
  OBL: ABI.Obligation_ABI as unknown as Abi,
  LIEN: ABI.Lien_ABI as unknown as Abi,
};

const WAD = 10n ** 18n;
const D = (s: string) => `${s}\n\n${REGULATORY_NOTICE}`;
const ACCOUNT = z.string().describe('The address that will sign and send the transaction (your wallet).');
const now = async () => (await testnetClient.getBlock()).timestamp;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// ── bullet products ──

const BULLET = {
  request: { name: 'BulletLoanRequest', abi: A.REQ },
  offer: { name: 'BulletLoanOffer', abi: A.OFF },
} as const;
type Kind = keyof typeof BULLET;
const OPENING = ['REQUEST_ONE', 'REQUEST_MANY', 'OFFER_ONE', 'OFFER_MANY'] as const;
const LOAN_STATE = ['NONE', 'OPEN', 'CLOSED', 'ORIGINATED', 'ENDED'] as const;
const ENTRY_STATE = ['NONE', 'LIVE', 'WON', 'SETTLED', 'RELEASED'] as const;
const PHASE_LIVE = 1;

interface Loan { opener: Addr; opening: number; state: number; auctionId: bigint; deadline: bigint; setId: bigint }
async function loanOf(kind: Kind, id: bigint): Promise<Loan> {
  const [opener, opening, state, auctionId, deadline, setId] = await read<[Addr, number, number, bigint, bigint, bigint]>(contract(BULLET[kind].name), BULLET[kind].abi, 'loanOf', [id]);
  return { opener, opening, state, auctionId, deadline, setId };
}
async function deadlineOf(kind: Kind, id: bigint) {
  const [end, deadline] = await read<[bigint, bigint]>(contract(BULLET[kind].name), BULLET[kind].abi, 'deadlineOf', [id]);
  return { end, deadline };
}

/**
 * The terms a bid must name (expectedTerms): the contracts keep the hash private and emit no
 * event carrying the terms, so they are rebuilt from the opening transaction's own calldata —
 * found through the LoanOpened event (the indexer first, then the chain's logs).
 */
/** GroupAuction's required improvement over a standing price (OpenBid.requiredImprovement): an absolute step, or BPS of the price rounded up, at least 1. */
function improvement(g: { step: bigint; stepKind: number }, old: bigint): bigint {
  if (g.stepKind === 0) return g.step; // ABSOLUTE
  const st = g.step > 10_000n ? 10_000n : g.step;
  const rest = (old % 10_000n) * st;
  const d = (old / 10_000n) * st + rest / 10_000n + (rest % 10_000n === 0n ? 0n : 1n);
  return d === 0n ? 1n : d;
}

async function openingTerms(kind: Kind, loanId: bigint): Promise<{ terms: Record<string, unknown>; many: boolean; hash: Hex; tx: Hex }> {
  const product = contract(BULLET[kind].name);
  const abi = BULLET[kind].abi;
  let txHash: Hex | undefined;
  const event = abi.find((x) => x.type === 'event' && x.name === 'LoanOpened');
  // 1. The indexer, filtered to events carrying this loan id (t1 matches any argument; the loanId field is checked here).
  try {
    const c = await v2Get<{ rows: Array<{ transactionHash: Hex; args: Record<string, string> }> }>('/events', { contract: product, event: 'LoanOpened', t1: loanId.toString(), limit: 50 });
    txHash = c.body.rows.find((r) => String(r.args?.loanId) === loanId.toString())?.transactionHash;
  } catch { /* not served or not indexed yet: the chain's logs follow */ }
  // 2. The chain's logs, by the indexed loanId: the whole range since deployment, newest first, in windows an RPC accepts.
  if (!txHash) {
    const from = BigInt(V2_DEPLOYMENT.contracts.find((c) => c.name === BULLET[kind].name)!.block);
    const latest = await testnetClient.getBlockNumber();
    const WINDOW = 100_000n;
    for (let to = latest; to >= from && !txHash; to -= WINDOW) {
      const fromBlock = to - WINDOW + 1n > from ? to - WINDOW + 1n : from;
      const logs = (await testnetClient.getLogs({ address: product, event: event as never, args: { loanId } as never, fromBlock, toBlock: to })) as Array<{ transactionHash: Hex | null }>;
      txHash = logs[0]?.transactionHash ?? undefined;
      if (fromBlock === from) break;
    }
  }
  if (!txHash) refuse(`Loan ${loanId}'s opening transaction was not found (no LoanOpened event for it on ${BULLET[kind].name}), so its terms cannot be rebuilt and a bid cannot be checked.`);
  // The transaction must be this product's own LoanOpened for this loan, called directly.
  const receipt = await testnetClient.getTransactionReceipt({ hash: txHash });
  const opened = receipt.logs.some((l) => {
    if (getAddress(l.address) !== product) return false;
    try { const e = decodeEventLog({ abi, data: l.data, topics: l.topics }); return e.eventName === 'LoanOpened' && (e.args as unknown as { loanId: bigint }).loanId === loanId; } catch { return false; }
  });
  if (!opened) refuse(`Transaction ${txHash} does not open loan ${loanId} on ${BULLET[kind].name}.`);
  const tx = await testnetClient.getTransaction({ hash: txHash });
  if (!tx.to || getAddress(tx.to) !== product) refuse(`Loan ${loanId} was opened through another contract (${tx.to}), so its terms cannot be read from the transaction and a bid cannot be checked.`);
  const fn = kind === 'request' ? 'openRequest' : 'openOffer';
  const d = decodeFunctionData({ abi, data: tx.input });
  if (d.functionName !== fn) refuse(`Loan ${loanId}'s opening transaction is not a direct ${fn} call, so a bid cannot be checked.`);
  const [, terms, many] = d.args as [Addr, Record<string, unknown>, boolean];
  const inputs = (abi.find((x) => x.type === 'function' && x.name === fn) as { inputs: readonly unknown[] }).inputs;
  const hash = keccak256(encodeAbiParameters([inputs[1], inputs[2]] as never, [terms, many] as never));
  return { terms, many, hash, tx: txHash };
}

const fmtSecs = (s: bigint) => new Date(Number(s) * 1000).toISOString();

export function registerV2WriteTools(server: McpServer) {
  // ── W1 ──
  server.registerTool(
    'prepare_test_token_mint',
    {
      title: 'Mint test tokens (testnet)',
      description: D(
        `Builds MockERC20.mint(to, amount) on one of this deployment's test tokens (mWBTC, mUSDC and the other mocks get_deployment lists). ` +
        `The mocks' mint is open to anyone, so this is how a test wallet gets tokens. Test tokens with no value.`
      ),
      inputSchema: {
        token: z.string().describe('A test token symbol (mWBTC, mUSDC, …) or its address.'),
        to: z.string().describe('The address to receive the tokens.'),
        amount: z.string().describe('In whole tokens, as a decimal string, e.g. "0.5".'),
      },
    },
    async ({ token: tk, to, amount: amt }) => {
      requireTier('free');
      const t = token(tk);
      const dest = address(to, 'to');
      const raw = amount(amt, t, 'amount');
      const tx = encode(t.address, A.ERC20, 'mint', [dest, raw]);
      return blueprint({
        intent: `Mint ${show(raw, t)} to ${dest}`,
        summaryForUser: `Mints ${show(raw, t)} (a test token with no value) to ${dest}. Anyone may call it.`,
        parametersYouSupplied: { token: tk, to, amount: amt },
        context: { token: t, rawAmount: raw.toString() },
        transaction: tx,
        deeplinks: deeplinks(tx, 'mint', [{ type: 'address', value: dest }, { type: 'uint256', value: raw.toString() }]),
        warnings: ['Test tokens with no value. The mocks also let anyone burn any holder\'s balance, so a test balance is not assured.'],
        simulation: await simulate(tx, dest, A.ERC20, 'mint', 'MockERC20', []),
      });
    }
  );

  // ── W2 ──
  server.registerTool(
    'prepare_vault_deposit',
    {
      title: 'Deposit into the Vault (testnet)',
      description: D(
        `Builds Vault.deposit(account, asset, amount, 0x): moves a test token from your wallet into your free Vault balance, ` +
        `which the V2 products reserve and lock from. Emits an exact ERC-20 approval to the Vault first when the allowance is short. ` +
        `The call carries bytes, so the EIP-681 link is null; use transaction.data.`
      ),
      inputSchema: { account: ACCOUNT, token: z.string().describe('A test token symbol or address.'), amount: z.string().describe('In whole tokens, decimal string.') },
    },
    async ({ account, token: tk, amount: amt }) => {
      requireTier('free');
      const who = address(account, 'account');
      const t = token(tk);
      const raw = amount(amt, t, 'amount');
      const vault = contract('Vault');
      const wallet = await balanceOf(t, who);
      if (wallet < raw) wouldRevert('MockERC20', 'ERC20InsufficientBalance', `the wallet holds ${show(wallet, t)}, below ${show(raw, t)}. prepare_test_token_mint mints test tokens.`);
      const pre = [await erc20Approval(t, who, vault, 'Vault', raw)].filter((p): p is Prerequisite => !!p);
      const tx = encode(vault, A.VAULT, 'deposit', [who, assetKey(t.address), raw, '0x']);
      const free = await vaultFree(who, t);
      return blueprint({
        intent: `Deposit ${show(raw, t)} into the Vault`,
        summaryForUser: `Moves ${show(raw, t)} from ${who}'s wallet into its free Vault balance (now ${show(free, t)}, after ${show(free + raw, t)}).`,
        parametersYouSupplied: { account, token: tk, amount: amt },
        context: { vault, asset: assetKey(t.address), rawAmount: raw.toString(), walletBalance: show(wallet, t), vaultFreeBefore: show(free, t) },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'deposit', null),
        warnings: [],
        simulation: await simulate(tx, who, A.VAULT, 'deposit', 'Vault', pre),
      });
    }
  );

  // ── W3 ──
  server.registerTool(
    'prepare_vault_withdraw',
    {
      title: 'Withdraw from the Vault (testnet)',
      description: D(
        `Builds Vault.withdraw(account, asset, amount, abi.encode(destination)): sends a test token from your FREE Vault balance to a wallet. ` +
        `Funds reserved by open orders or offers, or locked as collateral, are not free and cannot be withdrawn until released.`
      ),
      inputSchema: {
        account: ACCOUNT,
        token: z.string().describe('A test token symbol or address.'),
        amount: z.string().describe('In whole tokens, decimal string.'),
        destination: z.string().optional().describe('Where the tokens go; defaults to account.'),
      },
    },
    async ({ account, token: tk, amount: amt, destination }) => {
      requireTier('free');
      const who = address(account, 'account');
      const t = token(tk);
      const raw = amount(amt, t, 'amount');
      const vault = contract('Vault');
      const dest = destination ? address(destination, 'destination') : who;
      if (dest === vault) wouldRevert('Vault', 'InvalidAddress', 'the destination is the Vault itself.');
      const free = await vaultFree(who, t);
      const total = await read<bigint>(vault, A.VAULT, 'totalBalance', [who, assetKey(t.address)]);
      if (free < raw) wouldRevert('Vault', 'InsufficientBalance', `${show(free, t)} is free; ${show(total - free, t)} more is reserved or locked and is not free.`);
      const tx = encode(vault, A.VAULT, 'withdraw', [who, assetKey(t.address), raw, encodeAbiParameters([{ type: 'address' }], [dest])]);
      return blueprint({
        intent: `Withdraw ${show(raw, t)} from the Vault to ${dest}`,
        summaryForUser: `Sends ${show(raw, t)} from ${who}'s free Vault balance (${show(free, t)}) to ${dest}.`,
        parametersYouSupplied: { account, token: tk, amount: amt, destination: destination ?? null },
        context: { vault, asset: assetKey(t.address), rawAmount: raw.toString(), vaultFree: show(free, t), vaultReservedOrLocked: show(total - free, t) },
        transaction: tx,
        deeplinks: deeplinks(tx, 'withdraw', null),
        warnings: total > free ? [`${show(total - free, t)} of this account is reserved or locked by open orders, offers or loans, and stays in the Vault.`] : [],
        simulation: await simulate(tx, who, A.VAULT, 'withdraw', 'Vault', []),
      });
    }
  );

  // ── W4 ──
  // The V2 products a user acts through (G1 §3.1's spenders and consumers), named, not filtered by pattern.
  const PRODUCT_NAMES = ['BulletLoanRequest', 'BulletLoanOffer', 'Obligation', 'Lien', 'FutureOrchestrator', 'CoverOrchestrator', 'BillPackager', 'ClaimLotMarket', 'ObligorPositionMarket', 'BondProtocol'];
  const PRODUCTS = (): Array<{ name: string; address: Addr }> => [
    ...PRODUCT_NAMES.map((n) => ({ name: n, address: contract(n) })),
    ...V2_DEPLOYMENT.spot.pairs.map((p) => ({ name: `spot ${p.name}`, address: getAddress(p.spotMarket) as Addr })),
    ...V2_DEPLOYMENT.spot.billSeries.map((b) => ({ name: `bill-${b.k}`, address: getAddress(b.spotMarket) as Addr })),
  ].filter((x, i, arr) => arr.findIndex((y) => y.address === x.address) === i);
  server.registerTool(
    'prepare_vault_product_approval',
    {
      title: 'Approve or revoke a product on your Vault account (testnet)',
      description: D(
        `Builds Vault.approveConsumer(product, approved): lets a V2 product (a spot or bill market, the bullet loan contracts, Obligation, Lien, …) ` +
        `reserve, lock or move your Vault balance for actions you take with it, or revokes that. The other write tools emit this as a prerequisite when it is missing. ` +
        `Approving a product governance has not authorised is refused.`
      ),
      inputSchema: {
        account: ACCOUNT,
        product: z.string().describe("A product: its name in get_deployment (e.g. BulletLoanRequest, Obligation, Lien), a spot pair ('mWBTC/mUSDC'), a bill series ('bill-3') or its address."),
        approved: z.boolean().describe('true to approve, false to revoke.'),
      },
    },
    async ({ account, product, approved }) => {
      requireTier('free');
      const who = address(account, 'account');
      const l = product.toLowerCase();
      const list = PRODUCTS();
      const p = list.find((x) => x.name.toLowerCase() === l || x.name.toLowerCase() === `spot ${l}` || x.address.toLowerCase() === l);
      if (!p) refuse(`'${product}' is not a V2 product on this deployment. Products: ${list.map((x) => x.name).join(', ')}.`);
      const vault = contract('Vault');
      const authorised = await read<boolean>(vault, A.VAULT, 'isAuthorisedConsumer', [p.address]);
      if (approved && !authorised) wouldRevert('Vault', 'ConsumerNotAuthorised', `${p.name} is not an authorised consumer; approving it would succeed but every action through it would revert.`);
      const current = await read<boolean>(vault, A.VAULT, 'isUserApproved', [who, p.address]);
      const tx = encode(vault, A.VAULT, 'approveConsumer', [p.address, approved]);
      return blueprint({
        intent: `${approved ? 'Approve' : 'Revoke'} ${p.name} on ${who}'s Vault account`,
        summaryForUser: `${approved ? 'Lets' : 'Stops'} ${p.name} (${p.address}) ${approved ? 'reserve, lock or move' : 'reserving, locking or moving'} ${who}'s Vault balance. It is ${current ? 'approved' : 'not approved'} now.`,
        parametersYouSupplied: { account, product, approved },
        context: { vault, product: p, authorisedByGovernance: authorised, approvedNow: current },
        transaction: tx,
        deeplinks: deeplinks(tx, 'approveConsumer', [{ type: 'address', value: p.address }, { type: 'bool', value: String(approved) }]),
        warnings: [
          ...(current === approved ? [`It is already ${approved ? 'approved' : 'revoked'}; the transaction would change nothing.`] : []),
          ...(!approved ? ['Revoking while orders, offers or loans through this product are open makes their later moves revert.'] : []),
        ],
        simulation: await simulate(tx, who, A.VAULT, 'approveConsumer', 'Vault', []),
      });
    }
  );

  // ── W5 ──
  async function spotMarket(ref: string) {
    const m = resolveMarket(ref);
    const addr = getAddress(m.spotMarket) as Addr;
    const [baseKey, quoteKey, baseVault, quoteVault] = await Promise.all([
      read<Hex>(addr, A.SPOT, 'baseAsset'), read<Hex>(addr, A.SPOT, 'quoteAsset'), read<Addr>(addr, A.SPOT, 'baseVault'), read<Addr>(addr, A.SPOT, 'quoteVault'),
    ]);
    const tk = async (key: Hex, label: string): Promise<Token> => {
      const a = tokenOfKey(key);
      const known = tokenByAddress(a);
      if (known) return known;
      const [decimals, symbol] = await Promise.all([read<number>(a, A.ERC20, 'decimals'), read<string>(a, A.ERC20, 'symbol')]);
      return { symbol: symbol || label, address: a, decimals: Number(decimals) };
    };
    return { m, addr, base: await tk(baseKey, m.base), quote: await tk(quoteKey, m.quote), baseVault: getAddress(baseVault) as Addr, quoteVault: getAddress(quoteVault) as Addr };
  }

  server.registerTool(
    'prepare_spot_order',
    {
      title: 'Place a spot or bill order (testnet)',
      description: D(
        `Builds SpotMarket.placeOrder(side, amountBase, limitPrice, expiresAtSlot, hintPrev) on a spot pair or bill series. ` +
        `The order reserves from your free Vault balance (a sell: the base amount; a buy: floor(amount × limit price) of the quote), so a Vault deposit and the market's ` +
        `consumer approval are emitted first where missing. It clears in a batch at one price for everyone, or not at all; nothing is filled on placement.`
      ),
      inputSchema: {
        account: ACCOUNT,
        market: z.string().describe("A pair ('mWBTC/mUSDC'), a bill series ('bill-3') or a SpotMarket address; list_spot_markets lists them."),
        side: z.enum(['buy', 'sell']),
        amount: z.string().describe('The base amount, in whole base tokens (decimal string).'),
        limit_price: z.string().describe('Quote per one whole base token (decimal string). A buy fills at or below it, a sell at or above.'),
        expires_at_slot: z.number().int().nonnegative().optional().describe('The last slot the order may fill in; omit (0) for good-till-cancelled.'),
      },
    },
    async ({ account, market, side, amount: amt, limit_price, expires_at_slot }) => {
      requireTier('free');
      const who = address(account, 'account');
      const s = await spotMarket(market);
      const amountBase = amount(amt, s.base, 'amount');
      const scale = 18 + s.quote.decimals - s.base.decimals;
      if (scale < 0) refuse('This market\'s decimals cannot express a limit price.');
      let limitPrice: bigint;
      try { limitPrice = (await import('../../factory/envelope.js')).toBaseUnits(limit_price, scale); } catch (e) { refuse(`limit_price: ${(e as Error).message}`); }
      if (limitPrice === 0n) wouldRevert('SpotMarket', 'InvalidPrice', 'the limit price is zero.');
      const sideN = side === 'buy' ? 0 : 1;
      const [paused, minBase, minQuote, cap, open, slot] = await Promise.all([
        read<boolean>(s.addr, A.SPOT, 'paused'), read<bigint>(s.addr, A.SPOT, 'MIN_ORDER_SIZE_BASE'), read<bigint>(s.addr, A.SPOT, 'MIN_ORDER_SIZE_QUOTE'),
        read<bigint>(s.addr, A.SPOT, 'MAX_OPEN_ORDERS_PER_USER'), read<bigint>(s.addr, A.SPOT, 'openOrdersByUser', [who]), read<bigint>(s.addr, A.SPOT, 'getCurrentSlot'),
      ]);
      if (paused) wouldRevert('SpotMarket', 'EnforcedPause', 'the market is paused.');
      if (amountBase < minBase) wouldRevert('SpotMarket', 'OrderBelowMinSize', `the minimum is ${show(minBase, s.base)}.`);
      const quote = (amountBase * limitPrice) / WAD;
      if (sideN === 0 && quote < minQuote) wouldRevert('SpotMarket', 'OrderBelowMinQuote', `the order's quote, ${show(quote, s.quote)}, is below the minimum ${show(minQuote, s.quote)}.`);
      const exp = BigInt(expires_at_slot ?? 0);
      if (exp !== 0n && exp < slot) wouldRevert('SpotMarket', 'ExpiresAtNotInFuture', `slot ${exp} is before the current slot ${slot}.`);
      if (open >= cap) wouldRevert('SpotMarket', 'UserOrderCapReached', `${who} has ${open} open orders (pending cancels count until drained); the cap is ${cap}.`);
      const hint = await read<bigint>(s.addr, A.SPOT, 'findHint', [sideN, limitPrice, 0n, 1000n]);
      const [fundT, fundAmt, fundVault] = sideN === 1 ? [s.base, amountBase, s.baseVault] : [s.quote, quote, s.quoteVault];
      const pre: Prerequisite[] = [
        ...(await vaultFunding(who, fundT, fundAmt, `This ${side} order`, fundVault)),
        ...[await consumerApproval(who, s.addr, `${s.m.name} market`, fundVault)].filter((p): p is Prerequisite => !!p),
      ];
      const tx = encode(s.addr, A.SPOT, 'placeOrder', [sideN, amountBase, limitPrice, exp, hint]);
      const sim = await simulate(tx, who, A.SPOT, 'placeOrder', 'SpotMarket', pre);
      return blueprint({
        intent: `${side === 'buy' ? 'Buy' : 'Sell'} ${show(amountBase, s.base)} at a limit of ${limit_price} ${s.quote.symbol} on ${s.m.name}`,
        summaryForUser: `Places a ${side} order for ${show(amountBase, s.base)} on ${s.m.name}, limit ${limit_price} ${s.quote.symbol} per ${s.base.symbol}, ` +
          `reserving ${show(fundAmt, fundT)} of ${who}'s free Vault balance until it fills, expires or a cancel is drained.`,
        parametersYouSupplied: { account, market, side, amount: amt, limit_price, expires_at_slot: expires_at_slot ?? null },
        context: {
          market: { name: s.m.name, address: s.addr, base: s.base, quote: s.quote }, rawAmountBase: amountBase.toString(), rawLimitPrice: limitPrice.toString(),
          reserves: show(fundAmt, fundT), currentSlot: slot.toString(), expiresAtSlot: exp.toString(), hintPrev: hint.toString(), openOrders: open.toString(), cap: cap.toString(),
          ...(sim.ran ? { orderId: String(sim.result) } : {}),
        },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'placeOrder', [
          { type: 'uint8', value: String(sideN) }, { type: 'uint256', value: amountBase.toString() }, { type: 'uint256', value: limitPrice.toString() },
          { type: 'uint256', value: exp.toString() }, { type: 'uint256', value: hint.toString() },
        ]),
        warnings: [
          'The order clears in a batch at one price for every order in the slot, or not at all (a low-volume slot clears nothing). Nothing fills on placement.',
          'hintPrev is the book position read now; if the book moves first the call may revert StaleHint, and the blueprint should be rebuilt.',
        ],
        simulation: sim,
      });
    }
  );

  // ── W6 ──
  const ORDER_STATUS = ['UNINITIALIZED', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED', 'EXPIRED'];
  const CANCEL_GAS = 400_000n;
  server.registerTool(
    'prepare_spot_cancel',
    {
      title: 'Cancel a spot or bill order (testnet)',
      description: D(
        `Builds SpotMarket.cancelOrder(orderId). A cancel is usually QUEUED: the order stops taking part from the next clearing, and its reservation returns to your ` +
        `free Vault balance only when the queue is drained (by anyone, or at the next clearing). It needs a high gas limit; the blueprint names one.`
      ),
      inputSchema: { account: ACCOUNT, market: z.string().describe('The pair, bill series or SpotMarket address.'), order_id: z.string().regex(/^\d+$/).describe('The order id.') },
    },
    async ({ account, market, order_id }) => {
      requireTier('free');
      const who = address(account, 'account');
      const s = await spotMarket(market);
      const id = BigInt(order_id);
      const [owner, , released] = await read<[Addr, number, boolean, bigint]>(s.addr, A.SPOT, 'getOrderRecord', [id]);
      if (/^0x0+$/.test(owner)) wouldRevert('SpotMarket', 'OrderNotFound', `order ${id} was not placed on ${s.m.name}.`);
      if (getAddress(owner) !== who) wouldRevert('SpotMarket', 'NotOrderOwner', `order ${id} belongs to ${owner}.`);
      if (released) refuse(`Order ${id} is already released; a cancel would do nothing.`);
      const o = await read<{ status: number; side: number }>(s.addr, A.SPOT, 'getOrder', [id]);
      const status = ORDER_STATUS[o.status] ?? String(o.status);
      // The reservation still held for the order: a sell holds base at the base vault, a buy quote at the quote vault.
      const [rVault, rToken] = o.side === 1 ? [s.baseVault, s.base] : [s.quoteVault, s.quote];
      const reserved = await read<bigint>(rVault, A.VAULT, 'reservedBalance', [s.addr, who, assetKey(rToken.address), id]);
      const closed = ['FILLED', 'CANCELLED', 'EXPIRED'].includes(status);
      // The engine refuses a closed order; the market re-raises that only when nothing is still reserved, and otherwise releases at once.
      if (closed && reserved === 0n) wouldRevert('BatchAuction', 'OrderNotOpen', `order ${id} is ${status} and nothing is reserved for it.`);
      const tx = encode(s.addr, A.SPOT, 'cancelOrder', [id]);
      const sim = await simulate(tx, who, A.SPOT, 'cancelOrder', 'SpotMarket', [], CANCEL_GAS);
      const effect = closed
        ? `The order is ${status}, so the market releases the ${show(reserved, rToken)} still reserved for it at once.`
        : status === 'PENDING_CANCEL'
          ? `A cancel is already queued; another releases the ${show(reserved, rToken)} reserved at once only if the market's clearing has stalled or a stall period has passed since the first cancel, and otherwise changes nothing.`
          : `The cancel is queued; the ${show(reserved, rToken)} reserved returns to the free Vault balance when the queue is drained (by anyone, or at the next clearing), or at once if the market's clearing has stalled.`;
      return blueprint({
        intent: `Cancel order ${id} on ${s.m.name}`,
        summaryForUser: `Cancels ${who}'s order ${id} (${status}) on ${s.m.name}. ${effect}`,
        parametersYouSupplied: { account, market, order_id },
        context: { market: { name: s.m.name, address: s.addr }, status, reserved: show(reserved, rToken), gasLimit: CANCEL_GAS.toString() },
        transaction: { ...tx, gas: CANCEL_GAS.toString() } as typeof tx,
        deeplinks: deeplinks(tx, 'cancelOrder', [{ type: 'uint256', value: id.toString() }]),
        warnings: [
          `Send with a gas limit of at least ${CANCEL_GAS}: the market forwards 150,000 gas to the engine and reverts InsufficientGas below about 155,000 left.`,
          ...(!closed ? ['An order in a clearing that is under way can still fill in that clearing.'] : []),
        ],
        simulation: sim,
      });
    }
  );

  // ── W7 ──
  const legSchema = z.object({ token: z.string(), amount: z.string() }).strict();
  server.registerTool(
    'prepare_bullet_request_open',
    {
      title: 'Open a bullet loan request (testnet)',
      description: D(
        `Builds BulletLoanRequest.openRequest(borrower, terms, many): you ask to borrow a loan token against collateral you lock, and lenders bid DOWN the repayment ` +
        `in an auction. one: a single lender lends the whole amount; many: several lenders share it at one uniform price. Collateral is locked until the loan ends ` +
        `(any shortfall in your free Vault balance is pulled from your wallet, so an exact approval to the Vault is emitted per leg), and the Vault consumer approval ` +
        `for BulletLoanRequest first where missing. The terms carry bytes inside a struct, so the EIP-681 link is null. Bidders need the terms hash, returned in context.`
      ),
      inputSchema: {
        account: ACCOUNT,
        loan_token: z.string().describe('The token to borrow (a test token symbol or address).'),
        amount: z.string().describe('The amount to borrow, in whole loan tokens.'),
        max_repayment: z.string().describe('The most you will repay in total (principal and interest), in whole loan tokens; the auction starts from here.'),
        term_days: z.number().int().describe('The loan term in days, 7 to 10950 (30 years).'),
        auction_hours: z.number().int().describe('How long lenders may bid, in hours, 24 to 168.'),
        collateral: z.array(legSchema).min(1).max(16).describe('The collateral legs: [{ token, amount }], each a test token in whole units.'),
        mode: z.enum(['one', 'many']).describe("'one': a single lender takes the whole loan; 'many': lenders share it."),
        bid_step: z.string().optional().describe("one only: the least a new bid must lower the repayment by, in whole loan tokens; at most 10% of amount."),
        min_amount: z.string().optional().describe("many only: the least total that must be lent for the loan to happen, in whole loan tokens."),
      },
    },
    async (a) => {
      requireTier('free');
      const who = address(a.account, 'account');
      const lt = token(a.loan_token, 'loan_token');
      const amt = amount(a.amount, lt, 'amount');
      const maxRep = amount(a.max_repayment, lt, 'max_repayment');
      const product = contract('BulletLoanRequest');
      const MAX_REPAYMENT = (2n ** 256n - 1n) / WAD;
      if (await read<boolean>(product, A.REQ, 'paused')) wouldRevert('BulletLoanRequest', 'EnforcedPause', 'the product is paused.');
      if (maxRep < amt || maxRep > MAX_REPAYMENT) wouldRevert('BulletLoanRequest', 'InvalidTerms(2)', 'max_repayment must be at least the amount.');
      if (a.term_days < 7 || a.term_days > 30 * 365) wouldRevert('BulletLoanRequest', 'InvalidTerms(10)', 'the term must be 7 to 10950 days.');
      if (a.auction_hours < 24 || a.auction_hours > 168) wouldRevert('BulletLoanRequest', 'InvalidTerms(11)', 'the auction must last 24 to 168 hours.');
      const many = a.mode === 'many';
      let minAmount = 0n;
      let bidStep = 0n;
      if (many) {
        if (a.bid_step !== undefined) refuse("bid_step is taken only with mode 'one'.");
        if (a.min_amount === undefined) refuse("mode 'many' needs min_amount.");
        minAmount = amount(a.min_amount, lt, 'min_amount');
        if (minAmount > amt) wouldRevert('BulletLoanRequest', 'InvalidTerms(6)', 'min_amount is above the amount.');
      } else {
        if (a.min_amount !== undefined) refuse("min_amount is taken only with mode 'many'.");
        if (a.bid_step === undefined) refuse("mode 'one' needs bid_step.");
        bidStep = amount(a.bid_step, lt, 'bid_step');
        if (bidStep > (amt * 1000n) / 10000n) wouldRevert('BulletLoanRequest', 'InvalidTerms(5)', `bid_step is above 10% of the amount (${show((amt * 1000n) / 10000n, lt)}).`);
      }
      // Legs: test tokens, one per token, sorted by asset key (the contract requires strictly ascending).
      const legs = a.collateral.map((l, i) => { const t = token(l.token, `collateral[${i}].token`); return { t, key: assetKey(t.address), raw: amount(l.amount, t, `collateral[${i}].amount`) }; })
        .sort((x, y) => (BigInt(x.key) < BigInt(y.key) ? -1 : 1));
      for (let i = 1; i < legs.length; i++) if (legs[i].key === legs[i - 1].key) refuse(`collateral names ${legs[i].t.symbol} twice; give one leg per token.`);
      const lockParams = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32[]' }, { type: 'uint256[]' }], [who, legs.map((l) => l.key), legs.map((l) => l.raw)]);
      const terms = {
        token: lt.address, lockParams, amount: amt, minAmount, maxRepayment: maxRep, bidStep,
        term: BigInt(a.term_days) * 86400n, duration: BigInt(a.auction_hours) * 3600n,
      };
      const vault = contract('Vault');
      const pre: Prerequisite[] = [];
      const consumer = await consumerApproval(who, product, 'BulletLoanRequest');
      if (consumer) pre.push(consumer);
      const legView = [];
      for (const l of legs) {
        const free = await vaultFree(who, l.t);
        const short = l.raw > free ? l.raw - free : 0n;
        if (short > 0n) {
          const wallet = await balanceOf(l.t, who);
          if (wallet < short) wouldRevert('MockERC20', 'ERC20InsufficientBalance', `the ${l.t.symbol} leg needs ${show(short, l.t)} from the wallet beyond the ${show(free, l.t)} free in the Vault; the wallet holds ${show(wallet, l.t)}.`);
          const ap = await erc20Approval(l.t, who, vault, 'Vault', short);
          if (ap) pre.push(ap);
        }
        legView.push({ token: l.t.symbol, amount: show(l.raw, l.t), fromVault: show(l.raw - short, l.t), fromWallet: show(short, l.t) });
      }
      const inputs = (A.REQ.find((x) => x.type === 'function' && x.name === 'openRequest') as { inputs: readonly unknown[] }).inputs;
      const termsHash = keccak256(encodeAbiParameters([inputs[1], inputs[2]] as never, [terms, many] as never));
      const tx = encode(product, A.REQ, 'openRequest', [who, terms, many]);
      const sim = await simulate(tx, who, A.REQ, 'openRequest', 'BulletLoanRequest', pre);
      return blueprint({
        intent: `Request to borrow ${show(amt, lt)} for ${a.term_days} days, repaying at most ${show(maxRep, lt)}`,
        summaryForUser: `Opens a ${many ? 'shared (many lenders)' : 'single-lender'} request to borrow ${show(amt, lt)} for ${a.term_days} days, repaying at most ${show(maxRep, lt)}, ` +
          `with ${legView.map((l) => l.amount).join(' + ')} locked as collateral from now until the loan ends. Lenders bid the repayment down for ${a.auction_hours} hours.`,
        parametersYouSupplied: a,
        context: {
          product, termsHash, many, collateral: legView,
          rawTerms: { ...terms, amount: amt.toString(), minAmount: minAmount.toString(), maxRepayment: maxRep.toString(), bidStep: bidStep.toString(), term: terms.term.toString(), duration: terms.duration.toString() },
          ...(sim.ran ? { loanId: String(sim.result) } : {}),
        },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'openRequest', null),
        warnings: [
          'The collateral is locked from opening until the loan is repaid, enforced, or the request ends without a loan.',
          'If the loan is made, the principal lands in your free Vault balance, not your wallet; prepare_vault_withdraw moves it.',
          'A request can be cancelled only before its first bid and before its auction window ends.',
        ],
        simulation: sim,
      });
    }
  );

  // ── W8 ──
  server.registerTool(
    'prepare_bullet_request_bid',
    {
      title: 'Bid on a bullet loan request (testnet)',
      description: D(
        `Builds BulletLoanRequest.bidRequest(lender, loanId, quantity, repayment, minFill, hintPrev, expectedTerms): you offer to lend against a request, naming the total ` +
        `you would be repaid. A lower repayment is a more competitive bid, and the bid may be outbid before the auction ends. The principal is reserved from your FREE ` +
        `Vault balance (no wallet pull), so a Vault deposit and the consumer approval are emitted first where missing. The request's terms hash is rebuilt from its opening transaction.`
      ),
      inputSchema: {
        account: ACCOUNT,
        loan_id: z.string().regex(/^\d+$/),
        repayment: z.string().describe('The total you would be repaid for your quantity, in whole loan tokens.'),
        quantity: z.string().optional().describe("many: the amount you would lend, in whole loan tokens. one: omit (the whole amount)."),
        min_fill: z.string().optional().describe('many: the least of your quantity you accept being filled; defaults to the auction minimum.'),
        expected_terms: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Optional: the terms hash you expect (e.g. from the opener's prepare_bullet_request_open). Refused if it differs from the hash rebuilt from the request's opening transaction."),
      },
    },
    async (a) => {
      requireTier('free');
      const who = address(a.account, 'account');
      const id = BigInt(a.loan_id);
      const product = contract('BulletLoanRequest');
      if (await read<boolean>(product, A.REQ, 'paused')) wouldRevert('BulletLoanRequest', 'EnforcedPause', 'the product is paused.');
      const loan = await loanOf('request', id);
      if (loan.state !== 1 || loan.opening > 1) wouldRevert('BulletLoanRequest', 'WrongState', `loan ${id} is ${LOAN_STATE[loan.state] ?? loan.state} (${OPENING[loan.opening] ?? loan.opening}); bids need an OPEN request.`);
      if (getAddress(loan.opener) === who) wouldRevert('SingleAuction', 'PrincipalCannotBid', 'the borrower cannot bid on its own request.');
      const o = await openingTerms('request', id);
      const t = o.terms as { token: Addr; amount: bigint; maxRepayment: bigint };
      if (a.expected_terms && a.expected_terms.toLowerCase() !== o.hash.toLowerCase()) {
        wouldRevert('BulletLoanRequest', 'TermsChanged', `the terms hash supplied (${a.expected_terms}) is not the one rebuilt from loan ${id}'s opening transaction (${o.hash}).`);
      }
      const expected = o.hash;
      const lt = tokenByAddress(t.token) ?? refuse(`loan ${id}'s token ${t.token} is not a test token of this deployment.`);
      const many = loan.opening === 1;
      if (!many && a.quantity !== undefined) refuse('quantity is taken only for a many request; a one request is lent whole.');
      if (!many && a.min_fill !== undefined) refuse('min_fill is taken only for a many request.');
      const qty = many ? amount(a.quantity ?? refuse('a many request needs quantity.'), lt, 'quantity') : t.amount;
      const rep = amount(a.repayment, lt, 'repayment');
      if (rep < qty) wouldRevert('BulletLoanRequest', 'InvalidTerms(20)', 'the repayment is below the quantity lent.');
      const cap = (t.maxRepayment * qty) / t.amount;
      if (rep > cap) wouldRevert('BulletLoanRequest', 'InvalidTerms(21)', `the most this quantity may be repaid is ${show(cap, lt)}.`);
      const price = ceilDiv(rep * WAD, qty);
      let minFill = 0n;
      let hint = 0n;
      const { end } = await deadlineOf('request', id);
      const ts = await now();
      if (ts >= end) wouldRevert('SingleAuction', 'NotLive', `the auction ended at ${fmtSecs(end)}.`);
      if (!many) {
        const single = await read<Addr>(product, A.REQ, 'single');
        const [minPrice, open] = await read<[bigint, boolean]>(single, A.SINGLE, 'minimumNextBid', [loan.auctionId]);
        if (!open) wouldRevert('SingleAuction', 'AtBound', 'the auction has reached its bound.');
        if (price > minPrice) wouldRevert('SingleAuction', 'StepNotMet', `the repayment must be at most ${show((minPrice * qty) / WAD, lt)} to beat the standing bid by the step.`);
      } else {
        const group = await read<Addr>(product, A.REQ, 'group');
        const g = await read<{ minBidQuantity: bigint; quantity: bigint; step: bigint; stepKind: number }>(group, A.GROUP, 'getAuction', [loan.auctionId]);
        if (qty < g.minBidQuantity || qty > g.quantity) wouldRevert('GroupAuction', 'QuantityOutOfRange', `quantity must be ${show(g.minBidQuantity, lt)} to ${show(g.quantity, lt)}.`);
        // An existing bid is amended, not replaced: it may only improve (GroupAuction.amend).
        const bidId = await read<bigint>(group, A.GROUP, 'bidOf', [loan.auctionId, who]);
        const old = bidId !== 0n ? await read<{ price: bigint; quantity: bigint; minFill: bigint }>(group, A.GROUP, 'getBid', [bidId]) : null;
        minFill = a.min_fill !== undefined ? amount(a.min_fill, lt, 'min_fill') : (old ? old.minFill : g.minBidQuantity);
        if (minFill < g.minBidQuantity || minFill > qty) wouldRevert('GroupAuction', 'MinFillOutOfRange', `min_fill must be ${show(g.minBidQuantity, lt)} to the quantity.`);
        if (old) {
          const step = improvement(g, old.price);
          const better = price === old.price || (price < old.price && old.price - price >= step);
          const changed = price !== old.price || qty !== old.quantity || minFill !== old.minFill;
          if (!better || qty < old.quantity || minFill > old.minFill || !changed) {
            wouldRevert('GroupAuction', 'NotImprovement', `your standing bid lends ${show(old.quantity, lt)} at a repayment of ${show((old.price * old.quantity) / WAD, lt)}; an amendment may not lower the quantity or raise min_fill, ` +
              `must keep the price or lower it by at least the auction's step (${show((step * old.quantity) / WAD, lt)} on this quantity), and must change something.`);
          }
        }
        hint = await read<bigint>(group, A.GROUP, 'findHint', [loan.auctionId, price, qty, 0n, 1000n]);
      }
      const live = await read<bigint>(product, A.REQ, 'liveEntryOf', [id, who]);
      // What the bid must newly reserve: a re-bid on a request to one keeps its reservation; an amendment of a shared bid
      // releases the old reservation and reserves the new quantity, so only the increase must be free.
      let held = 0n;
      if (live !== 0n) held = (await read<[bigint, number, Addr, bigint, bigint, bigint]>(product, A.REQ, 'entryOf', [live]))[3];
      const newly = live !== 0n && !many ? 0n : qty > held ? qty - held : 0n;
      const pre: Prerequisite[] = [];
      if (newly > 0n) pre.push(...(await vaultFunding(who, lt, newly, live !== 0n ? 'Raising this bid' : 'This bid', contract('Vault'))));
      const consumer = await consumerApproval(who, product, 'BulletLoanRequest');
      if (consumer) pre.push(consumer);
      const tx = encode(product, A.REQ, 'bidRequest', [who, id, qty, rep, minFill, hint, expected]);
      const sim = await simulate(tx, who, A.REQ, 'bidRequest', 'BulletLoanRequest', pre);
      return blueprint({
        intent: `Bid to lend ${show(qty, lt)} on request ${id} for a repayment of ${show(rep, lt)}`,
        summaryForUser: `Bids to lend ${show(qty, lt)} on loan request ${id}, to be repaid ${show(rep, lt)} in total. ${show(qty, lt)} of ${who}'s free Vault balance is reserved while the bid stands.`,
        parametersYouSupplied: a,
        context: {
          product, loan: { opener: loan.opener, opening: OPENING[loan.opening], auctionId: loan.auctionId.toString(), endsAt: fmtSecs(end) },
          expectedTerms: expected, termsFrom: o ? { openingTx: o.tx } : 'supplied', rawPrice: price.toString(), minFill: minFill.toString(), hintPrev: hint.toString(),
          ...(sim.ran ? { entryId: String(sim.result) } : {}),
        },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'bidRequest', [
          { type: 'address', value: who }, { type: 'uint256', value: id.toString() }, { type: 'uint256', value: qty.toString() }, { type: 'uint256', value: rep.toString() },
          { type: 'uint256', value: minFill.toString() }, { type: 'uint256', value: hint.toString() }, { type: 'bytes32', value: expected },
        ]),
        warnings: [
          'A lower repayment is a more competitive bid. The bid may be outbid before the auction ends; an outbid entry\'s reservation is released.',
          `The auction ends at ${fmtSecs(end)} (it can extend; deadlineOf has the current end).`,
        ],
        simulation: sim,
      });
    }
  );

  // ── W9 ──
  server.registerTool(
    'prepare_bullet_offer_open',
    {
      title: 'Open a bullet loan offer (testnet)',
      description: D(
        `Builds BulletLoanOffer.openOffer(lender, terms, many): you offer to lend, and borrowers bid UP the repayment in an auction. one: a single borrower takes a loan ` +
        `between min_loan and max_loan; many: several borrowers share the principal. Each borrower locks collateral at your loan-to-collateral ratio. The principal is reserved ` +
        `from your FREE Vault balance (no wallet pull) until fills or a cancel, so a Vault deposit and the consumer approval are emitted first where missing.`
      ),
      inputSchema: {
        account: ACCOUNT,
        loan_token: z.string(),
        principal: z.string().describe('The total you offer to lend, in whole loan tokens.'),
        min_loan: z.string().describe('The smallest loan a borrower may take, in whole loan tokens.'),
        max_loan: z.string().describe("The largest loan a borrower may take; for mode 'one' it must equal principal."),
        collateral_token: z.string().describe('The collateral token borrowers must lock (a test token).'),
        loan_per_collateral: z.string().describe('Loan tokens lent per one whole collateral token (the loan-to-collateral ratio), decimal.'),
        floor_rate: z.string().describe('The least repayment per 1 lent, e.g. "1.05" for 5% over the term; at least 1.'),
        ceiling_rate: z.string().optional().describe('The most repayment per 1 lent; omit for no ceiling.'),
        term_days: z.number().int(),
        auction_hours: z.number().int(),
        mode: z.enum(['one', 'many']),
        max_fills: z.number().int().optional().describe('many only: the most borrowers, 1 to 25.'),
      },
    },
    async (a) => {
      requireTier('free');
      const who = address(a.account, 'account');
      const product = contract('BulletLoanOffer');
      const lt = token(a.loan_token, 'loan_token');
      const ct = token(a.collateral_token, 'collateral_token');
      const principal = amount(a.principal, lt, 'principal');
      const minLoan = amount(a.min_loan, lt, 'min_loan');
      const maxLoan = amount(a.max_loan, lt, 'max_loan');
      const many = a.mode === 'many';
      const env = await import('../../factory/envelope.js');
      const ltaScale = 18 + lt.decimals - ct.decimals;
      if (ltaScale < 0) refuse('These tokens\' decimals cannot express the ratio.');
      let lta: bigint; let floor: bigint; let ceiling = 0n;
      try { lta = env.toBaseUnits(a.loan_per_collateral, ltaScale); } catch (e) { refuse(`loan_per_collateral: ${(e as Error).message}`); }
      try { floor = env.toBaseUnits(a.floor_rate, 18); } catch (e) { refuse(`floor_rate: ${(e as Error).message}`); }
      if (a.ceiling_rate !== undefined) { try { ceiling = env.toBaseUnits(a.ceiling_rate, 18); } catch (e) { refuse(`ceiling_rate: ${(e as Error).message}`); } }
      const MAX_REPAYMENT = (2n ** 256n - 1n) / WAD;
      if (await read<boolean>(product, A.OFF, 'paused')) wouldRevert('BulletLoanOffer', 'EnforcedPause', 'the product is paused.');
      if (minLoan > maxLoan || maxLoan > principal) wouldRevert('BulletLoanOffer', 'InvalidTerms(2)', 'min_loan ≤ max_loan ≤ principal is required.');
      if (!many && principal !== maxLoan) wouldRevert('BulletLoanOffer', 'InvalidTerms(3)', "mode 'one' needs max_loan equal to principal.");
      if (lta === 0n || (minLoan * WAD) / lta === 0n) wouldRevert('BulletLoanOffer', 'InvalidTerms(4)', 'the ratio leaves the smallest loan needing no collateral.');
      if (floor < WAD || floor > MAX_REPAYMENT) wouldRevert('BulletLoanOffer', 'InvalidTerms(5)', 'floor_rate must be at least 1.');
      if (ceiling !== 0n && (ceiling < floor || ceiling > MAX_REPAYMENT)) wouldRevert('BulletLoanOffer', 'InvalidTerms(6)', 'ceiling_rate is below floor_rate.');
      if (many && (a.max_fills === undefined || a.max_fills < 1 || a.max_fills > 25)) wouldRevert('BulletLoanOffer', 'InvalidTerms(7)', "mode 'many' needs max_fills 1 to 25.");
      if (!many && a.max_fills !== undefined) refuse("max_fills is taken only with mode 'many'.");
      if (a.term_days < 7 || a.term_days > 30 * 365) wouldRevert('BulletLoanOffer', 'InvalidTerms(10)', 'the term must be 7 to 10950 days.');
      if (a.auction_hours < 24 || a.auction_hours > 168) wouldRevert('BulletLoanOffer', 'InvalidTerms(11)', 'the auction must last 24 to 168 hours.');
      const terms = {
        token: lt.address, collateral: assetKey(ct.address), principal, minLoan, maxLoan, loanToCollateral: lta, floorPrice: floor, ceilingPrice: ceiling,
        maxFills: many ? a.max_fills! : 0, term: BigInt(a.term_days) * 86400n, duration: BigInt(a.auction_hours) * 3600n,
      };
      const pre: Prerequisite[] = [...(await vaultFunding(who, lt, principal, 'This offer'))];
      const consumer = await consumerApproval(who, product, 'BulletLoanOffer');
      if (consumer) pre.push(consumer);
      const inputs = (A.OFF.find((x) => x.type === 'function' && x.name === 'openOffer') as { inputs: readonly unknown[] }).inputs;
      const termsHash = keccak256(encodeAbiParameters([inputs[1], inputs[2]] as never, [terms, many] as never));
      const tx = encode(product, A.OFF, 'openOffer', [who, terms, many]);
      const sim = await simulate(tx, who, A.OFF, 'openOffer', 'BulletLoanOffer', pre);
      return blueprint({
        intent: `Offer to lend ${show(principal, lt)} for ${a.term_days} days against ${ct.symbol}`,
        summaryForUser: `Offers ${show(principal, lt)} to lend for ${a.term_days} days in loans of ${show(minLoan, lt)} to ${show(maxLoan, lt)}, each borrower locking ` +
          `${ct.symbol} at ${a.loan_per_collateral} ${lt.symbol} per ${ct.symbol}; borrowers bid the repayment up from ${a.floor_rate} per 1 lent for ${a.auction_hours} hours. ` +
          `${show(principal, lt)} of ${who}'s free Vault balance is reserved until filled or cancelled.`,
        parametersYouSupplied: a,
        context: {
          product, termsHash, many,
          rawTerms: { ...terms, principal: principal.toString(), minLoan: minLoan.toString(), maxLoan: maxLoan.toString(), loanToCollateral: lta.toString(), floorPrice: floor.toString(), ceilingPrice: ceiling.toString(), term: terms.term.toString(), duration: terms.duration.toString() },
          ...(sim.ran ? { loanId: String(sim.result) } : {}),
        },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'openOffer', null),
        warnings: ['The principal is reserved until a fill or a cancel; a cancel is possible only before the first bid and before the auction window ends.'],
        simulation: sim,
      });
    }
  );

  // ── W10 ──
  server.registerTool(
    'prepare_bullet_offer_bid',
    {
      title: 'Bid on a bullet loan offer (testnet)',
      description: D(
        `Builds BulletLoanOffer.bidOffer(borrower, loanId, loanSize, repayment, minFill, hintPrev, expectedTerms): you ask to borrow from an offer, naming the total you ` +
        `would repay. A higher repayment is a more competitive bid. Every bid locks collateral of floor(loanSize ÷ the offer's ratio) — on an offer to one, a full new lock ` +
        `until the displaced entry is released — pulling any shortfall in your free Vault balance from your wallet, so an exact approval to the Vault is emitted where short.`
      ),
      inputSchema: {
        account: ACCOUNT,
        loan_id: z.string().regex(/^\d+$/),
        loan_size: z.string().describe('The amount to borrow, in whole loan tokens.'),
        repayment: z.string().describe('The total you would repay, in whole loan tokens; above loan_size.'),
        min_fill: z.string().optional().describe('many: the least of your loan size you accept; defaults to the auction minimum.'),
        expected_terms: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("Optional: the terms hash you expect (e.g. from the lender's prepare_bullet_offer_open). Refused if it differs from the hash rebuilt from the offer's opening transaction."),
      },
    },
    async (a) => {
      requireTier('free');
      const who = address(a.account, 'account');
      const id = BigInt(a.loan_id);
      const product = contract('BulletLoanOffer');
      if (await read<boolean>(product, A.OFF, 'paused')) wouldRevert('BulletLoanOffer', 'EnforcedPause', 'the product is paused.');
      const loan = await loanOf('offer', id);
      if (loan.state !== 1 || loan.opening < 2) wouldRevert('BulletLoanOffer', 'WrongState', `loan ${id} is ${LOAN_STATE[loan.state] ?? loan.state} (${OPENING[loan.opening] ?? loan.opening}); bids need an OPEN offer.`);
      if (getAddress(loan.opener) === who) wouldRevert('SingleAuction', 'PrincipalCannotBid', 'the lender cannot bid on its own offer.');
      const o = await openingTerms('offer', id);
      const t = o.terms as { token: Addr; collateral: Hex; minLoan: bigint; maxLoan: bigint; loanToCollateral: bigint; floorPrice: bigint; ceilingPrice: bigint };
      if (a.expected_terms && a.expected_terms.toLowerCase() !== o.hash.toLowerCase()) {
        wouldRevert('BulletLoanOffer', 'TermsChanged', `the terms hash supplied (${a.expected_terms}) is not the one rebuilt from loan ${id}'s opening transaction (${o.hash}).`);
      }
      const expected = o.hash;
      const lt = tokenByAddress(t.token) ?? refuse(`loan ${id}'s token is not a test token of this deployment.`);
      const ct = tokenByAddress(tokenOfKey(t.collateral)) ?? refuse(`loan ${id}'s collateral is not a test token of this deployment.`);
      const size = amount(a.loan_size, lt, 'loan_size');
      const rep = amount(a.repayment, lt, 'repayment');
      if (rep <= size) wouldRevert('BulletLoanOffer', 'InvalidTerms(30)', 'the repayment must be above the loan size.');
      if (size < t.minLoan || size > t.maxLoan) wouldRevert('SingleAuction', 'QuantityOutOfRange', `loan_size must be ${show(t.minLoan, lt)} to ${show(t.maxLoan, lt)}.`);
      const price = (rep * WAD) / size;
      if (price < t.floorPrice) wouldRevert('SingleAuction', 'BeyondLimit', `the repayment must be at least ${show(ceilDiv(t.floorPrice * size, WAD), lt)} (the offer's floor).`);
      if (t.ceilingPrice !== 0n && price > t.ceilingPrice) wouldRevert('SingleAuction', 'BeyondBound', `the repayment may be at most ${show((t.ceilingPrice * size) / WAD, lt)} (the offer's ceiling).`);
      const { end } = await deadlineOf('offer', id);
      if ((await now()) >= end) wouldRevert('SingleAuction', 'NotLive', `the auction ended at ${fmtSecs(end)}.`);
      const many = loan.opening === 3;
      let minFill = 0n;
      let hint = 0n;
      if (!many) {
        if (a.min_fill !== undefined) refuse('min_fill is taken only for a many offer.');
        const single = await read<Addr>(product, A.OFF, 'single');
        const [minPrice, open] = await read<[bigint, boolean]>(single, A.SINGLE, 'minimumNextBid', [loan.auctionId]);
        if (!open) wouldRevert('SingleAuction', 'AtBound', 'the auction has reached its bound.');
        if (price < minPrice) {
          // Larger first: a bid at exactly the standing price with a larger size also stands (SingleAuction, rankByQuantity).
          const [standingId, s] = await read<[bigint, { price: bigint; quantity: bigint }]>(single, A.SINGLE, 'standing', [loan.auctionId]);
          const tie = standingId !== 0n && price === s.price && size > s.quantity;
          if (!tie) {
            wouldRevert('SingleAuction', 'StepNotMet', `the repayment must be at least ${show(ceilDiv(minPrice * size, WAD), lt)} to beat the standing bid by the step` +
              (standingId !== 0n ? `, or exactly the standing rate with a loan size above ${show(s.quantity, lt)}.` : '.'));
          }
        }
      } else {
        const group = await read<Addr>(product, A.OFF, 'group');
        const g = await read<{ minBidQuantity: bigint; step: bigint; stepKind: number }>(group, A.GROUP, 'getAuction', [loan.auctionId]);
        const bidId = await read<bigint>(group, A.GROUP, 'bidOf', [loan.auctionId, who]);
        const old = bidId !== 0n ? await read<{ price: bigint; quantity: bigint; minFill: bigint }>(group, A.GROUP, 'getBid', [bidId]) : null;
        minFill = a.min_fill !== undefined ? amount(a.min_fill, lt, 'min_fill') : (old ? old.minFill : g.minBidQuantity);
        if (minFill < g.minBidQuantity || minFill > size) wouldRevert('GroupAuction', 'MinFillOutOfRange', `min_fill must be ${show(g.minBidQuantity, lt)} to the loan size.`);
        if (old) {
          const step = improvement(g, old.price);
          const better = price === old.price || (price > old.price && price - old.price >= step);
          const changed = price !== old.price || size !== old.quantity || minFill !== old.minFill;
          if (!better || size < old.quantity || minFill > old.minFill || !changed) {
            wouldRevert('GroupAuction', 'NotImprovement', `your standing bid borrows ${show(old.quantity, lt)}; an amendment may not lower the size or raise min_fill, ` +
              `must keep the rate or raise it by at least the auction's step, and must change something.`);
          }
        }
        hint = await read<bigint>(group, A.GROUP, 'findHint', [loan.auctionId, price, size, 0n, 1000n]);
      }
      // floor(minLoan × 1e18 / ratio) > 0 is required at opening (InvalidTerms 4), so any size in range needs collateral.
      const need = (size * WAD) / t.loanToCollateral;
      // On a shared offer an existing entry is amended: the same size keeps its lock; a new size releases the old lock first.
      let freed = 0n;
      let keepsLock = false;
      if (many) {
        const live = await read<bigint>(product, A.OFF, 'liveEntryOf', [id, who]);
        if (live !== 0n) {
          const oldSize = (await read<[bigint, number, Addr, bigint, bigint, bigint]>(product, A.OFF, 'entryOf', [live]))[3];
          if (oldSize === size) keepsLock = true;
          else freed = (oldSize * WAD) / t.loanToCollateral;
        }
      }
      const pre: Prerequisite[] = [];
      const consumer = await consumerApproval(who, product, 'BulletLoanOffer');
      if (consumer) pre.push(consumer);
      const free = (await vaultFree(who, ct)) + freed;
      const short = keepsLock ? 0n : need > free ? need - free : 0n;
      if (short > 0n) {
        const wallet = await balanceOf(ct, who);
        if (wallet < short) wouldRevert('MockERC20', 'ERC20InsufficientBalance', `the bid locks ${show(need, ct)}; ${show(free, ct)} is free in the Vault and the wallet holds ${show(wallet, ct)}, short of ${show(short, ct)}.`);
        const ap = await erc20Approval(ct, who, contract('Vault'), 'Vault', short);
        if (ap) pre.push(ap);
      }
      const tx = encode(product, A.OFF, 'bidOffer', [who, id, size, rep, minFill, hint, expected]);
      const sim = await simulate(tx, who, A.OFF, 'bidOffer', 'BulletLoanOffer', pre);
      return blueprint({
        intent: `Bid to borrow ${show(size, lt)} on offer ${id}, repaying ${show(rep, lt)}`,
        summaryForUser: `Bids to borrow ${show(size, lt)} on loan offer ${id}, repaying ${show(rep, lt)} in total, and locks ${show(need, ct)} of ${who}'s collateral ` +
          `(${show(need - short, ct)} from the Vault, ${show(short, ct)} from the wallet) while the bid stands and, if it wins, for the loan.`,
        parametersYouSupplied: a,
        context: {
          product, loan: { opener: loan.opener, opening: OPENING[loan.opening], auctionId: loan.auctionId.toString(), endsAt: fmtSecs(end) },
          expectedTerms: expected, termsFrom: { openingTx: o.tx }, collateralLocked: show(need, ct), rawPrice: price.toString(), minFill: minFill.toString(), hintPrev: hint.toString(),
          ...(sim.ran ? { entryId: String(sim.result) } : {}),
        },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'bidOffer', [
          { type: 'address', value: who }, { type: 'uint256', value: id.toString() }, { type: 'uint256', value: size.toString() }, { type: 'uint256', value: rep.toString() },
          { type: 'uint256', value: minFill.toString() }, { type: 'uint256', value: hint.toString() }, { type: 'bytes32', value: expected },
        ]),
        warnings: [
          'A higher repayment is a more competitive bid; the bid may be outbid before the auction ends.',
          ...(!many ? [`On an offer to one every bid locks a full new ${show(need, ct)} until the entry it displaces is released (prepare_bullet_entry_release).`] : []),
          'If the loan is made, the principal lands in your free Vault balance, not your wallet.',
        ],
        simulation: sim,
      });
    }
  );

  // ── W11 to W13: cancel, release, finalise (either product) ──
  const PRODUCT = z.enum(['request', 'offer']).describe("Which bullet product the loan is on: 'request' (BulletLoanRequest) or 'offer' (BulletLoanOffer).");

  server.registerTool(
    'prepare_bullet_cancel',
    {
      title: 'Cancel a bullet loan request or offer (testnet)',
      description: D(
        `Builds cancel(loanId) on BulletLoanRequest or BulletLoanOffer. Only the opener may cancel, only while the loan is OPEN, before its first bid and before its auction ` +
        `window ends. The escrow (locked collateral, or the reserved principal) returns to the opener's free Vault balance, not the wallet.`
      ),
      inputSchema: { account: ACCOUNT, product: PRODUCT, loan_id: z.string().regex(/^\d+$/) },
    },
    async ({ account, product: kind, loan_id }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(loan_id);
      const P = BULLET[kind];
      const addr = contract(P.name);
      if (await read<boolean>(addr, P.abi, 'paused')) wouldRevert(P.name, 'EnforcedPause', 'the product is paused.');
      const loan = await loanOf(kind, id);
      if (loan.state !== 1) wouldRevert(P.name, 'WrongState', `loan ${id} is ${LOAN_STATE[loan.state] ?? loan.state}.`);
      if (getAddress(loan.opener) !== who) wouldRevert(P.name, 'NotApprovedOperator', `loan ${id} was opened by ${loan.opener}.`);
      const { end } = await deadlineOf(kind, id);
      if ((await now()) >= end) wouldRevert('SingleAuction', 'CancelNotAllowed', `the auction window ended at ${fmtSecs(end)}.`);
      const tx = encode(addr, P.abi, 'cancel', [id]);
      const sim = await simulate(tx, who, P.abi, 'cancel', P.name, []);
      return blueprint({
        intent: `Cancel ${kind} ${id}`,
        summaryForUser: `Cancels ${who}'s loan ${kind} ${id}; its ${kind === 'request' ? 'locked collateral' : 'reserved principal'} returns to the free Vault balance.`,
        parametersYouSupplied: { account, product: kind, loan_id },
        context: { product: addr, opening: OPENING[loan.opening], auctionEndsAt: fmtSecs(end) },
        transaction: tx,
        deeplinks: deeplinks(tx, 'cancel', [{ type: 'uint256', value: id.toString() }]),
        warnings: ['A cancel is refused once any bid has been placed (CancelNotAllowed); the simulation checks this.'],
        simulation: sim,
      });
    }
  );

  server.registerTool(
    'prepare_bullet_entry_release',
    {
      title: 'Release a bullet loan entry (testnet)',
      description: D(
        `Builds release(entryId) on BulletLoanRequest or BulletLoanOffer: returns a bid's escrow (a lender's reservation, or a borrower's collateral lock) to its owner's ` +
        `free Vault balance once the entry has been outbid, the loan has ended, or the loan has stalled past its deadline. Anyone may call it.`
      ),
      inputSchema: { account: ACCOUNT, product: PRODUCT, entry_id: z.string().regex(/^\d+$/) },
    },
    async ({ account, product: kind, entry_id }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(entry_id);
      const P = BULLET[kind];
      const addr = contract(P.name);
      const [loanId, state, owner, size] = await read<[bigint, number, Addr, bigint, bigint, bigint]>(addr, P.abi, 'entryOf', [id]);
      const es = ENTRY_STATE[state] ?? String(state);
      if (es !== 'LIVE' && es !== 'WON') wouldRevert(P.name, 'NotReleasable', `entry ${id} is ${es}.`);
      const loan = await loanOf(kind, loanId);
      const stalled = (await now()) >= (await deadlineOf(kind, loanId)).deadline;
      const ls = LOAN_STATE[loan.state];
      if (es === 'LIVE' && ls === 'OPEN' && !stalled) wouldRevert(P.name, 'NotReleasable', `entry ${id} still stands in the open auction of loan ${loanId}.`);
      if (es === 'WON' && (ls === 'ORIGINATED' || (!stalled && ls !== 'ENDED'))) wouldRevert(P.name, 'NotReleasable', `entry ${id} won loan ${loanId}, which is ${ls}.`);
      const tx = encode(addr, P.abi, 'release', [id]);
      const sim = await simulate(tx, who, P.abi, 'release', P.name, []);
      return blueprint({
        intent: `Release entry ${id} on ${kind} ${loanId}`,
        summaryForUser: `Releases entry ${id} (${es}, size ${size}) on loan ${kind} ${loanId}; its escrow returns to ${owner}'s free Vault balance.`,
        parametersYouSupplied: { account, product: kind, entry_id },
        context: { product: addr, loanId: loanId.toString(), entryState: es, owner, loanState: ls, stalled },
        transaction: tx,
        deeplinks: deeplinks(tx, 'release', [{ type: 'uint256', value: id.toString() }]),
        warnings: getAddress(owner) !== who ? [`The entry belongs to ${owner}; the escrow goes to that account, not the sender.`] : [],
        simulation: sim,
      });
    }
  );

  server.registerTool(
    'prepare_bullet_finalise',
    {
      title: 'Finalise a bullet loan auction (testnet)',
      description: D(
        `Builds finalise(loanId, maxSteps) on BulletLoanRequest or BulletLoanOffer: after the auction ends, settles the result — the loan is made (an Obligation, a Lien ` +
        `on the collateral, the principal moved to the borrower's free Vault balance) or ends with no sale. Anyone may call it, and the fleet's keepers usually do; this is for ` +
        `a user who does not wait. A shared (many) auction may need more than one call.`
      ),
      inputSchema: { account: ACCOUNT, product: PRODUCT, loan_id: z.string().regex(/^\d+$/), max_steps: z.number().int().min(1).max(200).optional().describe('Paging bound for a shared auction; default 200.') },
    },
    async ({ account, product: kind, loan_id, max_steps }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(loan_id);
      const P = BULLET[kind];
      const addr = contract(P.name);
      if (await read<boolean>(addr, P.abi, 'paused')) wouldRevert(P.name, 'EnforcedPause', 'the product is paused.');
      const loan = await loanOf(kind, id);
      const ls = LOAN_STATE[loan.state];
      if (ls !== 'OPEN' && ls !== 'CLOSED') wouldRevert(P.name, 'WrongState', `loan ${id} is ${ls}.`);
      const { end, deadline } = await deadlineOf(kind, id);
      const ts = await now();
      if (ts >= deadline) wouldRevert(P.name, 'Stalled', `the settlement deadline passed at ${fmtSecs(deadline)}; only expire remains.`);
      if (ts < end) wouldRevert('SingleAuction', 'AuctionNotEnded', `the auction ends at ${fmtSecs(end)}.`);
      const steps = BigInt(max_steps ?? 200);
      const tx = encode(addr, P.abi, 'finalise', [id, steps]);
      const sim = await simulate(tx, who, P.abi, 'finalise', P.name, []);
      return blueprint({
        intent: `Finalise ${kind} ${id}`,
        summaryForUser: `Settles the ended auction of loan ${kind} ${id}: the loan is made with its winning bid(s), or ends with no sale and the escrow is released.`,
        parametersYouSupplied: { account, product: kind, loan_id, max_steps: max_steps ?? null },
        context: { product: addr, opening: OPENING[loan.opening], state: ls, endedAt: fmtSecs(end), deadline: fmtSecs(deadline) },
        transaction: tx,
        deeplinks: deeplinks(tx, 'finalise', [{ type: 'uint256', value: id.toString() }, { type: 'uint256', value: steps.toString() }]),
        warnings: [
          'Keepers usually finalise; if one lands first this call may revert WrongState.',
          ...(loan.opening === 1 ? ['A shared request settles in pages and then once more: call again until the loan is ORIGINATED or ENDED.'] : []),
          ...(loan.opening === 3 ? ['A shared offer settles each winner by executeFill; finalise only pages the auction closed.'] : []),
        ],
        simulation: sim,
      });
    }
  );

  // ── W14 to W19: obligation and lien ──
  const OBL_STATUS = ['OPEN', 'DISCHARGED', 'BREACHED', 'SETTLED', 'PAID_LATE', 'RELEASED'];
  const SET_STATUS = ['CREATING', 'ACTIVE', 'BREACHED', 'DISCHARGED', 'SETTLED', 'PAID_LATE'];
  const LIEN_STATUS = ['ACTIVE', 'RELEASED', 'PAID_OFF', 'ENFORCED'];
  const SOURCE = z.enum(['wallet', 'vault']).describe("Pay from the wallet (an exact ERC-20 approval is emitted where short) or from the free Vault balance.");

  async function obligation(id: bigint) {
    const obl = contract('Obligation');
    let o: { setId: bigint; asset: Hex; status: number; dueAt: bigint };
    try { o = await read(obl, A.OBL, 'getObligation', [id]); } catch (e) { if (!isRevert(e)) chainUnavailable(e); wouldRevert('Obligation', 'InvalidStatus', `obligation ${id} does not exist.`); }
    const s = await read<{ status: number; bound: boolean; obligor: Addr }>(obl, A.OBL, 'getSet', [o.setId]);
    const t = tokenByAddress(tokenOfKey(o.asset)) ?? refuse(`obligation ${id}'s asset is not a test token of this deployment.`);
    return { obl, o, s, t };
  }

  server.registerTool(
    'prepare_obligation_pay',
    {
      title: 'Repay an obligation (testnet)',
      description: D(
        `Builds Obligation.pay(obligationId, amount, source): repays a bullet loan's obligation in full (a bullet must be paid whole: its payoff, principal and interest less ` +
        `anything paid). From the wallet, an exact approval to Obligation is emitted where short; from the Vault, the consumer approval for Obligation. ` +
        `A loan whose set has been marked breached is paid off through the Lien instead (prepare_lien_payoff); this tool refuses it and says so.`
      ),
      inputSchema: { account: ACCOUNT, obligation_id: z.string().regex(/^\d+$/), source: SOURCE },
    },
    async ({ account, obligation_id, source }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(obligation_id);
      const { obl, o, s, t } = await obligation(id);
      const os = OBL_STATUS[o.status]; const ss = SET_STATUS[s.status];
      if (ss === 'BREACHED' && s.bound) wouldRevert('Obligation', 'InvalidStatus', `set ${o.setId} has been marked breached; it is paid off through its Lien — use prepare_lien_payoff.`);
      if (!(os === 'OPEN' && ss === 'ACTIVE') && !(ss === 'BREACHED' && !s.bound)) wouldRevert('Obligation', 'InvalidStatus', `obligation ${id} is ${os} in a ${ss} set.`);
      const payoff = await read<bigint>(obl, A.OBL, 'payoff', [id]);
      // Unreachable while the obligation is OPEN in an ACTIVE set (checked above); kept as the contract's own refusal of a zero payment.
      if (payoff === 0n) wouldRevert('Obligation', 'InvalidAmount', `nothing is owed on obligation ${id}.`);
      const pre: Prerequisite[] = [];
      if (source === 'wallet') {
        const wallet = await balanceOf(t, who);
        if (wallet < payoff) wouldRevert('MockERC20', 'ERC20InsufficientBalance', `the payoff is ${show(payoff, t)}; the wallet holds ${show(wallet, t)}.`);
        const ap = await erc20Approval(t, who, obl, 'Obligation', payoff);
        if (ap) pre.push(ap);
      } else {
        const free = await vaultFree(who, t);
        if (free < payoff) wouldRevert('Vault', 'InsufficientBalance', `the payoff is ${show(payoff, t)}; ${show(free, t)} is free in the Vault. Pay from the wallet, or deposit first.`);
        const ap = await consumerApproval(who, obl, 'Obligation');
        if (ap) pre.push(ap);
      }
      const src = source === 'vault' ? 0 : 1;
      const tx = encode(obl, A.OBL, 'pay', [id, payoff, src]);
      const sim = await simulate(tx, who, A.OBL, 'pay', 'Obligation', pre);
      const late = (await now()) > o.dueAt;
      return blueprint({
        intent: `Repay obligation ${id}: ${show(payoff, t)} from the ${source}`,
        summaryForUser: `Pays obligation ${id}'s payoff of ${show(payoff, t)} from ${who}'s ${source === 'vault' ? 'free Vault balance' : 'wallet'}, discharging it. Due ${fmtSecs(o.dueAt)}.`,
        parametersYouSupplied: { account, obligation_id, source },
        context: { obligation: obl, setId: o.setId.toString(), status: os, setStatus: ss, payoff: show(payoff, t), rawPayoff: payoff.toString(), dueAt: fmtSecs(o.dueAt), late },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'pay', [{ type: 'uint256', value: id.toString() }, { type: 'uint256', value: payoff.toString() }, { type: 'uint8', value: String(src) }]),
        warnings: [
          ...(late ? ['The obligation is past due. Once the set is marked breached (after the grace period), it can no longer be paid here, only through prepare_lien_payoff.'] : []),
          'Once discharged, the Lien is released (by anyone, usually a keeper: prepare_lien_release) and the collateral is credited to the position owner, then claimed with prepare_lien_claim.',
        ],
        simulation: sim,
      });
    }
  );

  async function lien(id: bigint) {
    const l = contract('Lien');
    let r: [Addr, bigint, bigint, Hex, number];
    try { r = await read(l, A.LIEN, 'getLien', [id]); } catch (e) { if (!isRevert(e)) chainUnavailable(e); wouldRevert('Lien', 'InvalidStatus', `lien ${id} does not exist.`); }
    const [, lockId, setId, settlementAsset, status] = r;
    const set = await read<{ status: number; obligor: Addr }>(contract('Obligation'), A.OBL, 'getSet', [setId]);
    return { l, lockId, setId, settlementAsset, status: LIEN_STATUS[status] ?? String(status), setStatus: SET_STATUS[set.status] ?? String(set.status) };
  }

  server.registerTool(
    'prepare_lien_payoff',
    {
      title: 'Pay off a breached loan through its Lien (testnet)',
      description: D(
        `Builds Lien.payoff(lienId, maxAmount, source): pays a breached bullet loan's whole debt and settles its set; the collateral becomes credit to the position owner. ` +
        `Only for a set marked breached (otherwise prepare_obligation_pay). The debt may move between this quote and the send, so max_amount is your cap. ` +
        `From the wallet, an exact approval to the Lien for max_amount is emitted where short; from the Vault, the consumer approval for the Lien.`
      ),
      inputSchema: { account: ACCOUNT, lien_id: z.string().regex(/^\d+$/), source: SOURCE, max_amount: z.string().optional().describe('The most you will pay, in whole tokens; defaults to the debt now.') },
    },
    async ({ account, lien_id, source, max_amount }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(lien_id);
      const L = await lien(id);
      if (L.status !== 'ACTIVE') wouldRevert('Lien', 'InvalidStatus', `lien ${id} is ${L.status}.`);
      if (L.setStatus !== 'BREACHED') wouldRevert('Lien', 'SetNotBreached', `set ${L.setId} is ${L.setStatus}; repay with prepare_obligation_pay.`);
      const t = tokenByAddress(tokenOfKey(L.settlementAsset)) ?? refuse('the settlement asset is not a test token of this deployment.');
      const debt = await read<bigint>(contract('Obligation'), A.OBL, 'debtAt', [L.setId, await now()]);
      const max = max_amount !== undefined ? amount(max_amount, t, 'max_amount') : debt;
      if (max < debt) wouldRevert('Lien', 'PayoffAboveMax', `the debt now is ${show(debt, t)}, above max_amount.`);
      const pre: Prerequisite[] = [];
      if (source === 'wallet') {
        const wallet = await balanceOf(t, who);
        if (wallet < debt) wouldRevert('MockERC20', 'ERC20InsufficientBalance', `the debt is ${show(debt, t)}; the wallet holds ${show(wallet, t)}.`);
        const ap = await erc20Approval(t, who, L.l, 'Lien', max);
        if (ap) pre.push(ap);
      } else {
        const free = await vaultFree(who, t);
        if (free < debt) wouldRevert('Vault', 'InsufficientBalance', `the debt is ${show(debt, t)}; ${show(free, t)} is free in the Vault.`);
        const ap = await consumerApproval(who, L.l, 'Lien');
        if (ap) pre.push(ap);
      }
      const src = source === 'vault' ? 0 : 1;
      const tx = encode(L.l, A.LIEN, 'payoff', [id, max, src]);
      const sim = await simulate(tx, who, A.LIEN, 'payoff', 'Lien', pre);
      return blueprint({
        intent: `Pay off lien ${id}: up to ${show(max, t)} from the ${source}`,
        summaryForUser: `Pays the breached set ${L.setId}'s debt (${show(debt, t)} now, capped at ${show(max, t)}) from ${who}'s ${source}, settling it; the locked collateral becomes credit to the position owner.`,
        parametersYouSupplied: { account, lien_id, source, max_amount: max_amount ?? null },
        context: { lien: L.l, setId: L.setId.toString(), debtNow: show(debt, t), cap: show(max, t) },
        prerequisites: pre,
        transaction: tx,
        deeplinks: deeplinks(tx, 'payoff', [{ type: 'uint256', value: id.toString() }, { type: 'uint256', value: max.toString() }, { type: 'uint8', value: String(src) }]),
        warnings: ['The debt can change between this quote and the send; the call reverts PayoffAboveMax if it rises above max_amount. Any excess is returned to your Vault balance.'],
        simulation: sim,
      });
    }
  );

  server.registerTool(
    'prepare_lien_release',
    {
      title: 'Release a discharged loan\'s Lien (testnet)',
      description: D(`Builds Lien.release(lienId): once the loan's set is discharged (repaid), credits the locked collateral to the position owner. Anyone may call it; keepers usually do.`),
      inputSchema: { account: ACCOUNT, lien_id: z.string().regex(/^\d+$/) },
    },
    async ({ account, lien_id }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(lien_id);
      const L = await lien(id);
      if (L.status !== 'ACTIVE') wouldRevert('Lien', 'InvalidStatus', `lien ${id} is ${L.status}.`);
      if (L.setStatus !== 'DISCHARGED') wouldRevert('Lien', 'SetNotDischarged', `set ${L.setId} is ${L.setStatus}.`);
      const tx = encode(L.l, A.LIEN, 'release', [id]);
      const sim = await simulate(tx, who, A.LIEN, 'release', 'Lien', []);
      return blueprint({
        intent: `Release lien ${id}`,
        summaryForUser: `Releases lien ${id} on the discharged set ${L.setId}; the collateral is credited to the position owner, to claim with prepare_lien_claim.`,
        parametersYouSupplied: { account, lien_id },
        context: { lien: L.l, setId: L.setId.toString(), setStatus: L.setStatus },
        transaction: tx,
        deeplinks: deeplinks(tx, 'release', [{ type: 'uint256', value: id.toString() }]),
        warnings: ['Keepers usually release; if one lands first this call reverts InvalidStatus.'],
        simulation: sim,
      });
    }
  );

  server.registerTool(
    'prepare_lien_claim',
    {
      title: 'Claim collateral credited by a Lien (testnet)',
      description: D(`Builds Lien.claim(lienId): moves the collateral credited to the position owner (after release, payoff or enforcement) into the owner's free Vault balance, and burns the position. Only the position owner may claim.`),
      inputSchema: { account: ACCOUNT, lien_id: z.string().regex(/^\d+$/) },
    },
    async ({ account, lien_id }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(lien_id);
      const L = await lien(id);
      const owner = await read<Addr>(contract('Obligation'), A.OBL, 'ownerOfPosition', [L.setId]);
      if (getAddress(owner) !== who) wouldRevert('Lien', 'NotPositionOwner', `the position of set ${L.setId} is held by ${owner}.`);
      if (L.status === 'ACTIVE') wouldRevert('Lien', 'InvalidStatus', `lien ${id} is still active; it is released, paid off or enforced first.`);
      const keys = await read<Hex[]>(L.l, A.LIEN, 'creditKeys', [id]);
      if (!keys.length) wouldRevert('Lien', 'NothingToClaim', `lien ${id} has no credit left.`);
      const tx = encode(L.l, A.LIEN, 'claim', [id]);
      const sim = await simulate(tx, who, A.LIEN, 'claim', 'Lien', []);
      return blueprint({
        intent: `Claim lien ${id}'s credit`,
        summaryForUser: `Moves lien ${id}'s credited collateral (${keys.length} asset${keys.length === 1 ? '' : 's'}) into ${who}'s free Vault balance and burns the position.`,
        parametersYouSupplied: { account, lien_id },
        context: { lien: L.l, setId: L.setId.toString(), status: L.status, credit: keys.map((k) => tokenByAddress(tokenOfKey(k))?.symbol ?? k) },
        transaction: tx,
        deeplinks: deeplinks(tx, 'claim', [{ type: 'uint256', value: id.toString() }]),
        warnings: ['The collateral lands in your free Vault balance; prepare_vault_withdraw moves it to a wallet.'],
        simulation: sim,
      });
    }
  );

  const destinationArgs = {
    destination: z.string().optional().describe('Where the proceeds go; defaults to account.'),
    to_vault: z.boolean().optional().describe("true: credit the destination's Vault balance; false (default): send the tokens to the destination's wallet."),
  };
  async function checkDestination(dest: Addr, obl: Addr) {
    if (dest === obl) wouldRevert('Obligation', 'InvalidAddress', 'the destination is the Obligation contract.');
    if (dest === contract('Vault')) wouldRevert('Obligation', 'InvalidAddress', 'the destination is the Vault.');
  }

  server.registerTool(
    'prepare_obligation_collect',
    {
      title: 'Collect a lender\'s repayment (testnet)',
      description: D(`Builds Obligation.collect(obligationId, key, destination, toVault): a claim-unit holder (the lender) collects what has been repaid to it in one asset, to a wallet or a Vault balance. The units are kept.`),
      inputSchema: { account: ACCOUNT, obligation_id: z.string().regex(/^\d+$/), token: z.string().optional().describe("The asset to collect; defaults to the obligation's own asset."), ...destinationArgs },
    },
    async ({ account, obligation_id, token: tk, destination, to_vault }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(obligation_id);
      const { obl, o, t: own } = await obligation(id);
      const t = tk ? token(tk) : own;
      const key = assetKey(t.address);
      const dest = destination ? address(destination, 'destination') : who;
      await checkDestination(dest, obl);
      const accrued = await read<bigint>(obl, A.OBL, 'accrued', [id, who, key]);
      if (accrued === 0n) wouldRevert('Obligation', 'InvalidAmount', `nothing in ${t.symbol} has accrued to ${who} on obligation ${id}.`);
      const tx = encode(obl, A.OBL, 'collect', [id, key, dest, !!to_vault]);
      const sim = await simulate(tx, who, A.OBL, 'collect', 'Obligation', []);
      return blueprint({
        intent: `Collect ${show(accrued, t)} from obligation ${id}`,
        summaryForUser: `Collects the ${show(accrued, t)} accrued to ${who} on obligation ${id}, ${to_vault ? `into ${dest}'s Vault balance` : `to ${dest}'s wallet`}.`,
        parametersYouSupplied: { account, obligation_id, token: tk ?? null, destination: destination ?? null, to_vault: to_vault ?? null },
        context: { obligation: obl, setId: o.setId.toString(), key, accrued: show(accrued, t) },
        transaction: tx,
        deeplinks: deeplinks(tx, 'collect', [{ type: 'uint256', value: id.toString() }, { type: 'bytes32', value: key }, { type: 'address', value: dest }, { type: 'bool', value: String(!!to_vault) }]),
        warnings: [],
        simulation: sim,
      });
    }
  );

  server.registerTool(
    'prepare_obligation_redeem',
    {
      title: 'Redeem claim units (testnet)',
      description: D(`Builds Obligation.redeem(obligationId, destination, toVault): once the obligation is final (discharged, settled, paid late or released), collects everything accrued to the holder and burns all its claim units.`),
      inputSchema: { account: ACCOUNT, obligation_id: z.string().regex(/^\d+$/), ...destinationArgs },
    },
    async ({ account, obligation_id, destination, to_vault }) => {
      requireTier('free');
      const who = address(account, 'account');
      const id = BigInt(obligation_id);
      const { obl, o } = await obligation(id);
      const os = OBL_STATUS[o.status];
      if (os === 'OPEN' || os === 'BREACHED') wouldRevert('Obligation', 'NotFinal', `obligation ${id} is ${os}.`);
      const units = await read<bigint>(obl, A.OBL, 'balanceOf', [who, id]);
      if (units === 0n) wouldRevert('Obligation', 'InvalidUnits', `${who} holds no claim units of obligation ${id}.`);
      const dest = destination ? address(destination, 'destination') : who;
      await checkDestination(dest, obl);
      const tx = encode(obl, A.OBL, 'redeem', [id, dest, !!to_vault]);
      const sim = await simulate(tx, who, A.OBL, 'redeem', 'Obligation', []);
      return blueprint({
        intent: `Redeem ${units} claim units of obligation ${id}`,
        summaryForUser: `Collects everything accrued to ${who} on obligation ${id} (${os}) ${to_vault ? `into ${dest}'s Vault balance` : `to ${dest}'s wallet`} and burns all ${units} of its claim units.`,
        parametersYouSupplied: { account, obligation_id, destination: destination ?? null, to_vault: to_vault ?? null },
        context: { obligation: obl, setId: o.setId.toString(), status: os, units: units.toString() },
        transaction: tx,
        deeplinks: deeplinks(tx, 'redeem', [{ type: 'uint256', value: id.toString() }, { type: 'address', value: dest }, { type: 'bool', value: String(!!to_vault) }]),
        warnings: ['Burns every claim unit the account holds of this obligation.'],
        simulation: sim,
      });
    }
  );
}

export const V2_WRITE_TOOLS = [
  'prepare_test_token_mint', 'prepare_vault_deposit', 'prepare_vault_withdraw', 'prepare_vault_product_approval',
  'prepare_spot_order', 'prepare_spot_cancel',
  'prepare_bullet_request_open', 'prepare_bullet_request_bid', 'prepare_bullet_offer_open', 'prepare_bullet_offer_bid',
  'prepare_bullet_cancel', 'prepare_bullet_entry_release', 'prepare_bullet_finalise',
  'prepare_obligation_pay', 'prepare_lien_payoff', 'prepare_lien_release', 'prepare_lien_claim',
  'prepare_obligation_collect', 'prepare_obligation_redeem',
] as const;
