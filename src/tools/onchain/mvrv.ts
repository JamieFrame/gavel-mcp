import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';

/**
 * MVRV — market cap over realised cap.
 *
 * CORRECTED 2026-08-26. This tool previously called /v1/onchain/mvrv, which
 * has never existed on the API. Every call returned an upstream 404, so the
 * tool was advertised in tools/list and did not work.
 *
 * The indicator itself is live and always was: it is a field on
 * /v1/onchain/indicators/latest, computed nightly by bitcoin-indicators.js
 * from the UTXO set. This is the same defect commit bc1efc9 fixed for hrcs
 * and rpid — "the paths were wrong, not the indicators" — recurring on a
 * third tool. See data/specs/verification_promises_v1.md §4 in aletheia-docs
 * and the copy pack's §4.5 hand-off list.
 */

interface IndicatorsLatest {
  date?: string;
  mvrv?: string | number;
  mvrv_z_score?: string | number;
  market_cap_usd?: string | number;
  realised_cap_usd?: string | number;
  realised_price_usd?: string | number;
  spot_price_usd?: string | number;
  utxos_included?: string | number;
}

const num = (v: unknown): number | null =>
  v === undefined || v === null || v === '' ? null : Number(v);

export function registerMvrvTool(server: McpServer): void {
  server.registerTool(
    'get_mvrv',
    {
      title: 'Bitcoin MVRV Ratio',
      description:
        `Returns the current Bitcoin MVRV ratio: market capitalisation divided ` +
        `by realised capitalisation, where realised cap values each coin at the ` +
        `price it last moved.\n\n` +
        `MVRV is therefore an identity on observed chain data. It states the ` +
        `aggregate unrealised position of the supply — how far the market values ` +
        `coins above or below what was last paid for them — and nothing about ` +
        `what follows from that. This tool returns data; it does not advise, ` +
        `forecast, or characterise the market.\n\n` +
        `Computed nightly from Aletheia's own full node and UTXO set. ` +
        `'mvrv_z_score' is returned alongside it: the same numerator measured ` +
        `in standard deviations of the historical market-cap series.\n\n` +
        `Returns: { value, mvrv_z_score, as_of, inputs: { market_cap_usd, ` +
        `realised_cap_usd, realised_price_usd, spot_price_usd }, ` +
        `methodology, disclaimer }.`,
      inputSchema: {
        timestamp: z
          .string()
          .optional()
          .describe(
            `ISO 8601 date. Currently ignored: the upstream serves the latest ` +
              `computed row only. Historical MVRV is available through ` +
              `get_gavel_indicator with include_history.`
          ),
      },
    },
    async () => {
      requireTier('free');
      const data = await upstreamGet<IndicatorsLatest>('/v1/onchain/indicators/latest');

      const out = {
        value: num(data.mvrv),
        mvrv_z_score: num(data.mvrv_z_score),
        as_of: data.date ?? null,
        inputs: {
          market_cap_usd: num(data.market_cap_usd),
          realised_cap_usd: num(data.realised_cap_usd),
          realised_price_usd: num(data.realised_price_usd),
          spot_price_usd: num(data.spot_price_usd),
          utxos_included: num(data.utxos_included),
        },
        methodology:
          'market_cap_usd / realised_cap_usd. Realised cap values each UTXO at ' +
          'the spot price when it was created. Computed nightly from Aletheia’s ' +
          'own Bitcoin full node and UTXO set; no third-party data source.',
        disclaimer:
          'Informational. Aletheia Analytics SASU operates this interface and ' +
          'data product; the Gavel Protocol is autonomous, permissionless code ' +
          'with no operating entity. No guarantee of accuracy, and nothing here ' +
          'is a recommendation.',
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      };
    }
  );
}
