import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireTier } from '../../tiers.js';

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
    status: 'pending',
    notes: 'Live once UTXO parser populates btc_network_metrics.realized_cap.',
  },
  // Add additional on-chain tools here as they ship in Week 2.
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
        content: [{ type: 'text', text: JSON.stringify({ tools: ONCHAIN_CATALOG }, null, 2) }],
      };
    }
  );
}
