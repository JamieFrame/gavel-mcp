import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { requireTier } from '../../tiers.js';
import { V2_DEPLOYMENT } from '../../v2/deployment.generated.js';
import { v2Get, provenance, sample, absent, answer, type Call } from '../../v2/read.js';
import { GAPS, notServed } from '../../v2/gaps.js';

// ============================================================================
// VZ10 row M1, G2 — the gavel-testnet profile's read tools (G1 §2.2; operator,
// 2026-11-18). Gavel V2 on Arbitrum Sepolia, read from the indexer's
// /v1/core/v2 routes only. Read src/v2/read.ts first.
//
// Every tool: the route's rows in the route's order, `provenance`, `sample`, a
// structured absence where a figure would be degenerate or a view is not
// served, and the testnet disclosure. No ranking, no default sort by rate, no
// forecast, no "best". Tier: free; this is a testnet.
// ============================================================================

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed 20-byte address');
const LIMIT = z.number().int().min(1).max(500).optional().describe('Rows to return, 1 to 500. Default 50 (the route\'s).');
const UNIX = z.number().int().min(0).max(1e12);
const ORDER_NOTE = 'Rows are in the order the indexer serves them: newest first by block. They are not ranked or sorted by rate or price.';

type Row = Record<string, unknown>;
const rowsOf = (b: unknown, key = 'rows'): Row[] => ((b as Record<string, unknown>)[key] as Row[]) ?? [];
const s = (v: unknown) => (typeof v === 'string' ? v : null);
const f = (v: unknown) => (v === true ? true : v === false ? false : null);

// ── The deployment table: names and markets, from the records (G1 C6) ──
const CONTRACTS = V2_DEPLOYMENT.contracts;
const PAIRS = V2_DEPLOYMENT.spot.pairs;
const BILLS = V2_DEPLOYMENT.spot.billSeries;

/** A contract by key ('Obligation', 'SpotMarket#2'), by name when unique, or by address. */
function resolveContract(ref: string): { key: string; address: string } {
  if (/^0x[0-9a-fA-F]{40}$/.test(ref)) {
    const c = CONTRACTS.find((x) => x.address.toLowerCase() === ref.toLowerCase());
    return { key: c?.key ?? ref, address: ref.toLowerCase() };
  }
  const byKey = CONTRACTS.find((x) => x.key.toLowerCase() === ref.toLowerCase());
  if (byKey) return { key: byKey.key, address: byKey.address.toLowerCase() };
  const byName = CONTRACTS.filter((x) => x.name.toLowerCase() === ref.toLowerCase() && !x.superseded);
  if (byName.length === 1) return { key: byName[0].key, address: byName[0].address.toLowerCase() };
  throw new McpError(
    ErrorCode.InvalidParams,
    byName.length > 1
      ? `'${ref}' names ${byName.length} contracts: use one of ${byName.map((x) => x.key).join(', ')}, or an address.`
      : `'${ref}' is not a V2 contract on this deployment. get_deployment lists every key.`
  );
}

/** A spot or bill market by pair name ('mWBTC/mUSDC'), bill series ('bill-3'), or SpotMarket address. */
export function resolveMarket(ref: string) {
  const l = ref.toLowerCase();
  const pair = PAIRS.find((p) => p.name.toLowerCase() === l || p.spotMarket.toLowerCase() === l);
  if (pair) return { kind: 'pair' as const, name: pair.name, spotMarket: pair.spotMarket.toLowerCase(), marketId: pair.marketId, base: pair.base, quote: pair.quote, params: pair.params };
  const m = /^bill-?(\d+)$/.exec(l);
  const bill = BILLS.find((b) => (m && b.k === Number(m[1])) || b.spotMarket.toLowerCase() === l);
  if (bill) return { kind: 'bill' as const, name: `bill-${bill.k}`, spotMarket: bill.spotMarket.toLowerCase(), marketId: bill.marketId, base: `BILL-${bill.k}`, quote: bill.quote, params: bill.params, k: bill.k, date: bill.date, billToken: bill.billToken };
  throw new McpError(
    ErrorCode.InvalidParams,
    `'${ref}' is not a spot or bill market on this deployment. Use a pair (${PAIRS.map((p) => p.name).join(', ')}), a bill series (bill-${BILLS[0]?.k} to bill-${BILLS[BILLS.length - 1]?.k}) or a SpotMarket address; list_spot_markets lists them.`
  );
}

const meta = (c: Call<unknown>) => c.body.ownAccount;

// /spot/:m/last looks at the newest 50 slots only (vz9-routes.js): an absence says so, never "never cleared".
const LAST_WINDOW_SLOTS = 50;
const NO_CLEARED_IN_WINDOW = absent('no_cleared_batch_in_window', { cleared: 1 }, { cleared: 0 }, {
  window: `the latest ${LAST_WINDOW_SLOTS} slots, the window the indexer reads for the last batch`,
  note: 'An earlier batch may have cleared; get_spot_market pages the batches.',
});
const NO_FLAG = { ownAccountShare: null, ownAccountShareReason: 'these rows carry no own-account flag' };

