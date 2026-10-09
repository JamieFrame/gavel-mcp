import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Profile } from '../profiles.js';
import { LENSES, promptName } from './lenses.js';

/**
 * OB4 §1.6 — the lens catalogue as a resource.
 *
 * "The knowledge corpus gains the lens catalogue as a resource
 * (`stack://lenses/index.json`) so an unfamiliar model can discover the lenses
 * before connecting."
 *
 * ── WHY A RESOURCE AND NOT JUST THE PROMPT LIST ────────────────────────────
 *
 * `prompts/list` gives a client a name, a title and a one-line description —
 * enough to draw a picker for a HUMAN who will choose one. It does not say what
 * a lens will actually instruct, which tools it will use, or what it refuses to
 * do. A model deciding whether a lens fits the question in front of it needs
 * exactly those three things, and `prompts/get` only tells it after it has
 * already committed to one.
 *
 * So the catalogue is published as a readable document: every lens with its
 * scope and its limits, in one fetch, before any lens is invoked.
 *
 * ── OB4-D2 IS THE REASON THIS IS THE RIGHT SHAPE ───────────────────────────
 *
 * D2 fixes the prompt surface small — five lenses — and puts depth in
 * resources, because "a connector exposing eighty prompts overwhelms the picker
 * and the model". This is that decision executed: the picker stays at five, and
 * the detail behind them is a document rather than more picker entries.
 *
 * OBSERVATORY ONLY, following OB4-D1. The Gavel server has no lenses, so it has
 * no lens catalogue; declaring an empty one there would advertise a surface
 * that does not exist.
 */
export function registerLensResources(server: McpServer, profile: Profile): void {
  if (profile.id !== 'observatory') return;

  server.registerResource(
    'lens-catalogue',
    'stack://lenses/index.json',
    {
      title: 'Lens catalogue',
      description:
        'Every reading lens this server offers, with the tools each one uses and what each one does not do. Read this to choose a lens before invoking it.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              // Named so a reader knows what kind of thing these are before
              // reading one. A lens is a presentation procedure, not an answer.
              about:
                'A lens is a read-only presentation procedure. It selects tools and frames how their output is presented; it never concludes, never ranks and carries no write tool — this server has none.',
              count: LENSES.length,
              lenses: LENSES.map((l) => ({
                name: promptName(l.id),
                title: l.title,
                description: l.description,
                tools: l.tools,
                does_not_do: l.doesNotDo,
              })),
              // The one thing a model must not infer from a short list.
              absent_by_design:
                'There is no lens that ranks venues, scores them, or identifies a best or cheapest one. That is not an omission from this catalogue; there is no such lens and none will be added.',
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // IX1 Phase 6 (operator, Gate 3 2026-10-09: "publish to all"): the launch note, the same text as the
  // site's /news page. Static: the figures are as read on its date, and the note says so.
  server.registerResource(
    'news-2026-10-09-indices-and-explorer',
    'stack://news/2026-10-09-indices-and-explorer.md',
    {
      title: 'News 2026-10-09: three indices and a new explorer',
      description: 'The launch note for the governed indices (bcsi, bsbs, wrc) and the explorer; dated, figures as read that day.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: NEWS_2026_10_09 }] })
  );
}

const NEWS_2026_10_09 = `# Three indices and a new explorer for the bitcoin credit market

2026-10-09 - https://www.bitcoincreditstack.com/news/2026-10-09-indices-and-explorer

The Bitcoin Credit Stack now publishes three governed indices, free with full history:

- **Bitcoin Collateral Share Index (bcsi):** how much of all bitcoin is pledged against debt. It is chain-linked, so venues entering our data don't move it. 114.5 on 2026-10-08 (100 = 2022-09-19).
- **Bitcoin-Secured Borrow Spread (bsbs):** what borrowing against bitcoin costs over 3-month Treasury bills across venues: +0.71 points on 2026-10-07, against a plain spread of +1.92 that venues entering the data have inflated.
- **Wrapper Reserve Coverage (wrc):** for WBTC, tBTC, kBTC and cdcBTC, the bitcoin at each issuer's published addresses, read on our own node, over the token's supply.

Each has a published methodology, and any change is announced 30 days ahead. Every published value is kept and can be read as known on any date.

The explorer now sets any of these beside the market's own figures and our node's chain series: collateral beside long-term-holder supply, the liquidation map beside cost basis, hashprice beside the borrow rate. Each series is in its own panel and on its own dates, with every point downloadable.

Also published: a null result. On this credit cycle, weeks when bitcoin-secured borrowing grew did not coincide with less spending of old coins; borrowing moved with the price.

All of it is descriptive: no forecasts, no signals, no ranking. Aletheia operates the thegavel.io interface and trades on Gavel for its own account; Gavel is in bcsi and bsbs at 0.0002% weight, disclosed on every value.

Figures as read on 2026-10-09; the current values are on each indicator (get_indicator).
`;
