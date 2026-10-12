#!/usr/bin/env node
/**
 * check-surface — does what the MCP SERVES stay true? (MR1 Phase 7)
 *
 * check-advertised.mjs calls the upstream paths and contract functions this
 * server consumes. This is its other half: it calls the server itself, as a
 * client does, and fails on any of the drift MR1 found and fixed by hand:
 *
 *   1. numerals   — a number in a tool description that is not a fixed fact
 *                   (MR-D3: counts are derived when served; four were stale).
 *   2. urls       — a URL in served text (descriptions, resources, the guide)
 *                   that does not answer (H-09: the methodology links pointed
 *                   at the wrong property; the OpenAPI link 404'd).
 *   3. arguments  — a tool that does not refuse an argument it does not take,
 *                   by name (MR-D4, MR-F01: `days` was silently ignored).
 *   4. questions  — a standard question whose call errors or comes back empty
 *                   (data/specs/mcp/stack_questions_v1.md).
 *   5. budgets    — a tool's default answer over its cost class's budget
 *                   (G0-9, src/content/cost-classes.ts).
 *   6. history    — list_indicators' has_history disagreeing with what
 *                   get_indicator serves.
 *   7. classes    — an observatory tool with no cost class.
 *   8. refs       — an internal reference (runbook or decision id, migration
 *                   number, spec section) in a description (design_system §1;
 *                   the API's served-text filter, gavel-indexer lib/public-text.js).
 *
 * Usage:  node scripts/check-surface.mjs <mcp endpoint> [--json]
 * Read-only. Paced under the server's anonymous limit (60 calls a minute).
 * Exit 0 = clean; 1 = findings; 2 = could not run.
 */

import { QUESTIONS } from '../dist/content/stack-questions.js';
import { COST_CLASS, CLASS_BUDGET_KB } from '../dist/content/cost-classes.js';

const EP = process.argv[2];
const JSON_OUT = process.argv.includes('--json');
const PACE = Number(process.env.SURFACE_DELAY_MS ?? 1100);
if (!EP) { console.error('usage: node scripts/check-surface.mjs <mcp endpoint>'); process.exit(2); }

const findings = [];
const passed = [];
const record = (check, name, detail, ok) => (ok ? passed : findings).push({ check, name, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = 0;
async function rpc(method, params) {
  if (method === 'tools/call') await sleep(PACE);
  const r = await fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const raw = await r.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : raw);
}
async function call(name, args) {
  const j = await rpc('tools/call', { name, arguments: args });
  const text = j.result?.content?.[0]?.text ?? '';
  let body = null; try { body = JSON.parse(text); } catch { /* prose (get_lens) */ }
  const error = j.error ? j.error.message : body?.error ? JSON.stringify(body.error) : (j.result?.isError || /^MCP error/.test(text)) ? text.slice(0, 200) : null;
  return { text, body, error, kb: Buffer.byteLength(text) / 1024 };
}

// ── 1. numerals: every number in a description must be a fixed fact ────────
// A fixed fact does not move with the data: a date, a year, a protocol or
// methodology version, a release name (H.15), a bound the tool enforces, a
// standard question id, a percentage band named by a measure. A count of
// venues, tools, series or rows is never one of these: it is served by
// get_guide, read from the data.
const FIXED = [
  /\b\d{4}-\d{2}-\d{2}\b/g,                 // dates
  /\b(?:19|20)\d{2}\b/g,                     // years
  /\bH\.\d+(?:\.\d+)?\b/g,                   // Federal Reserve releases
  /\bSQ-[A-Za-z]+\d+\b/g,                    // standard question ids
  /\bv\d+(?:\.\d+)*\b/g, /\b[a-z]+_v\d+\b/g, // versions
  /\b\d+(?:\.\d+)?\s?%/g,                    // a stated percentage (a band, a threshold)
  /\b\d+\s?(?:to|–|-)\s?\d+\b/g,             // an enforced range ("1 to 13", "30 to 1500")
  /\b\d+(?:\.\d+)?(?:d|m|y)\b/g,             // tenors (7d, 3m, 1y)
  /\b\d+-(?:month|year|day)\b/g,             // "3-month bill"
  /\b\d+\s(?:days?|months?|years?)\b/g,      // a window the tool defines
  /\bdefault \d+(?:\.\d+)?\b/g,              // a default the tool applies
  /\$\d[\d,]*\s+buckets\b/g,                 // a bucket width that defines the measure
  /\b0x[0-9a-fA-F]+\b/g,                     // addresses
  /\bERC-?\d+\b/g, /\bEIP-?\d+\b/g,          // standards
];
const ALLOWED_LITERALS = new Set(['0', '1', '2', '10', '20', '30', '100', '155', '200', '365', '500']);
function strayNumerals(text) {
  let t = text;
  for (const re of FIXED) t = t.replace(re, ' ');
  return [...new Set((t.match(/\b\d[\d,.]*\b/g) ?? []).filter((n) => !ALLOWED_LITERALS.has(n.replace(/[,.]$/, ''))))];
}

// ── 8. refs: the API's served-text patterns (gavel-indexer lib/public-text.js REF_SRC) ──
const RUNBOOK = '(?:CX|PV|OB|HX|IX|CS|EH|EC|RW|SV|FB|NX|AF|VC|OC|FP|SA|DI|MR|AD|TA|TP|CU|CO|SR|UT|FL)';
const REF = new RegExp([
  String.raw`\b${RUNBOOK}\d+[a-z]?(?:-[A-Z]{1,2}\d+[a-z]?)?\b`, String.raw`\bG0-\d+[a-z]?\b`,
  String.raw`§\s?\d+(?:\.\d+)*`, String.raw`\b(?:ingest )?migrations? \d+\b`, String.raw`\bhole #\d+\b`,
].join('|'), 'g');

// ── 2. urls ─────────────────────────────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g;
async function resolves(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow' });
    return r.status;
  } catch (e) { return 0; }
}

