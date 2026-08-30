import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Profile } from '../profiles.js';
import { LENSES, renderLens } from './lenses.js';

/**
 * OB4 §1.2 — register the lens prompts.
 *
 * OBSERVATORY ONLY (OB4-D1). The Gavel server gets no lenses: its persona
 * surface is the TA templates, which are procedures for participating rather
 * than procedures for reading, and one orientation prompt already exists in its
 * `initialize` instructions. Duplicating lenses there would blur the two-server
 * split that OB1 exists to draw.
 *
 * A lens carries no write tool in scope, and on this server there are none to
 * carry — OB1 §0.1 keeps every `prepare_*` off the observatory, so the
 * constraint is structural rather than a promise this file makes.
 *
 * OB4-D10 tightened it further, by accident. The audit warned that a lens
 * naming a venue-anchored indicator would present one venue's rate as market
 * context; those ten left this server's catalogue, so `analyst`'s
 * `get_indicator` scope can now only reach the 23 venue-independent ones. The
 * constraint enforces itself rather than relying on the copy staying careful.
 */
export function registerLensPrompts(server: McpServer, profile: Profile): void {
  if (profile.id !== 'observatory') return;

  for (const lens of LENSES) {
    server.registerPrompt(
      `lens:${lens.id}`,
      { title: lens.title, description: lens.description },
      () => ({
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: renderLens(lens) },
          },
        ],
      })
    );
  }
}
