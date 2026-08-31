import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';
import { registerLensPrompts } from './prompts/index.js';
import { registerLensResources } from './prompts/resources.js';
import { activeProfile, type Profile } from './profiles.js';

/**
 * OB1 — this file used to hold one server identity. It now builds whichever of
 * the two profiles it is handed:
 *
 *   - `gavel`       — participation. mcp.thegavel.io.
 *   - `observatory` — The Bitcoin Credit Stack, read-only, zero write tools.
 *
 * The name, version, instructions and tool allowlist all live in
 * src/profiles.ts. `INSTRUCTIONS` moved there too: it has an external source of
 * truth (aletheia-docs commercial/operational/agent_listing_copy_v1.md) and a
 * `listing_copy_drift` sensor comparing against it, and keeping both servers'
 * copy in one file is what lets the lint check both in one pass.
 */
export function buildServer(profile: Profile = activeProfile()): McpServer {
  const server = new McpServer(
    { name: profile.serverName, version: profile.serverVersion },
    {
      capabilities: {
        tools: {},
        // OB4 §1.2 — prompts, on the observatory only. Declared per profile
        // because a client discovers prompts ONLY through the declared
        // capability: advertising it on a server with no prompts registered
        // would put an empty picker in front of a reader.
        ...(profile.id === 'observatory' ? { prompts: {} } : {}),
        // OB4 §1.6 — resources, on the observatory only, for the same reason
        // as prompts above: a client discovers them ONLY through the declared
        // capability, and declaring it on a server with none registered puts an
        // empty list in front of a reader.
        ...(profile.id === 'observatory' ? { resources: {} } : {}),
      },
      // No individual tool description carries the operator disclosure; the
      // editorial guideline v1.2 requires it in every self-description surface
      // and the server's `instructions` is the one place it belongs. Seventeen
      // repetitions across tool descriptions would be worse.
      //
      // Source of truth: the copy pack. §2.2 for `gavel`, §7 (the observatory
      // section) for `observatory`. Edit there first.
      instructions: profile.instructions,
    }
  );
  registerAllTools(server, profile);
  registerLensPrompts(server, profile);
  registerLensResources(server, profile);
  return server;
}

// Back-compat named exports. Anything importing these gets the ACTIVE profile's
// identity, which is what /health and the boot log want.
export const SERVER_NAME = activeProfile().serverName;
export const SERVER_VERSION = activeProfile().serverVersion;
export const INSTRUCTIONS = activeProfile().instructions;
