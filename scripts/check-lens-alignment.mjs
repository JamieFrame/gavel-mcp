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
 * Usage:  node scripts/check-lens-alignment.mjs [--json] [--test-lens="<text>"]
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
  let resources = [];
  let lensDoc = null;
  try {
    ({ resources } = await client.listResources());
    if (resources.some((r) => r.uri === 'stack://lenses/index.json')) {
      const doc = await client.readResource({ uri: 'stack://lenses/index.json' });
      lensDoc = JSON.parse(doc.contents[0].text);
    }
  } catch { resources = []; }
  const rendered = {};
  for (const p of prompts) {
    const got = await client.getPrompt({ name: p.name, arguments: {} });
    rendered[p.name] = got.messages.map((m) => m.content.text ?? '').join('\n');
  }
  await client.close();
  await server.close();
  return { tools, prompts, rendered, resources, lensDoc, profile: PROFILES[profileId] };
}

/** Tool-shaped identifiers appearing in prose. */
const TOOL_MENTION = /\b(?:list|get|compare|prepare|find|check|submit|create)_[a-z0-9_]+\b/g;
const mentionsIn = (text) => [...new Set(text.match(TOOL_MENTION) ?? [])];

const obs = await surfaceFor('observatory');
const gav = await surfaceFor('gavel');
const { LENSES, promptName } = await import(join(ROOT, 'dist/prompts/lenses.js'));
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
    // `title` included: it is the field a client renders, and leaving it out
    // is how 'Get a Gavel Indicator' survived the first pass of this check.
    const prose = [t.title ?? '', t.description ?? '', JSON.stringify(t.inputSchema ?? {})].join(' ');
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
  const prose = [t.title ?? '', t.description ?? '', JSON.stringify(t.inputSchema ?? {})].join(' ');
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
      fail('lens_scope_crosses_property', `${promptName(lens.id)} scopes '${tool}', which lives on the GAVEL server — a lens must not reach across the split`);
    } else {
      fail('lens_scope_resolvable', `${promptName(lens.id)} scopes '${tool}', which no server exposes`);
    }
  }
}

// ── 5. Every tool a lens's TEXT names must be in that lens's own scope ─────
// The scope list is the promise; the prose is what the model actually follows.
for (const lens of LENSES) {
  const text = obs.rendered[promptName(lens.id)] ?? '';
  if (!text) { fail('lens_renders', `${promptName(lens.id)} rendered empty`); continue; }
  const scope = new Set(lens.tools);
  for (const m of mentionsIn(text)) {
    if (!scope.has(m)) {
      fail('lens_prose_outside_scope', `${promptName(lens.id)} names '${m}' in its text but does not carry it in scope`);
    }
  }
}

// ── 6. No write tool in any lens scope (OB4 §0.2 / D1) ────────────────────
const WRITE_NAME = /^(prepare_|create_|submit_|send_|sign_|broadcast_|approve_|set_|update_|delete_|write_|execute_)/;
for (const lens of LENSES) {
  for (const tool of lens.tools) {
    if (WRITE_NAME.test(tool)) fail('lens_read_only', `${promptName(lens.id)} scopes write-shaped tool '${tool}'`);
  }
}

// ── 7. No lens presents a venue-anchored indicator as market context ───────
// §1.4's warning. D10 made it structural by removing them from this server's
// catalogue; this asserts the copy did not keep pointing at them anyway.
for (const lens of LENSES) {
  const text = obs.rendered[promptName(lens.id)] ?? '';
  for (const a of ANCHORED) {
    if (new RegExp(`\\b${a}\\b`).test(text))
      fail('lens_no_anchored_indicator', `${promptName(lens.id)} names anchored indicator '${a}' — one venue's rate presented as market context`);
  }
}

// ── 8. Editorial v1.2, and only where the term is ASSERTED ────────────────
// "not a recommendation" and "does not say any venue is safe" are the guideline
// being OBEYED. A checker that flags them trains its reader to ignore it, so a
// term counts only outside a negation.
const BANNED = ['recommend', 'should', 'best', 'optimal', 'maximise', 'maximize', 'safest', 'safe'];
const NEGATED = /\b(no|not|never|nothing|none|without|does not|do not|cannot|neither|nor)\b[^.]{0,80}$/i;
for (const lens of LENSES) {
  const text = obs.rendered[promptName(lens.id)] ?? '';
  for (const term of BANNED) {
    for (const m of text.matchAll(new RegExp(`\\b${term}\\w*\\b`, 'gi'))) {
      const before = text.slice(Math.max(0, m.index - 90), m.index);
      if (!NEGATED.test(before)) {
        warn('lens_editorial_v1_2', `${promptName(lens.id)} uses '${m[0]}' outside a negation — read it: “…${text.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\n/g, ' ')}…”`);
      }
    }
  }
}

