import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MOVED_FROM_GAVEL, OBSERVATORY_HOST, PROFILES, type Profile } from '../profiles.js';

/**
 * OB1 §1.5 — compatibility shims.
 *
 * A tool that left this server keeps its name for one release and answers with
 * a structured `moved` error naming where it went. Two audiences, one payload:
 * an agent reads `moved_to` and retries against the other server without a
 * human in the loop, and a person reads `message`.
 *
 * This is the ONE place the Gavel server names the observatory host, and the
 * pointer is data-ward (OB1-D4). It is not a referral into Gavel and the
 * observatory has no shim pointing back — the direction is one-way by design.
 *
 * `moved_tool_error_rate` watches these. When it decays to zero the shims drop;
 * they are a migration aid, not a permanent surface.
 */
export function registerMovedTools(server: McpServer, profile: Profile): void {
  // Only the Gavel server carries shims: the observatory is new, so nothing
  // ever addressed it under an old name.
  if (profile.id !== 'gavel') return;

  const here = new Set(profile.tools);
  const moved = MOVED_FROM_GAVEL.filter((name) => !here.has(name));

  for (const name of moved) {
    const exposedElsewhere = PROFILES.observatory.renames[name] ?? name;
    server.registerTool(
      name,
      {
        title: `Moved — now served by the Bitcoin Credit Stack`,
        description:
          `This tool has moved. Cross-venue credit data is served by the Bitcoin ` +
          `Credit Stack MCP at ${OBSERVATORY_HOST}, where this tool is called ` +
          `\`${exposedElsewhere}\`. Calling it here returns a structured 'moved' ` +
          `error naming the host. This shim is temporary and will be removed.`,
        inputSchema: {},
      },
      async () => ({
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: {
                  code: 'moved',
                  message:
                    `'${name}' is no longer served here. Cross-venue credit data is ` +
                    `served by the Bitcoin Credit Stack MCP at ${OBSERVATORY_HOST}, ` +
                    `where this tool is called '${exposedElsewhere}'.`,
                  moved_to: {
                    server: 'The Bitcoin Credit Stack',
                    url: OBSERVATORY_HOST,
                    tool: exposedElsewhere,
                  },
                  retryable: true,
                },
              },
              null,
              2
            ),
          },
        ],
      })
    );
  }
}