export function registerV2ReadTools(server: McpServer): void {
  // ── R1 get_deployment ───────────────────────────────────────────────────
  server.registerTool(
    'get_deployment',
    {
      title: 'Gavel V2 testnet deployment',
      description:
        `What Gavel V2 is deployed as on Arbitrum Sepolia (chain 421614): every contract by name, product and address, ` +
        `whether it is superseded, the eleven mock tokens with their decimals, and the spot and bill markets. ` +
        `The table is generated from the deployment records, never typed; its record hashes and docs commit are in provenance. ` +
        `The indexer's own list of what it follows (/deployment) is returned beside it.\n\n` +
        `Superseded contracts (VZ8's core and AuctionOrchestrator, BOND v0.2) are listed and marked; nothing on this server encodes a call to them. ` +
        `VZ8's ObligorPosition, replaced by Stage 3's, is listed under omitted with its reason. ` +
        `BOND's listing state (prices, lapse, caps) is not served by the indexer yet and is returned as a structured absence.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      const c = await v2Get<{ chainId: number; contracts: Row[] }>('/deployment');
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.contracts, ownAccount: meta(c) }),
        data: {
          chainId: V2_DEPLOYMENT.chainId,
          contracts: CONTRACTS,
          tokens: V2_DEPLOYMENT.tokens,
          spot: V2_DEPLOYMENT.spot,
          superseded: V2_DEPLOYMENT.superseded,
          omitted: V2_DEPLOYMENT.omitted,
          indexerFollows: c.body.contracts,
          bondListing: notServed(GAPS.G3),
        },
      });
    }
  );

  // ── R2 get_tape ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_tape',
    {
      title: 'Gavel V2 testnet tape',
      description:
        `Every user-level action on Gavel V2 on Arbitrum Sepolia, as the indexer records it: one row per action ` +
        `(kind, address, contract, product, block, transaction, the ids it touched, and its own-account flag). ` +
        `${ORDER_NOTE} Pages with \`cursor\` (the previous answer's \`next\`).\n\n` +
        `With figures: true, the seven-day figures instead: distinct addresses, actions in 24 hours, breaches (enforced, protected) and BOND mints, with their window. ` +
        `They count every address, own-account included: the indexer serves no own-account split of them, and the answer says so. ` +
        `The rows (without figures) carry a flag each.`,
      inputSchema: {
        since: UNIX.optional().describe('Unix time; rows from then on. Default seven days ago; at most 90 days ago.'),
        product: z.string().regex(/^[a-z-]{1,32}$/).optional().describe("Filter by product as the tape names it, e.g. 'spot', 'bullet-loan'."),
        kind: z.string().regex(/^[a-z-]{1,40}$/).optional().describe("Filter by kind as the tape names it, e.g. 'order-placed', 'batch-cleared'."),
        cursor: z.string().regex(/^[0-9]{1,15}:[0-9]{1,9}$/).optional().describe('block:logIndex, from a previous answer.'),
        limit: LIMIT,
        figures: z.boolean().optional().describe('Return the seven-day figures in place of the rows.'),
        as_of: UNIX.optional().describe('With figures: the unix time the seven-day window ends at. Default now.'),
      },
    },
    async ({ since, product, kind, cursor, limit, figures, as_of }) => {
      requireTier('free');
      if (figures) {
        const ignored = Object.entries({ since, product, kind, cursor, limit }).filter(([, v]) => v !== undefined).map(([k]) => k);
        if (ignored.length) throw new McpError(ErrorCode.InvalidParams, `With figures: true, get_tape takes only as_of; ${ignored.join(', ')} would be ignored.`);
        const c = await v2Get<Row>('/tape/figures', { asOf: as_of });
        const { indexedTo, source, abiCommit, ownAccount, ...figs } = c.body as Row;
        void indexedTo; void source; void abiCommit; void ownAccount;
        return answer({
          provenance: provenance([c]),
          sample: {
            rows: null, window: figs.window,
            ownAccountShare: null,
            ownAccountShareReason: 'the figures route serves no own-account split; every figure counts own-account activity too',
          },
          data: {
            ...figs,
            ownAccountSplit: absent('not_served_by_the_indexer', 'an own-account split of each figure', null, {
              note: 'The figures include own-account activity. get_tape without figures returns the rows, each with its own-account flag.',
            }),
          },
        });
      }
      if (as_of !== undefined) throw new McpError(ErrorCode.InvalidParams, 'as_of is taken only with figures: true.');
      const c = await v2Get<{ rows: Row[]; next: string | null; since: number }>('/tape', { since, product, kind, cursor, limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, next: c.body.next, window: { from: c.body.since, to: Math.floor(Date.now() / 1000) }, parties: (r) => [s(r.address)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(c) }),
        data: { since: c.body.since, rows: c.body.rows, next: c.body.next },
      });
    }
  );

  // ── R3 get_account ──────────────────────────────────────────────────────
  const SECTIONS = ['holdings', 'vault_events', 'held_units', 'bond', 'loans_opened', 'entries', 'policies', 'futures'] as const;
  server.registerTool(
    'get_account',
    {
      title: 'A Gavel V2 testnet account',
      description:
        `What one address holds and has done on Gavel V2 on Arbitrum Sepolia, as the indexer records it. Sections:\n` +
        `- holdings: loan claim units by obligation (including units escrowed in an open secondary sale) and obligor positions by set;\n` +
        `- vault_events: the address's vault ledger events (deposits, withdrawals, reservations, locks);\n` +
        `- held_units: units a product holds for the address, with the function that claims them;\n` +
        `- bond: the address's BOND registrations, commitments, mints and stake burns, as events;\n` +
        `- loans_opened, entries: bullet loans it opened and entries it recorded;\n` +
        `- policies: cover policies where it is insured, beneficiary or seller;\n` +
        `- futures: futures where it is long or short.\n\n` +
        `Not served by the indexer yet, and returned as structured absences: vault balances (free, reserved, locked), ` +
        `the state of an obligation, set or lien, and liquidation-cover accounts. This tool does not read the chain.`,
      inputSchema: {
        address: ADDRESS.describe('The account.'),
        sections: z.array(z.enum(SECTIONS)).min(1).optional().describe(`Which sections; default all: ${SECTIONS.join(', ')}.`),
        limit: LIMIT,
      },
    },
    async ({ address, sections, limit }) => {
      requireTier('free');
      const want = new Set(sections ?? SECTIONS);
      const a = address.toLowerCase();
      const plan: Array<[(typeof SECTIONS)[number], string, Record<string, string | number | undefined>]> = [
        ['holdings', `/accounts/${a}/holdings`, {}],
        ['vault_events', `/accounts/${a}/vault-events`, { limit }],
        ['held_units', `/accounts/${a}/held-units`, {}],
        ['bond', `/accounts/${a}/bond`, {}],
        ['loans_opened', '/bullet-loans/opened', { opener: a, limit }],
        ['entries', '/bullet-loans/entries', { owner: a, limit }],
        ['policies', '/protection/policies', { account: a, limit }],
        ['futures', '/futures', { account: a, limit }],
      ];
      const todo = plan.filter(([k]) => want.has(k));
      const calls = await Promise.all(todo.map(([, p, q]) => v2Get<Row>(p, q)));
      const data: Record<string, unknown> = { address: a };
      const perSection: Record<string, unknown> = {};
      // Sections the route pages (limit applies) and those it serves whole; the flags each row carries.
      const BOUNDED = new Set(['vault_events', 'loans_opened', 'entries', 'policies', 'futures']);
      const FLAGS: Partial<Record<(typeof SECTIONS)[number], (r: Row) => Array<boolean | null>>> = {
        loans_opened: (r) => [f(r.ownAccount)],
        policies: (r) => { const o = (r.ownAccount ?? {}) as Row; return [f(o.insured), f(o.seller)]; },
      };
      todo.forEach(([k], i) => {
        const b = calls[i].body as Row;
        const rows = k === 'holdings' ? [...((b.claims as Row[]) ?? []), ...((b.positions as Row[]) ?? [])] : ((b.rows as Row[]) ?? []);
        data[k] = k === 'holdings' ? { claims: b.claims, positions: b.positions } : b.rows;
        perSection[k] = sample({ rows, limit: BOUNDED.has(k) ? limit ?? 50 : undefined, flags: FLAGS[k], ownAccount: meta(calls[i]) });
      });
      data.notServed = { balances: notServed(GAPS.G1), obligationState: notServed(GAPS.G2), liquidationCover: notServed(GAPS.G4) };
      return answer({
        provenance: provenance(calls),
        sample: { perSection, note: 'Each section is sampled on its own: a section whose rows reach its limit is truncated; holdings, held_units and bond are served whole.' },
        data,
      });
    }
  );

  // ── R4 get_contract_events ──────────────────────────────────────────────
  server.registerTool(
    'get_contract_events',
    {
      title: 'Gavel V2 testnet contract events',
      description:
        `One event of one Gavel V2 contract on Arbitrum Sepolia, decoded, as the indexer holds it: each row's arguments, block, transaction, log index, time and sender. ` +
        `Use it for the history of an obligation, a set or a lien (e.g. contract 'Obligation', event 'SetCreated', t1 = the set id) while no state view is served. ` +
        `${ORDER_NOTE} Pages with \`cursor\`.\n\n` +
        `contract is a key from get_deployment ('Obligation', 'Lien', 'SpotMarket#2', 'BulletLoanRequest'), a name that is unique, or an address.`,
      inputSchema: {
        contract: z.string().min(1).max(64).describe('A contract key, a unique name, or an address.'),
        event: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/).describe('The event name, e.g. LoanOpened.'),
        t1: z.string().max(80).optional().describe('Match rows any of whose arguments equals this value (an id or address).'),
        t2: z.string().max(80).optional().describe('A second such value.'),
        t3: z.string().max(80).optional().describe('A third such value.'),
        from_block: z.number().int().min(0).optional(),
        to_block: z.number().int().min(0).optional(),
        cursor: z.string().regex(/^[0-9]{1,15}:[0-9]{1,9}$/).optional(),
        limit: LIMIT,
      },
    },
    async ({ contract, event, t1, t2, t3, from_block, to_block, cursor, limit }) => {
      requireTier('free');
      const c0 = resolveContract(contract);
      const c = await v2Get<{ rows: Row[]; next: string | null }>('/events', { contract: c0.address, event, t1, t2, t3, fromBlock: from_block, toBlock: to_block, cursor, limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, next: c.body.next, parties: (r) => [s(r.from)], ownAccount: meta(c) }),
        data: { contract: c0, event, rows: c.body.rows, next: c.body.next, stateNotServed: notServed(GAPS.G2) },
      });
    }
  );

  // ── R5 list_auctions ────────────────────────────────────────────────────
  server.registerTool(
    'list_auctions',
    {
      title: 'Gavel V2 testnet auctions',
      description:
        `Auctions on Gavel V2's engines on Arbitrum Sepolia that a product opened (bullet loans, spot and bill batches, secondary sales, futures), as the indexer records them.\n\n` +
        `Open: engine, auction id, product, controller, loan id, opener, amount, term, bid count, and the standing bid as the engine records it (\`bestBid\`, num/den) — ` +
        `a field name of the indexer's, not a judgement. The live end is a view of the engine (\`deadlineOf\`), not an event, and is not served here.\n` +
        `Closed: adds size, bid quantity, bid-to-cover, clearing rate, the range of bid prices, distinct bidders, status, and \`isPrice\` with \`notPriceReason\`: ` +
        `a posted take, or a clearing followed by expiry, is not a price.\n\n` +
        `${ORDER_NOTE} The route serves no own-account flag on auctions; get_auction_bids flags each bidder.\n\n` +
        `Spot and bill batches are auctions of the BatchAuction engine, and their orders are not engine bids: for them bids, distinct bidders and bid quantity are zero ` +
        `and the opener is empty by construction, not because nobody traded. get_spot_market gives each batch's orders placed, fills and clearing price.`,
      inputSchema: {
        state: z.enum(['open', 'closed']).optional().describe("Default 'open'."),
        product: z.string().regex(/^[a-z-]{1,32}$/).optional().describe("Filter by product, e.g. 'bullet-loan', 'spot'."),
        limit: LIMIT,
      },
    },
    async ({ state, product, limit }) => {
      requireTier('free');
      const c = await v2Get<{ state: string; rows: Row[] }>('/auctions', { state, product, limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, parties: (r) => [s(r.opener)], ownAccount: meta(c) }),
        data: { state: c.body.state, rows: c.body.rows },
      });
    }
  );

  // ── R6 get_auction_bids ─────────────────────────────────────────────────
  server.registerTool(
    'get_auction_bids',
    {
      title: 'Bids on a Gavel V2 testnet auction',
      description:
        `Every bid on one auction of a Gavel V2 engine on Arbitrum Sepolia: bidder, price (num/den, as the engine prices it), size, block, transaction and own-account flag. ` +
        `Newest first by sequence; not sorted by price. engine and auction_id come from list_auctions.\n\n` +
        `A spot or bill batch (the BatchAuction engine) has no engine bids, so this list is empty for it by construction; its orders are in get_spot_market.`,
      inputSchema: {
        engine: ADDRESS.describe('The engine address (list_auctions `engine`).'),
        auction_id: z.string().regex(/^[0-9]{1,78}$/).describe('The auction id, as a decimal string.'),
      },
    },
    async ({ engine, auction_id }) => {
      requireTier('free');
      const c = await v2Get<{ rows: Row[] }>(`/auctions/${engine.toLowerCase()}/${auction_id}/bids`);
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, parties: (r) => [s(r.bidder)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(c) }),
        data: {
          engine: engine.toLowerCase(), auctionId: auction_id, rows: c.body.rows,
          ...(engine.toLowerCase() === V2_DEPLOYMENT.spot.engine.toLowerCase()
            ? { batchOrders: absent('not_engine_bids', 'engine bids', 'a BatchAuction batch', { note: 'A spot or bill batch takes orders, not engine bids; get_spot_market gives its orders placed, fills and clearing price.' }) }
            : {}),
        },
      });
    }
  );

  // ── R7 list_bullet_loans ────────────────────────────────────────────────
  server.registerTool(
    'list_bullet_loans',
    {
      title: 'Gavel V2 testnet bullet loans',
      description:
        `Bullet loans on Gavel V2 on Arbitrum Sepolia, as the indexer records them.\n` +
        `- loans: contract (BulletLoanRequest or BulletLoanOffer), loan id, side, opening terms, opener, engine, auction id, status, and each origination's ref, set id and lien id;\n` +
        `- entries: bids recorded on a loan: loan id, entry id, owner, size, repayment, released.\n` +
        `${ORDER_NOTE} The set and lien ids lead to get_contract_events for their history.`,
      inputSchema: {
        view: z.enum(['loans', 'entries', 'both']).optional().describe("Default 'both'."),
        opener: ADDRESS.optional().describe('Loans opened by this address.'),
        owner: ADDRESS.optional().describe('Entries owned by this address.'),
        limit: LIMIT,
      },
    },
    async ({ view, opener, owner, limit }) => {
      requireTier('free');
      const v = view ?? 'both';
      if (v === 'loans' && owner) throw new McpError(ErrorCode.InvalidParams, "owner filters entries; with view 'loans' it would be ignored. Use opener, or view 'entries' or 'both'.");
      if (v === 'entries' && opener) throw new McpError(ErrorCode.InvalidParams, "opener filters loans; with view 'entries' it would be ignored. Use owner, or view 'loans' or 'both'.");
      const calls: Array<Call<{ rows: Row[] }>> = [];
      const data: Record<string, unknown> = {};
      if (v !== 'entries') { const c = await v2Get<{ rows: Row[] }>('/bullet-loans/opened', { opener: opener?.toLowerCase(), limit }); calls.push(c); data.loans = c.body.rows; }
      if (v !== 'loans') { const c = await v2Get<{ rows: Row[] }>('/bullet-loans/entries', { owner: owner?.toLowerCase(), limit }); calls.push(c); data.entries = c.body.rows; }
      const loans = (data.loans as Row[]) ?? [];
      const entries = (data.entries as Row[]) ?? [];
      return answer({
        provenance: provenance(calls),
        sample: {
          ...(data.loans ? { loans: sample({ rows: loans, limit: limit ?? 50, parties: (r) => [s(r.opener)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(calls[0]) }) } : {}),
          ...(data.entries ? { entries: sample({ rows: entries, limit: limit ?? 50, parties: (r) => [s(r.owner)], ownAccount: meta(calls[calls.length - 1]) }) } : {}),
        },
        data,
      });
    }
  );

  // ── R8 get_curve ────────────────────────────────────────────────────────
  server.registerTool(
    'get_curve',
    {
      title: 'Gavel V2 testnet observed rates',
      description:
        `The rates observed on Gavel V2 on Arbitrum Sepolia, point by point: each cleared bullet loan's rate (num/den) with its term and set id, and each bill market's last clearing price. ` +
        `With the count of points and of loans; from five loans up, also their time span, the distinct counterparties and the own-account share, as the indexer computes them. ` +
        `Below five loans those three are withheld, and the answer says so as a structured absence.\n\n` +
        `There is no fit, no interpolation and no forecast: these are the observations. When there are none, the answer is a structured absence, not an empty curve.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      const c = await v2Get<{ points: Row[]; n: number; span: unknown; distinctCounterparties: number; ownAccountShare: number | null }>('/curve');
      const b = c.body;
      const hasPoints = (b.points?.length ?? 0) >= 1;
      // G1 §2.2: below five loans no summary is given; the points are still served.
      const SUMMARY_MIN = 5;
      const summary = b.n >= SUMMARY_MIN
        ? {
            span: b.span, distinctAddresses: b.distinctCounterparties, ownAccountShare: b.ownAccountShare,
            ...(b.ownAccountShare === null ? { ownAccountShareReason: 'as served by the indexer: null when no party is flagged (unknown)' } : {}),
          }
        : { summary: absent('below_threshold', { loans: SUMMARY_MIN }, { loans: b.n }, { withheld: ['span', 'distinctAddresses', 'ownAccountShare'] }) };
      return answer({
        provenance: provenance([c]),
        sample: { rows: b.points?.length ?? 0, loans: b.n, ...summary },
        data: hasPoints ? { points: b.points } : absent('no_observations', { points: 1 }, { points: b.points?.length ?? 0, loans: b.n }),
      });
    }
  );

  // ── R9 list_spot_markets ────────────────────────────────────────────────
  server.registerTool(
    'list_spot_markets',
    {
      title: 'Gavel V2 testnet spot and bill markets',
      description:
        `The spot markets of Gavel V2 on Arbitrum Sepolia: the six pairs and the ten insured-bill series, each a SpotMarket clearing in batches on one BatchAuction engine. ` +
        `For each: name (or bill series k and its date D_k), SpotMarket address, the engine's market id, base and quote, and the parameters (minimum order sizes, slot durations, the open-order cap). ` +
        `In the order of the deployment record, never by price or volume.\n\n` +
        `With last: true, each market's last cleared batch from the indexer (16 calls). The indexer looks for it in the latest 50 slots; a market with none there returns a structured absence saying so, which does not mean it never cleared.`,
      inputSchema: { last: z.boolean().optional().describe("Add each market's last cleared batch.") },
    },
    async ({ last }) => {
      requireTier('free');
      const markets = [
        ...PAIRS.map((p) => ({ kind: 'pair', name: p.name, spotMarket: p.spotMarket, marketId: p.marketId, base: p.base, quote: p.quote, params: p.params })),
        ...BILLS.map((b) => ({ kind: 'bill', name: `bill-${b.k}`, k: b.k, date: b.date, billToken: b.billToken, spotMarket: b.spotMarket, marketId: b.marketId, base: `BILL-${b.k}`, quote: b.quote, params: b.params })),
      ];
      if (!last) {
        const c = await v2Get<{ contracts: Row[] }>('/deployment');
        return answer({ provenance: provenance([c]), sample: { rows: markets.length, ...NO_FLAG }, data: { engine: V2_DEPLOYMENT.spot.engine, markets } });
      }
      const calls = await Promise.all(markets.map((m) => v2Get<{ last: Row | null }>(`/spot/${m.spotMarket.toLowerCase()}/last`)));
      return answer({
        provenance: provenance(calls),
        sample: { rows: markets.length, withACleared: calls.filter((c) => c.body.last).length, lastWindowSlots: LAST_WINDOW_SLOTS, ...NO_FLAG },
        data: { engine: V2_DEPLOYMENT.spot.engine, markets: markets.map((m, i) => ({ ...m, last: calls[i].body.last ?? NO_CLEARED_IN_WINDOW })) },
      });
    }
  );

  // ── R10 get_spot_market ─────────────────────────────────────────────────
  server.registerTool(
    'get_spot_market',
    {
      title: 'A Gavel V2 testnet spot or bill market',
      description:
        `One spot or bill market of Gavel V2 on Arbitrum Sepolia, batch by batch: slot, slot id, status, clearing price, matched base volume, whether volume was low, fills, ` +
        `and orders placed on each side, with the last cleared batch. Prices are quote per base scaled by 1e18, in raw units (quote = base × price / 1e18). ` +
        `${ORDER_NOTE}\n\nWith pages: true, the clearing pages too: the keeper, steps, amount credited, keeper paid and gas used.\n\n` +
        `market is a pair ('mWBTC/mUSDC'), a bill series ('bill-3') or a SpotMarket address.`,
      inputSchema: {
        market: z.string().min(1).max(64).describe("A pair name, 'bill-<k>', or a SpotMarket address."),
        limit: LIMIT,
        pages: z.boolean().optional().describe('Add the clearing pages.'),
      },
    },
    async ({ market, limit, pages }) => {
      requireTier('free');
      const m = resolveMarket(market);
      const calls = await Promise.all([
        v2Get<{ rows: Row[] }>(`/spot/${m.spotMarket}/batches`, { limit }),
        v2Get<{ last: Row | null }>(`/spot/${m.spotMarket}/last`),
        ...(pages ? [v2Get<{ rows: Row[] }>(`/spot/${m.spotMarket}/clearing-pages`, { limit })] : []),
      ]);
      const batches = (calls[0].body as { rows: Row[] }).rows;
      const lastBatch = (calls[1].body as { last: Row | null }).last;
      return answer({
        provenance: provenance(calls as Array<Call<unknown>>),
        sample: sample({ rows: batches, limit: limit ?? 50, ownAccount: meta(calls[0]) }),
        data: {
          market: m,
          batches,
          last: lastBatch ?? NO_CLEARED_IN_WINDOW,
          ...(pages ? { clearingPages: (calls[2].body as { rows: Row[] }).rows } : {}),
        },
      });
    }
  );

  // ── R11 list_future_offers ──────────────────────────────────────────────
  server.registerTool(
    'list_future_offers',
    {
      title: 'Gavel V2 testnet future offers',
      description:
        `Offers on Gavel V2's cash-settled future on Arbitrum Sepolia, grouped by reference date T (unix): offer id, maker, the maker's side, quantity, forward price, cap per unit, ` +
        `when the offer expires, and status. Dates in calendar order; offers within a date by id. Not sorted by price.`,
      inputSchema: {},
    },
    async () => {
      requireTier('free');
      const c = await v2Get<{ byDate: Record<string, Row[]> }>('/calendar/futures-offers');
      const all = Object.values(c.body.byDate ?? {}).flat();
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: all, parties: (r) => [s(r.maker)], ownAccount: meta(c) }),
        data: all.length ? { byDate: c.body.byDate } : absent('no_offers', { offers: 1 }, { offers: 0 }),
      });
    }
  );

  // ── R12 list_futures ────────────────────────────────────────────────────
  server.registerTool(
    'list_futures',
    {
      title: 'Gavel V2 testnet futures',
      description:
        `Futures opened on Gavel V2 on Arbitrum Sepolia: future id, offer id, long and short accounts, each leg's set and obligation ids, the reference key, when opened and when settled. ${ORDER_NOTE}`,
      inputSchema: { account: ADDRESS.optional().describe('Futures where this address is long or short.'), limit: LIMIT },
    },
    async ({ account, limit }) => {
      requireTier('free');
      const c = await v2Get<{ rows: Row[] }>('/futures', { account: account?.toLowerCase(), limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, parties: (r) => [s(r.long), s(r.short)], ownAccount: meta(c) }),
        data: { rows: c.body.rows },
      });
    }
  );

  // ── R13 list_cover_offers ───────────────────────────────────────────────
  server.registerTool(
    'list_cover_offers',
    {
      title: 'Gavel V2 testnet cover offers',
      description:
        `Cover offers on Gavel V2's CoverOrchestrator on Arbitrum Sepolia: loan protection on a Gavel loan claim, and liquidation cover through an adapter. ` +
        `Each: offer id, underwriter, product, terms (asset, capacity, premium in bps, cover grace, pay delay, adapter, collateral key, minimum collateral, maximum loan grace, due window, expiry), ` +
        `capacity remaining, close status and own-account flag. ${ORDER_NOTE}\n\n` +
        `Liquidation cover is this list filtered by a MorphoCoverAdapter address (get_deployment). The state of a liquidation-cover account is not served by the indexer yet.`,
      inputSchema: {
        open: z.boolean().optional().describe('Only offers not closed.'),
        adapter: ADDRESS.optional().describe('Only offers through this adapter.'),
        limit: LIMIT,
      },
    },
    async ({ open, adapter, limit }) => {
      requireTier('free');
      const c = await v2Get<{ rows: Row[] }>('/protection/offers', { open: open ? 1 : undefined, adapter: adapter?.toLowerCase(), limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, parties: (r) => [s(r.underwriter)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(c) }),
        data: { rows: c.body.rows, liquidationCoverAccounts: notServed(GAPS.G4) },
      });
    }
  );

  // ── R14 list_policies ───────────────────────────────────────────────────
  server.registerTool(
    'list_policies',
    {
      title: 'Gavel V2 testnet cover policies',
      description:
        `Cover policies written on Gavel V2 on Arbitrum Sepolia: policy id, offer id, product, kind, insured, beneficiary, seller, the cover's set and id, the loan id or ref, units, cover, premium, phase, ` +
        `and own-account flags for the insured and the seller. ${ORDER_NOTE}`,
      inputSchema: {
        account: ADDRESS.optional().describe('Policies involving this address.'),
        role: z.enum(['insured', 'beneficiary', 'seller']).optional().describe("With account: only this role. Default any."),
        limit: LIMIT,
      },
    },
    async ({ account, role, limit }) => {
      requireTier('free');
      if (role && !account) throw new McpError(ErrorCode.InvalidParams, 'role is taken only with account.');
      const c = await v2Get<{ rows: Row[] }>('/protection/policies', { account: account?.toLowerCase(), role, limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({
          rows: c.body.rows, limit: limit ?? 50, parties: (r) => [s(r.insured), s(r.beneficiary), s(r.seller)],
          flags: (r) => { const o = (r.ownAccount ?? {}) as Row; return [f(o.insured), f(o.seller)]; }, ownAccount: meta(c),
        }),
        data: { rows: c.body.rows },
      });
    }
  );

  // ── R15 get_bill_series ─────────────────────────────────────────────────
  server.registerTool(
    'get_bill_series',
    {
      title: 'A Gavel V2 testnet insured-bill series',
      description:
        `One series of Gavel V2's insured bill on Arbitrum Sepolia: its number k and date D_k (from the deployment record: the series epoch plus k weeks), its bill token, ` +
        `its SpotMarket (pass it to get_spot_market for the batches), the events that back it (deposits, finalisations, redemptions) and the policies written for it. ${ORDER_NOTE}`,
      inputSchema: { k: z.number().int().min(1).describe(`The series number, ${BILLS[0]?.k} to ${BILLS[BILLS.length - 1]?.k} on this deployment.`) },
    },
    async ({ k }) => {
      requireTier('free');
      const bill = BILLS.find((b) => b.k === k);
      if (!bill) throw new McpError(ErrorCode.InvalidParams, `Series ${k} has no market on this deployment; series ${BILLS.map((b) => b.k).join(', ')} do.`);
      const calls = await Promise.all([v2Get<{ rows: Row[] }>(`/bills/${k}/backing`), v2Get<{ rows: Row[] }>(`/bills/${k}/policies`)]);
      return answer({
        provenance: provenance(calls as Array<Call<unknown>>),
        sample: { backing: calls[0].body.rows.length, policies: calls[1].body.rows.length, ...NO_FLAG },
        data: {
          series: { k: bill.k, date: bill.date, billToken: bill.billToken, spotMarket: bill.spotMarket, marketId: bill.marketId, quote: bill.quote },
          backing: calls[0].body.rows,
          policies: calls[1].body.rows,
        },
      });
    }
  );

  // ── R16 list_secondary_sales ────────────────────────────────────────────
  server.registerTool(
    'list_secondary_sales',
    {
      title: 'Gavel V2 testnet secondary sales',
      description:
        `Sales on Gavel V2's secondary markets on Arbitrum Sepolia: lots of loan claim units (ClaimLotMarket) and obligor positions (ObligorPositionMarket). ` +
        `Each: market, auction id, kind, seller, size, latest end, status, winner, price and the seller's own-account flag. ${ORDER_NOTE}`,
      inputSchema: {
        market: ADDRESS.optional().describe('One market (get_deployment: ClaimLotMarket or ObligorPositionMarket).'),
        state: z.string().regex(/^[A-Za-z_]{1,16}$/).optional().describe("A status as the indexer records it, e.g. 'open', 'settled'."),
        limit: LIMIT,
      },
    },
    async ({ market, state, limit }) => {
      requireTier('free');
      const c = await v2Get<{ rows: Row[] }>('/secondary/sales', { market: market?.toLowerCase(), state, limit });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, limit: limit ?? 50, parties: (r) => [s(r.seller), s(r.winner)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(c) }),
        data: { rows: c.body.rows },
      });
    }
  );

  // ── R17 get_secondary_sale_bids ─────────────────────────────────────────
  server.registerTool(
    'get_secondary_sale_bids',
    {
      title: 'Bids on a Gavel V2 testnet secondary sale',
      description:
        `Every bid on one secondary sale on Arbitrum Sepolia (bidder, price, size, transaction, own-account flag), and the bids escrowed for it. Newest first; not sorted by price.`,
      inputSchema: {
        market: ADDRESS.describe('The market (list_secondary_sales `market`).'),
        auction_id: z.string().regex(/^[0-9]{1,78}$/).describe('The auction id, as a decimal string.'),
      },
    },
    async ({ market, auction_id }) => {
      requireTier('free');
      const c = await v2Get<{ bids: Row[]; escrowed: Row[] }>(`/secondary/${market.toLowerCase()}/${auction_id}/bids`);
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.bids, parties: (r) => [s(r.bidder)], flags: (r) => [f(r.ownAccount)], ownAccount: meta(c) }),
        data: { market: market.toLowerCase(), auctionId: auction_id, bids: c.body.bids, escrowed: c.body.escrowed },
      });
    }
  );

  // ── R18 get_calendar ────────────────────────────────────────────────────
  server.registerTool(
    'get_calendar',
    {
      title: 'Gavel V2 testnet calendar',
      description:
        `Dated events on Gavel V2 on Arbitrum Sepolia between two times: bullet-loan due dates, future reference times T, and cover windows' ends, in date order. ` +
        `Bill series dates D_k are not in the events; get_bill_series and list_spot_markets give them from the deployment record.\n\n` +
        `With scenario: true, the scenario calendar the test fleet publishes instead (source 'scenario-file', not indexed): what the fleet is scheduled to do. ` +
        `It describes the testnet's own-account activity, not a forecast of the market.`,
      inputSchema: {
        from: UNIX.optional().describe('Unix time. Default now.'),
        to: UNIX.optional().describe('Unix time. Default now + 90 days.'),
        scenario: z.boolean().optional().describe("Return the fleet's scenario calendar instead."),
      },
    },
    async ({ from, to, scenario }) => {
      requireTier('free');
      if (scenario) {
        const c = await v2Get<Row>('/calendar/scenario');
        const b = c.body as Row;
        return answer({
          provenance: provenance([c]),
          sample: { rows: null, fileModifiedAt: b.fileModifiedAt ?? null },
          data: b.document ? { kind: b.kind, fileModifiedAt: b.fileModifiedAt, document: b.document } : absent('not_published', 'a published scenario file', b.absent ?? null),
        });
      }
      const c = await v2Get<{ from: number; to: number; rows: Row[]; absent: Row }>('/calendar', { from, to });
      return answer({
        provenance: provenance([c]),
        sample: sample({ rows: c.body.rows, window: { from: c.body.from, to: c.body.to }, ownAccount: meta(c) }),
        data: { from: c.body.from, to: c.body.to, rows: c.body.rows, notInEvents: c.body.absent },
      });
    }
  );
}

