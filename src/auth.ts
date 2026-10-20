import type { Request, Response, NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { requestContext } from './context.js';
import { resolveTier } from './tiers.js';
import { logger } from './logger.js';

/**
 * Express middleware that:
 *   1. Extracts the bearer token from the Authorization header (if present)
 *   2. Resolves the caller's real product tier via the API's key store
 *      (R18 Phase 1 / MD5) — fails open to 'free', never throws
 *   3. Generates a request id (echoed back as X-Request-Id)
 *   4. Installs a RequestContext into AsyncLocalStorage for the request lifetime
 *
 * Downstream handlers and tool invocations read this context via getContext().
 *
 * Async because resolution is a cached loopback call. `resolveTier` swallows
 * its own failures, so there is no rejection path to hand to next(err) — a
 * request can never fail here because tier lookup was unavailable.
 */
// MN1 Gate 3: in X402_MODE=test only the test agent is priced (src/x402.ts).
const TEST_KEY = process.env.X402_MODE === 'test' ? String(process.env.X402_TEST_KEY || '') : '';
function isTestAgent(v: string | undefined): boolean {
  if (!TEST_KEY || TEST_KEY.length < 32 || !v) return false;
  const a = Buffer.from(v); const b = Buffer.from(TEST_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.header('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearerToken = bearerMatch ? bearerMatch[1].trim() : null;
  const tier = await resolveTier(bearerToken);

  const requestId = req.header('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();

  // MN1 Phase 2: what the shadow meter needs (src/meter.ts); a request without X-Forwarded-For
  // reached this process directly on the host, i.e. our own harness or monitors.
  const ctx = { tier, ip, bearerToken, requestId,
    userAgent: req.header('user-agent') || null, viaProxy: !!req.header('x-forwarded-for'),
    x402Test: isTestAgent(req.header('x-x402-test')) };

  // Light access log on entry; the real per-tool log happens inside the tool
  // handler so we know which tool was actually invoked. This entry just
  // confirms the request reached the MCP layer.
  logger.debug({ ...ctx, path: req.path, method: req.method }, 'mcp request received');

  // Run the rest of the chain inside the AsyncLocalStorage scope so anything
  // downstream can call getContext() and see this request's data.
  requestContext.run(ctx, () => next());
}
