// ============================================================================
// The Stack's standard questions (MR1 Phase 5; operator, Gate 5 2026-10-11).
//
// The one home is aletheia-docs data/specs/mcp/stack_questions_v1.md; this is the served copy of its
// rows, word for word. A change to a question is made there first and copied here in the same change.
// Served by get_guide (question), the stack://questions.json resource, one line in each tool's
// description, and the lenses; the harness runs every one (scripts/harness/calls.observatory.json).
// ============================================================================

export type StackQuestion = { id: string; group: string; question: string; tool: string; args: Record<string, unknown>; page: string; meaning: string; limits: string };

export const QUESTIONS: readonly StackQuestion[] = [
  {
    "id": "SQ-M1",
    "group": "Market",
    "question": "What are the market's six figures: bitcoin collateral, dollar debt, LTV, borrow and lend rates, and where it liquidates?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.market.collateral_btc",
        "credit.market.debt_usd",
        "credit.market.ltv",
        "credit.market.borrow_rate",
        "credit.market.lend_rate",
        "credit.market.liq_price_usd"
      ],
      "plan": false
    },
    "page": "/",
    "meaning": "The same six figures at every level of the credit tree, here the market: bitcoin posted as collateral, the dollar debt against it, the aggregate LTV, the borrow and lend rates (continuously compounded), and the price at which the book liquidates as one position. The last point of each series is today's reading; each point carries its kind and coverage.",
    "limits": "Coverage is the venues read on the day; a venue not read is absent, not zero. Rates are continuously compounded. Six units: read them as six series, not one chart (a chart takes two units)."
  },
  {
    "id": "SQ-M2",
    "group": "Market",
    "question": "How have the market's debt and collateral moved over time?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.market.debt_usd",
        "credit.market.collateral_btc"
      ],
      "from": "2022-09-19"
    },
    "page": "/explore?fig=debt&n=market:market",
    "meaning": "The market's dollar debt and bitcoin collateral through time, each point with its kind, on two panels (USD, BTC).",
    "limits": "Weekly rebuilt points before 2026-10-01, daily after; coverage widens over time (coverage steps), so a jump can be the data widening, not the market moving."
  },
  {
    "id": "SQ-M3",
    "group": "Market",
    "question": "At what bitcoin price would the market's debt be liquidated?",
    "tool": "get_liquidation_map",
    "args": {
      "level": "market"
    },
    "page": "/",
    "meaning": "How much bitcoin-secured dollar debt is liquidated at which bitcoin price, by bucket, at each venue's own mark.",
    "limits": "Venues whose positions are not read are named, not counted; each venue's own mark, not one market price."
  },
  {
    "id": "SQ-M4",
    "group": "Market",
    "question": "How much debt sits within 10, 20 or 30% of liquidation, and how has that moved?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.market.liq_within_10",
        "credit.market.liq_within_20",
        "credit.market.liq_within_30"
      ]
    },
    "page": "/explore?n=&s=credit.market.liq_within_10,credit.market.liq_within_20,credit.market.liq_within_30",
    "meaning": "Dollar debt within 10, 20 and 30% of its venue's own mark, through time.",
    "limits": "Kind partial where the map does not read every venue with debt; the map widens over time."
  },
  {
    "id": "SQ-M5",
    "group": "Market",
    "question": "How much debt is owed against each bitcoin wrapper?",
    "tool": "get_debt_by_collateral",
    "args": {
      "days": 30
    },
    "page": "/",
    "meaning": "The dollar debt against each bitcoin representation, by venue type, with each observer named and the collateral rule stated.",
    "limits": "A venue whose collateral cannot be split by wrapper is named under its own heading, not spread across wrappers."
  },
  {
    "id": "SQ-M6",
    "group": "Market",
    "question": "What did borrowing against bitcoin cost over each recent window, and what does it cost for each term agreed today, beside the Treasury?",
    "tool": "get_indicator",
    "args": {
      "id": "benchmark-curves"
    },
    "page": "/",
    "meaning": "The signed curve: realised rates by lookback window for each class, and contracted rates by maturity (Treasuries, the auction curve, posted cards), every point continuously compounded beside its quoted rate.",
    "limits": "A lookback window is an averaging window, not a maturity. The auction curve is fitted to one venue's book, which is predominantly own-account; beyond its longest observed tenor it is fitted, not observed. Posted cards are administered, not cleared."
  },
  {
    "id": "SQ-M7",
    "group": "Market",
    "question": "How did bitcoin-secured debt and collateral change week on week?",
    "tool": "get_indicator",
    "args": {
      "id": "credit-weekly-change"
    },
    "page": "/indicators/credit-weekly-change",
    "meaning": "The week-on-week change in debt and collateral across only the venues read on both dates, so venues entering the data do not move it.",
    "limits": "Matched venues only; a flagged venue's change is also shown left out."
  },
  {
    "id": "SQ-M8",
    "group": "Market",
    "question": "What has changed in bitcoin-secured credit recently: debt, collateral or rates moving past a published rule, levels crossed, company filings?",
    "tool": "get_events",
    "args": {},
    "page": "/activity",
    "meaning": "The credit-market events, newest first: each a dated sentence with its figures, the rule it met in words, and its source (the daily readings, or the filing and the sentence that holds the figure).",
    "limits": "A change caused by coverage or method is not an event and is not returned. Daily readings from 2026-10-02. Ether events are their own feed (collateral: 'eth'), never added to bitcoin's."
  },
  {
    "id": "SQ-C1",
    "group": "Class",
    "question": "How do the credit classes compare on dollar debt, and how has that moved?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.class.algorithmic.debt_usd",
        "credit.class.minted.debt_usd",
        "credit.class.auction.debt_usd",
        "credit.class.posted-card.debt_usd",
        "credit.class.corporate.debt_usd"
      ]
    },
    "page": "/classes",
    "meaning": "Each class's dollar debt (algorithmic, minted, auction, posted card, corporate) through time, on one panel. Any of the six figures reads the same way by its id (credit.class.<class>.<figure>, list_series).",
    "limits": "Corporate is corporate lending (no lien), shown as its own class. The auction class is one venue's book, predominantly own-account (the disclosure rides with it)."
  },
  {
    "id": "SQ-C2",
    "group": "Class",
    "question": "Which venues make up a class, and how do they compare at a term and LTV?",
    "tool": "compare_venues",
    "args": {
      "class": "algorithmic"
    },
    "page": "/classes/algorithmic",
    "meaning": "The class's venues side by side on the published criteria and their rates, in no ranked order.",
    "limits": "No composite score and no default sort by rate; a reader weighs the criteria."
  },
  {
    "id": "SQ-C3",
    "group": "Class",
    "question": "How has a class's debt moved over time?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.class.algorithmic.debt_usd",
        "credit.class.minted.debt_usd"
      ]
    },
    "page": "/explore?fig=debt&n=class:algorithmic,class:minted",
    "meaning": "Each class's dollar debt through time, on one panel.",
    "limits": "As SQ-M2: coverage steps mark the data widening."
  },
  {
    "id": "SQ-C4",
    "group": "Class",
    "question": "What do borrowers pay over what lenders earn, in each class?",
    "tool": "get_indicator",
    "args": {
      "id": "intermediation-spread"
    },
    "page": "/indicators/intermediation-spread",
    "meaning": "Borrow over lend rate per class, where both legs come from the same venues (pools; desks posting both).",
    "limits": "Not at market level, where the legs come from different classes; not for minted stablecoins (no lender) or the auction (one cleared rate)."
  },
  {
    "id": "SQ-V1",
    "group": "Venue",
    "question": "Which venues does the Stack cover?",
    "tool": "list_venues",
    "args": {},
    "page": "/venues",
    "meaning": "The registry of venues that take bitcoin as collateral, one compact row each: type, class, status, collateral and page.",
    "limits": "In no ranked order. detail: 'full' returns each row whole."
  },
  {
    "id": "SQ-V2",
    "group": "Venue",
    "question": "What is known about a venue, criterion by criterion?",
    "tool": "get_venue",
    "args": {
      "venue_id": "aave_v3_ethereum"
    },
    "page": "/venues/aave_v3_ethereum",
    "meaning": "The venue's criteria cells (price, quality, composition), each with its value, source and as-of date.",
    "limits": "'unknown' is a value with its reason, not an omission; there is no composite score."
  },
  {
    "id": "SQ-V3",
    "group": "Venue",
    "question": "What are a venue's headline figures, and where does it sit on the measured axes?",
    "tool": "get_venue",
    "args": {
      "venue_id": "aave_v3_ethereum",
      "include": [
        "headline",
        "axes"
      ]
    },
    "page": "/venues/aave_v3_ethereum",
    "meaning": "The venue's six figures as the headline reads them (with the read each one is from), and the same sixteen axes every venue is measured on, each from the read that can answer it or the reason it cannot.",
    "limits": "An axis a venue's reads cannot answer is absent with its reason. For about a minute after an API restart, the axes read is cold (25-30 s) and the call answers upstream_unavailable; it is cached and warmed after that."
  },
  {
    "id": "SQ-V4",
    "group": "Venue",
    "question": "How have a venue's debt and borrow rate moved over time?",
    "tool": "get_series",
    "args": {
      "ids": [
        "credit.venue.aave_v3_ethereum.debt_usd",
        "credit.venue.aave_v3_ethereum.borrow_rate"
      ]
    },
    "page": "/venues/aave_v3_ethereum",
    "meaning": "The venue's dollar debt and borrow rate through time, on two panels (USD; points, continuously compounded).",
    "limits": "From the venue's first read; a back-filled venue is marked by its kinds."
  },
  {
    "id": "SQ-V5",
    "group": "Venue",
    "question": "Which venues take ether as collateral?",
    "tool": "list_venues",
    "args": {
      "collateral": "eth"
    },
    "page": "/venues",
    "meaning": "The venues whose collateral set includes ether, measured as bitcoin is and never added to it.",
    "limits": "Ether figures are a separate book: never summed with bitcoin."
  },
  {
    "id": "SQ-V6",
    "group": "Venue",
    "question": "What rates do the custodial desks post?",
    "tool": "get_desk_rates",
    "args": {},
    "page": "/venues",
    "meaning": "Each desk's posted card: the representative APR and range, term, maximum LTV, custody and liquidation model, effective date and source.",
    "limits": "Administered, not cleared; a card older than the staleness bar is marked stale."
  },
  {
    "id": "SQ-I1",
    "group": "Indicator",
    "question": "Which indicators does the Stack publish?",
    "tool": "list_indicators",
    "args": {},
    "page": "/indicators",
    "meaning": "The catalogue: id, name, family, units and whether each is live; ids anchored on one venue's own rate are listed as served elsewhere.",
    "limits": "A catalogue, not a ranking."
  },
  {
    "id": "SQ-I2",
    "group": "Indicator",
    "question": "What do borrowers pay against bitcoin collateral across venues, over the 3-month Treasury bill?",
    "tool": "get_indicator",
    "args": {
      "id": "bsbs",
      "include_history": true,
      "from": "2026-01-01"
    },
    "page": "/indicators/bsbs",
    "meaning": "The Bitcoin-Secured Borrow Spread, chain-linked so venues entering the data do not move it, with the plain spread beside it.",
    "limits": "Includes Gavel, whose book is predominantly own-account (disclosed with the index). One credit cycle of history."
  },
  {
    "id": "SQ-I3",
    "group": "Indicator",
    "question": "How has the bitcoin posted as collateral moved as a share of all spendable bitcoin?",
    "tool": "get_indicator",
    "args": {
      "id": "bcsi",
      "include_history": true,
      "from": "2026-01-01"
    },
    "page": "/indicators/bcsi",
    "meaning": "The Bitcoin Collateral Share Index, chain-linked, with the plain share beside it.",
    "limits": "As SQ-I2."
  },
  {
    "id": "SQ-I4",
    "group": "Indicator",
    "question": "For each bitcoin wrapper, how much bitcoin is held at the addresses its issuer publishes, over the token's supply?",
    "tool": "get_indicator",
    "args": {
      "id": "wrc",
      "include_history": true,
      "wrapper": "wbtc"
    },
    "page": "/indicators/wrc",
    "meaning": "Wrapper Reserve Coverage, one wrapper at a time, read on Aletheia's own node; never combined across wrappers.",
    "limits": "Only wrappers whose issuers publish a usable address list are members; the others are named with the reason. A verification series, not a rating."
  },
  {
    "id": "SQ-I5",
    "group": "Indicator",
    "question": "What did a published figure read on the day it was published?",
    "tool": "get_indicator",
    "args": {
      "id": "bsbs",
      "as_known_on": "2026-10-09"
    },
    "page": "/indicators/bsbs",
    "meaning": "The indicator as the vintage store held it at the end of that day (UTC), so a figure quoted then can be reproduced.",
    "limits": "Only indicators kept by vintage (list_indicators marks them); before a dataset's first vintage, the answer is the baseline and says so."
  },
  {
    "id": "SQ-I6",
    "group": "Indicator",
    "question": "What share of all spendable bitcoin is posted as collateral, for the market, each class and the fixed 2022 panel?",
    "tool": "get_indicator",
    "args": {
      "id": "collateral-share"
    },
    "page": "/indicators/collateral-share",
    "meaning": "Bitcoin posted as collateral against lien-backed debt over spendable supply, per scope.",
    "limits": "Lien-backed collateral only; corporate holdings are holdings-share."
  },
  {
    "id": "SQ-I7",
    "group": "Indicator",
    "question": "What do borrowers pay over the 3-month bill, class by class?",
    "tool": "get_indicator",
    "args": {
      "id": "borrow-spread",
      "include_history": true,
      "series": "cx.class.algorithmic.borrow_spread_over_ust_3m",
      "from": "2026-01-01"
    },
    "page": "/indicators/borrow-spread",
    "meaning": "The borrow spread over the 3-month bill for one class (a measure's sub-series).",
    "limits": "As read on each date, coverage steps included; not chain-linked (that is bsbs)."
  },
  {
    "id": "SQ-Ch1",
    "group": "Chain",
    "question": "What can I chart from Aletheia's own node?",
    "tool": "list_series",
    "args": {
      "group": "Holders and spending",
      "limit": 50
    },
    "page": "/explore",
    "meaning": "The chain series built from every block on Aletheia's node: supply by age, holders, spending, realised value, MVRV, SOPR and more, each with unit, span and licence.",
    "limits": "Values priced before 2020-07-13 rest on CoinGecko's daily price: free, attributed use only."
  },
  {
    "id": "SQ-Ch2",
    "group": "Chain",
    "question": "What is bitcoin's MVRV now?",
    "tool": "get_mvrv",
    "args": {},
    "page": "/indicators/onchain-latest",
    "meaning": "Market value over realised value, from the latest reading.",
    "limits": "Rests on a third-party price for the market value."
  },
  {
    "id": "SQ-Ch3",
    "group": "Chain",
    "question": "How much bitcoin last moved at a price within 10, 20 or 30% below the market mark, where the liquidation bands sit?",
    "tool": "get_indicator",
    "args": {
      "id": "costbasis-near-liquidation"
    },
    "page": "/indicators/costbasis-near-liquidation",
    "meaning": "Supply whose cost basis lies in the liquidation bands, beside the debt the map places there.",
    "limits": "The mark is a debt-weighted mean of the venues' own marks, not a price any venue liquidates against. Partly priced from CoinGecko before 2020-07-13."
  },
  {
    "id": "SQ-Ch4",
    "group": "Chain",
    "question": "How is bitcoin's supply spread by the price each coin was created at, on a given day?",
    "tool": "get_cost_basis",
    "args": {
      "date": "2026-10-01"
    },
    "page": "/indicators/cost-basis",
    "meaning": "Supply alive at the end of the day, in price buckets, from Aletheia's node.",
    "limits": "Complete days only; coins before 2010-07-17 have no price and form one bucket at 0."
  },
  {
    "id": "SQ-Ch5",
    "group": "Chain",
    "question": "What did the network pay its miners, as a share of supply?",
    "tool": "get_indicator",
    "args": {
      "id": "miner-revenue-share"
    },
    "page": "/indicators/miner-revenue-share",
    "meaning": "Subsidy plus fees each day, annualised, over spendable supply. Price-free.",
    "limits": "Shown beside the borrow rate, never subtracted from it."
  },
  {
    "id": "SQ-Co1",
    "group": "Corporate",
    "question": "Which corporate instruments are in the registry, and what does a holder receive?",
    "tool": "get_corporate_instruments",
    "args": {},
    "page": "/instruments",
    "meaning": "Each listed instrument of the corporate issuers: terms, seniority, the yield where a last regular-session trade prices it, returns, and the issuer's bitcoin holdings.",
    "limits": "Corporate lending, not bitcoin-backed credit: no lien. Income is what the terms accrue, not what was confirmed paid."
  },
  {
    "id": "SQ-Co2",
    "group": "Corporate",
    "question": "What share of all spendable bitcoin do the issuers in the registry hold?",
    "tool": "get_indicator",
    "args": {
      "id": "holdings-share"
    },
    "page": "/indicators/holdings-share",
    "meaning": "The issuers' bitcoin, from their filings, over spendable supply.",
    "limits": "Holdings, not collateral: there is no lien."
  },
  {
    "id": "SQ-S1",
    "group": "Scope and method",
    "question": "What does this server cover?",
    "tool": "get_guide",
    "args": {},
    "page": "/data",
    "meaning": "The scope as served, every count read from the data when asked, each with what it counts.",
    "limits": "Counts move as the registry and the store grow."
  },
  {
    "id": "SQ-S2",
    "group": "Scope and method",
    "question": "How should I read these figures for a given purpose?",
    "tool": "get_lens",
    "args": {
      "lens": "orientation"
    },
    "page": "/methodology",
    "meaning": "A reading procedure (orientation, holder, treasurer, analyst, risk): which tools to call and how to present what they return.",
    "limits": "Guidance for presentation; it adds no figures."
  },
  {
    "id": "SQ-S3",
    "group": "Scope and method",
    "question": "How do I chart two series together the way the site does?",
    "tool": "get_series",
    "args": {
      "ids": [
        "cx.index.bsbs",
        "cx.market.secured.borrow_spread_over_ust_3m"
      ],
      "plan": "only"
    },
    "page": "/explore?n=&s=cx.index.bsbs,cx.market.secured.borrow_spread_over_ust_3m",
    "meaning": "The chart plan: panels by unit (two at most), the refusals with their reasons, a text alternative, and the /explore link that draws the same chart.",
    "limits": "Ether and bitcoin are never drawn on one chart; a third unit is refused."
  },
  {
    "id": "SQ-S4",
    "group": "Scope and method",
    "question": "Which series does the Stack hold for ether collateral?",
    "tool": "list_series",
    "args": {
      "collateral": "eth",
      "prefix": "credit.market.",
      "limit": 50
    },
    "page": "/explore",
    "meaning": "The ether book's series, measured as bitcoin's are, at each contract rate.",
    "limits": "Never added to bitcoin; the explorer draws bitcoin only."
  },
  {
    "id": "SQ-S5",
    "group": "Scope and method",
    "question": "Why does a figure read as absent?",
    "tool": "get_guide",
    "args": {},
    "page": "/methodology",
    "meaning": "Every absence carries its kind (not_read, not_applicable, below_floor, …) and a reason; the guide lists the vocabulary.",
    "limits": "An absence is never a zero."
  }
] as const;

