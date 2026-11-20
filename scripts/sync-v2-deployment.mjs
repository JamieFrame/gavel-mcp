#!/usr/bin/env node
// ============================================================================
// sync-v2-deployment.mjs — generate src/v2/deployment.generated.ts from the deployment records
// (VZ10 row M1, G1 C6; operator, 2026-11-18). No address is typed here or in the output.
// ----------------------------------------------------------------------------
// Reads gavel-protocol-docs operational/v2/testnet_deployments/ at a pinned ref with `git show`, so
// the working tree of that clone is never touched (as gavel-frontend-testnet's sync-deployments.mjs
// does):
//   arbitrum_sepolia_core_2026-11-04.md   VZ8: the vault, ObligationLogic, the eleven mock tokens,
//                                          and VZ8's core and AO (superseded by Stage 3)
//   arbitrum_sepolia_vz9_2026-11-12.md    VZ9 Stage 3: the 38 contracts
//   arbitrum_sepolia_vz9_s3m.json         VZ9 S3m: the spot engine and the 16 spot and bill markets
//   arbitrum_sepolia_vz9_bond_v03.md      VZ9 S4: BOND v0.3's four contracts (v0.2 superseded)
// and writes src/v2/deployment.generated.ts with each record's sha256 and the docs commit.
//
// Cross-checks, each fatal: 38 Stage 3 contracts, 6 VZ8 contracts, 11 tokens, 4 BOND v0.3
// contracts; every address well formed; s3m.json's vault is VZ8's vault; every token s3m.json
// names is one of VZ8's, with the same decimals; no address carries two names.
//
// Usage:
//   node scripts/sync-v2-deployment.mjs [--docs ../gavel-protocol-docs] [--ref ec19600]   write
//   node scripts/sync-v2-deployment.mjs --check [...]                                      write nothing;
//        fail if the committed file differs from a fresh generation
//   node scripts/sync-v2-deployment.mjs --check --live <testnet API base>                 also compare
//        with the indexer's /v1/core/v2/deployment: every V2 address followed, superseded agreeing
// ============================================================================
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'v2', 'deployment.generated.ts');
const DIR = 'operational/v2/testnet_deployments';
const RECORDS = {
  core: `${DIR}/arbitrum_sepolia_core_2026-11-04.md`,
  stage3: `${DIR}/arbitrum_sepolia_vz9_2026-11-12.md`,
  s3m: `${DIR}/arbitrum_sepolia_vz9_s3m.json`,
  bond03: `${DIR}/arbitrum_sepolia_vz9_bond_v03.md`,
};

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const DOCS = resolve(ROOT, arg('--docs', '../gavel-protocol-docs'));
const REF = arg('--ref', 'ec19600');
const CHECK = process.argv.includes('--check');
const LIVE = arg('--live', null);

const die = (m) => { console.error(`sync-v2-deployment: ${m}`); process.exit(1); };
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const git = (...a) => execFileSync('git', ['-C', DOCS, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 });
let commit;
try { commit = git('rev-parse', `${REF}^{commit}`).trim(); } catch { die(`docs ref '${REF}' not found in ${DOCS}`); }
const read = (p) => {
  try { return git('show', `${commit}:${p}`); } catch { return die(`${p} is not in docs ${commit}`); }
};
const text = Object.fromEntries(Object.entries(RECORDS).map(([k, p]) => [k, read(p)]));
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ── Markdown tables: the rows of the table under a heading, as arrays of cells ──
function table(md, heading) {
  const lines = md.split(/\r?\n/);
  const i = lines.findIndex((l) => { const t = l.replace(/\s+$/, ''); return t === heading || t.startsWith(`${heading} (`); });
  if (i < 0) die(`heading '${heading}' not found`);
  const rows = [];
  let seenHeader = false;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.startsWith('#')) break;
    if (!l.startsWith('|')) { if (seenHeader && rows.length) break; continue; }
    if (!seenHeader) { seenHeader = true; continue; }       // header row
    if (/^\|\s*-/.test(l)) continue;                        // separator row
    rows.push(l.slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}
