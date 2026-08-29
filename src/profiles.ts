/**
 * Server profiles — OB1.
 *
 * One codebase, two MCP services:
 *
 *   - `gavel`       — the Gavel Protocol's participation surface. Gavel-native
 *                     reads plus the unsigned `prepare_*` blueprints.
 *                     Served at https://mcp.thegavel.io/mcp.
 *   - `observatory` — The Bitcoin Credit Stack. Cross-venue credit data,
 *                     read-only, ZERO write tools. Interim host
 *                     https://data-mcp.thegavel.io/mcp.
 *
 * Runbook OB1 §0.1 is the hard constraint on the observatory: no write tools,
 * no blueprint tools, no `prepare_*`, and no tool that names Gavel outside its
 * uniform venue row. `tools` below is an ALLOWLIST and the registration path is
 * fail-closed (src/tools/index.ts): a tool added to the catalogue later is not
 * exposed on the observatory unless someone puts its name in this file. That is
 * deliberate — the failure mode of a denylist is a write tool appearing on the
 * observatory the day it is written, which OB1 §0.1 calls a red finding.
 *
 * OB1 §0.3 — one tool, one home. A name may appear in both lists only when the
 * disposition table records it as `both-split`, in which case both servers must
 * return an identical payload from the same backend (`split_payload_parity`).
 */

export type ProfileId = 'gavel' | 'observatory';

export interface Profile {
  readonly id: ProfileId;
  /** MCP `serverInfo.name`. */
  readonly serverName: string;
  readonly serverVersion: string;
  /** Structured-log `service` field. Distinct per profile so the AF-T
   *  `mcp_initialize` client counter is not shared between the two services. */
  readonly logService: string;
  /** Served as the `initialize` result's `instructions`. */
  readonly instructions: string;
  /** Allowlist of catalogue tool names this profile exposes. */
  readonly tools: readonly string[];
  /** Catalogue name -> exposed name. See OB1 disposition flag D-B. */
  readonly renames: Readonly<Record<string, string>>;
}

/**
 * OB1 §0.4 — the observatory's entity disclosure, verbatim. This sentence is
 * fixed by the runbook and is quoted unaltered by the copy pack's observatory
 * section, the OB2 site footer and every observatory payload's `links` block.
 * Edit it in the copy pack first; `listing_copy_drift` compares against that.
 */
export const OBSERVATORY_DISCLOSURE =
  'Operated by Aletheia Analytics SASU, which also created the Gavel Protocol ' +
  '(a venue covered by this data) and participates on it own-account.';

/**
 * OB3 §0.4 requires two canonical scope sentences — one per server — as the
 * vocabulary every downstream document quotes rather than paraphrases.
 */
export const SCOPE_SENTENCE_OBSERVATORY =
  'The Bitcoin Credit Stack MCP serves measurements of the Bitcoin-collateralised ' +
  'credit markets across every venue Aletheia covers; it is read-only and prepares ' +
  'no transactions.';

export const SCOPE_SENTENCE_GAVEL =
  "The Gavel MCP serves the Gavel Protocol's own data and unsigned transaction " +
  'blueprints for participating on it; it does not serve cross-venue credit data.';

/**
 * OB1 §1.4 — the only cross-pointer, and it points data-ward. A fact about
 * where data lives, not a referral into Gavel. Direction is load-bearing:
 * the observatory never points into any venue, Gavel included (OB1-D4), and
 * OB2 §0.5 budgets exactly one cross-link each way.
 */
export const OBSERVATORY_HOST = process.env.OBSERVATORY_MCP_URL
  ?? 'https://data-mcp.thegavel.io/mcp';

export const GAVEL_DATA_POINTER =
  `Cross-venue credit data is served by the Bitcoin Credit Stack MCP at ${OBSERVATORY_HOST}.`;

