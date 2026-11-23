import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { upstreamGet, upstreamFailureOf } from '../upstream.js';
import { V2_DEPLOYMENT } from './deployment.generated.js';

// ============================================================================
// VZ10 row M1, G2 — the read layer of the gavel-testnet profile (G1 §2.1).
//
// Every read tool reaches the indexer's V2 routes through here and nowhere else:
// /v1/core/v2 on the testnet API, through the existing upstream client, which
// refuses rather than serve mainnet data under a testnet label. There are no
// chain reads in the read tools (G1 C1, operator 2026-11-18).
//
// Describe, don't recommend: each answer is the route's rows in the route's own
// order (newest first by block), with what was observed beside them: the block
// the indexer has read to, the sample, and the own-account share where the
// register allows it. Nothing here ranks, scores, sorts by rate or forecasts.
// ============================================================================

export const V2_PREFIX = '/v1/core/v2';

export const TESTNET_DISCLOSURE =
  'Arbitrum Sepolia test network. Test tokens with no value; contracts unaudited. ' +
  'Activity on this testnet is predominantly own-account.';

export interface OwnAccountMeta {
  available: boolean;
  registered: number | null;
  note: string | null;
}

/** The envelope every /v1/core/v2 answer carries (vz9-routes.js `envelope()`). */
export interface V2Meta {
  indexedTo: number | null;
  source: string;
  abiCommit: string | null;
  ownAccount: OwnAccountMeta;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

/** One call to a V2 route, with the route recorded for provenance. */
export interface Call<T> {
  route: string;
  body: T & V2Meta;
}

export async function v2Get<T = Record<string, unknown>>(path: string, query?: Query): Promise<Call<T>> {
  const body = await upstreamGet<T & V2Meta>(`${V2_PREFIX}${path}`, { query, network: 'arbitrum-sepolia' });
  const qs = query
    ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join('&')
    : '';
  return { route: `${V2_PREFIX}${path}${qs ? `?${qs}` : ''}`, body };
}

/**
 * A route read inside a tool that makes several calls (VZ10 M1g, operator ruling 2026-11-23): if it fails,
 * that part of the answer becomes a structured absence naming the route, the status and the indexer's own
 * message, and the rest of the answer stands. A 4xx other than 429 is not retryable; 429 and 5xx may be.
 */
export async function v2Try<T = Record<string, unknown>>(path: string, query?: Query): Promise<{ call: Call<T> } | { failed: ReturnType<typeof absent> }> {
  try {
    return { call: await v2Get<T>(path, query) };
  } catch (e) {
    const u = upstreamFailureOf(e);
    const status = u?.status ?? null;
    return {
      failed: absent('indexer_route_failed', null, null, {
        route: `${V2_PREFIX}${path}`,
        status,
        detail: u?.detail ?? (e instanceof Error ? e.message : String(e)),
        retryable: status === null || status === 429 || status >= 500,
      }),
    };
  }
}

/**
 * A G-2 lookup by id (/obligations/:id, /sets/:id, /liens/:id). An id the indexer has not seen as at its
 * cursor is refused in the indexer's own words, not the client's generic "not found" (operator ruling, M1g).
 */
export async function v2GetById<T = Record<string, unknown>>(path: string): Promise<Call<T>> {
  try {
    return await v2Get<T>(path);
  } catch (e) {
    const u = upstreamFailureOf(e);
    if (u?.status === 404) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `${u.detail ?? `not found: ${path}`}. An id appears once the block that created it is indexed; get_contract_events lists the ids seen.`
      );
    }
    throw e;
  }
}

