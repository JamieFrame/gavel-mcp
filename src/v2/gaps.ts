// ============================================================================
// VZ10 row M1, G2 — what the indexer does not serve yet (G1 §2.4; operator, 2026-11-18).
//
// The read tools read /v1/core/v2 only. Four views have no route. Each is
// disclosed where a reader would look for it, as a structured absence naming
// the route and the exact fields it would need, so a gavel-indexer row can be
// briefed from this file. The write tools read the chain for their own checks;
// the read tools never do.
// ============================================================================

export interface Gap {
  id: string;
  what: string;
  wouldNeed: { route: string; fields: Record<string, string> };
  contractViews: string[];
}

export const GAPS: Record<'G1' | 'G2' | 'G3' | 'G4', Gap> = {
  G1: {
    id: 'G-1',
    what: "An account's vault balances: free, reserved and locked, per asset.",
    wouldNeed: {
      route: 'GET /v1/core/v2/accounts/:address/balances',
      fields: {
        'rows[].asset': 'bytes32 asset key (0x01 ‖ zero bytes ‖ token for an ERC-20)',
        'rows[].token': 'token address, with symbol and decimals from the deployment',
        'rows[].free': 'Vault.balance(user, asset): integer string, base units',
        'rows[].total': 'Vault.totalBalance(user, asset)',
        'rows[].reserved[]': '{ consumer, contextId, amount } per open reservation (Vault.reservedBalance)',
        'rows[].locked[]': '{ lockId (vault loan id), owner (the consumer holding the lock), amount } per live lock leg',
        'consumers[]': '{ consumer, approved (Vault.isUserApproved), authorised (Vault.isAuthorisedConsumer) } for every V2 product',
      },
    },
    contractViews: ['Vault.balance', 'Vault.totalBalance', 'Vault.reservedBalance', 'Vault.getLoanLegs', 'Vault.isUserApproved', 'Vault.isAuthorisedConsumer'],
  },
  G2: {
    id: 'G-2',
    what: 'The state of an obligation, its set and its lien, by id.',
    wouldNeed: {
      route: 'GET /v1/core/v2/obligations/:obligationId (and /sets/:setId, /liens/:lienId)',
      fields: {
        obligationId: 'integer string',
        setId: 'integer string',
        obligor: 'address',
        asset: 'bytes32 key, and the token',
        principal: 'integer string', interest: 'integer string', paid: 'integer string',
        payoff: 'Obligation.payoff(id) as at indexedTo',
        debtAt: 'Obligation.debtAt(setId, t) as at indexedTo',
        accrualStart: 'unix', dueAt: 'unix', pauseShift: 'seconds', grace: 'seconds (the set\'s)',
        prepayment: 'NONE | FULL | ACCRUED',
        status: 'OPEN | DISCHARGED | BREACHED | SETTLED | PAID_LATE | RELEASED',
        setStatus: 'CREATING | ACTIVE | BREACHED | DISCHARGED | SETTLED | PAID_LATE',
        unitsOutstanding: 'integer string',
        contingent: '{ kind, resolved, fired } or null',
        lien: '{ lienId, status, bound, takeMode, lockId } or null',
        position: '{ owner, state } (ObligorPosition, token id = setId)',
      },
    },
    contractViews: ['Obligation.getObligation', 'Obligation.getSet', 'Obligation.payoff', 'Obligation.debtAt', 'Obligation.positionState', 'Lien.getLien', 'Lien.lienOfSet'],
  },
  G3: {
    id: 'G-3',
    what: "BOND's state: listed loan tokens, prices and their lapse, caps and supply.",
    wouldNeed: {
      route: 'GET /v1/core/v2/bond/listing',
      fields: {
        'loanTokens[]': '{ token, cap, floor, minted, priced (bool), live (bool) }',
        'pricedAssets[]': '{ token, market (SpotMarket), price (assetPrice), priced (bool), lastClearings: [{ slot, price, at }], lapsesAt: unix (oldest of the last PRICE_SAMPLES clearings + PRICE_WINDOW) }',
        'curve[]': '{ loanToken, rate, observations } as BondCurve records it',
        supply: 'BondToken.totalSupply', genesis: 'integer string', listingEnd: 'unix (LISTING_END)',
        'registrations[]': '{ setId | externalId, registrant, stake, status } (per account: already /accounts/:address/bond as events)',
      },
    },
    contractViews: ['BondListing.assetPrice', 'BondListing.loanToken', 'BondToken.totalSupply', 'BondProtocol.estimateMint'],
  },
  G4: {
    id: 'G-4',
    what: "A liquidation-cover account's state on a MorphoCoverAdapter.",
    wouldNeed: {
      route: 'GET /v1/core/v2/liquidation-cover/accounts?owner=:address',
      fields: {
        'rows[].adapter': 'MorphoCoverAdapter address',
        'rows[].accountId': 'integer string', 'rows[].owner': 'address', 'rows[].account': 'CoverAccount clone address',
        'rows[].collateral': 'integer string, base units',
        'rows[].borrowShares': 'integer string', 'rows[].borrowAssets': 'integer string as at indexedTo',
        'rows[].health': 'healthOf(accountId): { used, maxBorrow, ceiling (MAX_HEALTH_USE) }',
        'rows[].frozen': 'bool', 'rows[].armed': 'bool', 'rows[].ref': 'integer string or null',
        'rows[].maxCover': 'coverTerms(ref, owner).maxCover, or null when not armed',
        'rows[].liquidated': 'bool',
      },
    },
    contractViews: ['MorphoCoverAdapter.accountOf', 'MorphoCoverAdapter.healthOf', 'MorphoCoverAdapter.frozen', 'MorphoCoverAdapter.refOf', 'MorphoCoverAdapter.coverTerms'],
  },
};

/** The structured absence a tool returns in place of a view the indexer does not serve. */
export function notServed(gap: Gap) {
  return {
    absent: {
      reason: 'not_served_by_the_indexer',
      gap: gap.id,
      what: gap.what,
      wouldNeed: gap.wouldNeed,
      note: 'This server reads the indexer only and does not read the chain for its data tools. The view is raised for the indexer.',
    },
  };
}
