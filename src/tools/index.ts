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
import { registerSurfaceTools } from './venues/surface.js';
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
/**
 * OB4 §1.5 — a rename is not complete until the tool's SELF-DESCRIPTION is
 * renamed too.
 *
 * D-B renames `list_gavel_indicators` -> `list_indicators` on the observatory.
 * Until this function existed the rename was applied to the NAME only, so the
 * live observatory shipped a `list_indicators` whose description said *"then
 * call get_gavel_indicator with an id"* and a `get_indicator` whose `id`
 * parameter said *"Indicator id from list_gavel_indicators"* — both naming a
 * tool that does not exist on that server. A model reading the schema to build
 * its call was being instructed to make an invalid one.
 *
 * That is §1.5's asymmetry test failing one level below the lenses: a
 * presentation the server instructs which is not derivable from the tools in
 * its own scope. Fixing the two strings by hand would have fixed the instance;
 * rewriting through the rename map fixes the class, so the next rename cannot
 * reintroduce it.
 *
 * Only whole-word occurrences of a renamed name are rewritten, and only the
 * human-readable strings — never a value a caller passes back.
 */
function applyRenames(text: string, renames: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [from, to] of Object.entries(renames)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }
  return out;
}

/** Rewrite the description and every parameter description through the map. */
function renameInConfig(config: unknown, renames: Readonly<Record<string, string>>): unknown {
  if (!config || typeof config !== 'object' || !Object.keys(renames).length) return config;
  const c = { ...(config as Record<string, unknown>) };
  if (typeof c.description === 'string') c.description = applyRenames(c.description, renames);
  // Zod schemas carry their prose in `.description`; rebuild each field with the
  // renamed text rather than mutating the shared schema object, which other
  // profiles in the same process also register from.
  const schema = c.inputSchema;
  if (schema && typeof schema === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema as Record<string, unknown>)) {
      const f = field as { description?: string; describe?: (d: string) => unknown };
      next[key] =
        typeof f?.description === 'string' && typeof f.describe === 'function'
          ? f.describe(applyRenames(f.description, renames))
          : field;
    }
    c.inputSchema = next;
  }
  return c;
}

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
          }).registerTool(exposedName, renameInConfig(config, profile.renames), handler);
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

  // OB1 §1.2 — the cross-venue market surface. This is where a Stack reader
  // meets Gavel's rate: inside a reading computed over the venue universe,
  // not under a heading of its own (operator ruling D-A).
  registerSurfaceTools(s);

  // OB1 §1.5 — one release of `moved` shims for tools that left this server.
  // Registered on the UNSCOPED server: these names are deliberately absent from
  // the profile allowlist, which is the whole reason they need a shim.
  registerMovedTools(server, profile);
}
