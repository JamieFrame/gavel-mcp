#!/usr/bin/env node
/**
 * The answer harness — what does the server actually answer?
 *
 * Added for MR1 (aletheia-docs runbooks/PLANNED/runbook_MR1_stack_mcp_refinement_v1.md,
 * Phase 1). Every server change is shown to the operator as answers, before and
 * after, not as a diff of source. This runs a fixed call set against any MCP
 * endpoint and records, per call: whether it answered or erred, the error's
 * shape, the answer's size and top-level keys, how many absences and zeros it
 * holds, and the numerals and URLs in its text. It also records tools/list:
 * names, arguments, and the numerals and URLs in every description.
 *
 * Usage:
 *   node scripts/harness/run.mjs <endpoint> <out.json> [calls.json]
 *   node scripts/harness/run.mjs --diff <before.json> <after.json>
 *
 * Read-only: every call in the set is a read on a read-only server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function rpc(endpoint, method, params, id) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '));
  const body = line ? line.slice(6) : raw;
  return { bytes: Buffer.byteLength(raw), json: JSON.parse(body) };
}

const URL_RE = /https?:\/\/[^\s"'`)<>\]]+/g;
// A numeral standing as a count in prose: "the other 161", "~160 rows", "(8 of 8)".
const COUNT_RE = /(?:~|about |the other |\()?\b\d{1,4}\b(?: of \d{1,4}\))?(?= (?:rows|venues|classes|indicators|series|tools|of|\)))/g;

function walk(v, visit, key = '') {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { visit(k, x); walk(x, visit, k); }
}

function summarise(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  const out = { top_keys: null, absences: 0, absent_kinds: {}, zeros: 0, urls: [...new Set(text.match(URL_RE) || [])] };
  if (parsed && typeof parsed === 'object') {
    out.top_keys = Array.isArray(parsed) ? ['[array]'] : Object.keys(parsed);
    walk(parsed, (k, x) => {
      if (k === 'kind' && typeof x === 'string' && x.startsWith('absent')) {
        out.absences++; out.absent_kinds[x] = (out.absent_kinds[x] || 0) + 1;
      }
      if (k === 'value' && (x === 0 || x === '0' || /^0\.0+$/.test(String(x)))) out.zeros++;
    });
  }
  return out;
}

async function run(endpoint, outFile, callsFile) {
  const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  const init = await rpc(endpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'answer-harness', version: '1' } }, 0);
  const list = await rpc(endpoint, 'tools/list', {}, 1);
  const tools = list.json.result.tools.map((t) => {
    const props = t.inputSchema?.properties || {};
    const texts = [t.description || '', ...Object.values(props).map((p) => p.description || '')].join('\n');
    return {
      name: t.name,
      args: Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.enum ? `enum(${p.enum.join('|')})` : (p.type || '?')])),
      required: t.inputSchema?.required || [],
      counts_in_text: [...new Set(texts.match(COUNT_RE) || [])],
      urls_in_text: [...new Set(texts.match(URL_RE) || [])],
      description_chars: (t.description || '').length,
    };
  });
  const results = [];
  let n = 2;
  for (const c of calls) {
    const t0 = Date.now();
    let r;
    try { r = await rpc(endpoint, 'tools/call', { name: c.tool, arguments: c.args }, n++); }
    catch (e) { results.push({ id: c.id, tool: c.tool, args: c.args, transport_error: String(e) }); continue; }
    const ms = Date.now() - t0;
    if (r.json.error) { results.push({ id: c.id, tool: c.tool, args: c.args, ms, bytes: r.bytes, outcome: 'rpc_error', error: r.json.error }); continue; }
    const res = r.json.result;
    const text = (res.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const entry = { id: c.id, tool: c.tool, args: c.args, ms, bytes: r.bytes, outcome: res.isError ? 'tool_error' : 'answer' };
    if (res.isError) entry.error_text = text.slice(0, 400);
    Object.assign(entry, summarise(text));
    results.push(entry);
  }
  const out = {
    endpoint, read_at: new Date().toISOString(),
    server: init.json.result?.serverInfo,
    instructions_chars: (init.json.result?.instructions || '').length,
    tool_count: tools.length, tools, results,
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
  for (const r of results) {
    console.log(`${r.outcome ?? 'transport'}\t${String(r.bytes ?? '').padStart(8)}\t${r.id}${r.error_text ? '\t' + r.error_text.slice(0, 90).replace(/\n/g, ' ') : ''}`);
  }
}

function diff(aFile, bFile) {
  const a = JSON.parse(fs.readFileSync(aFile, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  const lines = [`# Answers: ${a.endpoint} (${a.read_at}) → ${b.endpoint} (${b.read_at})`, ''];
  const ta = new Map(a.tools.map((t) => [t.name, t])), tb = new Map(b.tools.map((t) => [t.name, t]));
  lines.push(`Tools: ${a.tool_count} → ${b.tool_count}`, '');
  for (const name of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(name), y = tb.get(name);
    if (!x) { lines.push(`- **${name}** added: args ${JSON.stringify(y.args)}`); continue; }
    if (!y) { lines.push(`- **${name}** REMOVED`); continue; }
    const d = [];
    if (JSON.stringify(x.args) !== JSON.stringify(y.args)) d.push(`args ${JSON.stringify(x.args)} → ${JSON.stringify(y.args)}`);
    if (JSON.stringify(x.counts_in_text) !== JSON.stringify(y.counts_in_text)) d.push(`counts in text ${JSON.stringify(x.counts_in_text)} → ${JSON.stringify(y.counts_in_text)}`);
    if (JSON.stringify(x.urls_in_text) !== JSON.stringify(y.urls_in_text)) d.push(`urls ${JSON.stringify(x.urls_in_text)} → ${JSON.stringify(y.urls_in_text)}`);
    if (d.length) lines.push(`- **${name}**: ${d.join('; ')}`);
  }
  lines.push('', '| call | before | after |', '|---|---|---|');
  const rb = new Map(b.results.map((r) => [r.id, r]));
  const cell = (r) => !r ? '—' : `${r.outcome} · ${Math.round((r.bytes || 0) / 1024)} KB` +
    (r.absences ? ` · ${r.absences} absent` : '') + (r.error_text ? ` · "${r.error_text.slice(0, 80).replace(/\n|\|/g, ' ')}"` : '');
  for (const r of a.results) {
    const s = rb.get(r.id);
    const ca = cell(r), cb = cell(s);
    lines.push(`| ${r.id} | ${ca} | ${ca === cb ? '(same)' : cb} |`);
  }
  for (const s of b.results) if (!a.results.find((r) => r.id === s.id)) lines.push(`| ${s.id} | — | ${cell(s)} |`);
  console.log(lines.join('\n'));
}

const argv = process.argv.slice(2);
if (argv[0] === '--diff') diff(argv[1], argv[2]);
else if (argv.length >= 2) await run(argv[0], argv[1], argv[2] || path.join(here, 'calls.observatory.json'));
else { console.error('usage: run.mjs <endpoint> <out.json> [calls.json] | --diff <a.json> <b.json>'); process.exit(2); }
