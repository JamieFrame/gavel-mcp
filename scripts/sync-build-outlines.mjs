#!/usr/bin/env node
/**
 * sync-build-outlines — VZ10 row M1, G4: the build-outlines resource, generated from the testnet site's Build
 * cards (its single source; operator's ruling, G4) and this profile's own map (src/v2/build-outlines.map.ts).
 *
 *   npm run build && node scripts/sync-build-outlines.mjs --site <gavel-frontend-testnet> --commit <sha> [--check]
 *
 * From the site at <sha> (read with `git show`, so the site's working tree is never touched):
 *   - src/pages/Build.jsx: block G3's cards, their copy-deck rows and order, and the not-deployed keys;
 *   - src/v2/copy.js: each card's title and body, verbatim;
 *   - src/components/v2/NotDeployed.jsx and copy.js TMK-M6.4: a not-deployed card's name;
 *   - src/v2/status.js: each built card's status, in the status file's words.
 * It fails (the drift check) if the site's cards and the map differ in any card or in order, or if a contract
 * or tool the map names is not in the deployment table or the gavel-testnet profile.
 *
 * --check  regenerate in memory and compare with src/v2/build-outlines.generated.ts; exit 1 on any difference.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAddress } from 'viem';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SITE = opt('--site');
const COMMIT = opt('--commit');
const CHECK = args.includes('--check');
const die = (m) => { console.error(`sync-build-outlines: ${m}`); process.exit(1); };
if (!SITE || !COMMIT) die('--site <gavel-frontend-testnet> and --commit <sha> are required');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'src/v2/build-outlines.generated.ts');

const show = (path) => {
  try { return execFileSync('git', ['-C', SITE, 'show', `${COMMIT}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 }); }
  catch { die(`cannot read ${path} at ${COMMIT} in ${SITE}`); }
};
const full = execFileSync('git', ['-C', SITE, 'rev-parse', COMMIT], { encoding: 'utf8' }).trim();
const tmp = mkdtempSync(join(tmpdir(), 'build-outlines-'));
const load = async (path, name) => { const f = join(tmp, name); writeFileSync(f, show(path)); return import(pathToFileURL(f).href); };
const { COPY } = await load('src/v2/copy.js', 'copy.mjs');
const STATUS = (await load('src/v2/status.js', 'status.mjs')).default;
const build = show('src/pages/Build.jsx');
const notDeployedSrc = show('src/components/v2/NotDeployed.jsx');

// The site's G3 block: its card rows in order, and its not-deployed keys.
const g3 = build.slice(build.indexOf('data-block="G3"'), build.indexOf('data-block="G4"'));
if (!g3) die('Build.jsx has no G3 block');
const siteCards = [...g3.matchAll(/title=\{COPY\['(TBD-G3\.\d+)'\]\} body=\{COPY\['(TBD-G3\.\d+)'\]\} chip=\{<StatusChip product="([a-z-]+)" \/>\}/g)]
  .map((m) => ({ title: m[1], body: m[2], product: m[3] }));
const notHere = build.match(/const NOT_HERE = \[([^\]]*)\]/);
if (!notHere) die('Build.jsx has no NOT_HERE list');
const notKeys = [...notHere[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
if (!/COPY\['TBD-G3\.12'\]\[i\]/.test(g3)) die("Build.jsx's not-deployed cards no longer take their bodies from TBD-G3.12[i]");
const rowKeys = [...notDeployedSrc.slice(notDeployedSrc.indexOf('const ROWS')).matchAll(/\['([a-z-]+)', [DI],/g)].map((m) => m[1]);
if (rowKeys.length !== COPY['TMK-M6.4'].length) die(`NotDeployed.jsx lists ${rowKeys.length} entries, TMK-M6.4 ${COPY['TMK-M6.4'].length}`);

const { OUTLINE_MAP } = await import('../dist/v2/build-outlines.map.js');
const { PROFILES } = await import('../dist/profiles.js');
const { V2_DEPLOYMENT } = await import('../dist/v2/deployment.generated.js');
const tools = new Set(PROFILES['gavel-testnet'].tools);

const expected = [...siteCards.map((c) => `${c.title}/${c.body}/${c.product}`), ...notKeys.map((k, i) => `${k}/TBD-G3.12#${i}`)];
const mapped = OUTLINE_MAP.map((o) => ('title' in o.card ? `${o.card.title}/${o.card.body}/${o.product}` : `${o.card.notDeployed}/${o.card.body}`));
if (expected.join('|') !== mapped.join('|')) die(`the site's cards and the map differ:\n  site: ${expected.join(', ')}\n  map:  ${mapped.join(', ')}`);

const text = (id) => {
  const [row, idx] = id.split('#');
  const v = COPY[row];
  if (v === undefined) die(`copy row ${row} missing at ${COMMIT}`);
  return idx === undefined ? v : v[Number(idx)];
};
const outlines = OUTLINE_MAP.map((o, i) => {
  for (const t of [...o.readTools, ...o.writeTools]) if (!tools.has(t)) die(`${t} is not a gavel-testnet tool`);
  for (const t of o.readTools) if (t.startsWith('prepare_')) die(`${t} listed as a read tool`);
  for (const t of o.writeTools) if (!t.startsWith('prepare_')) die(`${t} listed as a write tool`);
  const contracts = o.contracts.map((name) => {
    const hits = V2_DEPLOYMENT.contracts.filter((c) => c.name === name && !c.superseded);
    if (!hits.length) die(`${name} is not a live contract of the deployment table`);
    return { name, addresses: hits.map((c) => getAddress(c.address)) };
  });
  let title, status;
  if ('title' in o.card) {
    title = text(o.card.title);
    status = STATUS.products?.[o.product]?.status;
    if (!status) die(`the site's status file has no product ${o.product}`);
  } else {
    title = COPY['TMK-M6.4'][rowKeys.indexOf(o.card.notDeployed)];
    if (!title) die(`no not-deployed entry ${o.card.notDeployed}`);
    status = 'Not deployed on the testnet';
  }
  return { position: i + 1, title, body: text(o.card.body), status, contracts, readTools: o.readTools, writeTools: o.writeTools, notYetServed: o.notYetServed };
});

const body = {
  source: { repository: 'gavel-frontend-testnet', commit: full, page: '/build', block: 'G3', heading: COPY['TBD-G3.1'] },
  outlines,
};
const out =
  `// GENERATED by scripts/sync-build-outlines.mjs from gavel-frontend-testnet ${full.slice(0, 7)} (/build, block G3) and\n` +
  `// src/v2/build-outlines.map.ts. Do not edit; edit the site's cards or the map and regenerate.\n` +
  `export const BUILD_OUTLINES = ${JSON.stringify(body, null, 2)} as const;\n`;

if (CHECK) {
  if (!existsSync(TARGET)) die('src/v2/build-outlines.generated.ts does not exist; run without --check');
  if (readFileSync(TARGET, 'utf8') !== out) die(`src/v2/build-outlines.generated.ts differs from the site at ${full.slice(0, 7)}: rerun without --check and review`);
  console.log(`build outlines up to date with gavel-frontend-testnet ${full.slice(0, 7)} (${outlines.length} cards)`);
} else {
  writeFileSync(TARGET, out);
  console.log(`wrote src/v2/build-outlines.generated.ts: ${outlines.length} cards from gavel-frontend-testnet ${full.slice(0, 7)}`);
}
