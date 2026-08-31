#!/usr/bin/env node
/**
 * OB4 §1.5 — the alignment check, prompt layer.
 *
 * OB2 §1.4 asked one question of the human pages: is every fact a page renders
 * carried by a payload? (`html_only_fact`, scripts/depth-check.mjs on the Stack
 * frontend.) §1.5 asks the SAME question one layer up, of the server's own
 * self-description:
 *
 *     Every presentation a lens instructs must be derivable from the tools in
 *     its scope.
 *
 * A lens that names a tool the server does not expose is the prompt-layer
 * `html_only_fact`: an instruction to present something no payload can supply.
 * The model does not fail cleanly when that happens — it fills the gap from its
 * own knowledge, which is the single outcome this dataset's whole design exists
 * to prevent.
 *
 * ── WHY THIS CHECKS TOOL DESCRIPTIONS TOO ──────────────────────────────────
 *
 * The first run of this check found the defect in the tool descriptions rather
 * than in the lenses. D-B renames `list_gavel_indicators` -> `list_indicators`
 * on the observatory, and the rename had been applied to the NAME only: the
 * live server shipped a `list_indicators` whose description said "then call
 * get_gavel_indicator", and a `get_indicator` whose `id` parameter offered
 * 'yield-curve' — an id that server refuses with a `moved` error.
 *
 * A lens is one way a server instructs a model. A tool description is another,
 * and it is the one every client reads whether or not it supports prompts. So
 * the rule is enforced over both, and the tool half is what actually fired.
 *
 * Usage:  node scripts/check-lens-alignment.mjs [--json]
 * Exit 0 clean, 1 on any red. Requires `npm run build` first.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.NODE_ENV = 'production';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const findings = [];
const fail = (rule, detail) => findings.push({ severity: 'red', rule, detail });
const warn = (rule, detail) => findings.push({ severity: 'amber', rule, detail });

/** Build a profile's real server and ask it, rather than reading the source. */
async function surfaceFor(profileId) {
  process.env.MCP_PROFILE = profileId;
  const { PROFILES } = await import(join(ROOT, 'dist/profiles.js'));
  const { buildServer } = await import(join(ROOT, 'dist/server.js'));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const server = buildServer(PROFILES[profileId]);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ob4-alignment', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  let prompts = [];
  try { ({ prompts } = await client.listPrompts()); } catch { prompts = []; }
  const rendered = {};
  for (const p of prompts) {
    const got = await client.getPrompt({ name: p.name, arguments: {} });
    rendered[p.name] = got.messages.map((m) => m.content.text ?? '').join('\n');
  }
  await client.close();
  await server.close();
  return { tools, prompts, rendered, profile: PROFILES[profileId] };
}

/** Tool-shaped identifiers appearing in prose. */
const TOOL_MENTION = /\b(?:list|get|compare|prepare|find|check|submit|create)_[a-z0-9_]+\b/g;
const mentionsIn = (text) => [...new Set(text.match(TOOL_MENTION) ?? [])];

const obs = await surfaceFor('observatory');
const gav = await surfaceFor('gavel');
const { LENSES } = await import(join(ROOT, 'dist/prompts/lenses.js'));
const { INDICATORS } = await import(join(ROOT, 'dist/tools/indicators/catalogue.js'));
const ANCHORED = INDICATORS.filter((i) => i.anchoredTo).map((i) => i.id);

// ── 1. A tool must not instruct a call the same server cannot answer ────────
// Both servers, because a rename or a relocation can strand either one.
for (const [id, surface] of Object.entries({ observatory: obs, gavel: gav })) {
  const exposed = new Set(surface.tools.map((t) => t.name));
  for (const t of surface.tools) {
    // The `moved` shims name the tool on the OTHER server on purpose — that is
    // what a shim is for, and OB1 §1.5 requires it. Excluded by that reason.
    if (/has moved/i.test(t.description ?? '')) continue;
    const prose = [t.description ?? '', JSON.stringify(t.inputSchema ?? {})].join(' ');
    for (const m of mentionsIn(prose)) {
      if (!exposed.has(m)) {
        fail(
          'tool_describes_absent_tool',
          `${id}: '${t.name}' instructs a caller to use '${m}', which this server does not expose`
        );
      }
    }
  }
}

// ── 2. An id offered as an example must be one this server serves ──────────
for (const t of obs.tools) {
  const prose = [t.description ?? '', JSON.stringify(t.inputSchema ?? {})].join(' ');
  for (const a of ANCHORED) {
    if (new RegExp(`'${a}'`).test(prose)) {
      fail(
        'tool_offers_moved_id',
        `observatory: '${t.name}' offers '${a}' as an example id, but this server answers it with a 'moved' error`
      );
    }
  }
}

// ── 3. Lenses live on the observatory only (OB4-D1) ────────────────────────
if (!obs.prompts.length) fail('lenses_registered', 'the observatory exposes no prompts');
if (gav.prompts.length) fail('lenses_observatory_only', `the gavel server exposes ${gav.prompts.length} prompts; OB4-D1 puts none there`);
if (obs.prompts.length !== LENSES.length)
  fail('lenses_registered', `${LENSES.length} lenses defined but ${obs.prompts.length} exposed`);