/**
 * Observatory `initialize` instructions.
 *
 * Four paragraphs, matching the Gavel block's shape: what this is, how to read
 * provenance, the no-advice/no-ranking rule, and the entity disclosure. The
 * final paragraph is OB1 §0.4 verbatim.
 *
 * Copy rules this text is written against:
 *   - observatory_positioning_v1 OP-D1: brand is "The Bitcoin Credit Stack".
 *     "Index" and "Benchmark" stay out of the brand (EU BMR posture).
 *   - venue_reliability_criteria_v1 §0.1 / VC-D2: no composite score, ever.
 *   - regulatory_positioning_v1_3_amendment §A4: no statement that anything is
 *     "safe", "verified safe" or "guaranteed" on any surface.
 *   - OB1 §0.1: Gavel is named here only in the §0.4 disclosure — no tool on
 *     this server names it outside its uniform venue row.
 *
 * Source of truth: aletheia-docs commercial/operational/agent_listing_copy_v1.md
 * §7 (the observatory section). `listing_copy_drift` compares against it.
 */
const OBSERVATORY_INSTRUCTIONS = [
  `This server exposes The Bitcoin Credit Stack: Aletheia Analytics' measurements`,
  `of the Bitcoin-collateralised credit markets — rate curves, chain indicators,`,
  `and a registry of credit venues categorised against published, versioned`,
  `criteria. Every tool here returns observed data. There are no transaction tools`,
  `on this server: nothing here signs, submits, broadcasts or prepares a`,
  `transaction, and no tool takes custody of funds or receives a mandate.`,
  ``,
  `Read the provenance fields before treating any figure as a market reference.`,
  `Each venue criterion carries the kind of source it came from, the source`,
  `itself and an as-of date; a criterion that cannot be established from public`,
  `sources is returned as unknown with the reason, never guessed and never`,
  `omitted. Where a figure would be degenerate on the observed data, the response`,
  `returns a structured absence naming the threshold and the observed count`,
  `rather than a zero.`,
  ``,
  `Nothing here is advice. There is no composite score, no ranking, no default`,
  `sort by rate and no safety verdict in any payload, and none will be added.`,
  `Tools that return catalogues do not rank their entries; tools that return`,
  `distributions report what was observed with the sample size, and do not`,
  `forecast a fill, a rate, a time-to-fill or a return. A reader weighs the`,
  `criteria; this server does not weigh them for the reader.`,
  ``,
  OBSERVATORY_DISCLOSURE,
].join('\n');

/** The Gavel server's instructions — unchanged from copy pack §2.2, plus the
 *  OB1 §1.4 data-ward pointer as its own final line. */
const GAVEL_INSTRUCTIONS_BASE = [
  `This server exposes Aletheia Analytics' data product for the Gavel Protocol: a`,
  `fixed-rate, fixed-term, oracle-free BTC-collateralised credit market on Arbitrum`,
  `One. Every tool here either returns observed data or returns an unsigned`,
  `transaction blueprint. Nothing on this server signs, submits or broadcasts a`,
  `transaction, and no tool takes custody of funds or receives a mandate — a`,
  `blueprint is calldata the caller's own wallet may choose to sign.`,
  ``,
  `Read the provenance fields before treating any rate as a market reference.`,
  `Gavel's mainnet book is small and currently predominantly own-account:`,
  `responses carry the observation count, the distinct-counterparty count, the`,
  `own-account share and a disclosure of whether the figure is yet an independent`,
  `market assessment. Where a figure would be degenerate on the current book, the`,
  `response returns a structured absence naming the threshold and the observed`,
  `count rather than a zero.`,
  ``,
  `Nothing here is advice. Tools that return catalogues do not rank their entries;`,
  `tools that return distributions report what was observed with the sample size,`,
  `and do not forecast a fill, a rate, a time-to-fill or a return.`,
  ``,
  `Aletheia Analytics SASU operates this interface and data product; the Gavel`,
  `Protocol is autonomous, permissionless code with no operating entity.`,
].join('\n');

/**
 * Tools the observatory exposes. OB1 §1.2 disposition table, DRAFT — this list
 * is not authoritative until the operator signs the table. Four rows carry an
 * open flag (D-A get_yield_curve, D-B the indicator pair's names, D-C
 * get_user_positions, D-D list_comparables); see the disposition table.
 */
