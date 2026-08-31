/**
 * Server profiles — OB1.
 *
 * One codebase, two MCP services:
 *
 *   - `gavel`       — the Gavel Protocol's participation surface. Gavel-native
 *                     reads plus the unsigned `prepare_*` blueprints.
 *                     Served at https://mcp.thegavel.io/mcp.
 *   - `observatory` — The Bitcoin Credit Stack. Cross-venue credit data,
 *                     read-only, ZERO write tools.
 *                     https://mcp.bitcoincreditstack.com/mcp.
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

export type ProfileId = 'gavel-presplit' | 'gavel' | 'observatory';

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
 * OB1 §0.4's global disclosure is REMOVED. Operator decision 2026-08-29,
 * amending §0.4.
 *
 * It said Aletheia Analytics "created the Gavel Protocol". That is factually
 * wrong and contradicted our own entity map: the Protocol was authored by Jamie
 * Frame personally under MIT (Layer 1); Aletheia is the commercial operator
 * (Layer 3). A disclosure carrying a false attribution is worse than none.
 *
 * The true half — that Aletheia holds own-account positions on Gavel — is not a
 * property of THIS DATASET, it is a property of ONE VENUE IN IT. Aletheia could
 * hold positions on any covered venue; a banner naming Gavel on every page
 * implies a relationship the data does not support, and would have to be
 * restated the day a second venue applied.
 *
 * So it lives where the criteria spec already put it: Pillar III's "own-account
 * share where applicable", carried in the registry's per-venue `disclosure`
 * column and travelling with that venue's row wherever the row is published.
 * The Gavel row has carried exactly that text since before this change; it is
 * passed through untouched by get_venue and rendered on the venue page.
 */

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
  ?? 'https://mcp.bitcoincreditstack.com/mcp';

/**
 * OB4-D10 — the observatory's ONE pointer back at the Gavel property, and it
 * exists for a single purpose: telling a caller where a venue-anchored
 * indicator went.
 *
 * ⚠ This is a genuine exception to OB1-D4 ("the observatory never points into
 * any venue, Gavel included") and it is narrower than it looks. D4 forbids
 * REFERRING a reader to a venue — routing them toward participation. This
 * points only in response to a caller who named a moved id, and it names where
 * that id is served. A `moved` error is not a referral: the alternative is
 * answering "unknown indicator", which would be false, since the indicator
 * exists and is computed nightly.
 *
 * It appears in no catalogue, no tool description and no unsolicited payload —
 * only in the error returned to someone who asked for the moved thing by name.
 */
export const GAVEL_MCP_HOST = process.env.GAVEL_MCP_URL ?? 'https://mcp.thegavel.io/mcp';

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
  `Where the operator holds a position at a venue, that is disclosed on that`,
  `venue's own row rather than as a statement about this dataset — read the`,
  `venue's disclosure field.`,
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
 * open flag (D-B the indicator pair's names, D-C get_user_positions, D-D
 * list_comparables); see the disposition table.
 *
 * D-A RULED 2026-08-29 by the operator: `get_yield_curve` is GAVEL-ONLY. It
 * returns one venue's own fitted curve under its own name, which is a surface
 * no other venue gets — the gate's "Gavel-special" fail condition on the
 * plainest reading. Gavel's rate reaches a Stack reader the same way every
 * other venue's does: as a row in compare_venues / get_venue, and inside the
 * cross-venue market surface. Gavel-specific curve data belongs on the Gavel
 * property, not here.
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
  // The cross-venue market surface — the Stack's own data (§1.2 "surface,
  // analytics"). Every venue reaches a reader through these and through the
  // venue tools above; none of them privileges one venue's own figures.
  'get_credit_state',
  'get_credit_state_history',
  'get_market_composition',
  'get_market_flows',
  // OB4 — the lens layer, served as a tool because no client surfaces MCP
  // prompts. Observatory only: the lenses are this property's reading
  // discipline, and OB4-D1 keeps them off the participation server.
  'get_lens',
  // both-split
  'get_verification_bundle',
] as const;

/** Everything on the catalogue that is not observatory-only. */
const GAVEL_TOOLS = [
  // OB4-D10 — the indicator pair, serving this property's own anchored set.
  'list_gavel_indicators',
  'get_gavel_indicator',
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
export const BOTH_SPLIT_TOOLS: readonly string[] = ['get_verification_bundle'];

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
  // ⚠ `list_gavel_indicators` / `get_gavel_indicator` were shimmed away here at
  // OB1 and are RESTORED at OB4-D10. The catalogue they serve is now split by
  // property: the Gavel server serves the 10 indicators anchored on its own
  // rate, the observatory serves the 23 that are venue-independent. A tool
  // named for Gavel, serving Gavel's own indicators, from the Gavel server is
  // the correct home — OB1 moved the pair because its catalogue was
  // cross-venue, and half of it no longer is.
  //
  // Leaving them shimmed produced a loop: the observatory pointed here for an
  // anchored id and this server pointed straight back.
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
  /**
   * The surface mcp.thegavel.io serves TODAY: all 21 tools, no renames, no
   * `moved` shims, no data-ward pointer, version 0.3.0.
   *
   * This profile exists so that MERGING OB1 CANNOT CUT OVER. The service takes
   * no MCP_PROFILE, `dist/` is built from the working tree, and Restart=always
   * means a reboot is a deploy — so if the default were the post-split surface,
   * the split would ship the first time anything restarted the process, with no
   * one deciding to. The disposition table is unsigned; cutover is not ours to
   * trigger by merging.
   *
   * Cutover is then one line: MCP_PROFILE=gavel in /root/gavel-mcp/.env, and a
   * restart. Reversible the same way.
   */
  'gavel-presplit': {
    id: 'gavel-presplit',
    serverName: 'aletheia-mcp',
    serverVersion: '0.3.0',
    logService: 'aletheia-mcp',
    instructions: GAVEL_INSTRUCTIONS_BASE,
    tools: [...GAVEL_TOOLS, ...MOVED_FROM_GAVEL],
    renames: {},
  },
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

/**
 * Resolve the active profile from MCP_PROFILE.
 *
 * Defaults to `gavel-presplit` — the surface that is live today. An unset
 * variable must mean "nothing changes", never "cut over": the deployment builds
 * from a working tree and restarts on its own, so a default that changed the
 * public tool surface would ship the split without a decision behind it.
 */
export function activeProfile(): Profile {
  const raw = (process.env.MCP_PROFILE || 'gavel-presplit').trim() as ProfileId;
  const profile = PROFILES[raw];
  if (!profile) {
    throw new Error(
      `MCP_PROFILE='${raw}' is not a known profile. Expected one of: ${Object.keys(PROFILES).join(', ')}.`
    );
  }
  return profile;
}
