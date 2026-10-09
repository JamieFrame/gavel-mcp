// R18 Phase 3 (MD4) — the Gavel indicator catalogue.
//
// One parameterised pair (list_gavel_indicators / get_gavel_indicator) rather
// than ~24 near-identical tools: a long tool list measurably degrades an
// agent's tool-selection accuracy, and one pair inherits the REST layer's
// empty-on-mainnet honesty automatically.
//
// Paths are the CANONICAL namespaced ones (/v1/credit/*, /v1/onchain/*,
// /v1/market/*). The flat legacy paths 301 to these, and a strict client that
// refuses redirects would break — so the catalogue names the destination, not
// the redirect. See gavel-indexer/lib/route-namespacing.js.
//
// WARNING, added 2026-08-26: the rule above - name the canonical destination,
// not the redirect - was applied to two entries whose namespaced destination
// was never mounted at all: hodl-waves and the onchain-latest history. Both
// 404'd while advertised live:true. Naming a destination only works if
// something is serving it. Run `npm run check:advertised` rather than assuming.
//
// `live` records what was verified against mainnet on 2026-07-22. It is a
// documentation hint only — get_gavel_indicator always asks upstream and
// reports what it actually finds, so a stale flag here can never fabricate a
// reading.

export type IndicatorFamily = 'credit' | 'onchain' | 'market';

export interface IndicatorSpec {
  id: string;
  name: string;
  family: IndicatorFamily;
  path: string;
  /** Canonical history path, or null where the series is not served. */
  historyPath: string | null;
  units: string;
  description: string;
  live: boolean;
  /** Present only when `live` is false — why, in plain language. */
  note?: string;
  /**
   * OB4-D10 — the venue whose own rate this indicator is anchored on, if any.
   *
   * An anchored indicator does not measure the market; it measures ONE VENUE
   * against the market. `drp` is `gavel_rate − treasury_yield`; there is no
   * `aave_drp`. Publishing them in the observatory's catalogue gave that venue
   * an indicator namespace no other venue has — `/indicators/yield-curve`
   * resolved while `/indicators/aave` was a 404 — which is the plainest reading
   * of the "no venue is surfaced in a way the others are not" rule failing.
   *
   * This is the SAME ruling the disposition table made at D-A for
   * `get_yield_curve`, which stayed Gavel-only for exactly this reason. The
   * catalogue then moved wholesale and carried the series back in, because D-A
   * was applied to a tool and nobody re-applied it one level down.
   *
   * Anchored entries stay in this file — they are real indicators and the Gavel
   * server serves them. They are filtered OFF the observatory profile and
   * answer there with a `moved` pointer, never a silent absence.
   *
   * The fix that removes this field is a per-venue rate endpoint: with one,
   * these generalise to every venue and stop being anchored at all. Three
   * separate workstreams now want that endpoint.
   *
   * RW15 (2026-09-14/15) built the indicator half of that: VRB, DRP, LPI,
   * CCS, COC and SRCS are now `target − reference` with a `target` venue_id
   * parameter, and no formula names a venue. The operator admitted "all venues
   * where the indicators can be consistently and coherently applied"
   * (2026-09-15): DRP, CCS and LPI now also run for every carded custodial desk
   * (cefi_<desk>); VRB (needs a lender yield), COC (needs WBTC collateral) and
   * SRCS (needs a dense series) admit gavel_arbitrum alone. These tools serve
   * the default target and pass no `target`, so the default IS the anchor for
   * everything they return, and this field says so.
   */
  anchoredTo?: string;
  /**
   * IX1 (2026-10-09) — not published on the Bitcoin Credit Stack. The indicator
   * stays in this file (the Gavel server and the pre-split surface may still serve
   * it) and its writer keeps writing; the observatory leaves it out of
   * list_indicators and answers get_indicator with this block, never "unknown id".
   *   retired  removed from the Stack's public surfaces (V14: history kept)
   *   held     computed, published nowhere on the Stack, revisited when its
   *            condition is met (IX1 treatment HOLD)
   *   merged   its question is answered by `successor`
   * Register: aletheia-docs runbooks/…/runbook_IX1_indicator_triage_and_explorer_v1.md §3a.
   */
  stack?: { status: 'retired' | 'held' | 'merged'; on: string; ruling: string; reason: string; successor?: string };
}

