#!/usr/bin/env node
/**
 * check-advertised — does every advertised thing actually answer?
 *
 * Added 2026-08-26 after a third instance of the same defect: this server
 * advertising something that is not there.
 *
 *   1. get_mvrv called /v1/onchain/mvrv, a path that has never existed.
 *      Every call returned an upstream 404 while the tool sat in tools/list.
 *   2. The indicator catalogue advertised hodl-waves as live: true at a path
 *      that 404s (SV4).
 *   3. get_protocol_reference advertised auctionFeeBps(), calculateAuctionFee()
 *      and marketplaceListingFee() — none of which exists on any deployment.
 *      That tool's own description tells agents to consult it *before
 *      constructing a transaction*.
 *   4. (2026-08-31) Every prepare_* tool returned
 *      `wallet_agnostic_url: https://thegavel.io/sign?…` and /sign HAD NEVER
 *      EXISTED. All five blueprint tools handed out a 404 on the only
 *      wallet-agnostic hand-off this server has, and it went unnoticed because
 *      nothing here had ever called a URL this server EMITS — only the paths it
 *      READS. Found when an agent-driven auction was attempted.
 *
 * Three instances across three tools is a systemic gap between what this
 * server claims and what it serves, not three unrelated bugs. Individually
 * fixing them leaves the gap. This closes it: every advertised upstream path
 * and every advertised contract function is called, and anything that does
 * not answer is a finding.
 *
 * Exit 0 = everything advertised answers. Exit 1 = at least one does not.
 *
 * Usage:  node scripts/check-advertised.mjs [--json]
 * Env:    GAVEL_API_BASE_URL (required), MAINNET_RPC_URL (optional)
 */

import { INDICATORS } from '../dist/tools/indicators/catalogue.js';
import { REFERENCES } from '../dist/tools/protocol/reference.js';

const BASE = process.env.GAVEL_API_BASE_URL;
const RPC = process.env.MAINNET_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const JSON_OUT = process.argv.includes('--json');

if (!BASE) {
  console.error('GAVEL_API_BASE_URL is not set. Refusing to run — a check that cannot reach the API would report false passes.');
  process.exit(2);
}

const findings = [];
const ok = [];

const record = (kind, name, detail, passed) =>
  (passed ? ok : findings).push({ kind, name, detail });

// ---------------------------------------------------------------- HTTP paths
async function head(path) {
  try {
    const r = await fetch(`${BASE}${path}`, { method: 'GET', redirect: 'follow' });
    return { status: r.status };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e) };
  }
}

async function checkIndicatorCatalogue() {
  for (const ind of INDICATORS) {
    // A `live: false` entry is an honest declaration and is not a finding —
    // but if it has started answering, the catalogue is understating itself
    // and that is worth knowing too.
    const paths = [ind.path, ind.historyPath].filter(Boolean);
    for (const p of paths) {
      const { status, error } = await head(p);
      const answers = status >= 200 && status < 300;
      if (ind.live && !answers) {
        record('indicator', `${ind.id} ${p}`, `advertised live:true but returned ${error ?? status}`, false);
      } else if (!ind.live && answers) {
        record('indicator', `${ind.id} ${p}`, `marked live:false but answers 200 — catalogue understates it`, false);
      } else {
        record('indicator', `${ind.id} ${p}`, `${status}`, true);
      }
    }
  }
}

// The paths tools call directly, which the catalogue does not cover.
const DIRECT_PATHS = ['/v1/auctions', '/v1/yield-curve', '/v1/onchain/indicators/latest'];

async function checkDirectPaths() {
  for (const p of DIRECT_PATHS) {
    const { status, error } = await head(p);
    const answers = status >= 200 && status < 300;
    record('upstream', p, answers ? `${status}` : `returned ${error ?? status}`, answers);
  }
}

// ---------------------------------------------------------------- contract functions
// Every signature get_protocol_reference advertises must exist on-chain.
// A view function that reverts is advertised-but-absent; a non-view is only
// checked for presence of its selector in the deployed runtime.
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
}

function selector(sig) {
  // keccak of the canonical signature — types only, no names.
  const canon = sig
    .replace(/\s*returns\s*\(.*\)\s*$/, '')
    .replace(/\s+view\s*$/, '')
    .trim();
  const open = canon.indexOf('(');
  const name = canon.slice(0, open).trim();
  const args = canon.slice(open + 1, canon.lastIndexOf(')'));
  const types = args
    .split(',')
    .map((a) => a.trim().split(/\s+/)[0])
    .filter(Boolean)
    .join(',');
  const nArgs = types === '' ? 0 : types.split(',').length;
  return { canonical: `${name}(${types})`, isView: /\bview\b/.test(sig), nArgs };
}

