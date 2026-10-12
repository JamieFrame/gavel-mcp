// ============================================================================
// Cost classes — what each observatory tool costs to serve (MR1 §6, MR-D10).
//
// For the API and MCP monetisation runbook, which inherits this table and
// decides prices, tiers and gates; MR1 decides none of them (A1 Gate B; R18
// MD2: MCP_TIER_ENFORCEMENT and HISTORY_GATE_ENFORCED stay off). Each class
// has a budget for a call's DEFAULT answer (no optional argument), held by
// scripts/check-surface.mjs, so a default stays bounded (G0-9).
//
// One home: aletheia-docs runbooks/…/runbook_MR1_stack_mcp_refinement_v1.md
// §6 names the classes; this is the per-tool assignment.
// ============================================================================

export type CostClass = 'catalogue' | 'reading' | 'snapshot' | 'history';

export const CLASS_BUDGET_KB: Readonly<Record<CostClass, number>> = {
  catalogue: 64,   // a list of what exists
  reading: 64,     // one current figure or one row
  snapshot: 256,   // a whole surface on one date
  history: 512,    // a series over a range
};

/** Each observatory tool's class for its default call. as_known_on is a further class on any of them (§6). */
export const COST_CLASS: Readonly<Record<string, CostClass>> = {
  list_onchain_indicators: 'catalogue',
  list_chain_series: 'catalogue',
  list_series: 'catalogue',
  list_indicators: 'catalogue',
  list_venues: 'catalogue',
  get_lens: 'catalogue',
  get_guide: 'catalogue',
  get_mvrv: 'reading',
  get_indicator: 'reading',          // history with include_history
  get_venue: 'reading',              // snapshot with include
  get_verification_bundle: 'reading',
  get_credit_state: 'snapshot',
  compare_venues: 'snapshot',
  get_liquidation_map: 'snapshot',   // history with history: true
  get_cost_basis: 'snapshot',
  get_market_composition: 'snapshot',
  get_market_flows: 'snapshot',
  get_corporate_instruments: 'snapshot',
  get_desk_rates: 'snapshot',
  get_debt_by_collateral: 'snapshot',
  get_chain_series: 'history',
  get_series: 'history',
  get_credit_state_history: 'history',
};
