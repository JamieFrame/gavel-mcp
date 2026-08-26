import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index.js';

export const SERVER_NAME = 'aletheia-mcp';
export const SERVER_VERSION = '0.3.0';

/**
 * Served as the MCP `initialize` result's `instructions`. Public copy —
 * governed by commercial/canonical/public_copy_editorial_guideline.md v1.2.
 */
export const INSTRUCTIONS = [
  `This server exposes Aletheia Analytics' data product for the Gavel Protocol: a`,
  `fixed-rate, fixed-term, oracle-free BTC-collateralised credit market on Arbitrum`,
  `One. Every tool here either returns observed data or returns an unsigned`,
  `transaction blueprint. Nothing on this server signs, submits or broadcasts a`,
  `transaction, and no tool takes custody of funds or receives a mandate — a`,
  `blueprint is calldata the caller's own wallet may choose to sign.`,
  ``,
  `Read the provenance fields before treating any rate as a market reference.`,
  `Gavel's mainnet book is small and currently predominantly own-account:`,
  `responses carry the observation count, the distinct-counterparty count, the`,
  `own-account share and a disclosure of whether the figure is yet an independent`,
  `market assessment. Where a figure would be degenerate on the current book, the`,
  `response returns a structured absence naming the threshold and the observed`,
  `count rather than a zero.`,
  ``,
  `Nothing here is advice. Tools that return catalogues do not rank their entries;`,
  `tools that return distributions report what was observed with the sample size,`,
  `and do not forecast a fill, a rate, a time-to-fill or a return.`,
  ``,
  `Aletheia Analytics SASU operates this interface and data product; the Gavel`,
  `Protocol is autonomous, permissionless code with no operating entity.`,
].join('\n');

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
      // Added 2026-08-26. Until now a client connecting to this server
      // received the tool list with no entity context at all: no individual
      // tool description carries the operator disclosure, and the editorial
      // guideline v1.2 requires it in every self-description surface. This
      // paragraph is that disclosure, and it is the one place it belongs —
      // seventeen repetitions across tool descriptions would be worse.
      //
      // Source of truth for this string: aletheia-docs
      // commercial/operational/agent_listing_copy_v1.md §2.2. The
      // listing_copy_drift sensor compares against it; edit there first.
      instructions: INSTRUCTIONS,
    }
  );
  registerAllTools(server);
  return server;
}