export const SPEC_URL = 'https://github.com/JamieFrame/aletheia-docs/blob/main/data/specs/mcp/stack_questions_v1.md';
export const SITE = 'https://www.bitcoincreditstack.com';

/** The ids a tool answers, in list order. */
export function questionsForTool(tool: string): string[] {
  return QUESTIONS.filter((q) => q.tool === tool).map((q) => q.id);
}

/** The compact index: one row per question. */
export function questionIndex() {
  return QUESTIONS.map((q) => ({ id: q.id, group: q.group, question: q.question, tool: q.tool }));
}

/** A question whole, by id; or the questions a few words match (every word found), by lookup, never by guess. */
export function findQuestions(asked: string): { exact?: StackQuestion; matches: StackQuestion[] } {
  const t = asked.trim();
  const exact = QUESTIONS.find((q) => q.id.toLowerCase() === t.toLowerCase());
  if (exact) return { exact, matches: [exact] };
  const words = t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return { matches: [] };
  const hay = (q: StackQuestion) => `${q.question} ${q.meaning} ${q.group}`.toLowerCase();
  return { matches: QUESTIONS.filter((q) => words.every((w) => hay(q).includes(w))) };
}

/** Which questions each lens's reading procedure uses (cited by id, never repeated). */
export const LENS_QUESTIONS: Readonly<Record<string, readonly string[]>> = {
  orientation: ['SQ-S1', 'SQ-M1', 'SQ-V1', 'SQ-I1', 'SQ-S5'],
  holder: ['SQ-M3', 'SQ-M4', 'SQ-Ch3', 'SQ-I4', 'SQ-Ch2'],
  treasurer: ['SQ-M6', 'SQ-V6', 'SQ-Co1', 'SQ-I2', 'SQ-C2'],
  analyst: ['SQ-M2', 'SQ-C1', 'SQ-I5', 'SQ-S3', 'SQ-I6'],
  risk: ['SQ-M3', 'SQ-M4', 'SQ-M5', 'SQ-Ch3', 'SQ-V3'],
};
