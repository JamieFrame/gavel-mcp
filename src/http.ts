import express, { type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
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

// Per-tier rate limit. The key is the request's tier plus IP; anonymous gets
// the lower bucket, paid gets the higher. When real per-key tier resolution
// lands in Phase 1.5 we can split paid into developer / pro / enterprise.
const tieredRateLimit = rateLimit({
  windowMs: 60_000,
  limit: (req: Request) => {
    try {
      const { tier } = getContext();
      return tier === 'anonymous' ? ANONYMOUS_PER_MINUTE : PAID_PER_MINUTE;
    } catch {
      return ANONYMOUS_PER_MINUTE;
    }
  },
  keyGenerator: (req: Request) => {
    try {
      const ctx = getContext();
      // Bearer-key callers share their own bucket across IPs; anonymous
      // callers are bucketed per-IP.
      return ctx.tier === 'anonymous'
        ? `anon:${ctx.ip}`
        : `key:${ctx.bearerToken?.slice(0, 16) ?? 'unknown'}`;
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
