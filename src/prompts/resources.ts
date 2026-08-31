import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Profile } from '../profiles.js';
import { LENSES, promptName } from './lenses.js';

/**
 * OB4 §1.6 — the lens catalogue as a resource.
 *
 * "The knowledge corpus gains the lens catalogue as a resource
 * (`stack://lenses/index.json`) so an unfamiliar model can discover the lenses
 * before connecting."
 *
 * ── WHY A RESOURCE AND NOT JUST THE PROMPT LIST ────────────────────────────
 *
 * `prompts/list` gives a client a name, a title and a one-line description —
 * enough to draw a picker for a HUMAN who will choose one. It does not say what
 * a lens will actually instruct, which tools it will use, or what it refuses to
 * do. A model deciding whether a lens fits the question in front of it needs
 * exactly those three things, and `prompts/get` only tells it after it has
 * already committed to one.
 *
 * So the catalogue is published as a readable document: every lens with its
 * scope and its limits, in one fetch, before any lens is invoked.
 *
 * ── OB4-D2 IS THE REASON THIS IS THE RIGHT SHAPE ───────────────────────────
 *
 * D2 fixes the prompt surface small — five lenses — and puts depth in
 * resources, because "a connector exposing eighty prompts overwhelms the picker
 * and the model". This is that decision executed: the picker stays at five, and
 * the detail behind them is a document rather than more picker entries.
 *
 * OBSERVATORY ONLY, following OB4-D1. The Gavel server has no lenses, so it has
 * no lens catalogue; declaring an empty one there would advertise a surface
 * that does not exist.
 */
export function registerLensResources(server: McpServer, profile: Profile): void {
  if (profile.id !== 'observatory') return;

  server.registerResource(
    'lens-catalogue',
    'stack://lenses/index.json',
    {
      title: 'Lens catalogue',
      description:
        'Every reading lens this server offers, with the tools each one uses and what each one does not do. Read this to choose a lens before invoking it.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              // Named so a reader knows what kind of thing these are before
              // reading one. A lens is a presentation procedure, not an answer.
              about:
                'A lens is a read-only presentation procedure. It selects tools and frames how their output is presented; it never concludes, never ranks and carries no write tool — this server has none.',
              count: LENSES.length,
              lenses: LENSES.map((l) => ({
                name: promptName(l.id),
                title: l.title,
                description: l.description,
                tools: l.tools,
                does_not_do: l.doesNotDo,
              })),
              // The one thing a model must not infer from a short list.
              absent_by_design:
                'There is no lens that ranks venues, scores them, or identifies a best or cheapest one. That is not an omission from this catalogue; there is no such lens and none will be added.',
            },
            null,
            2
          ),
        },
      ],
    })
  );
}
