#!/usr/bin/env node
/**
 * Streamable-HTTP transport conformance, against a LIVE endpoint.
 *
 * Built 2026-08-31, after Cursor could not hold a connection to either server
 * and every check this project owns said both were healthy.
 *
 * ── WHY NOTHING CAUGHT IT ──────────────────────────────────────────────────
 *
 * Every probe in this estate is a POST. `check-profiles.mjs` and
 * `check-lens-alignment.mjs` build the server in memory and never speak HTTP at
 * all; the ops catalogue probe POSTs `tools/list`; every ad-hoc check in every
 * session POSTed. So the servers looked correct from here while being unusable
 * from a client that implements more of the transport than we ever exercised.
 *
 * The failure: `app.post('/mcp', …)` was the only route, so a GET fell through
 * to the catch-all 404. Under the spec a 404 is not a neutral "no" — it is the
 * signal that a SESSION HAS BEEN TERMINATED, and a client receiving one MUST
 * start a new session. Cursor did, five times, then tombstoned the transport
 * and disabled retry. The client was correct; the server was not.
 *
 * ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────
 *
 * Spec 2025-06-18, "Listening for Messages from the Server":
 *   "The server MUST either return Content-Type: text/event-stream in response
 *    to this HTTP GET, or else return HTTP 405 Method Not Allowed."
 *
 * "Session Management":
 *   "The server MAY respond to this [DELETE] with HTTP 405 Method Not Allowed."
 *   "The server MAY terminate the session at any time, after which it MUST
 *    respond to requests containing that session ID with HTTP 404 Not Found."
 *
 * So on the MCP endpoint a 404 is RESERVED, and answering one to a GET is a
 * protocol lie. This check exists to make that lie impossible to ship twice.
 *
 * Usage: node scripts/check-transport.mjs [url ...]
 *        (defaults to both production endpoints)
 */
const URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['https://mcp.bitcoincreditstack.com/mcp', 'https://mcp.thegavel.io/mcp'];

const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const findings = [];
const fail = (u, d) => findings.push(`${u}: ${d}`);

for (const url of URLS) {
  console.log(`\n### ${url}`);

  // POST initialize must still work — this is the half that was never broken,
  // and a check that only asserted the fix would not notice breaking it.
  let sid = null;
  try {
    const r = await fetch(url, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transport-check', version: '1.0.0' } },
      }),
    });
    sid = r.headers.get('mcp-session-id');
    console.log(`  POST initialize -> ${r.status}${sid ? ` (session ${sid})` : ' (stateless, no session id)'}`);
    if (r.status !== 200) fail(url, `POST initialize returned ${r.status}`);
    await r.text();
  } catch (e) {
    fail(url, `POST initialize unreachable: ${e.message}`);
    continue;
  }

  // GET — the one that broke. Either an SSE stream, or 405. Never 404.
  try {
    const g = await fetch(url, { method: 'GET', headers: { accept: 'text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) } });
    const ct = g.headers.get('content-type') ?? '';
    const ok = g.status === 405 || ct.includes('text/event-stream');
    console.log(`  GET  SSE stream -> ${g.status}${g.status === 405 ? ` (Allow: ${g.headers.get('allow') ?? 'MISSING'})` : ` ${ct}`}`);
    if (!ok) {
      fail(url, `GET returned ${g.status}; the spec requires text/event-stream or 405${g.status === 404 ? ' — and 404 tells every compliant client its SESSION WAS TERMINATED, which is what tombstoned Cursor' : ''}`);
    }
    if (g.status === 405 && !g.headers.get('allow')) fail(url, 'GET 405 carries no Allow header');
    if (g.body) await g.text().catch(() => {});
  } catch (e) {
    fail(url, `GET failed: ${e.message}`);
  }

  // DELETE — 405 is explicitly permitted for a server that has no sessions.
  try {
    const d = await fetch(url, { method: 'DELETE', headers: sid ? { 'mcp-session-id': sid } : {} });
    console.log(`  DELETE session  -> ${d.status}`);
    if (d.status === 404) fail(url, 'DELETE returned 404; use 405 (no sessions) or 200 — 404 means "session terminated"');
    await d.text().catch(() => {});
  } catch (e) {
    fail(url, `DELETE failed: ${e.message}`);
  }
}

console.log('');
if (findings.length) {
  console.error('TRANSPORT CONFORMANCE FAILED:');
  for (const f of findings) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('Transport conformance: clean — GET and DELETE answer 405, and 404 stays reserved for a terminated session.');