export const INDICATORS: IndicatorSpec[] = [
  // ── Gavel-derived credit assessments — the proprietary layer ──────────────
  {
    id: 'yield-curve',
    anchoredTo: 'gavel_arbitrum',
    name: 'Gavel Yield Curve',
    family: 'credit',
    path: '/v1/credit/yield-curve',
    historyPath: '/v1/credit/yield-curve/history',
    units: 'implied APR (%) by tenor',
    description:
      'The canonical oracle-free term structure, fitted log-quadratically through binned auction observations. The base layer of the Bitcoin Credit Stack.',
    live: true,
  },
  {
    id: 'tci',
    name: 'Terminal Conviction Index',
    family: 'credit',
    path: '/v1/credit/tci',
    historyPath: '/v1/credit/tci/history',
    units: 'ratio',
    description: 'Long-tenor lender conviction relative to the short end. A regime signal, not a rate.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: it is computed from one venue\'s book (Gavel\'s), so it measures that venue, not the market (IX-D4).' },
  },
  {
    id: 'tsr',
    name: 'Term Slope Ratio',
    family: 'credit',
    path: '/v1/credit/tsr',
    historyPath: '/v1/credit/tsr/history',
    units: 'ratio',
    description: 'The slope of the curve expressed as a ratio between long and short tenors.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: it is computed from one venue\'s book (Gavel\'s), so it measures that venue, not the market (IX-D4).' },
  },
  {
    id: 'cdr',
    name: 'Confidence Decay Rate',
    family: 'credit',
    path: '/v1/credit/cdr',
    historyPath: '/v1/credit/cdr/history',
    units: 'rate per day',
    description:
      'The rate at which the market-implied collateral floor decays across the curve, with an implied half-life. A measure of how fast lender confidence falls away with tenor.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: it is computed from one venue\'s book (Gavel\'s), so it measures that venue, not the market (IX-D4).' },
  },
  {
    id: 'ccpi',
    name: 'Credit-Cycle Phase Indicator',
    family: 'credit',
    path: '/v1/credit/ccpi',
    // History route added 2026-07-24 (R12). ccpi_history had been accumulating
    // since 2026-03 with no route to serve it, so has_history:false was
    // accurate only because the data was unreachable, not absent.
    historyPath: '/v1/credit/ccpi/history',
    units: 'composite z-score',
    description:
      'Composite of TCI-z, SOPR-z and MVRV-z classifying the credit cycle phase. Combines the credit and on-chain layers.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: a composite score with phase labels, and the Stack publishes no composites or signals (IX-D1, IX-D3).' },
  },
  {
    id: 'implied-price',
    name: 'Implied Price Floor',
    family: 'credit',
    path: '/v1/credit/implied-price',
    historyPath: '/v1/credit/implied-price/history',
    units: 'USD',
    description:
      'The BTC price implied by where lenders are willing to lend against collateral, by tenor. A market-clearing floor, not a forecast.',
    live: true,
    stack: { status: 'held', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Held: computed from Gavel\'s book alone, which is still predominantly own-account; held, unpublished, until that book is an independent market.' },
  },
  {
    id: 'regime',
    name: 'Curve Regime',
    family: 'credit',
    path: '/v1/credit/regime',
    historyPath: '/v1/credit/regime/history',
    units: 'classification',
    description: 'Curve shape classification (NORMAL / FLAT / INVERTED) with the fitted beta coefficients.',
    live: true,
    stack: { status: 'held', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Held: computed from Gavel\'s book alone, which is still predominantly own-account; held, unpublished, until that book is an independent market.' },
  },
  {
    id: 'surface',
    name: 'Credit Surface',
    family: 'credit',
    path: '/v1/credit/surface',
    historyPath: null,
    units: 'APR (%) over the tenor x LTV grid',
    description: 'The full two-dimensional rate surface across duration and loan-to-value buckets.',
    live: true,
    stack: { status: 'held', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Held: computed from Gavel\'s book alone, which is still predominantly own-account; held, unpublished, until that book is an independent market.' },
  },
  {
    id: 'lci',
    name: 'Leverage Conviction Index',
    family: 'credit',
    path: '/v1/credit/lci',
    historyPath: '/v1/credit/lci/history',
    units: 'annualised % by rolling window',
    description:
      'The annualised cost of holding leveraged BTC long exposure via perpetual futures funding. ' +
      'NOT a Gavel rate: sourced from Binance BTCUSDT 8-hour funding, summed over the rolling ' +
      'window and annualised. Positive means longs pay shorts (net long conviction); negative ' +
      'means shorts pay longs. Functions as the zero-duration point of the capital stack.',
    live: false,
    note: 'Retired 2026-10-02 (PV1 G0-2c): Binance perpetual-futures data is not licensed for redistribution. The route still answers, with null values and a `retired` block; the history is retained, not served.',
  },
  {
    id: 'vrb',
    anchoredTo: 'gavel_arbitrum',
    name: 'Variable Rate Basis',
    family: 'credit',
    path: '/v1/credit/vrb',
    historyPath: '/v1/credit/vrb/history',
    units: 'spread (percentage points)',
    description:
      'Target − reference: the target venue\'s fixed-term lender yield (default gavel_arbitrum, ' +
      'the one venue with such a series) minus the best BASE USDC supply rate — rewards excluded — ' +
      'of four named pools (Aave v3 Ethereum and Arbitrum, Compound v3 Ethereum and Base), ' +
      'gate-publishable rows only, both continuously compounded. Positive: the target pays more ' +
      'than the variable alternative. breaks[] marks where the series moved onto this convention; ' +
      'earlier rows carry rate_convention legacy_mixed.',
    live: true,
  },
  {
    id: 'lpi',
    anchoredTo: 'gavel_arbitrum',
    name: 'Leverage Premium Index',
    family: 'credit',
    path: '/v1/credit/lpi',
    historyPath: '/v1/credit/lpi/history',
    units: 'spread (percentage points)',
    description:
      'Target − reference: the target\'s fixed-term rate minus LCI (perp funding), both ' +
      'continuously compounded, over the SAME N days — LCI_Nd is funding paid over the last N days, ' +
      'so the target side is its N-day rate QUOTED N days ago (target_quoted_at, pairing_note). A ' +
      'window whose quote does not reach back N days is an absence. ⚠ The SIGN FLIPPED and the ' +
      'series was RE-PAIRED at RW15: positive now means the fixed-term loan cost MORE than perp ' +
      'funding; before the break in breaks[] the series was LCI − today\'s forward rate, and each ' +
      'row carries its orientation and pairing. regime keeps its meaning (the leverage premium, ' +
      'LCI − target). Served for gavel_arbitrum; the API also computes it for each carded desk.',
    live: false,
    note: 'Retired 2026-10-02 (PV1 G0-2c) with LCI, its reference leg: Binance perpetual-futures data is not licensed for redistribution. The route still answers, with null values and a `retired` block; the history is retained, not served.',
  },
  {
    id: 'drp',
    anchoredTo: 'gavel_arbitrum',
    name: 'DeFi Risk Premium',
    family: 'credit',
    path: '/v1/credit/drp',
    historyPath: '/v1/credit/drp/history',
    units: 'spread vs matched treasury (percentage points)',
    description:
      'Target − reference: the target\'s fixed-term rate minus the US Treasury bill of the SAME ' +
      'tenor, both continuously compounded, at 30, 90, 180 and 365 days only. Every other window ' +
      'is an absence (no bill matches), including 7, 14, 60 and 730 days, which were paired with a ' +
      'bill or note of a different maturity before the break in breaks[]. Served for ' +
      'gavel_arbitrum; the API also computes it for each carded desk at its card\'s bill-matching ' +
      'term, with target_basis_status saying whether the desk\'s compounding basis is established ' +
      'or assumed.',
    live: true,
  },
  {
    id: 'sli',
    name: 'Stablecoin Liquidity Index',
    family: 'credit',
    path: '/v1/credit/sli',
    historyPath: '/v1/credit/sli/history',
    units: 'index',
    description: 'Stablecoin liquidity conditions on the lending side, with a regime classification.',
    live: true,
    stack: { status: 'merged', on: '2026-10-09', ruling: 'IX1 sitting D', reason: 'Merged: stablecoin supply growth is shown as the growth view of stablecoins, without regime labels.', successor: 'stablecoins' },
  },
  {
    id: 'sdr',
    name: 'Stablecoin Dominance Ratio',
    family: 'credit',
    path: '/v1/credit/sdr',
    historyPath: '/v1/credit/sdr/history',
    units: 'percent',
    description: 'Stablecoin market cap as a share of total crypto market cap.',
    live: false,
    note: 'Retired 2026-10-02 (PV1 G0-2g): total crypto market capitalisation has no root source. The route still answers, with null values and a `retired` block; the history is retained, not served.',
  },
  {
    id: 'coc',
    anchoredTo: 'gavel_arbitrum',
    name: 'Collateral Opportunity Cost',
    family: 'credit',
    path: '/v1/credit/coc',
    historyPath: '/v1/credit/coc/history',
    units: 'APR (%)',
    description:
      'The BASE WBTC supply yield a borrower forgoes by locking WBTC as collateral — the best of ' +
      'Aave v3 Ethereum and Arbitrum WBTC, rewards excluded, continuously compounded. ' +
      'all_in_cost = the target\'s 30d rate (continuously compounded) + COC, each network priced ' +
      'off its own curve. breaks[] marks the move onto this convention.',
    live: true,
  },
  {
    id: 'gls',
    anchoredTo: 'gavel_arbitrum',
    name: 'Gavel Liquidity Sensitivity',
    family: 'credit',
    path: '/v1/credit/gls',
    historyPath: '/v1/credit/gls/history',
    units: 'regression coefficient (beta) + residual gap',
    description:
      'How strongly the reference lending rate responds to stablecoin liquidity conditions. ' +
      'An OLS fit of rate on SLI over a trailing window (rate = alpha + beta x SLI), returning ' +
      'the full fit (alpha, beta, R-squared, confidence intervals) plus the current-moment ' +
      'residual gap. NOT a spread against a venue. Returns null below 30 paired observations.',
    live: true,
  },
  {
    id: 'mrys',
    anchoredTo: 'gavel_arbitrum',
    name: 'Miner Revenue Yield Spread',
    family: 'credit',
    path: '/v1/credit/mrys',
    historyPath: '/v1/credit/mrys/history',
    units: 'spread',
    description: 'Mining revenue yield spread against the Gavel curve at matched tenor.',
    live: true,
  },
  {
    id: 'srcs',
    anchoredTo: 'gavel_arbitrum',
    name: 'Stablecoin-Rate Correlation Signal',
    family: 'credit',
    path: '/v1/credit/srcs',
    historyPath: null,
    units: 'correlation / gap',
    description: 'Correlation between stablecoin liquidity (SLI) and 14-day changes in the target\'s 30d rate (continuously compounded, BTC-collateral curve only), with the implied liquidity gap.',
    live: false,
    note: 'Retired 2026-10-09 (IX1 sitting B): it correlates stablecoin supply with the FOLLOWING 14 days of the rate, so it is forward-looking by construction. History is kept, not served.',
  },
  {
    id: 'ccs',
    anchoredTo: 'gavel_arbitrum',
    name: 'CeFi Credit Spread',
    family: 'credit',
    path: '/v1/credit/ccs',
    historyPath: '/v1/credit/ccs/history',
    units: 'spread',
    description:
      'Target − reference: the target\'s rate minus a custodial desk\'s posted rate at the matched ' +
      'tenor, both continuously compounded. ⚠ The SIGN FLIPPED at RW15: NEGATIVE now means the ' +
      'target is cheaper than the desk. Every desk is valued: on the compounding basis its own ' +
      'pages establish (cefi_basis_status established), or on the stated default — simple ' +
      'interest paid at the end of the term — marked assumed, with ccs_range_cc giving the spread ' +
      'across the desk\'s admissible bases. Weigh an assumed value by its range. The CeFi inputs ' +
      'are administered (posted) rates, not cleared trades.',
    live: true,
  },
  {
    id: 'intermediation-spread',
    name: 'Borrow over lend rate, per class',
    family: 'market',
    path: '/v1/market/measure/intermediation-spread',
    historyPath: '/v1/market/measure/intermediation-spread/history',
    units: 'percent_cc (points)',
    description: 'What borrowers pay over what lenders earn, per class, where both legs come from the same venues: pools (from 2022-09-19) and the desks that post both rates (from 2026-10-07). Not at market level, where the two legs come from different classes; not for minted stablecoins (no lender) or auctions (one price). Recast at IX1 Phase 3 (2026-10-09) from a one-venue comparison.',
    live: true,
  },
  {
    id: 'capital-stack',
    name: 'Capital Stack',
    family: 'credit',
    path: '/v1/credit/capital-stack',
    historyPath: null,
    units: 'APR (%) by layer',
    description: 'The Bitcoin Credit Stack: risk-free, CeFi, DeFi and Gavel layers side by side at matched tenors. The variable DeFi layers are currently withheld (DefiLlama data, not redistributed) and return empty. The leveraged (perp funding) layer is retired (PV1, 2026-10-02) and returns empty. Payloads carry `withheld` and `retired` blocks naming each field returned empty or null and why.',
    live: true,
  },
  {
    id: 'benchmark-curves',
    name: 'Benchmark Curves',
    family: 'credit',
    path: '/v1/credit/benchmark-curves',
    historyPath: null,
    units: 'APR (%) by tenor',
    description: 'The reference curves (US Treasury and other benchmarks) at matched tenors, against which the market\'s borrow spreads are measured (bsbs, borrow-spread).',
    live: true,
  },
  {
    id: 'complex',
    name: 'Bitcoin Credit Complex (aggregate)',
    family: 'credit',
    path: '/v1/credit/complex',
    historyPath: null,
    units: 'mixed',
    description:
      'Eleven credit indicators in one response: the yield curve (rates, fit and both shape ' +
      'classifications), tci, tsr, cdr, implied_price, vrb, drp, sli, srcs, coc and ccpi. lci, ' +
      'lpi and sdr are retired (PV1, 2026-10-02): their keys stay, null, named in `retired`. ' +
      'Cheaper than fetching these individually when building a dashboard. ' +
      'It is NOT the whole catalogue — surface, gls, mrys, ccs, intermediation-spread, ' +
      'capital-stack and benchmark-curves have their own endpoints, and the response carries a ' +
      '_coverage block listing exactly what is and is not included. Check it rather than ' +
      'assuming completeness.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: a bundle of indicators computed from one venue\'s book (IX-D4).' },
  },
  {
    id: 'forward-curve',
    name: 'Forward Curve',
    family: 'credit',
    path: '/v1/credit/forward-curve',
    historyPath: '/v1/credit/forward-curve/history',
    units: 'implied forward APR (%)',
    description: 'Forward rates implied by the fitted curve.',
    live: false,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting A', reason: 'Not published on the Stack: forwards from one venue\'s fitted curve, and not live on mainnet.' },
    note: 'Derived from v2 protocol data, which is testnet-only until v2 reaches mainnet. Mainnet returns an explicit 404 rather than an empty series.',
  },
  {
    id: 'hrcs',
    anchoredTo: 'gavel_arbitrum',
    name: 'Hash-Rate Credit Spread',
    family: 'credit',
    // Served under /v1/onchain/*, not /v1/credit/* — it is computed by the
    // on-chain module from mining economics, and the route follows the module.
    // The catalogue pointed at /v1/credit/hrcs, which does not exist, and
    // declared the indicator unimplemented on the strength of that 404.
    path: '/v1/onchain/hrcs',
    historyPath: '/v1/onchain/hrcs/history',
    units: 'spread',
    description:
      'Mining economics spread against the Gavel curve: the miner breakeven price against the ' +
      'credit-implied collateral floor, with hash rate and BTC price. Carries `data_maturity`.',
    live: true,
  },
  {
    id: 'rpid',
    name: 'Realised Price Implied Divergence',
    family: 'credit',
    // Served under /v1/onchain/*, for the same reason as hrcs above.
    path: '/v1/onchain/rpid',
    historyPath: '/v1/onchain/rpid/history',
    units: 'divergence',
    description:
      'Divergence between the on-chain realised price and the credit-implied collateral floor, ' +
      'with the MVRV ratio and BTC price. Carries `data_maturity`.',
    live: true,
    stack: { status: 'merged', on: '2026-10-09', ruling: 'IX1 sitting C', reason: 'Merged: its credit-implied floor is read from one venue\'s curve; the cross-venue question (where the book liquidates against the realised price) is liq-over-realised.', successor: 'liq-over-realised' },
  },

  // ── Commodity on-chain — free permanently (D4) ────────────────────────────
  {
    id: 'onchain-latest',
    name: 'On-chain Indicators (latest)',
    family: 'onchain',
    path: '/v1/onchain/indicators/latest',
    // 2026-10-01: the route now sits behind namespacing (gavel-indexer, BCS
    // loose ends), so the namespaced path answers and the flat one 301s to it.
    // (Until then the flat path was mounted ahead of the rewrite and this 404'd.)
    historyPath: '/v1/onchain/indicators/history',
    units: 'mixed',
    description:
      'The full commodity on-chain set in one response: MVRV, MVRV-z, SOPR (and 7d/z), realised cap and price, STH/LTH supply and cost basis, circulating supply, spot price.',
    live: true,
  },
  {
    id: 'hodl-waves',
    name: 'HODL Waves',
    family: 'onchain',
    // 2026-10-01: namespaced again. The route was mounted ahead of the
    // namespacing rewrite, which is why this path 404'd and the 2026-08-26
    // correction pointed at the flat one; it now sits behind the rewrite (and
    // the property split and rate gate), so the flat path 301s here.
    // scripts/check-advertised.mjs still guards it.
    path: '/v1/onchain/indicators/hodl-waves',
    historyPath: null,
    units: 'percent of supply by age band',
    description: 'UTXO supply distribution across twelve age bands, from under a day to over ten years.',
    live: true,
  },
  {
    // Miner Metrics v2 Gate 0 (operator, 2026-10-08, MM-D7): name and description copied verbatim from
    // data/specs/indicators/miner_metrics_v0.md section 3. Served per PH/s per day, BTC (miner.hpx_btc) and USD
    // (miner.hpx_usd), by the Gate 0 unit ruling; the spec's $/TH/day wording predates it.
    id: 'hpx',
    name: 'Hashprice',
    family: 'onchain',
    path: '/v1/onchain/series/miner.hpx_btc',
    historyPath: '/v1/onchain/series/miner.hpx_btc',
    units: 'BTC per PH/s per day (miner.hpx_btc); USD per PH/s per day as miner.hpx_usd',
    description: 'Hashprice: what one PH/s of hashrate earned in a day (subsidy plus fees), in bitcoin and in dollars, from our own node. The miner\'s unit of account.',
    live: true,
  },

  // ── Market context ────────────────────────────────────────────────────────
  {
    id: 'defi-rates',
    name: 'DeFi Rates',
    family: 'market',
    path: '/v1/market/defi-rates/current',
    historyPath: '/v1/market/defi-rates/history',
    units: 'APR (%)',
    description: 'Which comparable DeFi venues and assets are observed, with their timestamps. The borrow/supply/TVL values are DefiLlama data and are currently withheld (returned as null). Payloads carry a `withheld` block naming each field returned as null and why.',
    live: true,
    stack: { status: 'retired', on: '2026-10-09', ruling: 'IX1 sitting D', reason: 'Not published on the Stack: its values are withheld (DefiLlama terms), and every venue\'s rate is in the credit tree and on the venue pages.' },
  },
  {
    id: 'rates-comparison',
    name: 'Rates Comparison',
    family: 'market',
    path: '/v1/market/rates/comparison',
    historyPath: '/v1/market/rates/comparison/history',
    units: 'APR (%)',
    description: 'Gavel rates beside CeFi and treasury comparators at matched tenors. The DeFi (Aave/Compound/Morpho) columns are DefiLlama data and are currently withheld (returned as null); the BTC funding column is retired (PV1, 2026-10-02) and returned as null. Payloads carry `withheld` and `retired` blocks naming each field returned as null and why.',
    live: true,
    stack: { status: 'merged', on: '2026-10-09', ruling: 'IX1 Phase 3 (operator)', reason: 'Merged: each class’s borrow rate over the 3-month bill is served by borrow-spread, across venues; this indicator set one venue beside desks and treasuries.', successor: 'borrow-spread' },
  },
  {
    id: 'stablecoins',
    name: 'Stablecoin Supply',
    family: 'market',
    path: '/v1/market/stablecoins/current',
    historyPath: '/v1/market/stablecoins/history',
    units: 'USD',
    description: 'Stablecoin market cap, the liquidity backdrop for the lending side. Supply by issuer and chain is DefiLlama data and is currently withheld (returned as null); issuer and chain coverage is still listed. Stablecoin dominance is retired (PV1, 2026-10-02) and returned as null. Payloads carry `withheld` and `retired` blocks naming each field returned as null and why.',
    live: true,
  },
  {
    id: 'macro',
    name: 'Macro Context',
    family: 'market',
    path: '/v1/market/macro/current',
    historyPath: '/v1/market/macro/history',
    units: 'mixed',
    description: 'Treasury yields and macro series used as benchmark inputs.',
    live: true,
  },
  {
    id: 'btc-price',
    name: 'BTC Reference Price (on-chain)',
    family: 'market',
    path: '/v1/onchain/series/price.btc_in_basket',
    historyPath: '/v1/onchain/series/price.btc_in_basket',
    units: 'USDBASKET_per_BTC (basket dollars, not fiat)',
    description: 'Our own daily BTC price, read on chain: the median across bitcoin wrappers (WBTC, cbBTC) of their pools against USDC and USDT, priced in a basket of dollar stablecoins, from 2020-07-13. Not CoinGecko. Each wrapper’s own peg is published separately. Recast at IX1 sitting D (2026-10-09) from a CoinGecko spot price.',
    live: true,
  },
  // CX1 Gate 8 (operator 2026-10-09): three governed indices, descriptive, free with
  // history, methodology on www.bitcoincreditstack.com/indicators/<id> and changes
  // published 30 days ahead. Venue-independent, so observatory-only (not anchored).
  {
    id: 'bcsi',
    name: 'Bitcoin Collateral Share Index',
    family: 'market',
    path: '/v1/market/index/bcsi',
    historyPath: '/v1/market/index/bcsi/history',
    units: 'index (100 on 2022-09-19)',
    description: 'Bitcoin posted as collateral against lien-backed debt, as a share of all spendable bitcoin, chain-linked over the venues read on both consecutive dates so a venue entering the data never moves it. Served with the plain share beside it, the matched coverage, and own_account: the weight of the one venue where the operator trades for its own account (Gavel, included and disclosed). Descriptive, not a signal.',
    live: true,
  },
  {
    id: 'bsbs',
    name: 'Bitcoin-Secured Borrow Spread',
    family: 'market',
    path: '/v1/market/index/bsbs',
    historyPath: '/v1/market/index/bsbs/history',
    units: 'percent_cc (points over the 3-month bill)',
    description: 'What borrowers pay against bitcoin collateral across venues over the 3-month US Treasury bill (H.15, continuously compounded): the plain spread on 2022-09-19, then each step the change in the debt-weighted rate over venues with a rate on both dates, minus the change in the bill. Served with the plain spread beside it and own_account (Gavel, included and disclosed). Not DRP, not a reference rate any contract uses.',
    live: true,
  },
  {
    id: 'wrc',
    name: 'Wrapper Reserve Coverage',
    family: 'market',
    path: '/v1/market/index/wrc',
    historyPath: '/v1/market/index/wrc/history',
    units: 'ratio per wrapper',
    description: 'For WBTC, tBTC, kBTC and cdcBTC: bitcoin at the issuer-published reserve addresses, read on our own node, over the token supply. One value per wrapper, never combined, no verdict. Wrappers without a full published address list or a fully read supply are listed with the reason.',
    live: true,
  },
  // CX1 Gate 8 option A (operator 2026-10-09): the joint credit x on-chain measures, each a named
  // descriptive series with its methodology on www.bitcoincreditstack.com/indicators/<id>. Not indices.
  {
    id: 'collateral-share',
    name: 'Bitcoin collateral as a share of supply',
    family: 'market',
    path: '/v1/market/measure/collateral-share',
    historyPath: '/v1/market/measure/collateral-share/history',
    units: 'ratio',
    description: 'Q2b. The share of all spendable bitcoin posted as collateral against lien-backed debt: the market, each class and the fixed 2022 panel, as read on each date. Coverage steps (venues entering) are named on every value, never smoothed; the chain-linked version is bcsi. Descriptive, not an index.',
    live: true,
  },
  {
    id: 'holdings-share',
    name: 'Corporate bitcoin holdings as a share of supply',
    family: 'market',
    path: '/v1/market/measure/holdings-share',
    historyPath: '/v1/market/measure/holdings-share/history',
    units: 'ratio',
    description: 'Q2c. The share of spendable bitcoin held by the issuers in the registry, from their filings: steps at filing dates, and holdings, not collateral (no lien). Descriptive, not an index.',
    live: true,
  },
  {
    id: 'liq-over-realised',
    name: 'Liquidation price over realised price',
    family: 'market',
    path: '/v1/market/measure/liq-over-realised',
    historyPath: '/v1/market/measure/liq-over-realised/history',
    units: 'ratio',
    description: 'Q8. Where the book liquidates as a multiple of the realised price, for the market and the pool and minted classes. Rests on CoinGecko prices for coins created before 2020-07-13: free, attributed use only (licence on every value). Descriptive, not an index.',
    live: true,
  },
  {
    id: 'debt-over-realised-cap',
    name: 'Secured debt over realised cap',
    family: 'market',
    path: '/v1/market/measure/debt-over-realised-cap',
    historyPath: '/v1/market/measure/debt-over-realised-cap/history',
    units: 'ratio',
    description: 'Q2a. Bitcoin-secured dollar debt over realised cap. Rests on CoinGecko prices for coins created before 2020-07-13: free, attributed use only. Descriptive, not an index.',
    live: true,
  },
  {
    id: 'borrow-spread',
    name: 'Borrow spread over the 3-month bill',
    family: 'market',
    path: '/v1/market/measure/borrow-spread',
    historyPath: '/v1/market/measure/borrow-spread/history',
    units: 'percent_cc',
    description: 'Q5. The credit tree’s borrow rate minus the 3-month Treasury bill (H.15, continuously compounded), for the market and each class, as read on each date: coverage steps move it. The chain-linked version is bsbs. Descriptive, not an index.',
    live: true,
  },
  {
    id: 'costbasis-near-liquidation',
    name: 'Supply whose cost basis sits in the liquidation bands',
    family: 'market',
    path: '/v1/market/measure/costbasis-near-liquidation',
    historyPath: '/v1/market/measure/costbasis-near-liquidation/history',
    units: 'BTC',
    description: 'Q1. Bitcoin that last moved at a price within 10, 20 or 30% below the market mark, beside the debt in the same liquidation bands. Some dates rest on CoinGecko prices (licence on every value). Descriptive, not a forecast.',
    live: true,
  },
  {
    id: 'btc-released-at-fall',
    name: 'Bitcoin liquidations would release at a fall',
    family: 'market',
    path: '/v1/market/measure/btc-released-at-fall',
    historyPath: '/v1/market/measure/btc-released-at-fall/history',
    units: 'BTC',
    description: 'Q7. Bitcoin that liquidations would release if every venue’s own mark fell 10, 20 or 30%, from the positions as they stand, with each venue’s liquidation incentive; absent where an incentive is not yet read (the venues are named). Arithmetic on the book, not a forecast.',
    live: true,
  },
  {
    id: 'credit-weekly-change',
    name: 'Weekly change in bitcoin-secured credit, matched venues',
    family: 'market',
    path: '/v1/market/measure/credit-weekly-change',
    historyPath: '/v1/market/measure/credit-weekly-change/history',
    units: 'ratio',
    description: 'Q4. The change over 7 days in debt and in collateral across only the venues read on both dates, with and without venues the integrity check flags. The finding built on it (no co-movement with old-coin spending) is published on the site. Descriptive, not a signal.',
    live: true,
  },
  // IX1 Phase 2 (operator, Gate 1 2026-10-09): the grouped chain pages (CS1 G0-6) and the holding-period curve.
  {
    id: 'spending',
    name: 'Spending by age',
    family: 'onchain',
    path: '/v1/onchain/spending',
    historyPath: null,
    units: 'BTC per day by age band; coin-days; days',
    description: 'Bitcoin spent each day by how long it had been unspent (twelve age bands), with coin-days destroyed and dormancy, from our own node since 2009. The reading is the last point of each series; each series\' history is on get_chain_series.',
    live: true,
  },
  {
    id: 'mining',
    name: 'Mining',
    family: 'onchain',
    path: '/v1/onchain/mining',
    historyPath: null,
    units: 'EH/s; difficulty; BTC per day; blocks and transactions per day',
    description: 'The network\'s mining each day from our own node: hashrate, difficulty, subsidy and fees, blocks and transactions. The reading is the last point of each series; history is on get_chain_series. Hashprice is hpx.',
    live: true,
  },
  {
    id: 'cost-basis',
    name: 'Cost basis',
    family: 'onchain',
    path: '/v1/onchain/cost-basis/latest',
    historyPath: null,
    units: 'USD per BTC (percentiles); BTC by price bucket',
    description: 'The price at which each coin of spendable supply was created, as percentiles; the full distribution for a day is get_cost_basis. Coins created before 2020-07-13 are priced from CoinGecko: free, attributed use only.',
    live: true,
  },
  {
    id: 'holding-period-curve',
    name: 'Realised holding-period curve',
    family: 'market',
    path: '/v1/market/curve',
    historyPath: '/v1/market/curve/replay',
    units: 'percent by holding period (1–730 days)',
    description: 'The rate borrowers paid by how long their positions stayed open, from positions read one by one (survival over the book). Morpho Blue only today: it widens as other venues\' positions are read one by one. Not a fixed-term curve.',
    live: true,
  },
  // IX1 Phase 3 (3d, operator 2026-10-09): shown beside the borrow rate, never subtracted from it.
  {
    id: 'miner-revenue-share',
    name: 'Miners’ revenue as a share of supply',
    family: 'onchain',
    path: '/v1/market/measure/miner-revenue-share',
    historyPath: '/v1/market/measure/miner-revenue-share/history',
    units: 'ratio per year (annualised share of spendable supply)',
    description: 'What the network paid its miners each day, block subsidy plus fees, times 365, over spendable supply: price-free, from our own node, every day since 2009. Each halving is a step. Set beside the bitcoin-secured borrow rate on the explorer, never subtracted from it: one is a bitcoin share, the other a dollar rate.',
    live: true,
  },
];

