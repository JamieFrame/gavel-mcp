#!/usr/bin/env node
/**
 * OB1 lint — the enforcement half of runbook §0.1 and §0.3.
 *
 *   §0.1  The observatory has no write tools, no blueprint tools, no prepare_*,
 *         and no tool that names Gavel outside its uniform venue row.
 *         "A write tool appearing on it is a red finding. Lint enforced."
 *   §0.3  One tool, one home. A name on both servers must be recorded as
 *         `both-split` in the disposition table; anything else is drift.
 *
 * It does not read the allowlist and call that a pass. It BUILDS each profile's
 * server and asks it `tools/list` over an in-memory transport — the same
 * question the remote sensor asks the live host — so a tool that the allowlist
 * forgot, or that registered under an unexpected name, is caught here rather
 * than in production.
 *
 * Usage:  node scripts/check-profiles.mjs [--json]
 * Exit 0 clean, 1 on any finding.  Requires `npm run build` first.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Structured logging: pino-pretty is a devDependency and is absent under
// `npm install --omit=dev`, where this lint still has to run.
process.env.NODE_ENV = 'production';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const findings = [];
const fail = (rule, detail) => findings.push({ severity: 'red', rule, detail });
const warn = (rule, detail) => findings.push({ severity: 'amber', rule, detail });

/** Ask a built profile for its real tools/list. */
async function toolsFor(profileId) {
  process.env.MCP_PROFILE = profileId;
  const { PROFILES } = await import('../dist/profiles.js');
  const { buildServer } = await import('../dist/server.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  const server = buildServer(PROFILES[profileId]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ob1-lint', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const instructions = server.server.getInstructions?.() ?? PROFILES[profileId].instructions;
  await client.close();
  await server.close();
  return { tools, profile: PROFILES[profileId], instructions };
}

const obs = await toolsFor('observatory');
const gav = await toolsFor('gavel');
const obsNames = obs.tools.map((t) => t.name);
const gavNames = gav.tools.map((t) => t.name);

// ── §0.1 no write tools ─────────────────────────────────────────────────────
// Name-shaped and annotation-shaped, because either alone can be evaded.
const WRITE_NAME = /^(prepare_|create_|submit_|send_|sign_|broadcast_|approve_|set_|update_|delete_|write_|execute_)/;
for (const t of obs.tools) {
  if (WRITE_NAME.test(t.name)) fail('observatory_no_write_tools', `'${t.name}' has a write-verb name`);
  if (t.annotations && t.annotations.readOnlyHint === false)
    fail('observatory_no_write_tools', `'${t.name}' declares readOnlyHint:false`);
  const d = (t.description || '').toLowerCase();
  if (d.includes('unsigned transaction blueprint') || d.includes('calldata'))
    fail('observatory_no_write_tools', `'${t.name}' description offers transaction calldata`);
}

// ── §0.1 no tool names Gavel ────────────────────────────────────────────────
for (const name of obsNames) {
  if (/gavel/i.test(name)) fail('observatory_names_no_venue', `tool name '${name}' names a venue`);
}
// The venue row itself is the permitted place; a description may name Gavel only
// as one row among others, so this is a warning to be read, not an auto-red.
// A description may name Gavel only as one row among others. These are warnings
// to be read and ruled on, not auto-reds: a tool that serves one venue's own
// figures under its own name is exactly the "Gavel-special" the gate asks about,
// and the disposition table is where that is decided.
for (const t of obs.tools) {
  if (/gavel/i.test(t.description || '') && !/venue/i.test(t.description || ''))
    warn(
      'observatory_names_no_venue',
      `'${t.name}' description names Gavel with no venue framing — confirm this tool is not a venue-specific surface other venues do not get`
    );
}

// ── §0.3 one tool, one home ─────────────────────────────────────────────────
// A `moved` shim is a redirect, not a home: the name is present but answers with
// an error naming the other server. It is excluded from the uniqueness rule and
// checked separately below — if it ever starts SERVING, that is a real finding.
const { BOTH_SPLIT_TOOLS, MOVED_FROM_GAVEL } = await import('../dist/profiles.js');
const bothSplit = new Set(BOTH_SPLIT_TOOLS);
const shims = new Set(MOVED_FROM_GAVEL);
for (const name of obsNames.filter((n) => gavNames.includes(n))) {
  if (bothSplit.has(name) || shims.has(name)) continue;
  fail('tool_home_unique', `'${name}' is exposed on BOTH servers but is not recorded as both-split`);
}
// A shim must be a shim: present on gavel, absent from its allowlist, and its
// description must name where the tool went.
for (const name of shims) {
  const t = gav.tools.find((x) => x.name === name);
  if (!t) { warn('moved_tool_shim', `'${name}' has no shim on the gavel server`); continue; }
  if (gav.profile.tools.includes(name))
    fail('moved_tool_shim', `'${name}' is both shimmed and allowlisted on gavel — it cannot be moved and served`);
  if (!/moved/i.test(t.description || ''))
    fail('moved_tool_shim', `'${name}' shim does not say it moved`);
}
for (const name of bothSplit) {
  if (!(obsNames.includes(name) && gavNames.includes(name)))
    fail('tool_home_unique', `'${name}' is recorded both-split but is not on both servers`);
}

// ── allowlist honesty: declared == exposed ──────────────────────────────────
for (const [id, { profile, tools }] of Object.entries({ observatory: obs, gavel: gav })) {
  const exposed = new Set(tools.map((t) => t.name));
  for (const declared of profile.tools) {
    const expected = profile.renames[declared] ?? declared;
    if (!exposed.has(expected))
      fail('profile_allowlist_honest', `${id}: '${declared}' is allowlisted but not registered (expected '${expected}')`);
  }
}

// ── §0.4 the disclosure is present, verbatim ────────────────────────────────
const { OBSERVATORY_DISCLOSURE } = await import('../dist/profiles.js');
if (!obs.instructions.includes(OBSERVATORY_DISCLOSURE))
  fail('observatory_disclosure_present', 'the §0.4 disclosure is missing from the observatory instructions');

// ── registry file sanity — the AD2 100-char trap ────────────────────────────
const sj = JSON.parse(readFileSync(join(ROOT, 'server.observatory.json'), 'utf8'));
if (sj.name !== 'io.aletheia/bitcoin-credit-stack')
  fail('registry_id_fixed', `server.observatory.json name is '${sj.name}', not the OB1-D3 id`);
if ((sj.description || '').length > 100)
  fail('registry_description_cap', `description is ${sj.description.length} chars; the registry caps it at 100`);

const summary = {
  observatory: { count: obsNames.length, tools: obsNames },
  gavel: { count: gavNames.length, tools: gavNames },
  both_split: [...bothSplit],
  moved_shims: [...shims],
  findings,
};
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`observatory: ${obsNames.length} tools -> ${obsNames.join(', ')}`);
  console.log(`gavel:       ${gavNames.length} tools -> ${gavNames.join(', ')}`);
  console.log(`both-split:  ${[...bothSplit].join(', ')}`);
  console.log(`moved shims: ${[...shims].join(', ')}`);
  console.log('');
  if (!findings.length) console.log('OB1 lint: clean (0 findings)');
  else for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`);
}
process.exit(findings.some((f) => f.severity === 'red') ? 1 : 0);
