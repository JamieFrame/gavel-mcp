import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { INDICATORS, INDICATOR_IDS, findIndicator } from './catalogue.js';

// R18 Phase 3 (MD4) — the parameterised indicator pair.
//
// Tiering note (MD3): both tools are `free`. The shorthand "the data and
// indicators become the paid tier" is NOT the settled partition — D1 holds
// that anything visible on-chain is freely presented, D4 that commodity
// on-chain indicators stay free permanently, and the CURRENT value of a
// Gavel-derived assessment is free because a bidder prices against it and a
// benchmark nobody can see is not a benchmark. History is free too: D9 (A2b)
// retired the 30-day cap on REST, and the MCP must not reintroduce a fence the
// surface it mirrors has abandoned. The paid boundary is BULK DELIVERY, which
// this pair does not offer.

export function registerIndicatorTools(server: McpServer): void {
  server.registerTool(
    'list_gavel_indicators',
    {
      title: 'Gavel Indicator Catalogue',
      description:
        `Returns the catalogue of Aletheia indicators computed from The Gavel ` +
        `Protocol and the Bitcoin chain: id, name, family, units, description, ` +
        `and whether the indicator is currently live on this network.\n\n` +
        `Three families: 'credit' (Gavel-derived assessments — the yield curve ` +
        `and the Bitcoin Credit Complex), 'onchain' (commodity chain metrics ` +
        `such as MVRV and SOPR), and 'market' (external context — DeFi rates, ` +
        `stablecoin supply, macro).\n\n` +
        `Use this to discover what is available, then call get_gavel_indicator ` +
        `with an id. This tool returns a catalogue; it does not rank indicators ` +
        `or advise which to use.`,
      inputSchema: {
        family: z
          .enum(['credit', 'onchain', 'market'])
          .optional()
          .describe(`Restrict to one family. Omit to return the whole catalogue.`),
        live_only: z
          .boolean()
          .default(false)
          .describe(`If true, omit indicators that are not currently live on this network.`),
      },
    },
    async ({ family, live_only }) => {
      requireTier('free');

      const matches = INDICATORS.filter(
        (i) => (!family || i.family === family) && (!live_only || i.live)
      );

      const shaped = {
        indicators: matches.map((i) => ({
          id: i.id,
          name: i.name,
          family: i.family,
          units: i.units,
          description: i.description,
          live: i.live,
          has_history: i.historyPath !== null,
          ...(i.note ? { note: i.note } : {}),
        })),
        count: matches.length,
        total_in_catalogue: INDICATORS.length,
        filter_echo: { family: family ?? null, live_only },
        notes:
          'An indicator marked live:false returns an explicit error rather than a fabricated or empty reading. ' +
          'Access to current values and history is free and open.',
      };

      return { content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }] };
    }
  );

  server.registerTool(
    'get_gavel_indicator',
    {
      title: 'Get a Gavel Indicator',
      description:
        `Returns the current value of a single Aletheia indicator by id, with ` +
        `its methodology reference. Call list_gavel_indicators first to ` +
        `discover valid ids.\n\n` +
        `Optionally returns the historical series instead of the current value ` +
        `(set include_history). History is free and unmetered on the same ` +
        `terms as the current value.\n\n` +
        `This is descriptive data; no recommendation is provided. An indicator ` +
        `that has no reading on this network says so explicitly rather than ` +
        `returning a null or a zero that could be mistaken for a value.`,
      inputSchema: {
        id: z
          .string()
          .describe(`Indicator id from list_gavel_indicators, e.g. 'tci', 'ccpi', 'yield-curve', 'onchain-latest'.`),
        include_history: z
          .boolean()
          .default(false)
          .describe(`If true, return the historical series instead of the current value. Not every indicator has one.`),
        from: z
          .string()
          .optional()
          .describe(`History start, ISO 8601 date. Only meaningful with include_history.`),
        to: z
          .string()
          .optional()
          .describe(`History end, ISO 8601 date. Only meaningful with include_history.`),
      },
    },
    async ({ id, include_history, from, to }) => {
      requireTier('free');

      const spec = findIndicator(id);
      if (!spec) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown indicator id '${id}'. Valid ids: ${INDICATOR_IDS.join(', ')}. ` +
            `Call list_gavel_indicators for the catalogue with descriptions.`
        );
      }

      if (!spec.live) {
        // Empty-on-mainnet honesty: say the reading does not exist rather than
        // letting an absent series read as a value.
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Indicator '${spec.id}' (${spec.name}) is not live on this network. ` +
            `${spec.note ?? ''} No value is available; this is not a transient error.`
        );
      }

      if (include_history && !spec.historyPath) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Indicator '${spec.id}' (${spec.name}) does not serve a historical series. ` +
            `Call again without include_history for the current value.`
        );
      }

      const path = include_history ? spec.historyPath! : spec.path;
      const data = await upstreamGet<Record<string, unknown>>(path, {
        query: include_history ? { from, to } : undefined,
      });

      const shaped = {
        id: spec.id,
        name: spec.name,
        family: spec.family,
        units: spec.units,
        description: spec.description,
        series: include_history ? 'history' : 'current',
        data,
        methodology: `https://docs.thegavel.io/methodology/${spec.id}`,
        source_path: path,
      };

      return { content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }] };
    }
  );
}
