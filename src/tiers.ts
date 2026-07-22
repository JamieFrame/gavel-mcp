import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getContext } from './context.js';

/**
 * Aletheia data product access tiers. Sequence is significant — each tier
 * implies access to everything at lower indices.
 *
 *  - anonymous    no auth; rate-limited; on-chain commodity data only
 *  - developer    cheapest paid tier; credit data, basic history depth
 *  - professional larger history depth, real-time feeds, API streaming
 *  - enterprise   custom limits, raw exports, multi-instance
 *
 * Phase 1 ships with anonymous + developer only (developer = any valid bearer).
 * professional + enterprise live in the enum so tools can declare their
 * required tier today; real per-key tier resolution lands in a later phase.
 */
export const TIERS = ['anonymous', 'developer', 'professional', 'enterprise'] as const;
export type Tier = typeof TIERS[number];

const TIER_RANK: Record<Tier, number> = {
  anonymous: 0,
  developer: 1,
  professional: 2,
  enterprise: 3,
};

/**
 * Throws an MCP protocol error if the current request's tier does not satisfy
 * the minimum required tier. Tools declare their required tier as the first
 * line of their handler body:
 *
 *     async (args) => {
 *       requireTier('developer');
 *       // ... rest of handler ...
 *     }
 */
export function requireTier(minimumTier: Tier): void {
  const { tier } = getContext();
  if (TIER_RANK[tier] < TIER_RANK[minimumTier]) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Tier '${minimumTier}' required; current tier is '${tier}'. ` +
        `Acquire an API key at https://www.thegavel.io/pricing and pass it ` +
        `as 'Authorization: Bearer <key>' on the HTTP request to mcp.thegavel.io.`
    );
  }
}

/**
 * Resolves a bearer token to a tier. In Phase 1 the rule is:
 *   - no token         → anonymous
 *   - any token        → developer
 *
 * Real per-key validation against the api_keys table lands in Phase 1.5,
 * either via a small upstream endpoint on api.thegavel.io or a direct
 * shared-secret-protected DB lookup.
 */
export function tierFromBearerToken(token: string | null): Tier {
  if (!token) return 'anonymous';
  // Phase 1 MVP: any non-empty token grants developer-tier access.
  // TODO(Phase 1.5): validate against api_keys, derive actual tier.
  return 'developer';
}
