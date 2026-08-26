import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerListOnchainTool } from './discovery/list-onchain.js';
import { registerYieldCurveTool } from './credit/yield-curve.js';
import { registerMvrvTool } from './onchain/mvrv.js';
import { registerProtocolReferenceTool } from './protocol/reference.js';
import { registerWalletStatusTool } from './protocol/wallet-status.js';
import { registerFindAuctionsTool } from './protocol/find-auctions.js';
import { registerOnrampsTool } from './onboarding/onramps.js';
import { registerListWalletsTool } from './onboarding/wallets.js';
import { registerIndicatorTools } from './indicators/indicators.js';
import { registerPositionTools } from './protocol/positions.js';
import { registerFactoryTools } from './factory/prepare.js';
import { registerETools } from './agent/e-tools.js';

/**
 * Registers every tool in the catalog. Discovery tools are registered first
 * so they appear early in the tools/list response — LLMs that scroll less
 * still see them.
 *
 * Phase 1 surface (Week 1):
 *   - list_onchain_indicators        (discovery)
 *   - get_yield_curve                (credit, live)
 *   - get_mvrv                       (on-chain, LIVE — corrected 2026-08-26)
 *   - get_protocol_reference         (protocol metadata: contracts, ABIs, conventions)
 *
 * Phase 1.5 read-tool family (this release — AI concierge layer):
 *   - check_wallet_status            (chain read: balances, allowances, readiness blockers)
 *   - find_auctions_matching_criteria (auction filter, user-supplied params, never ranks)
 *   - list_fiat_onramps              (fiat-to-USDC catalog filtered by country/amount;
 *                                     renamed from recommend_fiat_onramp 2026-08-26)
 *   - list_wallet_options            (compatible self-custody wallets)
 *
 * AF-T day 5 (2026-08-26) — the E-series, four of nine:
 *   - list_comparables               (E4 — nearest-k settled auctions)
 *   - get_address_history            (E6 — what an address did; supervisor data)
 *   - get_book                       (E9 — what is open right now)
 *   - get_verification_bundle        (E8 free form — contracts, promises, checks)
 *
 * R18 (this release):
 *   - list_gavel_indicators / get_gavel_indicator  (Phase 3, MD4 — the
 *     parameterised indicator pair; one pair, not ~24 tools)
 *   - get_user_positions / get_loan_status         (Phase 4 — Layer A
 *     completion; "did my bid win?", "has it been repaid?")
 *
 * Layer B (factory-model writes) is Phase 5. Per MD9 it ships to mainnet;
 * read MD10 and MD12 before touching it — the §12 phrasings and the
 * user-supplied parameter echo are build requirements, not commentary.
 */
export function registerAllTools(server: McpServer): void {
  // Discovery
  registerListOnchainTool(server);

  // Credit (live now)
  registerYieldCurveTool(server);

  // On-chain — LIVE. Reads mvrv from /v1/onchain/indicators/latest. The old
  // /v1/onchain/mvrv path never existed and every call 404'd; corrected 2026-08-26.
  registerMvrvTool(server);

  // Protocol metadata
  registerProtocolReferenceTool(server);

  // Phase 1.5 — concierge read tools
  registerWalletStatusTool(server);
  registerFindAuctionsTool(server);

  // Phase 1.5 — onboarding catalogs
  registerOnrampsTool(server);
  registerListWalletsTool(server);

  // R18 Phase 4 — position + loan lifecycle (Layer A completion)
  registerPositionTools(server);

  // R18 Phase 3 — the indicator & analytics surface
  registerIndicatorTools(server);

  // R18 Phase 5 — Layer B factory model. Aletheia builds, the user signs;
  // there is no signing surface in this process. See src/factory/envelope.ts.
  registerFactoryTools(server);

  // AF-T day 5 — the E-series decision endpoints. Four of the nine: the ones
  // that re-present chain state and are free by the founding rule. E1/E2/E3/E5
  // and E7 need thresholds and the delayed tier and are not exposed yet.
  registerETools(server);
}