// ── 9. Structural promises every lens makes ───────────────────────────────
const { LENSES: L } = { LENSES };
for (const lens of L) {
  const text = obs.rendered[promptName(lens.id)] ?? '';
  if (!lens.doesNotDo?.length) fail('lens_states_limits', `${promptName(lens.id)} names nothing it does not do`);
  if (!/What this lens does not do/.test(text)) fail('lens_states_limits', `${promptName(lens.id)} renders no limits section`);
  if (!/`unknown` is a VALUE/.test(text)) fail('lens_disclosure_verbatim', `${promptName(lens.id)} is missing the disclosure block`);
  if (!/Tools in scope/.test(text)) fail('lens_states_scope', `${promptName(lens.id)} renders no tools-in-scope section`);
}

// ── 10. The lens catalogue resource agrees with the lenses it describes ───
// OB4 §1.6 publishes the catalogue as a document so a model can choose a lens
// before invoking one. A document that describes a lens the server does not
// serve, or names a tool it does not expose, is the same defect as a lens
// naming an absent tool — one level further out, and read EARLIER.
if (obs.lensDoc) {
  const doc = obs.lensDoc;
  if (doc.count !== LENSES.length)
    fail('lens_resource_agrees', `stack://lenses/index.json says ${doc.count} lenses; ${LENSES.length} are defined`);
  const promptNames = new Set(obs.prompts.map((p) => p.name));
  for (const l of doc.lenses ?? []) {
    if (!promptNames.has(l.name))
      fail('lens_resource_agrees', `the catalogue lists '${l.name}', which this server does not expose as a prompt`);
    for (const t of l.tools ?? []) {
      if (!obsExposed.has(t))
        fail('lens_resource_agrees', `the catalogue gives '${l.name}' the tool '${t}', which this server does not expose`);
    }
    if (!(l.does_not_do ?? []).length)
      fail('lens_resource_agrees', `the catalogue lists '${l.name}' with no limits — every lens must name what it does not do`);
  }
} else if (obs.resources.length) {
  warn('lens_resource_agrees', 'the observatory declares resources but serves no lens catalogue');
} else {
  warn('lens_resource_agrees', 'the observatory serves no lens catalogue (OB4 §1.6 asks for stack://lenses/index.json)');
}
if (gav.resources.length)
  fail('lens_resource_observatory_only', `the gavel server exposes ${gav.resources.length} resource(s); the lens corpus is the observatory's`);

// ── 11. get_lens: the delivery path that clients actually read ───────────
// The prompts are correct and INVISIBLE — no client tested surfaces them. The
// tool is how the lens layer reaches anyone, so it is checked at least as hard
// as the prompts are, and its content must be the SAME content: two renderings
// of one lens that could drift would be worse than one that never shipped.
{
  const tool = obs.tools.find((t) => t.name === 'get_lens');
  if (!tool) {
    fail('lens_tool_present', 'the observatory does not expose get_lens — with no client surfacing prompts, the lens layer reaches nobody');
  } else {
    const enumIds = tool.inputSchema?.properties?.lens?.enum ?? [];
    const defined = LENSES.map((l) => l.id);
    for (const id of defined) {
      if (!enumIds.includes(id)) fail('lens_tool_complete', `get_lens does not offer '${id}', which is a defined lens`);
    }
    for (const id of enumIds) {
      if (!defined.includes(id)) fail('lens_tool_complete', `get_lens offers '${id}', which is not a defined lens`);
    }
  }
  if (gav.tools.some((t) => t.name === 'get_lens')) {
    fail('lens_tool_observatory_only', 'the gavel server exposes get_lens; OB4-D1 keeps the lens layer on the observatory');
  }
}