/** The routes each read tool calls, for scripts/check-v2-routes.mjs (the advertised-route check). */
export const V2_READ_ROUTES: Record<string, string[]> = {
  get_deployment: ['/deployment'],
  get_tape: ['/tape', '/tape/figures'],
  get_account: ['/accounts/:address/holdings', '/accounts/:address/vault-events', '/accounts/:address/held-units', '/accounts/:address/bond', '/bullet-loans/opened', '/bullet-loans/entries', '/protection/policies', '/futures'],
  get_contract_events: ['/events'],
  list_auctions: ['/auctions'],
  get_auction_bids: ['/auctions/:engine/:auctionId/bids'],
  list_bullet_loans: ['/bullet-loans/opened', '/bullet-loans/entries'],
  get_curve: ['/curve'],
  list_spot_markets: ['/deployment', '/spot/:market/last'],
  get_spot_market: ['/spot/:market/batches', '/spot/:market/last', '/spot/:market/clearing-pages'],
  list_future_offers: ['/calendar/futures-offers'],
  list_futures: ['/futures'],
  list_cover_offers: ['/protection/offers'],
  list_policies: ['/protection/policies'],
  get_bill_series: ['/bills/:k/backing', '/bills/:k/policies'],
  list_secondary_sales: ['/secondary/sales'],
  get_secondary_sale_bids: ['/secondary/:market/:auctionId/bids'],
  get_calendar: ['/calendar', '/calendar/scenario'],
};

export const V2_READ_TOOLS = Object.keys(V2_READ_ROUTES);
