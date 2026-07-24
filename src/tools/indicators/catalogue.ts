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
}

export const INDICATORS: IndicatorSpec[] = [
  // ── Gavel-derived credit assessments — the proprietary layer ──────────────
  {
    id: 'yield-curve',
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
  },
  {
    id: 'ccpi',
    name: 'Credit-Cycle Phase Indicator',
    family: 'credit',
    path: '/v1/credit/ccpi',
    historyPath: null,
    units: 'composite z-score',
    description:
      'Composite of TCI-z, SOPR-z and MVRV-z classifying the credit cycle phase. Combines the credit and on-chain layers.',
    live: true,
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
    live: true,
  },
  {
    id: 'vrb',
    name: 'Variable Rate Basis',
    family: 'credit',
    path: '/v1/credit/vrb',
    historyPath: '/v1/credit/vrb/history',
    units: 'spread (percentage points)',
    description:
      'The premium Gavel lenders earn over passive variable-rate DeFi lending: ' +
      'gavel_rate − max(USDC supply APY across Aave, Compound, Morpho) at matched tenor. ' +
      'The fixed-versus-variable lending premium. Uses supply APY, not borrow APY, because ' +
      'the lender\'s actual alternative is earning USDC supply yield.',
    live: true,
  },
  {
    id: 'lpi',
    name: 'Leverage Premium Index',
    family: 'credit',
    path: '/v1/credit/lpi',
    historyPath: '/v1/credit/lpi/history',
    units: 'spread (percentage points)',
    description:
      'The excess that leveraged perp exposure commands over Gavel fixed-term collateralised ' +
      'lending at matched duration: LPI = LCI − gavel_rate. Positive means leverage costs more ' +
      'than term borrowing; negative (INVERSION) means the derivatives market is bearish while ' +
      'the term credit market prices stability.',
    live: true,
  },
  {
    id: 'drp',
    name: 'DeFi Risk Premium',
    family: 'credit',
    path: '/v1/credit/drp',
    historyPath: '/v1/credit/drp/history',
    units: 'spread vs matched treasury (percentage points)',
    description:
      'The spread Gavel rates command over duration-matched US Treasury yields: ' +
      'DRP = gavel_rate − treasury_yield at the matched tenor. The institutional benchmark — ' +
      'what is earned in DeFi over the risk-free rate at similar maturity.',
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
  },
  {
    id: 'sdr',
    name: 'Stablecoin Dominance Ratio',
    family: 'credit',
    path: '/v1/credit/sdr',
    historyPath: '/v1/credit/sdr/history',
    units: 'percent',
    description: 'Stablecoin market cap as a share of total crypto market cap.',
    live: true,
  },
  {
    id: 'coc',
    name: 'Collateral Opportunity Cost',
    family: 'credit',
    path: '/v1/credit/coc',
    historyPath: '/v1/credit/coc/history',
    units: 'APR (%)',
    description:
      'The yield a Gavel borrower foregoes by locking WBTC as collateral instead of supplying it ' +
      'on Aave/Compound/Morpho: COC = max(WBTC supply APY across protocols). Makes the borrower\'s ' +
      'true all-in cost visible as gavel_rate + COC. Small today (0.004–0.05%) but material if ' +
      'BTC yield opportunities emerge.',
    live: true,
  },
  {
    id: 'gls',
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
    name: 'Stablecoin-Rate Correlation Signal',
    family: 'credit',
    path: '/v1/credit/srcs',
    historyPath: null,
    units: 'correlation / gap',
    description: 'Correlation between stablecoin liquidity and realised Gavel rates, with the implied liquidity gap.',
    live: true,
  },
  {
    id: 'ccs',
    name: 'CeFi Credit Spread',
    family: 'credit',
    path: '/v1/credit/ccs',
    historyPath: '/v1/credit/ccs/history',
    units: 'spread',
    description:
      'Gavel rates spread against CeFi posted rate cards. Note the CeFi inputs are administered (posted) rates, not cleared trades.',
    live: true,
  },
  {
    id: 'intermediation-spread',
    name: 'Intermediation Spread',
    family: 'credit',
    path: '/v1/credit/intermediation-spread',
    historyPath: '/v1/credit/intermediation-spread/history',
    units: 'spread',
    description: "The wedge between borrow and lend rates — Gavel's beside everyone else's.",
    live: true,
  },
  {
    id: 'capital-stack',
    name: 'Capital Stack',
    family: 'credit',
    path: '/v1/credit/capital-stack',
    historyPath: null,
    units: 'APR (%) by layer',
    description: 'The Bitcoin Credit Stack: risk-free, CeFi, DeFi and Gavel layers side by side at matched tenors.',
    live: true,
  },
  {
    id: 'benchmark-curves',
    name: 'Benchmark Curves',
    family: 'credit',
    path: '/v1/credit/benchmark-curves',
    historyPath: null,
    units: 'APR (%) by tenor',
    description: 'Reference curves (treasury and others) at matched tenors, for spreading Gavel against.',
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
      'Every credit-complex indicator in one response. Prefer this over N separate calls when building a dashboard view.',
    live: true,
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
    note: 'Derived from v2 protocol data, which is testnet-only until v2 reaches mainnet. Mainnet returns an explicit 404 rather than an empty series.',
  },
  {
    id: 'hrcs',
    name: 'Hash-Rate Credit Spread',
    family: 'credit',
    path: '/v1/credit/hrcs',
    historyPath: null,
    units: 'spread',
    description: 'Mining economics spread against the Gavel curve — miner breakeven price against the credit-implied collateral floor.',
    live: false,
    note:
      'Computed and stored, but not yet served: `compute-onchain.js` writes `hrcs_history` ' +
      'nightly on both networks. What is missing is the REST route, so the endpoint returns 404. ' +
      'This is a serving gap, not an unimplemented indicator.',
  },
  {
    id: 'rpid',
    name: 'Realised Price Implied Divergence',
    family: 'credit',
    path: '/v1/credit/rpid',
    historyPath: null,
    units: 'divergence',
    description: 'Divergence between the on-chain realised price and the credit-implied collateral floor.',
    live: false,
    note:
      'Computed and stored, but not yet served: `compute-onchain.js` writes `rpid_history` ' +
      'nightly on both networks. What is missing is the REST route, so the endpoint returns 404. ' +
      'This is a serving gap, not an unimplemented indicator.',
  },

  // ── Commodity on-chain — free permanently (D4) ────────────────────────────
  {
    id: 'onchain-latest',
    name: 'On-chain Indicators (latest)',
    family: 'onchain',
    path: '/v1/onchain/indicators/latest',
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
    path: '/v1/onchain/indicators/hodl-waves',
    historyPath: null,
    units: 'percent of supply by age band',
    description: 'UTXO supply distribution across twelve age bands, from under a day to over ten years.',
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
    description: 'Current borrow/supply rates at comparable DeFi venues.',
    live: true,
  },
  {
    id: 'rates-comparison',
    name: 'Rates Comparison',
    family: 'market',
    path: '/v1/market/rates/comparison',
    historyPath: '/v1/market/rates/comparison/history',
    units: 'APR (%)',
    description: 'Gavel rates beside CeFi and DeFi comparators at matched tenors.',
    live: true,
  },
  {
    id: 'stablecoins',
    name: 'Stablecoin Supply',
    family: 'market',
    path: '/v1/market/stablecoins/current',
    historyPath: '/v1/market/stablecoins/history',
    units: 'USD',
    description: 'Aggregate stablecoin supply, the liquidity backdrop for the lending side.',
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
    name: 'BTC Spot Price',
    family: 'market',
    path: '/v1/market/prices/btc',
    historyPath: '/v1/market/prices/btc/history',
    units: 'USD',
    description: 'Spot BTC price as used across the indicator set.',
    live: true,
  },
];

export function findIndicator(id: string): IndicatorSpec | undefined {
  const needle = id.trim().toLowerCase();
  return INDICATORS.find((i) => i.id === needle);
}

export const INDICATOR_IDS = INDICATORS.map((i) => i.id);
