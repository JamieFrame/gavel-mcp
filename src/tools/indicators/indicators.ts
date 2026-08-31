import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { upstreamGet } from '../../upstream.js';
import { requireTier } from '../../tiers.js';
import { INDICATORS, INDICATOR_IDS, findIndicator, catalogueFor, isAnchored } from './catalogue.js';
import { activeProfile, GAVEL_MCP_HOST, OBSERVATORY_HOST, PROFILES } from '../../profiles.js';

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

/**
 * OB4 §1.5 — the catalogue this pair describes DIFFERS BY PROPERTY, so its
 * self-description has to as well.
 *
 * OB4-D10 split the catalogue: the ten indicators anchored on one venue's own
 * rate are served by that venue's server, and the observatory serves the 23
 * that are venue-independent. The tool descriptions were written before that
 * split and kept describing the whole catalogue from both servers. On the
 * observatory that produced three separate false statements in the payload a
 * model reads to decide what to call:
 *
 *   - "computed from The Gavel Protocol and the Bitcoin chain" — the
 *     observatory's 23 are venue-independent by construction, and OB1 §0.1
 *     bars a tool on this server from naming a venue outside its uniform row.
 *   - "'credit' (Gavel-derived assessments — the yield curve and the Bitcoin
 *     Credit Complex)" — the yield curve is precisely what D10 relocated.
 *   - an `id` example of 'yield-curve' — an id THIS SERVER REFUSES with a
 *     `moved` error. The parameter documentation was offering, as its worked
 *     example, a call that cannot succeed.
 *
 * The rename map (src/tools/index.ts) cannot fix these: they are not old tool
 * names, they are a description of the wrong catalogue.
 *
 * ⚠ `title` is one of them, and it was MISSED on the first pass — the fix went
 * to `description` and the parameter schemas, and the titles ("Gavel Indicator
 * Catalogue", "Get a Gavel Indicator") shipped to the live observatory
 * unchanged. Both sensors missed it too, because both read `description` and
 * `inputSchema` and neither read `title`. A title is the field a client renders
 * in a picker, so it is the Gavel-naming a reader is MOST likely to see.
 */
function onObservatory(): boolean {
  return activeProfile().id === 'observatory';
}

/** Example ids drawn from the catalogue this profile actually serves, so the
 *  worked example is always a call that can succeed. */
function EXAMPLE_IDS(): string {
  const ids = catalogueFor(activeProfile().id)
    .filter((i) => i.live)
    .slice(0, 3)
    .map((i) => `'${i.id}'`);
  return ids.length ? ids.join(', ') : "'tci'";
}

function SCOPE_SENTENCE(): string {
  return onObservatory()
    ? `This server serves the venue-independent indicator set; an indicator ` +
      `anchored on a single venue's own rate is served by that venue's own MCP ` +
      `and answers here with a pointer to it.`
    : `This server serves this protocol's own indicator set, including those ` +
      `anchored on its rate.`;
}

function CATALOGUE_DESCRIPTION(): string {
  const shared =
    `id, name, family, units, description, and whether the indicator is ` +
    `currently live on this network.\n\n` +
    `Three families: 'credit' (credit-market assessments), 'onchain' ` +
    `(commodity chain metrics such as MVRV and SOPR), and 'market' (external ` +
    `context — DeFi rates, stablecoin supply, macro).\n\n` +
    `Use this to discover what is available, then call get_gavel_indicator ` +
    `with an id. This tool returns a catalogue; it does not rank indicators ` +
    `or advise which to use.`;
  return onObservatory()
    ? `Returns the catalogue of Aletheia indicators measured across the ` +
      `Bitcoin-collateralised credit markets and the Bitcoin chain: ${shared}\n\n` +
      `Indicators anchored on a single venue's own rate are not served here; ` +
      `they are listed as withheld, with the server that serves them.`
    : `Returns the catalogue of Aletheia indicators computed from The Gavel ` +
      `Protocol and the Bitcoin chain: ${shared}`;
}