const code = (cell) => {
  const m = /`(0x[0-9a-fA-F]{40})`/.exec(cell);
  return m ? m[1] : null;
};
const nameOf = (cell) => cell.replace(/\s*\(.*$/, '').trim();

// ── VZ8: the vault, its contracts and the eleven mocks ──
const coreRows = table(text.core, '## Contracts');
const vz8 = coreRows.map((r) => ({ name: nameOf(r[0]), address: code(r[1]), block: Number(r[3]) }));
if (vz8.length !== 6) die(`VZ8 record: expected 6 contracts, found ${vz8.length}`);
const vault = vz8.find((c) => c.name === 'Vault');
if (!vault) die('VZ8 record names no Vault');
const tokens = table(text.core, '## Tokens (mock, testnet only)').map((r) => ({
  symbol: r[0], name: r[1], decimals: Number(r[2]), address: code(r[3]),
}));
if (tokens.length !== 11) die(`VZ8 record: expected 11 tokens, found ${tokens.length}`);

// ── Stage 3: the 38 contracts ──
const PRODUCT_BY_STEP = { 1: 'core', 3: 'engines', 4: 'bullet-loan', 5: 'spot', 6: 'future', 7: 'insurance', 8: 'secondary', 9: 'bond', 10: 'liquidation-cover' };
const s3Rows = table(text.stage3, '## Contracts');
if (s3Rows.length !== 38) die(`Stage 3 record: expected 38 contracts, found ${s3Rows.length}`);
const seen = {};
const stage3 = s3Rows.map((r) => {
  const step = Number(r[0]);
  const name = nameOf(r[1]);
  seen[name] = (seen[name] || 0) + 1;
  return { key: `${name}#${seen[name]}`, name, address: code(r[2]), step, block: Number(r[4]), product: PRODUCT_BY_STEP[step] || die(`step ${step} has no product`) };
});
// Keys are name#n only where a name repeats; a single contract keeps its name.
for (const c of stage3) if (seen[c.name] === 1) c.key = c.name;

// ── S3m: the engine and the markets ──
let s3m;
try { s3m = JSON.parse(text.s3m); } catch { die('s3m record is not JSON'); }
if (s3m.vault?.toLowerCase() !== vault.address.toLowerCase()) die("s3m.json's vault is not VZ8's vault");
const bySymbol = new Map(tokens.map((t) => [t.symbol, t]));
const tok = (t) => {
  const v = bySymbol.get(t.symbol);
  if (!v || v.address.toLowerCase() !== t.address.toLowerCase() || v.decimals !== Number(t.decimals)) die(`s3m token ${t.symbol} differs from VZ8's record`);
  return t.symbol;
};
const params = (p) => Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, String(v)]));
if (s3m.pairs?.length !== 6 || s3m.billSeries?.length !== 10) die(`s3m record: expected 6 pairs and 10 bill series, found ${s3m.pairs?.length} and ${s3m.billSeries?.length}`);
const pairs = s3m.pairs.map((p) => ({ name: p.name, stage: p.stage, spotMarket: p.spotMarket, marketId: Number(p.marketId), base: tok(p.base), quote: tok(p.quote), params: params(p.params) }));
const billSeries = s3m.billSeries.map((b) => ({ k: Number(b.series), date: Number(b.date), billToken: b.billToken, spotMarket: b.spotMarket, marketId: Number(b.marketId), quote: tok(b.quote), params: params(b.params) }));

// ── BOND v0.3 ──
const bond03 = table(text.bond03, '## Contracts').map((r) => ({ name: r[1], address: code(r[2]), block: Number(r[4]) }));
if (bond03.length !== 4) die(`BOND v0.3 record: expected 4 contracts, found ${bond03.length}`);

// ── Superseded: VZ8's core and AO (Stage 3, S3-D6), and BOND v0.2 (S4) ──
const superseded = [
  ...table(text.stage3, '## Superseded').map((r) => ({ name: r[0], address: code(r[1]), by: 'stage3' })),
  ...stage3.filter((c) => c.step === 9).map((c) => ({ name: `${c.name} (BOND v0.2)`, address: c.address, by: 'bond03' })),
];
const supSet = new Set(superseded.map((s) => s.address.toLowerCase()));
if (superseded.filter((x) => x.by === 'stage3').length !== 3) die("Stage 3's Superseded table: expected VZ8's Obligation, Lien and AuctionOrchestrator");
for (const x of superseded) {
  if (!ADDR.test(x.address || '')) die(`superseded ${x.name}: not an address`);
  if (x.by === 'stage3' && !vz8.some((c) => c.address.toLowerCase() === x.address.toLowerCase())) die(`superseded ${x.name} is not a VZ8 contract`);
}
// VZ8 contracts neither served nor superseded are said so, not dropped silently.
const omitted = vz8.filter((c) => !['Vault', 'ObligationLogic'].includes(c.name) && !supSet.has(c.address.toLowerCase()))
  .map((c) => ({ name: `${c.name} (VZ8)`, address: c.address, reason: "VZ8's; Stage 3 deploys its own, and Stage 3's Superseded table lists only the vault's consumers" }));

// ── The table every tool reads ──
const contracts = [
  ...vz8.filter((c) => ['Vault', 'ObligationLogic'].includes(c.name)).map((c) => ({ key: c.name, name: c.name, address: c.address, product: 'core', record: 'core', block: c.block })),
  ...stage3.map((c) => ({ key: c.key, name: c.name, address: c.address, product: c.product, record: 'stage3', block: c.block })),
  ...bond03.map((c) => ({ key: `${c.name}`, name: c.name, address: c.address, product: 'bond', record: 'bond03', block: c.block })),
].map((c) => ({ ...c, superseded: supSet.has(c.address.toLowerCase()) }));
// The BOND v0.2 keys would collide with v0.3's names; give the superseded ones their own key.
for (const c of contracts) if (c.record === 'stage3' && c.product === 'bond') c.key = `${c.name}V02`;