export function findIndicator(id: string): IndicatorSpec | undefined {
  const needle = id.trim().toLowerCase();
  return INDICATORS.find((i) => i.id === needle);
}

export const INDICATOR_IDS = INDICATORS.map((i) => i.id);

/** OB4-D10 — indicators anchored on one venue's own rate. */
export const isAnchored = (spec: IndicatorSpec): boolean => Boolean(spec.anchoredTo);

/** The catalogue a given profile may publish. The observatory publishes only
 *  venue-independent indicators; the Gavel server publishes everything. */
export function catalogueFor(profileId: string): IndicatorSpec[] {
  // DISJOINT, and that is the point. The observatory publishes the venue-independent indicators the IX1 register keeps (§3a)
  // venue-independent indicators; the Gavel server publishes the 10 anchored on
  // its own rate. Neither publishes the other's, so OB1 §0.3's one-tool-one-home
  // rule holds at the catalogue level too: the pair appears on both servers, but
  // no INDICATOR is served from both.
  //
  // ⚠ The first cut of D10 returned all 33 here, which produced a REDIRECT LOOP:
  // the observatory said "yield-curve is served by the Gavel MCP", and the Gavel
  // MCP — where OB1 had shimmed the whole indicator pair away to the observatory
  // — answered "get_gavel_indicator has moved to the observatory". Each server
  // pointed at the other. It shipped because the destination was named without
  // being called, which is the SV6-D3 discipline ("a recast page is deleted only
  // after its destination renders") applied everywhere this session except here.
  if (profileId === 'observatory') return INDICATORS.filter((i) => !isAnchored(i) && !i.stack); // IX1: not published on the Stack
  if (profileId === 'gavel') return INDICATORS.filter(isAnchored);
  return INDICATORS; // gavel-presplit: the pre-split surface, unchanged.
}

/** Anchored ids, for the observatory's `moved` responses. */
export const ANCHORED_IDS: string[] = INDICATORS.filter(isAnchored).map((i) => i.id);
