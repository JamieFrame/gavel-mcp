/**
 * VZ10 row M1, G4: the signing surface of the gavel-testnet profile, declared once.
 *
 * Every transaction a gavel-testnet write tool can hand out — the blueprint and each prerequisite — is a call
 * named here, to an address this table resolves from the generated deployment (never typed). Three readers
 * share it:
 *   - the write tools (W4 takes its product list from CONSUMERS);
 *   - scripts/check-v2-writes.mjs, which fails if any transaction it sends on the fork falls outside it;
 *   - scripts/export-site-table.mjs, which publishes it for the testnet site's /sign page (G1 §4): that page
 *     relays only a call this table admits, and refuses everything else by default.
 * A new write tool, or a new call in an existing one, must be added here, or the fork proof fails.
 */
import { getAddress } from 'viem';
import { V2_DEPLOYMENT } from './deployment.generated.js';

type Addr = `0x${string}`;

/** The functions the profile encodes, by contract kind. A kind resolves to one or more addresses below. */
export const SIGN_CALLS = {
  TestToken: ['mint', 'approve'],
  Vault: ['deposit', 'withdraw', 'approveConsumer'],
  SpotMarket: ['placeOrder', 'cancelOrder'],
  BulletLoanRequest: ['openRequest', 'bidRequest', 'cancel', 'release', 'finalise'],
  BulletLoanOffer: ['openOffer', 'bidOffer', 'cancel', 'release', 'finalise'],
  Obligation: ['pay', 'collect', 'redeem'],
  Lien: ['payoff', 'release', 'claim'],
} as const satisfies Record<string, readonly string[]>;

export type SignKind = keyof typeof SIGN_CALLS;

/** The spenders an ERC-20 approval may name: the contracts that pull a user's tokens in wave 1. */
export const SPENDERS = ['Vault', 'Obligation', 'Lien'] as const;

/** The named V2 products a user may approve as a Vault consumer (W4), not filtered by pattern; with the spot and bill markets, consumerAddresses(). */
export const CONSUMERS = [
  'BulletLoanRequest', 'BulletLoanOffer', 'Obligation', 'Lien', 'FutureOrchestrator', 'CoverOrchestrator',
  'BillPackager', 'ClaimLotMarket', 'ObligorPositionMarket', 'BondProtocol',
] as const;

/**
 * How a reader decodes what the ABI alone leaves opaque, per call (for /sign; G1 §4: "shows every argument").
 *   bytes:  a `bytes` argument the tools fill with an ABI-encoded tuple, by parameter path, and that tuple's types
 *           (W3's destination; W7's collateral legs). `empty` marks a `bytes` the tools always leave as 0x.
 *   units:  an amount argument, by parameter path, and where its token is named: `to` (the call's own target, a
 *           test token), `to.base` (a spot pair's base token; a bill market has none here, so its amounts show raw), or the path of an address or asset-key argument in the same call. An amount whose
 *           token the call does not name (a bid against a loan, a payment against an obligation) has no entry
 *           and is shown in raw units.
 */
export const SIGN_HINTS: Record<string, {
  bytes?: Record<string, Array<{ name: string; type: string }> | 'empty'>;
  units?: Record<string, string>;
}> = {
  'TestToken.mint': { units: { amount: 'to' } },
  'TestToken.approve': { units: { value: 'to' } },
  'Vault.deposit': { bytes: { params: 'empty' }, units: { amount: 'asset' } },
  'Vault.withdraw': { bytes: { externalDestination: [{ name: 'destination', type: 'address' }] }, units: { amount: 'asset' } },
  'BulletLoanRequest.openRequest': {
    bytes: { 't.lockParams': [{ name: 'from', type: 'address' }, { name: 'assets', type: 'bytes32[]' }, { name: 'amounts', type: 'uint256[]' }] },
    units: { 't.amount': 't.token', 't.minAmount': 't.token', 't.maxRepayment': 't.token', 't.bidStep': 't.token', 't.lockParams.amounts': 't.lockParams.assets' },
  },
  'SpotMarket.placeOrder': { units: { amountBase: 'to.base' } },
  'BulletLoanOffer.openOffer': { units: { 't.principal': 't.token', 't.minLoan': 't.token', 't.maxLoan': 't.token' } },
};

/** The unique live address of a named contract in the generated deployment. */
export function liveAddress(name: string): Addr {
  const hits = V2_DEPLOYMENT.contracts.filter((c) => c.name === name && !c.superseded);
  if (hits.length !== 1) throw new Error(`sign-surface: ${name} has ${hits.length} live entries in the deployment table`);
  return getAddress(hits[0].address) as Addr;
}

const tokenAddr = (symbol: string): Addr => {
  const t = V2_DEPLOYMENT.tokens.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`sign-surface: no test token ${symbol}`);
  return getAddress(t.address) as Addr;
};

/** Every address of a kind, with the name a reader sees for it. */
export function addressesOf(kind: SignKind): Array<{ address: Addr; label: string; base?: Addr; quote?: Addr }> {
  switch (kind) {
    case 'TestToken':
      return V2_DEPLOYMENT.tokens.map((t) => ({ address: getAddress(t.address) as Addr, label: `${t.symbol} (test token)` }));
    case 'SpotMarket':
      return [
        ...V2_DEPLOYMENT.spot.pairs.map((p) => ({ address: getAddress(p.spotMarket) as Addr, label: `Spot market ${p.name}`, base: tokenAddr(p.base), quote: tokenAddr(p.quote) })),
        ...V2_DEPLOYMENT.spot.billSeries.map((b) => ({ address: getAddress(b.spotMarket) as Addr, label: `Bill series ${b.k} market` })),
      ];
    default:
      return [{ address: liveAddress(kind), label: kind }];
  }
}

/** The kind an address belongs to, or null: a transaction to any other address is outside the surface. */
export function kindOf(address: string): SignKind | null {
  const a = getAddress(address);
  for (const kind of Object.keys(SIGN_CALLS) as SignKind[]) {
    if (addressesOf(kind).some((x) => x.address === a)) return kind;
  }
  return null;
}

/**
 * Every product a Vault approval (`approveConsumer`) may name: the named products above, and every spot and
 * bill market (a spot order's prerequisite approves its market; W4 offers them too).
 */
export function consumerAddresses(): Array<{ name: string; address: Addr }> {
  return [
    ...CONSUMERS.map((name) => ({ name: name as string, address: liveAddress(name) })),
    ...addressesOf('SpotMarket').map((m) => ({ name: m.label, address: m.address })),
  ];
}