// ── 12. The credit conditions panel: no lens asks to sum, average or count its rows (RED) ──
// CN1 (aletheia-docs data/specs/indicators/credit_conditions_panel_v1.md §6.2, §6.4; CN-R2): the panel
// states, for each measure on its own, where its reading sits in its own history. Nothing adds, averages,
// counts or weights the rows — counting how many sit at an extreme included. A lens may name the panel; it
// must not instruct the reader's model to aggregate it. Unlike rule 8 this is red: an instruction to combine
// the rows rebuilds the composite the panel was designed not to be. A negation ("never sum the rows") is the
// rule being obeyed, so it is exempt, as in rule 8.
// Usage: --test-lens="<text>" adds one stand-in lens text to the run, so the rule can be seen to refuse it.
const AGG_VERB = '(?:sum(?:s|med|ming)?|add(?:s|ed|ing)? up|total(?:s|led|ling)?|averag(?:e|es|ed|ing)|mean|count(?:s|ed|ing)?|tall(?:y|ies|ied|ying)|combin(?:e|es|ed|ing)|aggregat(?:e|es|ed|ing)|weight(?:s|ed|ing)?)';
const AGG_OBJ = '(?:rows?|components?|positions?|percentiles?|bands?|extremes?|panel)';
const AGGREGATE = new RegExp(`\\b${AGG_VERB}\\b[^.\\n]{0,60}?\\b${AGG_OBJ}\\b|\\bhow many\\b[^.\\n]{0,40}?\\b${AGG_OBJ}\\b`, 'gi');
// "count" after a determiner is the noun ("its counts (below, equal, n)", "the observation count"), not an instruction.
const COUNT_NOUN = /\b(?:the|its|their|a|as|with|of|and|observation)\s+$/i;
/** Each instruction in `text` to aggregate the panel's rows, outside a negation. */
function aggregateAsks(text) {
  const out = [];
  for (const m of text.matchAll(AGGREGATE)) {
    const before = text.slice(Math.max(0, m.index - 90), m.index);
    if (NEGATED.test(before)) continue;
    if (/^count/i.test(m[0]) && COUNT_NOUN.test(before)) continue;
    out.push(m[0]);
  }
  return out;
}
// The rule checks itself first: a rule that stopped matching would pass every lens.
{
  const MUST_REFUSE = [
    'Sum the percentiles of the rows and give the total.',
    'Average the four rows into one reading of credit conditions.',
    'Count how many rows sit in their highest tenth.',
    'Tell the reader how many components are at an extreme of their history.',
  ];
  const MUST_PASS = [
    'Present each row on its own; never sum, average or count the rows.',
    'The rows are not combined, ranked or scored.',
    'Render provenance with every figure: the observation count where one is given.',
    'Give each row as counts (below, equal, n) and the percentile computed from them.',
  ];
  for (const t of MUST_REFUSE) if (!aggregateAsks(t).length) fail('lens_no_panel_aggregate_self_test', `the rule did not refuse: “${t}”`);
  for (const t of MUST_PASS) if (aggregateAsks(t).length) fail('lens_no_panel_aggregate_self_test', `the rule refused an obeying sentence: “${t}”`);
}
const testLens = process.argv.find((a) => a.startsWith('--test-lens='))?.slice('--test-lens='.length) ?? null;
const lensTexts = [...LENSES.map((l) => [promptName(l.id), obs.rendered[promptName(l.id)] ?? '']), ...(testLens != null ? [['lens_test (--test-lens)', testLens]] : [])];
for (const [name, text] of lensTexts) {
  for (const ask of aggregateAsks(text)) {
    fail('lens_no_panel_aggregate', `${name} asks to aggregate the credit conditions rows: “${ask}” — each row is read on its own; nothing sums, averages or counts them (CN-R2)`);
  }
}

// ── 13. The credit conditions panel's words (RED) ───────────────────────────
// Spec §6.4's copy check, on this server's half: the panel's catalogue row and every lens line that names it
// carry no signal or verdict word. Limited to the panel, as the site's check is (the word "signal" appears in
// negations elsewhere). No negation exemption: these words do not appear at all.
const PANEL_WORDS = /\b(fear|greed|healthy|unhealthy|stress(?:ed)?|overheated|cheap|rich|bullish|bearish|signal|risk-on|risk-off|predicts|leading|early warning)\b/i;
{
  const row = INDICATORS.find((i) => i.id === 'credit-conditions');
  if (row) {
    const prose = [row.name, row.units, row.description, row.historyElsewhere ?? '', row.note ?? ''].join(' ');
    const w = prose.match(PANEL_WORDS);
    if (w) fail('panel_words', `the credit-conditions catalogue row uses '${w[0]}'`);
  }
  for (const [name, text] of lensTexts) {
    for (const line of text.split('\n').filter((l) => /credit-conditions|credit conditions/i.test(l))) {
      const w = line.match(PANEL_WORDS);
      if (w) fail('panel_words', `${name} uses '${w[0]}' in a line naming the credit conditions panel`);
    }
  }
}

const summary = {
  observatory: { tools: obs.tools.length, prompts: obs.prompts.map((p) => p.name), resources: obs.resources.map((r) => r.uri) },
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
  for (const l of LENSES) console.log(`  ${promptName(l.id).padEnd(18)} ${l.tools.length} tools in scope — all resolvable`);
  console.log('');
  if (!findings.length) console.log('§1.5 prompt layer: clean — every presentation a lens instructs is derivable from the tools in its scope.');
  else for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`);
}
process.exit(findings.some((f) => f.severity === 'red') ? 1 : 0);