(async () => {
  const list = await rpc('tools/list', {});
  const tools = list.result?.tools ?? [];
  if (!tools.length) { console.error('tools/list returned nothing'); process.exit(2); }

  // 1. numerals
  for (const t of tools) {
    const stray = strayNumerals(t.description ?? '');
    record('numerals', t.name, stray.length ? `numbers that are not fixed facts: ${stray.join(', ')}` : 'none', !stray.length);
  }

  // 8. refs: tool descriptions, and the indicator catalogue's descriptions and units (served text too)
  for (const t of tools) {
    const refs = [...new Set((t.description ?? '').match(REF) ?? [])];
    record('refs', t.name, refs.length ? `internal references: ${refs.join(', ')}` : 'none', !refs.length);
  }
  const cat = (await call('list_indicators', {})).body;
  for (const i of cat?.indicators ?? []) {
    const refs = [...new Set(`${i.description ?? ''} ${i.units ?? ''}`.match(REF) ?? [])];
    record('refs', `indicator ${i.id}`, refs.length ? `internal references: ${refs.join(', ')}` : 'none', !refs.length);
  }

  // 7. classes
  for (const t of tools) record('classes', t.name, COST_CLASS[t.name] ?? 'no cost class', !!COST_CLASS[t.name]);

  // 2. urls: descriptions, resources, the guide
  const texts = tools.map((t) => t.description ?? '');
  const res = await rpc('resources/list', {});
  for (const r of res.result?.resources ?? []) {
    const c = await rpc('resources/read', { uri: r.uri });
    texts.push(c.result?.contents?.[0]?.text ?? '');
  }
  texts.push((await call('get_guide', {})).text);
  const urls = [...new Set(texts.flatMap((t) => t.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:]+$/, '')))]
    .filter((u) => !/[<{]/.test(u) && !/localhost|127\.0\.0\.1|example\./.test(u));
  for (const u of urls) {
    const s = await resolves(u);
    record('urls', u, String(s), s >= 200 && s < 400);
  }

  // 3. arguments: one argument no tool takes, refused by name
  for (const t of tools) {
    const r = await call(t.name, { __surface_probe: 1 });
    const refused = /unrecognized_keys/.test(r.text) && /__surface_probe/.test(r.text);
    record('arguments', t.name, refused ? 'refused by name' : `not refused: ${r.text.slice(0, 120)}`, refused);
  }

  // 4. questions, and 5. budgets on each default call
  const defaultCalls = new Map();
  for (const q of QUESTIONS) {
    const r = await call(q.tool, q.args);
    // Only a series fetch can come back empty; a catalogue's rows carry no points by design.
    const empty = q.tool === 'get_series' && r.body && Array.isArray(r.body.series) && r.body.series.every((s) => !s.points?.length && !s.error);
    record('questions', q.id, r.error ? `error: ${r.error.slice(0, 140)}` : empty ? 'answered with no values' : `${r.kb.toFixed(0)} KB`, !r.error && !empty);
    if (!Object.keys(q.args).length) defaultCalls.set(q.tool, r.kb);
  }
  for (const t of tools) {
    const required = t.inputSchema?.required ?? [];
    if (required.length || defaultCalls.has(t.name)) continue;
    const r = await call(t.name, {});
    if (!r.error) defaultCalls.set(t.name, r.kb);
  }
  for (const [name, kb] of defaultCalls) {
    const cls = COST_CLASS[name]; const budget = cls ? CLASS_BUDGET_KB[cls] : null;
    record('budgets', name, budget ? `${kb.toFixed(0)} KB of ${budget} KB (${cls})` : 'no class', budget != null && kb <= budget);
  }

  // 6. has_history flags
  const ind = (await call('list_indicators', {})).body;
  for (const i of (ind?.indicators ?? []).filter((x) => x.live)) {
    const r = await call('get_indicator', { id: i.id, include_history: true });
    const serves = !r.error;
    record('history', i.id, `has_history ${i.has_history}, history ${serves ? 'served' : 'refused'}`, serves === !!i.has_history);
  }

  const by = (c) => ({ passed: passed.filter((x) => x.check === c).length, findings: findings.filter((x) => x.check === c).length });
  const checks = ['numerals', 'refs', 'urls', 'arguments', 'questions', 'budgets', 'history', 'classes'];
  if (JSON_OUT) console.log(JSON.stringify({ endpoint: EP, checks: Object.fromEntries(checks.map((c) => [c, by(c)])), findings }, null, 2));
  else {
    console.log(`check-surface ${EP}`);
    for (const c of checks) console.log(`  ${c.padEnd(10)} ${by(c).passed} pass, ${by(c).findings} finding(s)`);
    for (const f of findings) console.log(`  ✗ ${f.check} · ${f.name}: ${f.detail}`);
  }
  process.exit(findings.length ? 1 : 0);
})().catch((e) => { console.error('check-surface could not run:', e.message); process.exit(2); });