export function registerIndicatorTools(server: McpServer): void {
  server.registerTool(
    'list_gavel_indicators',
    {
      title: onObservatory() ? 'Indicator Catalogue' : 'Gavel Indicator Catalogue',
      description: CATALOGUE_DESCRIPTION(),
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

      // OB4-D10 — the observatory publishes only venue-independent indicators.
      // An anchored indicator measures ONE VENUE against the market, and
      // publishing it here would give that venue an indicator namespace no
      // other venue has. Same ruling as the disposition table's D-A, applied
      // one level down to the catalogue that carried the series back in.
      const profile = activeProfile();
      const publishable = catalogueFor(profile.id);
      const withheld = INDICATORS.filter(isAnchored).map((i) => i.id);

      const matches = publishable.filter(
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
        total_in_catalogue: publishable.length,
        filter_echo: { family: family ?? null, live_only },
        notes:
          'An indicator marked live:false returns an explicit error rather than a fabricated or empty reading. ' +
          'Access to current values and history is free and open.',
        // Never a silent absence. A reader who knew this catalogue held 33
        // entries is told where the other ten went and why, rather than
        // finding a shorter list and drawing their own conclusion.
        ...(profile.id === 'observatory' && withheld.length
          ? {
              not_served_here: {
                ids: withheld,
                reason:
                  'These measure one venue against the market rather than the market itself — ' +
                  "for example drp is that venue's rate minus the matched treasury yield, and no " +
                  'equivalent exists for any other venue. Publishing them here would give one venue ' +
                  'an indicator namespace the other 161 do not have. They are served by that ' +
                  "venue's own MCP.",
                served_by: GAVEL_MCP_HOST,
                will_return_here_when:
                  'a per-venue rate endpoint exists, at which point each generalises to every ' +
                  'venue and stops being anchored to one.',
              },
            }
          : {}),
      };

      return { content: [{ type: 'text', text: JSON.stringify(shaped, null, 2) }] };
    }
  );

  server.registerTool(
    'get_gavel_indicator',
    {
      title: onObservatory() ? 'Get an Indicator' : 'Get a Gavel Indicator',
      description:
        `Returns the current value of a single Aletheia indicator by id, with ` +
        `its methodology reference. ${SCOPE_SENTENCE()} Call ` +
        `list_gavel_indicators first to discover valid ids.\n\n` +
        `Optionally returns the historical series instead of the current value ` +
        `(set include_history). History is free and unmetered on the same ` +
        `terms as the current value.\n\n` +
        `This is descriptive data; no recommendation is provided. An indicator ` +
        `that has no reading on this network says so explicitly rather than ` +
        `returning a null or a zero that could be mistaken for a value.`,
      inputSchema: {
        id: z
          .string()
          .describe(
            `Indicator id from list_gavel_indicators, e.g. ${EXAMPLE_IDS()}.`
          ),
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

      // OB4-D10 — an anchored id asked of the observatory is MOVED, not
      // unknown. Answering "unknown id" would be false: the indicator exists,
      // it is computed nightly, and it is served — just not from a property
      // whose rule is that no venue gets a surface the others do not.
      if (spec && isAnchored(spec) && activeProfile().id === 'observatory') {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: {
                    code: 'moved',
                    message:
                      `'${spec.id}' is not served here. It measures one venue against the ` +
                      `market rather than the market itself, so it is served by that venue's ` +
                      `own MCP at ${GAVEL_MCP_HOST}, where it is called 'get_gavel_indicator'.`,
                    moved_to: {
                      server: 'The Gavel MCP',
                      url: GAVEL_MCP_HOST,
                      tool: 'get_gavel_indicator',
                      indicator: spec.id,
                    },
                    anchored_to: spec.anchoredTo,
                    retryable: true,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // The mirror of the branch above. Asking the GAVEL server for a
      // venue-independent indicator is equally a `moved`, not an unknown id —
      // otherwise the two catalogues would be disjoint in list_indicators and
      // silently overlapping in get_indicator, which is worse than either being
      // wrong consistently.
      if (spec && !isAnchored(spec) && activeProfile().id === 'gavel') {
        const exposed = PROFILES.observatory.renames['get_gavel_indicator'] ?? 'get_indicator';
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: {
                    code: 'moved',
                    message:
                      `'${spec.id}' is not served here. It is a cross-venue measurement rather ` +
                      `than one of this venue's own, and is served by the Bitcoin Credit Stack ` +
                      `MCP at ${OBSERVATORY_HOST}, where this tool is called '${exposed}'.`,
                    moved_to: {
                      server: 'The Bitcoin Credit Stack',
                      url: OBSERVATORY_HOST,
                      tool: exposed,
                      indicator: spec.id,
                    },
                    retryable: true,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

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
