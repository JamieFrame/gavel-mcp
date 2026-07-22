import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

interface MvrvResponse {
  value?: number;
  computed_at?: string;
  context?: Record<string, unknown>;
  data_maturity?: 'mature' | 'provisional' | 'degraded' | 'early';
  methodology?: string;
}

/**
 * Sample on-chain tool from Aletheia_MCP_Implementation_Spec_v1_0.md §6.
 *
 * The upstream endpoint /v1/onchain/mvrv is part of the
 * Aletheia_OnChain_API_Endpoint_Spec_v1_0.md surface and lights up when:
 *   1. The UTXO parser writes realized_cap into btc_network_metrics
 *   2. The onchain-routes module exposes /v1/onchain/mvrv from that table
 *
 * Until then this tool returns a structured McpError("not found") to the LLM
 * client, which is the correct user-facing behaviour and matches the spec's
 * "degraded" lifecycle stage.
 */
export function registerMvrvTool(server: McpServer): void {
  server.registerTool(
    'get_mvrv',
    {
      title: 'Bitcoin MVRV Ratio',
      description:
        `Returns the current Bitcoin MVRV (Market Cap / Realized Cap) ratio.\n\n` +
        `MVRV measures whether BTC market cap is high or low relative to the ` +
        `aggregate cost basis of all coins (Realized Cap). Values above 3.0 ` +
        `historically correspond to market tops; values below 1.0 correspond ` +
        `to capitulation phases. This is descriptive data; no recommendation ` +
        `is provided.\n\n` +
        `Returns: { value, computed_at, context: {...}, data_maturity: ` +
        `'mature'|'provisional'|'degraded', methodology }.`,
      inputSchema: {
        timestamp: z
          .string()
          .optional()
          .describe(`ISO 8601 timestamp; defaults to latest available value.`),
      },
    },
    async ({ timestamp }) => {
      requireTier('free');
      const data = await upstreamGet<MvrvResponse>('/v1/onchain/mvrv', { query: { timestamp } });
      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