/** provenance: what was read, from where, as at which block. Several calls report the lowest indexedTo. */
export function provenance(calls: Array<Call<unknown>>) {
  const first = calls[0]?.body;
  const indexed = calls.map((c) => c.body.indexedTo).filter((v): v is number => typeof v === 'number');
  const sources = [...new Set(calls.map((c) => c.body.source))];
  return {
    chain: { id: V2_DEPLOYMENT.chainId, name: 'arbitrum-sepolia', testnet: true },
    indexedTo: indexed.length ? Math.min(...indexed) : null,
    source: sources.length === 1 ? sources[0] : sources,
    abiCommit: first?.abiCommit ?? null,
    deployment: {
      docsCommit: V2_DEPLOYMENT.docs.commit,
      records: Object.fromEntries(Object.entries(V2_DEPLOYMENT.docs.records).map(([k, r]) => [k, r.sha256])),
    },
    ownAccount: first?.ownAccount ?? { available: false, registered: null, note: 'no call made' },
    routes: calls.map((c) => c.route),
  };
}

type Flag = boolean | null | undefined;

export interface SampleSpec<R> {
  rows: R[];
  limit?: number;
  next?: string | null;
  window?: { from: number; to: number } | null;
  /** Address fields counted for distinctAddresses. Omit when the rows carry none. */
  parties?: (r: R) => Array<string | null | undefined>;
  /** The row's own-account flags. Omit when the route serves none. */
  flags?: (r: R) => Flag[];
  ownAccount: OwnAccountMeta;
}

/**
 * sample: how much was observed. ownAccountShare is null with its reason whenever the register is
 * unavailable, the route serves no flag, or every flag is null — a null flag means unknown, never no.
 */
export function sample<R>(s: SampleSpec<R>) {
  const rows = s.rows.length;
  const parties = s.parties ? new Set(s.rows.flatMap(s.parties).filter((a): a is string => !!a).map((a) => a.toLowerCase())) : null;
  // Rows observed but none carrying an address: the count is unknown, not zero (e.g. a spot batch
  // has no opener and no engine bidders; its orders are counted by get_spot_market).
  const distinctAddresses = parties && (parties.size > 0 || rows === 0) ? parties.size : null;
  const distinctAddressesReason = !s.parties
    ? 'these rows carry no address'
    : distinctAddresses === null ? 'no row observed carries an address in this field' : null;
  let ownAccountRows: number | null = null;
  let ownAccountShare: number | null = null;
  let ownAccountShareReason: string | null = null;
  if (!s.flags) ownAccountShareReason = 'this route serves no own-account flag';
  else if (!s.ownAccount.available) ownAccountShareReason = 'the own-account register is not available';
  else if (rows === 0) ownAccountShareReason = 'no rows observed';
  else {
    const flags = s.rows.map(s.flags);
    if (flags.every((f) => f.every((x) => x === null || x === undefined))) ownAccountShareReason = 'every flag is null (unknown)';
    else {
      ownAccountRows = flags.filter((f) => f.some((x) => x === true)).length;
      ownAccountShare = ownAccountRows / rows;
    }
  }
  return {
    rows,
    limit: s.limit ?? null,
    truncated: s.next ? true : s.limit !== undefined ? rows >= s.limit : false,
    next: s.next ?? null,
    window: s.window ?? null,
    distinctAddresses,
    ...(distinctAddressesReason ? { distinctAddressesReason } : {}),
    ownAccountRows,
    ownAccountShare,
    ...(ownAccountShareReason ? { ownAccountShareReason } : {}),
  };
}

/**
 * A tool's input made strict, with a refusal naming what it takes. The testnet's own: the
 * observatory's strictInput (src/observatory/wrap.ts) adds a sentence about the ether side,
 * which means nothing here.
 */
export function strictTestnetInput(tool: string, shape: ZodRawShape): ZodTypeAny {
  const accepted = Object.keys(shape);
  const takes = accepted.length ? `It takes: ${accepted.join(', ')}.` : 'It takes no arguments.';
  return z.object(shape).strict(`${tool} does not take that argument. ${takes}`);
}

/** A structured absence: never a zero where a figure would be degenerate (G1 §2.1). */
export function absent(reason: string, threshold: unknown, observed: unknown, extra: Record<string, unknown> = {}) {
  return { absent: { reason, threshold, observed, ...extra } };
}

/** The tool result: compact JSON in one text block. */
export function answer(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ...payload, disclosure: TESTNET_DISCLOSURE }) }] };
}
