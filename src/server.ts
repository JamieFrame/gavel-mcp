import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';

export const SERVER_NAME = 'aletheia-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Build a fresh McpServer instance with the full Aletheia tool catalog
 * registered. Called once per HTTP request when running stateless, or once
 * at boot when running stateful (Phase 1.5).
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // Resources and prompts deferred to Phase 1.5.
      },
    }
  );
  registerAllTools(server);
  return server;
}
