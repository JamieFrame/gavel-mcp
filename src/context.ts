import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tier } from './tiers.js';

// Per-request context carried through the call chain into tool handlers and
// upstream calls without having to thread it through every function signature.
// Set by the Express middleware in http.ts when a request arrives; read by
// `requireTier()` and `upstreamGet()`.
export interface RequestContext {
  tier: Tier;
  ip: string;
  bearerToken: string | null;
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current request context, or throws if called outside the
 * Express middleware chain. Use sparingly — most consumers should pass the
 * context explicitly when they have it.
 */
export function getContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error('No request context — getContext() called outside an HTTP request');
  }
  return ctx;
}

/**
 * Returns the current context if available, or null otherwise. Useful for
 * code paths that can degrade gracefully without context (e.g. anonymous
 * default rate limits in places that aren't strictly per-request).
 */
export function tryGetContext(): RequestContext | null {
  return requestContext.getStore() ?? null;
}