const OBSERVATORY_TOOLS = [
  // Venue registry + criteria payloads (OB1 §1.3)
  'list_venues',
  'get_venue',
  'compare_venues',
  // Indicators — the Aletheia catalogue, renamed off the Gavel-bearing names
  'list_onchain_indicators',
  'get_mvrv',
  'list_gavel_indicators',
  'get_gavel_indicator',
  // both-split
  'get_yield_curve',
  'get_verification_bundle',
] as const;

/** Everything on the catalogue that is not observatory-only. */
const GAVEL_TOOLS = [
  'get_protocol_reference',
  'check_wallet_status',
  'find_auctions_matching_criteria',
  'list_fiat_onramps',
  'list_wallet_options',
  'get_user_positions',
  'get_loan_status',
  'list_comparables',
  'get_address_history',
  'get_book',
  'prepare_bid_calldata',
  'prepare_create_auction_calldata',
  'prepare_repay_loan_calldata',
  'prepare_claim_collateral_calldata',
  'prepare_claim_refund_calldata',
  // both-split
  'get_yield_curve',
  'get_verification_bundle',
] as const;

/** OB1 §0.3 — rows the disposition table records as `both-split`. Both servers
 *  must return an identical payload from the same backend. Any other name
 *  appearing in both allowlists is a `tool_home_unique` red. */
export const BOTH_SPLIT_TOOLS: readonly string[] = ['get_yield_curve', 'get_verification_bundle'];

/**
 * OB1 §1.5 — tools that were LIVE on mcp.thegavel.io before the split and have
 * moved to the observatory. Derived from the live `tools/list` of 2026-08-29
 * (21 tools), NOT from the observatory allowlist: `list_venues`, `get_venue`
 * and `compare_venues` are new on the observatory and were never addressable
 * here, so shimming them would advertise a history that does not exist — and
 * would put cross-venue tool names back on the Gavel server, which §0.2 exists
 * to prevent.
 *
 * These shims last one release. `moved_tool_error_rate` decays to zero, then
 * this list empties.
 */
export const MOVED_FROM_GAVEL: readonly string[] = [
  'list_onchain_indicators',
  'get_mvrv',
  'list_gavel_indicators',
  'get_gavel_indicator',
];

/**
 * Disposition flag D-B. OB1 §0.1 forbids "any tool that names Gavel outside its
 * uniform venue row"; `list_gavel_indicators` / `get_gavel_indicator` name it in
 * the tool name itself. On the observatory they are exposed under neutral names.
 * The handlers, upstream paths and payloads are untouched.
 */
const OBSERVATORY_RENAMES: Record<string, string> = {
  list_gavel_indicators: 'list_indicators',
  get_gavel_indicator: 'get_indicator',
};

export const PROFILES: Record<ProfileId, Profile> = {
  gavel: {
    id: 'gavel',
    serverName: 'aletheia-mcp',
    serverVersion: '0.4.0',
    logService: 'aletheia-mcp',
    instructions: `${GAVEL_INSTRUCTIONS_BASE}\n\n${GAVEL_DATA_POINTER}`,
    tools: GAVEL_TOOLS,
    renames: {},
  },
  observatory: {
    id: 'observatory',
    serverName: 'bitcoin-credit-stack-mcp',
    serverVersion: '0.1.0',
    logService: 'bitcoin-credit-stack-mcp',
    instructions: OBSERVATORY_INSTRUCTIONS,
    tools: OBSERVATORY_TOOLS,
    renames: OBSERVATORY_RENAMES,
  },
};

/** Resolve the active profile from MCP_PROFILE. Defaults to `gavel` so an
 *  existing deployment that has not set the variable is unchanged. */
export function activeProfile(): Profile {
  const raw = (process.env.MCP_PROFILE || 'gavel').trim() as ProfileId;
  const profile = PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MCP_PROFILE='${raw}' is not a known profile. Expected one of: ${Object.keys(PROFILES).join(', ')}.`
    );
  }
  return profile;
}
