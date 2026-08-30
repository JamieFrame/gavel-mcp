/**
 * OB4 §1.2 — the lens prompts. Observatory only (OB4-D1).
 *
 * A lens is a READ-ONLY PRESENTATION PROCEDURE. It selects tools and frames how
 * their output is presented. It never concludes, never ranks, and never carries
 * a write tool in scope — there are none on this server to carry.
 *
 * Every string here is public copy (OB4 §0.3) and is written against
 * `public_copy_editorial_guideline.md` v1.2: no "recommend", "should", "best",
 * "optimal", "maximise" or "safe". Every lens names what it does not do — that
 * section is not decoration, it is the part that stops a capable model filling
 * the gap with its own defaults.
 *
 * OB4-D8 fixed the set at five. `trader` was dropped at ratification: its
 * relative-value framing sits closest to what the guideline guards against, and
 * the constant-tenor cross-venue comparison it needs is the thinnest data the
 * estate holds — the lens most likely to produce confident output the dataset
 * cannot support.
 */

/** Carried verbatim by every lens. */
const DISCLOSURE = [
  'Before presenting anything from this dataset:',
  '',
  '- It is a record of what venues did or published, each cell with the source that establishes it and an as-of date. It is not advice, not a recommendation, and not an offer.',
  '- There is no composite score, no ranking and no default sort by rate, and none will be added. A reader weighs the criteria; this dataset does not weigh them for the reader.',
  '- `unknown` is a VALUE, not a gap to fill. It carries a reason, and the reason says whether the gap is this dataset\'s or the venue\'s. Do not substitute your own knowledge for an `unknown` — say what the dataset says.',
  '- Aletheia Analytics operates automated agents for its own account on one covered venue. That is disclosed on that venue\'s own row, in its `disclosure` field. Surface it whenever that row is presented.',
].join('\n');

const PROVENANCE = [
  'Render provenance with every figure: the as-of date, the observation count where one is given, and the source for any criterion cell. A figure without its provenance is a different claim from the one the dataset made.',
  'Where a response returns a structured absence — a threshold and an observed count rather than a value — present the absence and its reason. Do not compute around it.',
].join('\n');

export interface Lens {
  readonly id: string;
  readonly title: string;
  /** Shown in the client's prompt picker. */
  readonly description: string;
  /** Tools this lens may use. Observatory read tools only. */
  readonly tools: readonly string[];
  /** What the lens leads with. */
  readonly leadsWith: string;
  /** The section that stops a model filling gaps with its own defaults. */
  readonly doesNotDo: readonly string[];
}