async function checkContractFunctions() {
  const { keccak256, toUtf8Bytes } = await import('ethers');
  const mainnet = REFERENCES['arbitrum-one'];

  // The advertised addresses are PROXIES (133-byte delegate-and-return), so a
  // selector will never appear in their runtime. The dispatch table lives in
  // the implementation — scan that.
  //
  // Presence is established by selector, not by calling: an eth_call probe
  // cannot distinguish "function absent" from "function present and reverted
  // on the zero arguments we sent". An earlier version of this script did
  // exactly that and reported nine present functions as missing.
  const runtimes = {};
  for (const [contract, addr] of Object.entries(mainnet.implementations)) {
    const r = await rpc('eth_getCode', [addr, 'latest']);
    runtimes[contract] = (r.result || '').toLowerCase();
  }

  for (const [contract, sigs] of Object.entries(mainnet.key_functions)) {
    // key_functions carries a generic 'ERC20' helper group that is not a Gavel
    // contract and has no address. Not a finding.
    if (!(contract in mainnet.contracts)) continue;
    const runtime = runtimes[contract];
    if (!runtime || runtime === '0x') {
      record('contract', contract, 'no implementation runtime found', false);
      continue;
    }
    for (const sig of sigs) {
      const { canonical, isView, nArgs } = selector(sig);
      const sel = keccak256(toUtf8Bytes(canonical)).slice(2, 10).toLowerCase();
      const present = runtime.includes(sel);

      if (!present) {
        record('contract', `${contract}.${canonical}`, 'ADVERTISED BUT ABSENT from the implementation', false);
        continue;
      }
      // Zero-argument views can be confirmed by actually calling them, which
      // is stronger than a selector match. Anything taking arguments is left
      // at selector presence: we have no valid arguments to send.
      if (isView && nArgs === 0) {
        const res = await rpc('eth_call', [{ to: mainnet.contracts[contract], data: '0x' + sel }, 'latest']);
        const answered = !res.error && res.result && res.result !== '0x';
        record('contract', `${contract}.${canonical}`, answered ? 'answers' : 'selector present but call reverted', answered);
      } else {
        record('contract', `${contract}.${canonical}`, 'selector present', true);
      }
    }
  }
}

/**
 * The URLs this server HANDS OUT, as opposed to the ones it calls.
 *
 * Everything above checks upstream paths and contract functions — things this
 * server consumes. `wallet_agnostic_url` is different in kind: it is a pointer
 * this server puts in front of a user, on the last step before they sign. It
 * was wrong for as long as it had existed, and no check here could see it,
 * because the whole file was pointed the other way.
 *
 * The base URL is called with no query string, which is the right test: the
 * page must EXIST. Whether it accepts a particular transaction is the page's
 * own adjudication and deliberately not ours to assert from here.
 */
async function checkEmittedUrls() {
  const { walletAgnosticUrl } = await import('../dist/factory/envelope.js');
  const sample = walletAgnosticUrl({ to: '0x' + '0'.repeat(40), data: '0x00', value: '0', chain_id: 42161 });
  const base = new URL(sample);
  base.search = '';
  try {
    const res = await fetch(base.toString(), { redirect: 'follow' });
    record(
      'emitted-url',
      base.toString(),
      res.status >= 400
        ? `HTTP ${res.status} — every prepare_* tool hands this to a user before they sign`
        : `serves (${res.status})`,
      res.status < 400
    );
  } catch (e) {
    record('emitted-url', base.toString(), `unreachable: ${e.message}`, false);
  }
}

// ---------------------------------------------------------------- run
await checkEmittedUrls();
await checkDirectPaths();
await checkIndicatorCatalogue();
try {
  await checkContractFunctions();
} catch (e) {
  record('contract', 'probe', `could not run: ${e?.message ?? e}`, false);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: ok.length, findings }, null, 2));
} else {
  console.log(`checked ${ok.length + findings.length} advertised things`);
  console.log(`  answering: ${ok.length}`);
  console.log(`  findings:  ${findings.length}`);
  for (const f of findings) console.log(`    [${f.kind}] ${f.name} — ${f.detail}`);
}

process.exit(findings.length === 0 ? 0 : 1);
