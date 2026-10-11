import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireTier } from '../../tiers.js';
import { activeProfile } from '../../profiles.js';

// Catalog of on-chain indicator tools. Hand-maintained for now; in v1.1 this
// can be auto-generated from a tool registry. The point of the discovery
// tool is to give LLMs a single call they can make to learn the surface.
const ONCHAIN_CATALOG = [
  {
    tool: 'get_mvrv',
    indicator: 'MVRV',
    description: 'Market cap / Realized cap ratio. Cycle-position indicator.',
    units: 'ratio',
    example: 'get_mvrv()',
    // MR1 H-02: live since 2026-08-26 (computed nightly from Aletheia's own node).
    status: 'live',
  },
];

// The chain-series tools live on the observatory only (OC1 Phase 4), so only it lists them.
const OBSERVATORY_ONLY = [
  {
    tool: 'list_chain_series',
    indicator: 'Chain, miner and price series (catalogue)',
    description: 'Every series in the vintage store: supply by age, realised value, MVRV, SOPR, miner revenue, price fixings.',
    units: 'per series',
    example: 'list_chain_series()',
    status: 'live',
  },
  {
    tool: 'get_chain_series',
    indicator: 'One chain series through time',
    description: 'Any series from list_chain_series by id, from 2009 where the chain allows, readable as known on a past date.',
    units: 'per series',
    example: "get_chain_series({ id: 'chain.cohort.mvrv', from: '2026-01-01' })",
    status: 'live',
  },
  {
    tool: 'get_cost_basis',
    indicator: 'Supply by cost basis',
    description: "Bitcoin's supply on one day, grouped by the price at which each coin was created.",
    units: 'BTC per price bucket',
    example: "get_cost_basis({ date: '2026-10-01' })",
    status: 'live',
  },
];

export function registerListOnchainTool(server: McpServer): void {
  server.registerTool(
    'list_onchain_indicators',
    {
      title: 'List On-chain Indicators',
      description:
        `Returns the catalog of available on-chain indicator tools, including ` +
        `tool name, indicator name, brief description, units, an example ` +
        `invocation, and current readiness status ('live' or 'pending'). Use ` +
        `this when you need to discover which tools are available for ` +
        `on-chain analysis without inspecting every tool definition.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      return {
        content: [{ type: 'text', text: JSON.stringify({ tools: activeProfile().id === 'observatory' ? [...ONCHAIN_CATALOG, ...OBSERVATORY_ONLY] : ONCHAIN_CATALOG }, null, 2) }],
      };
    }
  );
}
