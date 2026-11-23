/**
 * VZ10 row M1, G4: the build-outlines resource's own part — for each of the testnet site's Build cards
 * ("What a team could launch", /build block G3), which contracts and which of this profile's tools the
 * composition uses, and what is not yet served.
 *
 * The cards themselves (their order, titles, bodies and status) are the site's, copied at a pinned commit by
 * scripts/sync-build-outlines.mjs into build-outlines.generated.ts; that script fails if a card here is
 * missing from the site, if the site has a card not here, or if a contract or tool named here does not exist.
 * Order is the site's. Nothing here ranks the cards or says which to build.
 */
export interface OutlineMap {
  /** The site's card, by its copy-deck row ids (title, body), or by its not-deployed key. */
  card: { title: string; body: string } | { notDeployed: string; body: string };
  /** The status file's product key for the card's chip; null for a card not deployed. */
  product: string | null;
  contracts: string[];
  readTools: string[];
  writeTools: string[];
  notYetServed: string[];
}

export const OUTLINE_MAP: OutlineMap[] = [
  {
    card: { title: 'TBD-G3.2', body: 'TBD-G3.3' },
    product: 'bills',
    contracts: ['BillPackager', 'CoverOrchestrator', 'CoverIssuance', 'CoverSettlement', 'Obligation', 'Vault'],
    readTools: ['get_bill_series', 'list_spot_markets', 'get_spot_market', 'list_cover_offers', 'list_policies', 'get_calendar', 'get_tape', 'get_obligation'],
    writeTools: ['prepare_spot_order', 'prepare_spot_cancel', 'prepare_vault_deposit', 'prepare_vault_withdraw', 'prepare_vault_product_approval'],
    notYetServed: [
      'Write tools for packaging a bill series and for loan protection (BillPackager, CoverOrchestrator).',
    ],
  },
  {
    card: { title: 'TBD-G3.4', body: 'TBD-G3.5' },
    product: 'liquidation',
    contracts: ['CoverOrchestrator', 'CoverAccount', 'MorphoCoverAdapter', 'MockMorpho', 'Vault'],
    readTools: ['list_cover_offers', 'list_policies', 'get_account', 'get_tape'],
    writeTools: [],
    notYetServed: [
      'Write tools for liquidation protection (the account adapters and their offers).',
    ],
  },
  {
    card: { title: 'TBD-G3.6', body: 'TBD-G3.7' },
    product: 'future',
    contracts: ['FutureOrchestrator', 'SpotReferenceResolver', 'SpotMarket', 'Vault'],
    readTools: ['list_future_offers', 'list_futures', 'get_calendar', 'list_spot_markets', 'get_spot_market'],
    writeTools: ['prepare_spot_order', 'prepare_spot_cancel', 'prepare_vault_deposit', 'prepare_vault_withdraw'],
    notYetServed: ['Write tools for posting, taking and settling a future (FutureOrchestrator).'],
  },
  {
    card: { title: 'TBD-G3.8', body: 'TBD-G3.9' },
    product: 'bullet-loan',
    contracts: ['BulletLoanRequest', 'BulletLoanOffer', 'SingleAuction', 'GroupAuction', 'Obligation', 'Lien', 'Vault'],
    readTools: ['list_bullet_loans', 'list_auctions', 'get_auction_bids', 'get_curve', 'get_account', 'get_contract_events', 'get_tape', 'get_obligation'],
    writeTools: [
      'prepare_vault_deposit', 'prepare_vault_withdraw', 'prepare_vault_product_approval',
      'prepare_bullet_request_open', 'prepare_bullet_request_bid', 'prepare_bullet_offer_open', 'prepare_bullet_offer_bid',
      'prepare_bullet_cancel', 'prepare_bullet_entry_release', 'prepare_bullet_finalise',
      'prepare_obligation_pay', 'prepare_lien_payoff', 'prepare_lien_release', 'prepare_lien_claim',
      'prepare_obligation_collect', 'prepare_obligation_redeem',
    ],
    notYetServed: [],
  },
  {
    card: { notDeployed: 'otc-settlement', body: 'TBD-G3.12#0' },
    product: null,
    contracts: [],
    readTools: [],
    writeTools: [],
    notYetServed: ['Not deployed on the testnet: no contract, read tool or write tool.'],
  },
  {
    card: { notDeployed: 'fixed-income-pools', body: 'TBD-G3.12#1' },
    product: null,
    contracts: [],
    readTools: [],
    writeTools: [],
    notYetServed: ['Not deployed on the testnet: no contract, read tool or write tool.'],
  },
];
