import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { tryGetContext } from './context.js';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const BASE_URL = (process.env.GAVEL_API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');

// Testnet is served by a separate API process against a separate database, so
// reaching it is a different host and not a query parameter. Added 2026-08-26
// for the E-series tools: the operator direction is to build testnet-first, and
// testnet carries the deeper book (446 loans against mainnet's 14).
const TESTNET_BASE_URL = (process.env.GAVEL_API_TESTNET_BASE_URL || '').replace(/\/$/, '');

export type GavelNetwork = 'arbitrum-one' | 'arbitrum-sepolia';

/**
 * Resolve the API host for a network. Falls back to mainnet when no testnet
 * host is configured — and says so in the log rather than silently serving
 * mainnet data under a testnet label, which would be the worse failure.
 */
export function baseUrlFor(network?: GavelNetwork): string {
  if (network === 'arbitrum-sepolia') {
    if (TESTNET_BASE_URL) return TESTNET_BASE_URL;
    logger.warn(
      { requested: network },
      'testnet API host not configured (GAVEL_API_TESTNET_BASE_URL); refusing to serve mainnet data as testnet'
    );
    throw new McpError(
      ErrorCode.InternalError,
      'The testnet deployment is not reachable from this server: no testnet API host is ' +
        'configured. Mainnet data is not returned in its place, because a mainnet figure ' +
        'labelled testnet is worse than an error.'
    );
  }
  return BASE_URL;
}

export interface UpstreamGetOptions {
  /**
   * Query parameters. Values of `undefined` and `null` are omitted from the
   * outgoing URL so callers can pass optional MCP tool args through without
   * pre-filtering.
   */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Request timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
  /**
   * Whether to forward the caller's bearer token to the upstream API. Default
   * true — useful so paid-tier upstream rate limits apply to paid MCP callers,
   * not the MCP server's anonymous IP.
   */
  forwardAuth?: boolean;
  /**
   * Which deployment to read. Selects the API host; defaults to mainnet.
   * Note the two run different contract builds — see the verification bundle.
   */
  network?: GavelNetwork;
}

/**
 * GET a JSON resource from the Aletheia data product. This is the only
 * function MCP tools should use to reach upstream data — keeps the
 * thin-wrapper principle from drifting.
 *
 * Translates upstream HTTP failures into MCP protocol errors so the LLM
 * client receives a structured, actionable response rather than a 500.
 */
export async function upstreamGet<T = unknown>(
  path: string,
  opts: UpstreamGetOptions = {}
): Promise<T> {
  const { query, timeoutMs = DEFAULT_TIMEOUT_MS, forwardAuth = true, network } = opts;
  const ctx = tryGetContext();

  const url = new URL(`${baseUrlFor(network)}${path.startsWith('/') ? '' : '/'}${path}`);
  if (query) {
    for (const [key, val] of Object.entries(query)) {
      if (val !== undefined && val !== null) url.searchParams.set(key, String(val));
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (forwardAuth && ctx?.bearerToken) {
    headers['Authorization'] = `Bearer ${ctx.bearerToken}`;
  }
  if (ctx?.requestId) headers['X-Request-Id'] = ctx.requestId;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  const startedAt = Date.now();
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers,
      signal: abortController.signal,
    });
    const durationMs = Date.now() - startedAt;

    logger.info(
      { upstream_url: url.pathname + url.search, upstream_status: res.status, duration_ms: durationMs, tier: ctx?.tier },
      'upstream call complete'
    );

    if (res.status === 404) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Upstream resource not found: ${path}. The indicator or endpoint may not be live yet.`
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Upstream rejected the request (${res.status}). Verify your API key tier covers this endpoint.`
      );
    }
    if (res.status === 429) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Upstream rate limit hit. Slow down or upgrade your tier.`
      );
    }
    if (!res.ok) {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream returned ${res.status}: ${res.statusText || 'unknown error'}`
      );
    }

    const body = (await res.json()) as T;
    return body;
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream request timed out after ${timeoutMs}ms: ${path}`
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, path }, 'upstream call failed');
    throw new McpError(ErrorCode.InternalError, `Upstream call failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}
