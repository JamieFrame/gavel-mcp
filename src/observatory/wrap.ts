import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { upstreamFailureOf } from '../upstream.js';

// ============================================================================
// MR1 Phase 2 (aletheia-docs runbooks/PLANNED/runbook_MR1_stack_mcp_refinement_v1.md,
// MR-D4): the observatory is never silent, and it answers in one shape.
//
// Applied in scopeTo (src/tools/index.ts) to every tool the observatory exposes,
// and to no tool on the Gavel profiles, which answer exactly as before.
//
//  1. An argument a tool does not take is REFUSED, never dropped (MR-F01). Every
//     schema already told clients `additionalProperties: false`, while the
//     server stripped unknown keys and answered: `collateral: 'eth'` on a
//     bitcoin-only tool returned bitcoin under no label at all. The schema is
//     now strict, and the refusal names the arguments the tool does take.
//  2. A failure is one JSON shape (MR-F06): `{ error: { code, message,
//     retryable, ... } }` — the shape the `moved` and `not_published` answers
//     already had. The API's own words about a failure travel in `message`
//     rather than "may not be live yet".
//  3. Answers are compact JSON (MR-F07). The values are untouched; the
//     two-space indentation was half of every byte served.
// ============================================================================

/** A tool's input shape, made strict, with a refusal that names what it takes. */
export function strictInput(tool: string, shape: ZodRawShape): ZodTypeAny {
  const accepted = Object.keys(shape);
  const takes = accepted.length ? `It takes: ${accepted.join(', ')}.` : 'It takes no arguments.';
  const noCollateral = accepted.includes('collateral')
    ? ''
    : ' It has no collateral choice: it does not read the ether side, and asking for it is refused rather than answered with bitcoin.';
  return z.object(shape).strict(`${tool} does not take that argument. ${takes}${noCollateral}`);
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean; [k: string]: unknown };

const errorResult = (error: Record<string, unknown>): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error }) }],
});

/** "MCP error -32602: text" -> "text" */
const bare = (m: string) => m.replace(/^MCP error -?\d+:\s*/, '');

/** Translate any failure into the one error shape. `say` rewrites tool names to the ones this server exposes. */
export function asErrorResult(err: unknown, say: (m: string) => string = (m) => m): ToolResult {
  const r = asErrorResultRaw(err);
  const e = JSON.parse(r.content![0].text!).error;
  return errorResult({ ...e, message: say(e.message) });
}

function asErrorResultRaw(err: unknown): ToolResult {
  const up = upstreamFailureOf(err);
  if (up) {
    if (up.status === 404) {
      return errorResult({
        code: 'not_found',
        message: `Nothing is served for that request: ${up.detail ?? 'the id, level or date does not exist'}.`,
        retryable: false,
      });
    }
    if (up.status === 400) {
      return errorResult({
        code: 'invalid_argument',
        message: up.detail ?? 'The data API refused the arguments.',
        retryable: false,
      });
    }
    // MN1 Phase 5: a 422 is the API declining what was asked (get_chart: the plan draws none of the
    // series), with its reason — not an outage, and asking again changes nothing.
    if (up.status === 422) {
      return errorResult({
        code: 'nothing_to_draw',
        message: up.detail ?? 'The data API could not draw that request.',
        retryable: false,
      });
    }
    if (up.status === 429) {
      return errorResult({ code: 'rate_limited', message: 'Too many requests; wait and call again.', retryable: true });
    }
    return errorResult({
      code: 'upstream_unavailable',
      message: `The data API did not answer this time (${up.status}${up.detail ? `: ${up.detail}` : ''}).`,
      retryable: true,
    });
  }
  if (err instanceof McpError) {
    const code =
      err.code === ErrorCode.InvalidParams ? 'invalid_argument'
        : err.code === ErrorCode.InvalidRequest ? 'not_available'
          : 'internal_error';
    return errorResult({ code, message: bare(err.message), retryable: code === 'internal_error' });
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResult({ code: 'invalid_argument', message, retryable: false });
}

/** Re-serialise every JSON text block compactly. Plain text is left as it is. */
function compact(result: ToolResult): ToolResult {
  if (!Array.isArray(result?.content)) return result;
  return {
    ...result,
    content: result.content.map((c) => {
      if (c.type !== 'text' || typeof c.text !== 'string') return c;
      const t = c.text.trimStart();
      if (!(t.startsWith('{') || t.startsWith('['))) return c;
      try {
        return { ...c, text: JSON.stringify(JSON.parse(c.text)) };
      } catch {
        return c;
      }
    }),
  };
}

/** Wrap a tool handler: one error shape, compact answers. */
export function wrapHandler<H extends (...args: any[]) => unknown>(handler: H, say: (m: string) => string = (m) => m): H {
  return (async (...args: unknown[]) => {
    try {
      const result = (await handler(...args)) as ToolResult;
      // A handler's own error answers ({ isError, error: {...} }) keep their shape; their text is
      // renamed like every other message this server sends.
      if (result?.isError && Array.isArray(result.content)) {
        return compact({ ...result, content: result.content.map((c) => (typeof c.text === 'string' ? { ...c, text: say(c.text) } : c)) });
      }
      return compact(result);
    } catch (err) {
      return asErrorResult(err, say);
    }
  }) as unknown as H;
}
