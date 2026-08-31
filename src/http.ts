import express, { type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { tryGetContext } from './context.js';
import { authMiddleware } from './auth.js';
import { getContext } from './context.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '3002', 10);

const ANONYMOUS_PER_MINUTE = parseInt(process.env.RATE_LIMIT_ANONYMOUS_PER_MINUTE || '60', 10);
const PAID_PER_MINUTE      = parseInt(process.env.RATE_LIMIT_PAID_PER_MINUTE      || '300', 10);

const corsOriginsRaw = (process.env.CORS_ALLOWED_ORIGINS || '').trim();
const corsOrigins = corsOriginsRaw ? corsOriginsRaw.split(',').map((s) => s.trim()) : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind nginx — req.ip should reflect the client

if (corsOrigins) {
  app.use(cors({ origin: corsOrigins, credentials: false }));
}

app.use(express.json({ limit: '256kb' }));

// Health check — no auth, no rate limit, optional secret.
app.get('/health', (req: Request, res: Response) => {
  const requiredSecret = process.env.HEALTH_CHECK_SECRET;
  if (requiredSecret) {
    const provided = (req.query.secret as string | undefined) || '';
    if (provided !== requiredSecret) {
      res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      return;
    }
  }
  res.json({
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    time: new Date().toISOString(),
  });
});

// Per-tier rate limit. The key is the request's tier plus IP; free gets the
// lower bucket, paid gets the higher.
//
// R18 / MD6 + D2: these are INFRASTRUCTURE PROTECTION, not a billing meter.
// They apply irrespective of MCP_TIER_ENFORCEMENT — a scraping loop is a
// scraping loop whether or not anyone is being charged. The free ceiling is
// deliberately generous (60/min, 10 000/day) because a cold-start concierge
// session — wallet choice through funding to a placed bid — is tens of tool
// calls, and a shared egress IP (corporate NAT, a university, a mobile
// carrier) must not exhaust it. Throttling that path would breach D3:
// participation is never gated.
const tieredRateLimit = rateLimit({
  windowMs: 60_000,
  limit: (req: Request) => {
    try {
      const { tier } = getContext();
      return tier === 'free' ? ANONYMOUS_PER_MINUTE : PAID_PER_MINUTE;
    } catch {
      return ANONYMOUS_PER_MINUTE;
    }
  },
  keyGenerator: (req: Request) => {
    try {
      const ctx = getContext();
      // Bearer-key callers share their own bucket across IPs; keyless callers
      // are bucketed per-IP. Note a free *key* is bucketed as a key, not an
      // IP — it is a stabler identifier and costs the holder nothing.
      return ctx.bearerToken
        ? `key:${ctx.bearerToken.slice(0, 16)}`
        : `anon:${ctx.ip}`;
    } catch {
      return `anon:${req.ip ?? 'unknown'}`;
    }
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limit_exceeded', message: 'Slow down or upgrade your tier.' } },
});

/**
 * MCP endpoint. The Streamable HTTP transport handles MCP protocol framing
 * over a single POST per RPC. We run stateless (sessionIdGenerator:
 * undefined) which means each request gets a fresh transport and server
 * instance — simpler, no session state to manage, and tools are pure
 * functions over upstream data so there's nothing useful to cache between
 * calls at the MCP layer.
 *
 * The auth middleware runs before the rate limiter so the limiter can read
 * the tier from request context.
 */
app.post(
  '/mcp',
  authMiddleware,
  tieredRateLimit,
  async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on('close', () => {
      transport.close().catch((e: unknown) => logger.warn({ err: String(e) }, 'transport close error'));
      server.close().catch((e: unknown) => logger.warn({ err: String(e) }, 'server close error'));
    });

    // ── AF-T external_agent_signal ────────────────────────────────────────
    // The signal Gate AF-T is decided on counts "non-own-account MCP sessions
    // by distinct client fingerprint". Until now nothing recorded who called:
    // the watching period would have had nothing to read, and a zero would
    // have meant "we did not look" while reading as "nobody came".
    //
    // What is logged is the client's OWN self-description from `initialize` —
    // e.g. {name: "claude-desktop", version: "0.9.1"}. That is a software
    // identity the client volunteers, not a person and not an address. No IP,
    // no header fingerprinting, no correlation across requests: the privacy
    // bound of E6 applies here too, and a discovery metric is not a reason to
    // start profiling callers.
    try {
      const body = req.body as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } };
      if (body && body.method === 'initialize') {
        const ci = body.params?.clientInfo;
        logger.info(
          {
            event: 'mcp_initialize',
            client_name: ci?.name ?? 'unknown',
            client_version: ci?.version ?? 'unknown',
            tier: tryGetContext()?.tier ?? 'anonymous',
          },
          'mcp client connected'
        );
      }
    } catch {
      // Never let telemetry break a request. A missed count is a missed count;
      // a failed call is a failed product.
    }

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal MCP error' },
          id: null,
        });
      }
    }
  }
);