// ── Every address once, and well formed ──
const all = [...contracts.map((c) => [c.key, c.address]), ...tokens.map((t) => [t.symbol, t.address]),
  ...pairs.map((p) => [`spot ${p.name}`, p.spotMarket]), ...billSeries.map((b) => [`bill ${b.k}`, b.spotMarket]), ['spot engine', s3m.engine], ['billPackager', s3m.billPackager]];
for (const [k, a] of all) if (!ADDR.test(a || '')) die(`${k}: not an address`);
const owner = new Map();
// The engine's rule first: 'spot engine' also begins with 'spot '.
const SAME_AS = [['spot engine', /^BatchAuction$/], ['billPackager', /^BillPackager$/], ['spot ', /^SpotMarket(#\d+)?$/], ['bill ', /^SpotMarket(#\d+)?$/]];
for (const [k, a] of all) {
  const l = a.toLowerCase();
  if (owner.has(l)) {
    // An s3m market, the engine or the packager is the same contract as a Stage 3 one of that kind; nothing else repeats.
    const rule = SAME_AS.find(([prefix]) => k.startsWith(prefix));
    if (!rule || !rule[1].test(owner.get(l))) die(`${a} carries two names: ${owner.get(l)} and ${k}`);
  } else owner.set(l, k);
}
const engine = contracts.find((c) => c.name === 'BatchAuction');
if (engine.address.toLowerCase() !== s3m.engine.toLowerCase()) die("s3m.json's engine is not Stage 3's BatchAuction");
const packager = contracts.find((c) => c.name === 'BillPackager');
if (packager.address.toLowerCase() !== s3m.billPackager.toLowerCase()) die("s3m.json's billPackager is not Stage 3's");

const generated = {
  chainId: 421614,
  docs: { repository: 'gavel-protocol-docs', commit, records: Object.fromEntries(Object.entries(RECORDS).map(([k, p]) => [k, { path: p, sha256: sha(text[k]) }])) },
  contracts,
  tokens,
  spot: { engine: s3m.engine, vault: s3m.vault, billPackager: s3m.billPackager, block: Number(s3m.block), pairs, billSeries },
  superseded,
  omitted,
};

const out = `// GENERATED by scripts/sync-v2-deployment.mjs from gavel-protocol-docs ${commit.slice(0, 7)}. Do not edit.
// Every address below comes from a deployment record; none is typed. Regenerate with
//   node scripts/sync-v2-deployment.mjs --ref <docs commit>
// and check with --check (and --live <testnet API base>).
/* eslint-disable */
export const V2_DEPLOYMENT = ${JSON.stringify(generated, null, 2)} as const;
`;

if (!CHECK) {
  writeFileSync(OUT, out);
  console.log(`wrote src/v2/deployment.generated.ts: ${contracts.length} contracts (${superseded.length} superseded, ${omitted.length} omitted), ${tokens.length} tokens, ${pairs.length} pairs, ${billSeries.length} bill series; docs ${commit.slice(0, 7)}`);
} else {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== out) die('src/v2/deployment.generated.ts is out of date with the records; regenerate it');
  console.log(`deployment table up to date with docs ${commit.slice(0, 7)}`);
}

if (LIVE) {
  const res = await fetch(`${LIVE.replace(/\/$/, '')}/deployment`, { headers: { Accept: 'application/json' } });
  if (!res.ok) die(`live /deployment answered ${res.status}`);
  const live = await res.json();
  if (live.chainId !== 421614) die(`live /deployment chainId is ${live.chainId}`);
  const liveBy = new Map(live.contracts.map((c) => [c.address.toLowerCase(), c]));
  const problems = [];
  for (const c of contracts) {
    if (c.name === 'ObligationLogic' || c.name === 'ModuleLogic') continue;   // libraries: emit at their caller
    const l = liveBy.get(c.address.toLowerCase());
    if (!l) { problems.push(`${c.key} is not in the indexer's deployment`); continue; }
    if (Boolean(l.superseded) !== c.superseded) problems.push(`${c.key}: superseded ${c.superseded} here, ${l.superseded} in the indexer`);
  }
  for (const s of superseded) {
    const l = liveBy.get(s.address.toLowerCase());
    if (l && !l.superseded) problems.push(`${s.name} is superseded here and not in the indexer`);
  }
  if (problems.length) die(`live check:\n  ${problems.join('\n  ')}`);
  console.log(`live check: every V2 address is in the indexer's deployment (${live.contracts.length} rows), superseded agreeing`);
}
