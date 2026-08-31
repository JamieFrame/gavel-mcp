import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LENSES, renderLens, promptName } from '../../prompts/lenses.js';

/**
 * `get_lens` — the lenses, delivered through the one primitive clients read.
 *
 * ── WHY A TOOL, WHEN THESE ARE ALREADY PROMPTS ────────────────────────────
 *
 * OB4 §1.2 shipped the five lenses as MCP prompts, which is what the spec
 * intends: prompts are "user-controlled", surfaced for a reader to pick. The
 * server serves them correctly — `prompts/list` returns all five, `prompts/get`
 * renders, the capability is declared and verified on the live host.
 *
 * NO CLIENT TESTED SURFACES THEM. Claude shows the 12 tools and none of the 5
 * prompts, on two different name forms. Grok documents tools only, with
 * prompts-as-commands "not currently implemented". Gemini reads `list_tools`
 * and supports neither prompts nor resources. The lens layer existed on the
 * wire and reached nobody.
 *
 * Tools are the one primitive every client reads. So the same content, from the
 * same LENSES array, is served here too. The prompts stay registered: the day a
 * client implements the picker it works, with nothing to rebuild.
 *
 * ── WHAT THIS CHANGES, AND IT IS NOT ONLY PLUMBING ────────────────────────
 *
 * A prompt is user-controlled; a tool is MODEL-controlled. As a prompt, a
 * reader chose a perspective. As a tool, the model may consult the framing
 * unprompted — arguably where it belongs, since the framing is what stops a
 * capable model ranking venues, and a model reaching for it unasked is the
 * outcome the lens exercise wanted. But it is a different shape from what
 * OB4-D1 and D2 described, and is recorded as such rather than slipped in.
 *
 * ── ONE TOOL, NOT FIVE ────────────────────────────────────────────────────
 *
 * D2 fixed the prompt surface small because a connector exposing eighty
 * prompts overwhelms the picker and the model. That logic applies to a tool
 * list too, so this is ONE tool whose enum IS the catalogue: a model reading
 * the schema already sees every lens and what it is for, and calling with no
 * argument returns the index rather than needing a sixth tool.
 */
export function registerLensTool(server: McpServer): void {
  const ids = LENSES.map((l) => l.id) as [string, ...string[]];

  server.registerTool(
    'get_lens',
    {
      title: 'Reading lenses',
      description:
        `Returns a READING LENS: a presentation procedure for this dataset, ` +
        `written for a particular kind of reader. A lens selects which tools to ` +
        `use and frames how their output is presented; it never concludes, never ` +
        `ranks, and carries no write tool — this server has none.\n\n` +
        `Call with no argument to list the lenses. Call with one to get its full ` +
        `procedure: what to lead with, the tools in its scope, and — the part ` +
        `that matters most — what that lens explicitly does not do.\n\n` +
        `Reading a lens before presenting anything from this dataset is the ` +
        `intended use. It is guidance for presentation, not data about the ` +
        `market, and it adds no figures of its own.`,
      inputSchema: {
        lens: z
          .enum(ids)
          .optional()
          .describe(
            `Which lens. Omit to list all of them. ` +
              LENSES.map((l) => `'${l.id}' — ${l.title}`).join('; ')
          ),
      },
    },
    async ({ lens }) => {
      if (!lens) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  about:
                    'A lens is a read-only presentation procedure. It selects tools and frames how their output is presented; it never concludes, never ranks and carries no write tool.',
                  count: LENSES.length,
                  lenses: LENSES.map((l) => ({
                    lens: l.id,
                    title: l.title,
                    description: l.description,
                    tools: l.tools,
                    does_not_do: l.doesNotDo,
                    // Named so a client that DOES implement prompts finds the
                    // same thing where the spec intends it to live.
                    also_available_as_prompt: promptName(l.id),
                  })),
                  absent_by_design:
                    'There is no lens that ranks venues, scores them, or identifies a best or cheapest one. That is not an omission from this catalogue; there is no such lens and none will be added.',
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const found = LENSES.find((l) => l.id === lens);
      if (!found) {
        // Unreachable through the enum, but a structured absence rather than a
        // throw: this server states what it does not have, it does not guess.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: {
                  code: 'unknown_lens',
                  message: `'${lens}' is not a lens on this server.`,
                  available: LENSES.map((l) => l.id),
                },
              }),
            },
          ],
        };
      }
      return { content: [{ type: 'text' as const, text: renderLens(found) }] };
    }
  );
}