// ── 4. Every tool in a lens's scope is exposed, under the exposed name ─────
const obsExposed = new Set(obs.tools.map((t) => t.name));
const gavOnly = new Set(gav.tools.map((t) => t.name).filter((n) => !obsExposed.has(n)));
for (const lens of LENSES) {
  for (const tool of lens.tools) {
    if (obsExposed.has(tool)) continue;
    if (gavOnly.has(tool)) {
      fail('lens_scope_crosses_property', `lens:${lens.id} scopes '${tool}', which lives on the GAVEL server — a lens must not reach across the split`);
    } else {
      fail('lens_scope_resolvable', `lens:${lens.id} scopes '${tool}', which no server exposes`);
    }
  }
}

// ── 5. Every tool a lens's TEXT names must be in that lens's own scope ─────
// The scope list is the promise; the prose is what the model actually follows.
for (const lens of LENSES) {
  const text = obs.rendered[`lens:${lens.id}`] ?? '';
  if (!text) { fail('lens_renders', `lens:${lens.id} rendered empty`); continue; }
  const scope = new Set(lens.tools);
  for (const m of mentionsIn(text)) {
    if (!scope.has(m)) {
      fail('lens_prose_outside_scope', `lens:${lens.id} names '${m}' in its text but does not carry it in scope`);
    }
  }
}

// ── 6. No write tool in any lens scope (OB4 §0.2 / D1) ────────────────────
const WRITE_NAME = /^(prepare_|create_|submit_|send_|sign_|broadcast_|approve_|set_|update_|delete_|write_|execute_)/;
for (const lens of LENSES) {
  for (const tool of lens.tools) {
    if (WRITE_NAME.test(tool)) fail('lens_read_only', `lens:${lens.id} scopes write-shaped tool '${tool}'`);
  }
}

// ── 7. No lens presents a venue-anchored indicator as market context ───────
// §1.4's warning. D10 made it structural by removing them from this server's
// catalogue; this asserts the copy did not keep pointing at them anyway.
for (const lens of LENSES) {
  const text = obs.rendered[`lens:${lens.id}`] ?? '';
  for (const a of ANCHORED) {
    if (new RegExp(`\\b${a}\\b`).test(text))
      fail('lens_no_anchored_indicator', `lens:${lens.id} names anchored indicator '${a}' — one venue's rate presented as market context`);
  }
}

// ── 8. Editorial v1.2, and only where the term is ASSERTED ────────────────
// "not a recommendation" and "does not say any venue is safe" are the guideline
// being OBEYED. A checker that flags them trains its reader to ignore it, so a
// term counts only outside a negation.
const BANNED = ['recommend', 'should', 'best', 'optimal', 'maximise', 'maximize', 'safest', 'safe'];
const NEGATED = /\b(no|not|never|nothing|none|without|does not|do not|cannot|neither|nor)\b[^.]{0,80}$/i;
for (const lens of LENSES) {
  const text = obs.rendered[`lens:${lens.id}`] ?? '';
  for (const term of BANNED) {
    for (const m of text.matchAll(new RegExp(`\\b${term}\\w*\\b`, 'gi'))) {
      const before = text.slice(Math.max(0, m.index - 90), m.index);
      if (!NEGATED.test(before)) {
        warn('lens_editorial_v1_2', `lens:${lens.id} uses '${m[0]}' outside a negation — read it: “…${text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\n/g, ' ')}…”`);
      }
    }
  }
}

// ── 9. Structural promises every lens makes ───────────────────────────────
const { LENSES: L } = { LENSES };
for (const lens of L) {
  const text = obs.rendered[`lens:${lens.id}`] ?? '';
  if (!lens.doesNotDo?.length) fail('lens_states_limits', `lens:${lens.id} names nothing it does not do`);
  if (!/What this lens does not do/.test(text)) fail('lens_states_limits', `lens:${lens.id} renders no limits section`);
  if (!/`unknown` is a VALUE/.test(text)) fail('lens_disclosure_verbatim', `lens:${lens.id} is missing the disclosure block`);
  if (!/Tools in scope/.test(text)) fail('lens_states_scope', `lens:${lens.id} renders no tools-in-scope section`);
}

const summary = {
  observatory: { tools: obs.tools.length, prompts: obs.prompts.map((p) => p.name) },
  gavel: { tools: gav.tools.length, prompts: gav.prompts.map((p) => p.name) },
  anchored_indicators: ANCHORED,
  lens_scopes: Object.fromEntries(LENSES.map((l) => [l.id, l.tools])),
  findings,
};
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log('OB4 §1.5 — lens/tool alignment\n');
  console.log(`observatory: ${obs.tools.length} tools, ${obs.prompts.length} lenses -> ${obs.prompts.map((p) => p.name).join(', ')}`);
  console.log(`gavel:       ${gav.tools.length} tools, ${gav.prompts.length} prompts (OB4-D1: must be 0)`);
  console.log(`anchored (served on gavel, 'moved' on observatory): ${ANCHORED.join(', ')}\n`);
  for (const l of LENSES) console.log(`  lens:${l.id.padEnd(12)} ${l.tools.length} tools in scope — all resolvable`);
  console.log('');
  if (!findings.length) console.log('§1.5 prompt layer: clean — every presentation a lens instructs is derivable from the tools in its scope.');
  else for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`);
}
process.exit(findings.some((f) => f.severity === 'red') ? 1 : 0);
