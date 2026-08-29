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
import { registerVenueTools } from './venues/venues.js';
import { registerMovedTools } from './moved.js';
import type { Profile } from '../profiles.js';

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
/**
 * OB1 — profile scoping.
 *
 * Every register* function below is written against the whole catalogue and does
 * not know which server it is running on. `scopeTo` wraps the McpServer so that
 * `registerTool` consults the profile's allowlist before anything is exposed,
 * and applies the profile's rename map.
 *
 * This is an ALLOWLIST and it is FAIL-CLOSED: a tool added to the catalogue
 * tomorrow is invisible on the observatory until someone adds its name to
 * src/profiles.ts. The denylist alternative fails the other way — a new
 * `prepare_*` tool would appear on the observatory the day it was written, and
 * OB1 §0.1 calls a write tool on the observatory a red finding.
 */
function scopeTo(server: McpServer, profile: Profile): McpServer {
  const allowed = new Set(profile.tools);
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: unknown, handler: unknown) => {
          if (!allowed.has(name)) return undefined;
          const exposedName = profile.renames[name] ?? name;
          return (target as unknown as {
            registerTool: (n: string, c: unknown, h: unknown) => unknown;
          }).registerTool(exposedName, config, handler);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function registerAllTools(server: McpServer, profile: Profile): void {
  const s = scopeTo(server, profile);

  // Discovery
  registerListOnchainTool(s);

  // Credit (live now) — both-split: identical payload on both servers.
  registerYieldCurveTool(s);

  // On-chain — LIVE. Reads mvrv from /v1/onchain/indicators/latest. The old
  // /v1/onchain/mvrv path never existed and every call 404'd; corrected 2026-08-26.
  registerMvrvTool(s);

  // Protocol metadata
  registerProtocolReferenceTool(s);

  // Phase 1.5 — concierge read tools
  registerWalletStatusTool(s);
  registerFindAuctionsTool(s);

  // Phase 1.5 — onboarding catalogs
  registerOnrampsTool(s);
  registerListWalletsTool(s);

  // R18 Phase 4 — position + loan lifecycle (Layer A completion)
  registerPositionTools(s);

  // R18 Phase 3 — the indicator & analytics surface
  registerIndicatorTools(s);

  // R18 Phase 5 — Layer B factory model. Aletheia builds, the user signs;
  // there is no signing surface in this process. See src/factory/envelope.ts.
  // The observatory allowlist contains none of these (OB1 §0.1).
  registerFactoryTools(s);

  // AF-T day 5 — the E-series decision endpoints.
  registerETools(s);

  // OB1 §1.3 — the observatory's venue registry + criteria payloads.
  registerVenueTools(s);

  // OB1 §1.5 — one release of `moved` shims for tools that left this server.
  // Registered on the UNSCOPED server: these names are deliberately absent from
  // the profile allowlist, which is the whole reason they need a shim.
  registerMovedTools(server, profile);
}