export const LENSES: readonly Lens[] = [
  {
    id: 'orientation',
    title: 'Orientation — what this dataset is, and what it will not tell you',
    description:
      'Start here if you have not read this dataset before. What it measures, how to read its criteria and its absences, and the questions it deliberately does not answer.',
    tools: ['list_venues', 'list_indicators', 'get_credit_state'],
    leadsWith: [
      'Explain, before presenting any figures:',
      '',
      '- What the dataset covers: BTC-collateralised credit across the venues in the registry, described through three pillars — Price (what credit costs here, and whether the rate is discovered or set), Quality (what stands behind a position, and what can change under the reader), Composition (who and what makes up this market).',
      '- That the criteria are published and versioned BEFORE any venue is measured against them, and applied identically to every row. That is what makes the dataset citable by someone who does not trust its publisher.',
      '- How to read `unknown`: it is a value with a reason attached, and the reason distinguishes a gap in this dataset from something the venue does not publish. These are different facts and the dataset never conflates them.',
      '- That coverage is not uniform: `list_venues` reports per-pillar coverage and a criteria-complete count per venue. Read them before comparing two rows.',
      '',
      'Then, if asked, give the current cross-venue reading from `get_credit_state` with its coverage block.',
    ].join('\n'),
    doesNotDo: [
      'Does not rank venues, score them, or identify a "best" or "cheapest" one.',
      'Does not tell the reader what to do with the data.',
      'Does not fill an `unknown` from outside knowledge — if the dataset does not establish it, the answer is that it is not established here.',
    ],
  },
  {
    id: 'holder',
    title: 'Holder — the cost of credit against bitcoin you already hold',
    description:
      'For someone holding BTC who is reading the credit market: what borrowing against it costs across venues and tenors, and on what terms.',
    tools: ['get_credit_state', 'compare_venues', 'get_venue', 'list_venues'],
    leadsWith: [
      'Lead with the cost of credit and the terms attached to it:',
      '',
      '- The cross-venue reading from `get_credit_state`, with its coverage block — how many venues contribute, and which are named absent.',
      '- Where a comparison is asked for, use `compare_venues` and present the rows in the order returned. Each row carries its rate KIND (discovered, administered, fitted) and its basis; two rates of different kinds are not like-for-like and the labels are what say so.',
      '- The terms that travel with a rate, from `get_venue`: term certainty (fixed or open), rate certainty (fixed at origination or variable), liquidation mechanism, custody model, recourse. A rate without these is half the picture.',
      '',
      'Where the reader is weighing borrowing against selling, present the INPUTS the dataset holds — the cost of credit at the tenors it covers, the terms, the collateral treatment. Do not perform the comparison with assumed defaults for the things the dataset does not hold: their tax position, their view on price, their liquidity needs.',
    ].join('\n'),
    doesNotDo: [
      'Does not compute a borrow-versus-sell answer. The dataset holds one side of that comparison and none of the reader\'s circumstances.',
      'Does not forecast a rate, a fill, a time-to-fill or a return.',
      'Does not identify a cheapest venue. Rates of different kinds are not comparable without their labels, and the dataset publishes no ranking.',
    ],
  },
  {
    id: 'treasurer',
    title: 'Treasurer — tenor, maturity and counterparty structure',
    description:
      'For a business managing a runway against a bitcoin position: how credit is structured across tenors, and what the composition of each market looks like.',
    tools: ['get_credit_state', 'get_credit_state_history', 'get_market_composition', 'get_venue', 'compare_venues'],
    leadsWith: [
      'Lead with structure over level:',
      '',
      '- Tenor and maturity: which tenors are actually observed, and at what depth. ⚠ Where a tenor axis is a LOOKBACK WINDOW rather than a maturity, say so — the constituent positions are open-term and no borrower agreed a term. A reader who takes that axis for a term structure has misread it.',
      '- Composition, from `get_market_composition`: what makes up each market, and the concentration behind a figure.',
      '- Term and rate certainty per venue, which is what a ladder is actually built from.',
      '- History from `get_credit_state_history` where the question is about change over time rather than the current level.',
      '',
      'Present the coverage share alongside any aggregate. An aggregate over a partial market is a statement about the part observed.',
    ].join('\n'),
    doesNotDo: [
      'Does not build a ladder, size a position, or model a runway. It presents the structure the dataset observes.',
      'Does not treat a lookback window as a maturity, or aggregate across denominations — btc and usd books are different products and are never summed.',
      'Does not forecast rates at any tenor.',
    ],
  },
  {
    id: 'analyst',
    title: 'Analyst — methodology, provenance and coverage',
    description:
      'For a professional researching this market: how every figure is constructed, what its sources are, and where the dataset states its own limits.',
    tools: ['get_venue', 'list_venues', 'compare_venues', 'get_credit_state', 'get_credit_state_history', 'get_market_composition', 'get_market_flows', 'list_indicators', 'get_indicator', 'get_verification_bundle'],
    leadsWith: [
      'Lead with construction, not with the number:',
      '',
      '- For any figure: its as-of date, its observation count, its weighting where one applies, and the coverage it was computed over.',
      '- For any criterion cell: the source that establishes it, and its source kind. A value without a source is not a populated cell and the dataset serves it as null rather than as a value.',
      '- The coverage matrix: which venues contribute to a reading and which are named absent, with the reason. The absences are part of the finding.',
      '- The criteria spec version the cells were graded against, which travels in the payload.',
      '',
      PROVENANCE,
    ].join('\n'),
    doesNotDo: [
      'Does not present a figure without its provenance, and does not reconcile two figures the dataset publishes side by side with a coverage share between them.',
      'Does not construct a composite, an index or a score from the served series.',
      'Does not fill a gap in coverage with an estimate.',
    ],
  },
  {
    id: 'risk',
    title: 'Risk — what stands behind a position, and what can change under it',
    description:
      'Pillar II, read directly: oracle dependency, liquidation mechanism, custody model and recourse, per venue, each with its source.',
    tools: ['get_venue', 'list_venues', 'compare_venues'],
    leadsWith: [
      'Present the Quality pillar cell by cell, for the venues asked about:',
      '',
      '- **Oracle dependency** — none, single, multiple, TWAP. What the position depends on for a price.',
      '- **Liquidation mechanism** — none, threshold, progressive, discretionary. What can end the position other than the borrower.',
      '- **Custody model** — self-custody, protocol-custodial, third-party. Who can move the collateral.',
      '- **Recourse** — non-recourse, with recourse, partial. What is owed beyond the collateral.',
      '',
      'Give each cell WITH ITS SOURCE — the contract, filing or documentation that establishes it. Where a cell is `unknown`, present the reason and say whether the gap is this dataset\'s or something the venue does not publish. Those are different findings about a venue and the distinction is often the most useful thing on the row.',
      '',
      'These are structural properties, not outcomes. A venue with no liquidation mechanism has not been judged; it has been described.',
    ].join('\n'),
    doesNotDo: [
      'Does not say any venue is safe, safer, sound, risky or unsafe. It reports what a venue does structurally; the reader judges.',
      'Does not rank venues by risk, score them, or produce a risk rating — there is no such field and none will be added.',
      'Does not infer a missing cell from a venue\'s reputation, size or category. `unknown` stays unknown.',
      'Does not treat "no incident recorded" as "no incident occurred". Track record is what this dataset has observed, over the period it has observed it.',
    ],
  },
];

/** The full prompt text a client receives for a lens. */
export function renderLens(lens: Lens): string {
  return [
    DISCLOSURE,
    '',
    `## ${lens.title}`,
    '',
    lens.leadsWith,
    '',
    '## Tools in scope',
    '',
    lens.tools.map((t) => `- \`${t}\``).join('\n'),
    'Use only these. Every one is read-only; this server has no write tools and prepares no transactions.',
    '',
    '## What this lens does not do',
    '',
    lens.doesNotDo.map((d) => `- ${d}`).join('\n'),
    '',
    'If a tool named above is unavailable, say so and stop. Do not substitute another source.',
  ].join('\n');
}
