#!/usr/bin/env node
/**
 * export-site-table — VZ10 row M1, G4: what the testnet site needs from the gavel-testnet profile, as one
 * generated file, site/gavel-testnet.json.
 *
 *   npm run build && node scripts/export-site-table.mjs [--check]
 *
 * The site (gavel-frontend-testnet) copies this file at a pinned gavel-mcp commit (its
 * scripts/sync-mcp-table.mjs) and never types any of it:
 *   - tools:     the profile's tool names, read or write, in the profile's order (for /mcp);
 *   - sign:      the signing surface of src/v2/sign-surface.ts resolved to addresses, with each call's full ABI
 *                fragment (parameter names and struct components), the admitted spenders and consumers, and the
 *                test tokens (for /sign, which relays only what this table admits: G1 §4);
 *   - display:   what the site shows (operator ruling 2026-11-19, TW3): mWBTC, mUSDC, mWETH and the markets between
 *                them, plus BOND and the bill series with their markets. Narrower than sign, which is unchanged.
 * No tool titles or descriptions: the site's words come from its copy deck.
 *
 * --check  regenerate in memory and compare with the committed file; exit 1 on any difference.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector, toFunctionSignature } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'site', 'gavel-testnet.json');
const CHECK = process.argv.includes('--check');
const die = (m) => { console.error(`export-site-table: ${m}`); process.exit(1); };

const { PROFILES } = await import('../dist/profiles.js');
const { V2_DEPLOYMENT } = await import('../dist/v2/deployment.generated.js');
const ABI = await import('../dist/v2/abi.generated.js');
const S = await import('../dist/v2/sign-surface.js');

const KIND_ABI = { TestToken: 'MockERC20', Vault: 'Vault', SpotMarket: 'SpotMarket', BulletLoanRequest: 'BulletLoanRequest', BulletLoanOffer: 'BulletLoanOffer', Obligation: 'Obligation', Lien: 'Lien' };

const profile = PROFILES['gavel-testnet'];
if (!profile) die('no gavel-testnet profile');
const toolNames = [...profile.tools];
const tools = toolNames.map((name) => ({ name, kind: name.startsWith('prepare_') ? 'write' : 'read' }));

for (const key of Object.keys(S.SIGN_HINTS)) { const [k, f] = key.split('.'); if (!S.SIGN_CALLS[k]?.includes(f)) die(`hint for ${key}, not a call of the surface`); }
const calls = [];
for (const [kind, fns] of Object.entries(S.SIGN_CALLS)) {
  const abi = ABI[`${KIND_ABI[kind]}_ABI`];
  if (!abi) die(`no ABI for ${kind}`);
  for (const fn of fns) {
    const hits = abi.filter((x) => x.type === 'function' && x.name === fn);
    if (hits.length !== 1) die(`${kind}.${fn}: ${hits.length} ABI entries (overloads are not admitted)`);
    const f = hits[0];
    calls.push({ kind, function: fn, signature: toFunctionSignature(f), selector: toFunctionSelector(f), abi: f });
  }
}

// display (operator ruling 2026-11-19, TW3): what the site SHOWS, a narrower list than what /sign ADMITS. The site lists
// these three mock tokens and the markets between them (and BOND's, once deployed), plus the protocol-issued tokens: BOND
// and the bill series with their markets. The sign section above stays the whole surface, so /sign relays every call it
// relayed before and every blueprint the MCP tools hand out; the tools themselves describe every deployed token.
const SHOWN_MOCKS = ['mWBTC', 'mUSDC', 'mWETH'];
const SHOWN_MARKET_IDS = [1, 4, 7]; // m1, m4, m7 in the ruling: asserted against the records, not used to select
const mocks = SHOWN_MOCKS.map((sym) => V2_DEPLOYMENT.tokens.find((t) => t.symbol === sym) ?? die(`display token ${sym} is not deployed`));
const bond = V2_DEPLOYMENT.contracts.find((c) => c.name === 'BondToken' && !c.superseded) ?? die('no live BondToken');
const shownSymbols = new Set([...SHOWN_MOCKS, 'BOND']);
const shownPairs = V2_DEPLOYMENT.spot.pairs.filter((p) => shownSymbols.has(p.base) && shownSymbols.has(p.quote));
const ids = shownPairs.map((p) => p.marketId);
if (SHOWN_MARKET_IDS.some((id) => !ids.includes(id))) die(`display markets ${ids.join(',')} do not include m${SHOWN_MARKET_IDS.join(', m')}`);
const display = {
  ruling: 'operator 2026-11-19 (TW3): three mock tokens and the markets between them; protocol-issued tokens stay. /sign admits the sign section, not this list.',
  tokens: [
    ...mocks.map((t) => ({ symbol: t.symbol, decimals: t.decimals, address: t.address, issuer: 'test' })),
    { symbol: 'BOND', address: bond.address, issuer: 'protocol' },
    ...V2_DEPLOYMENT.spot.billSeries.map((b) => ({ bill: b.k, maturity: b.date, address: b.billToken, issuer: 'protocol' })),
  ],
  markets: [
    ...shownPairs.map((p) => ({ marketId: p.marketId, name: p.name, base: p.base, quote: p.quote, address: p.spotMarket })),
    ...V2_DEPLOYMENT.spot.billSeries.map((b) => ({ marketId: b.marketId, bill: b.k, quote: b.quote, address: b.spotMarket })),
  ],
};

const body = {
  about: 'Generated by gavel-mcp scripts/export-site-table.mjs from the gavel-testnet profile. Do not edit.',
  profile: profile.id,
  chainId: V2_DEPLOYMENT.chainId,
  deployment: V2_DEPLOYMENT.docs,
  abi: ABI.V2_ABI_SOURCE.contracts,
  tools,
  sign: {
    contracts: Object.keys(S.SIGN_CALLS).flatMap((kind) => S.addressesOf(kind).map((x) => ({ kind, label: x.label, address: x.address, ...(x.base ? { base: x.base, quote: x.quote } : {}) }))),
    calls: calls.map((c) => ({ ...c, hints: S.SIGN_HINTS[`${c.kind}.${c.function}`] ?? null })),
    spenders: S.SPENDERS.map((name) => ({ name, address: S.liveAddress(name) })),
    consumers: S.consumerAddresses(),
    tokens: V2_DEPLOYMENT.tokens.map((t) => ({
      symbol: t.symbol, decimals: t.decimals, address: t.address,
      assetKey: `0x01${'00'.repeat(11)}${t.address.slice(2).toLowerCase()}`,
    })),
  },
  display,
};
const text = `${JSON.stringify(body, null, 2)}\n`;

if (CHECK) {
  if (!existsSync(TARGET)) die('site/gavel-testnet.json does not exist; run without --check');
  if (readFileSync(TARGET, 'utf8') !== text) die('site/gavel-testnet.json differs from the profile: rerun without --check and review');
  console.log(`site table up to date (${tools.length} tools, ${calls.length} calls, ${body.sign.contracts.length} addresses)`);
} else {
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, text);
  console.log(`wrote site/gavel-testnet.json: ${tools.length} tools, ${calls.length} calls, ${body.sign.contracts.length} addresses`);
}
