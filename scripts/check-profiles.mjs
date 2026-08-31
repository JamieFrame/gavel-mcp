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
  let promptNames = [];
  try { promptNames = (await client.listPrompts()).prompts.map((p) => p.name); } catch { promptNames = []; }
  const instructions = server.server.getInstructions?.() ?? PROFILES[profileId].instructions;
  await client.close();
  await server.close();
  return { tools, promptNames, profile: PROFILES[profileId], instructions };
}

const obs = await toolsFor('observatory');
const gav = await toolsFor('gavel');
const pre = await toolsFor('gavel-presplit');
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
// Every human-readable field, not just `description`: the first pass at this
// checked description alone and let "Gavel Indicator Catalogue" ship as a TITLE,
// which is the field a client actually renders in its picker.
for (const t of obs.tools) {
  const prose = [t.title, t.description, JSON.stringify(t.inputSchema ?? {})].filter(Boolean).join(' ');
  if (/gavel/i.test(t.title || ''))
    fail('observatory_names_no_venue', `'${t.name}' has the venue in its TITLE ('${t.title}') — the field a client shows in its picker`);
  if (/gavel/i.test(prose) && !/venue/i.test(prose))
    warn(
      'observatory_names_no_venue',
      `'${t.name}' names Gavel with no venue framing — confirm this tool is not a venue-specific surface other venues do not get`
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

// ── the merge must not cut over ─────────────────────────────────────────────
// `gavel-presplit` is what mcp.thegavel.io serves today and what an unset
// MCP_PROFILE resolves to. If it ever stops matching the pre-split surface,
// merging OB1 ships the split on the next restart with nobody deciding to.
if (pre.profile.serverVersion !== '0.3.0')
  fail('presplit_unchanged', `gavel-presplit reports ${pre.profile.serverVersion}, not the live 0.3.0`);
if (pre.tools.length !== 21)
  fail('presplit_unchanged', `gavel-presplit exposes ${pre.tools.length} tools, not the live 21`);
if (/Bitcoin Credit Stack MCP/.test(pre.instructions))
  fail('presplit_unchanged', 'gavel-presplit carries the data-ward pointer; that ships at cutover, not before');
for (const name of MOVED_FROM_GAVEL) {
  const t = pre.tools.find((x) => x.name === name);
  if (!t) fail('presplit_unchanged', `gavel-presplit is missing '${name}', which is live today`);
  else if (/has moved/.test(t.description || ''))
    fail('presplit_unchanged', `'${name}' is a moved shim on gavel-presplit; it must still SERVE until cutover`);
}

// ── §0.4, AS AMENDED — the dataset-level disclosure must be ABSENT ─────────
//
// This check used to assert the opposite: that OBSERVATORY_DISCLOSURE appeared
// verbatim in the observatory instructions. The operator WITHDREW that
// disclosure on 2026-08-29 and the export went with it, so the lint has been
// importing `undefined` and reddening on correct code ever since — a guard that
// fails when canon is obeyed, which is worse than no guard, because the way to
// make it pass was to put the false sentence back.
//
// It is inverted here to enforce what canon actually says
// (`canonical/two_property_strategy_v1.md` §2 and §5):
//
//   §2  Aletheia Analytics did NOT create the Gavel Protocol. Jamie Frame
//       authored it personally under MIT — Layer 1, not Layer 3. This exact
//       sentence has been published and withdrawn once already.
//   §5  The own-account disclosure belongs on the VENUE ROW, never on the
//       dataset. Aletheia may hold a position at any covered venue; a
//       dataset-level banner naming one implies a relationship the data does
//       not establish.
const CREATED_CLAIM = /aletheia[^.]{0,80}\b(creat|built|develop|author)/i;
if (CREATED_CLAIM.test(obs.instructions))
  fail('entity_attribution', 'the observatory instructions claim Aletheia created/authored the Protocol — two_property_strategy_v1 §2 says Layer 1, not Layer 3');
if (CREATED_CLAIM.test(gav.instructions))
  fail('entity_attribution', 'the gavel instructions claim Aletheia created/authored the Protocol — §2 says Layer 1, not Layer 3');
// A dataset-level own-account banner. The permitted place is the venue row's
// own `disclosure` field, which get_venue passes through untouched.
if (/own account/i.test(obs.instructions) && !/venue'?s own row|that venue/i.test(obs.instructions))
  fail('disclosure_on_row_not_dataset', 'the observatory instructions carry an own-account disclosure without scoping it to the venue row (§5)');
// And the pointer TO the row must still be there — removing the banner must not
// have removed the reader's route to the fact.
if (!/disclosure/i.test(obs.instructions))
  fail('disclosure_on_row_not_dataset', 'the observatory instructions no longer point the reader at the venue row disclosure field (§5)');

// ── registry file sanity — the AD2 100-char trap ────────────────────────────
const sj = JSON.parse(readFileSync(join(ROOT, 'server.observatory.json'), 'utf8'));
// OB1-D3 fixed `io.aletheia/bitcoin-credit-stack`. AMENDED by operator decision
// 2026-08-29: that id reverse-maps to aletheia.io, which Aletheia does not
// control, and the registry validates that a domain namespace's server URL sits
// on that domain. The id now matches the domain the server actually lives on,
// so DNS-auth and URL validation both pass.
const EXPECTED_REGISTRY_ID = 'com.bitcoincreditstack/mcp';
if (sj.name !== EXPECTED_REGISTRY_ID)
  fail('registry_id_fixed', `server.observatory.json name is '${sj.name}', not '${EXPECTED_REGISTRY_ID}'`);
// The registry rejects a remote URL that is not on the namespace's own domain.
const nsDomain = EXPECTED_REGISTRY_ID.split('/')[0].split('.').reverse().join('.');
const remoteUrl = sj.remotes?.[0]?.url ?? '';
if (!new URL(remoteUrl).hostname.endsWith(nsDomain))
  fail('registry_namespace_matches_host', `remote ${remoteUrl} is not on the namespace domain ${nsDomain}`);
if ((sj.description || '').length > 100)
  fail('registry_description_cap', `description is ${sj.description.length} chars; the registry caps it at 100`);

// The GAVEL registry entry, checked by the same rules. It was not checked at
// all until OB4 §1.6 — only the observatory's was — so a namespace or a cap
// breach on this side would have reached the registry unexamined.
const gj = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
const GAVEL_REGISTRY_ID = 'io.thegavel/gavel';
if (gj.name !== GAVEL_REGISTRY_ID)
  fail('registry_id_fixed', `server.json name is '${gj.name}', not '${GAVEL_REGISTRY_ID}'`);
const gavelNs = GAVEL_REGISTRY_ID.split('/')[0].split('.').reverse().join('.');
const gavelRemote = gj.remotes?.[0]?.url ?? '';
if (!new URL(gavelRemote).hostname.endsWith(gavelNs))
  fail('registry_namespace_matches_host', `remote ${gavelRemote} is not on the namespace domain ${gavelNs}`);
if ((gj.description || '').length > 100)
  fail('registry_description_cap', `server.json description is ${gj.description.length} chars; the registry caps it at 100`);
// `title` is capped at 100 too, and both entries now carry one.
for (const [file, j] of [['server.json', gj], ['server.observatory.json', sj]]) {
  if (j.title && j.title.length > 100)
    fail('registry_title_cap', `${file} title is ${j.title.length} chars; the registry caps it at 100`);
  // §1.6 — the entry names the connect URL. It must be on that property's own
  // site, not the other one's: a registry entry pointing a reader at the wrong
  // property is the cross-property leak OB1's split exists to prevent.
  const host = new URL(j.remotes[0].url).hostname.replace(/^mcp\./, '');
  if (j.websiteUrl && !new URL(j.websiteUrl).hostname.endsWith(host))
    fail('registry_connect_same_property', `${file} websiteUrl ${j.websiteUrl} is not on ${host}`);
}
// OB4-D1 — the lenses are the observatory's, and the registry must say so.
if ((gj._meta?.['io.thegavel/surface']?.prompts ?? []).length)
  fail('registry_lenses_observatory_only', 'server.json advertises prompts; OB4-D1 puts none on the gavel server');
const declaredLenses = sj._meta?.['com.bitcoincreditstack/lenses']?.names ?? [];
if (declaredLenses.length !== obs.promptNames.length)
  fail('registry_lenses_match', `server.observatory.json names ${declaredLenses.length} lenses; the server exposes ${obs.promptNames.length}`);
for (const n of declaredLenses) {
  if (!obs.promptNames.includes(n))
    fail('registry_lenses_match', `server.observatory.json names lens '${n}', which the server does not expose`);
}

const summary = {
  observatory: { count: obsNames.length, tools: obsNames },
  gavel: { count: gavNames.length, tools: gavNames },
  presplit: { count: pre.tools.length, version: pre.profile.serverVersion },
  both_split: [...bothSplit],
  moved_shims: [...shims],
  findings,
};
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`observatory: ${obsNames.length} tools -> ${obsNames.join(', ')}`);
  console.log(`gavel:       ${gavNames.length} tools -> ${gavNames.join(', ')}`);
  console.log(`presplit:    ${pre.tools.length} tools @ ${pre.profile.serverVersion} (what mcp.thegavel.io serves today)`);
  console.log(`both-split:  ${[...bothSplit].join(', ')}`);
  console.log(`moved shims: ${[...shims].join(', ')}`);
  console.log('');
  if (!findings.length) console.log('OB1 lint: clean (0 findings)');
  else for (const f of findings) console.log(`[${f.severity.toUpperCase()}] ${f.rule}: ${f.detail}`);
}
process.exit(findings.some((f) => f.severity === 'red') ? 1 : 0);