/**
 * The MCP endpoint's OTHER two methods — 405, never 404.
 *
 * Added 2026-08-31 after Cursor could not hold a connection to either server.
 * Its log is the whole diagnosis:
 *
 *     Successfully connected to streamableHttp server
 *     Client error: Failed to open SSE stream: Not Found
 *     Detected session termination, re-initializing connection before retry
 *     ... x5 ...
 *     Tombstoning streamable HTTP transport after 5 consecutive session
 *     HTTP 404 responses; automatic retry disabled
 *
 * POST worked. The client then issued the GET that opens the server->client
 * SSE stream, and Express fell through to the catch-all 404 below, because
 * only POST was ever routed here.
 *
 * ── WHY 404 IS THE WORST POSSIBLE ANSWER, AND 405 IS REQUIRED ─────────────
 *
 * The transport spec (2025-06-18, "Listening for Messages from the Server"):
 *
 *   "The server MUST either return Content-Type: text/event-stream in response
 *    to this HTTP GET, or else return HTTP 405 Method Not Allowed, indicating
 *    that the server does not offer an SSE stream at this endpoint."
 *
 * And 404 is not a neutral "no". Under "Session Management" it is load-bearing:
 *
 *   "The server MAY terminate the session at any time, after which it MUST
 *    respond to requests containing that session ID with HTTP 404 Not Found."
 *   "When a client receives HTTP 404 ... it MUST start a new session by sending
 *    a new InitializeRequest."
 *
 * So our 404 told every compliant client "your session is dead, start over".
 * Cursor obeyed, five times, then tombstoned the transport. The client was
 * correct and this server was not.
 *
 * It stayed invisible because a client that never opens the GET stream never
 * asks the question — every probe this project runs is a POST, and so the
 * servers looked healthy from here while being unusable from a client that
 * follows the spec more completely.
 *
 * 405 is the honest answer rather than a workaround: this server is stateless
 * (sessionIdGenerator: undefined) and has nothing to push, so there is no
 * server-initiated stream to offer. DELETE gets the same treatment, which the
 * spec names explicitly: "The server MAY respond to this request with HTTP 405
 * Method Not Allowed, indicating that the server does not allow clients to
 * terminate sessions."
 */
const mcpMethodNotAllowed = (req: Request, res: Response) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          req.method === 'DELETE'
            ? 'This server is stateless and issues no session id, so there is no session to terminate. Use POST for all MCP messages.'
            : 'This server does not offer a server-initiated SSE stream at this endpoint. Use POST for all MCP messages.',
      },
      id: null,
    });
};
app.get('/mcp', mcpMethodNotAllowed);
app.delete('/mcp', mcpMethodNotAllowed);

// 404 catch-all so MCP clients exploring the URL space get a structured
// response rather than the default Express HTML page.
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: { code: 'not_found', message: `Route ${req.path} not found` } });
});

app.listen(PORT, () => {
  logger.info(
    { port: PORT, server: SERVER_NAME, version: SERVER_VERSION, upstream: process.env.GAVEL_API_BASE_URL },
    'Aletheia MCP server listening'
  );
});
