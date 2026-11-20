#!/usr/bin/env node
/**
 * sync-v2-abi — VZ10 row M1, G3: the ABI fragments the gavel-testnet write tools encode and read
 * with, generated from a gavel-contracts build, never typed (G1 §3, §7).
 *
 *   node scripts/sync-v2-abi.mjs --out <forge out dir> [--commit a554ee0] [--check]
 *
 * --out     the `out/` directory of a forge build of gavel-contracts at the commit named.
 * --commit  the gavel-contracts commit the build is of (recorded in the file; default a554ee0).
 * --check   regenerate in memory and compare with src/v2/abi.generated.ts; exit 1 on any drift.
 *
 * For each contract it takes the functions and events named below, and EVERY custom error the
 * contract's ABI carries, so that a simulated revert decodes to the contract's own error name.
 * A named function or event missing from the build stops the run: that is the abi-check — a
 * signature the tools rely on that the contracts no longer have.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('--out');
const COMMIT = opt('--commit', 'a554ee0');
const CHECK = args.includes('--check');
const die = (m) => { console.error(`sync-v2-abi: ${m}`); process.exit(1); };
if (!OUT) die('--out <forge out dir> is required');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'src/v2/abi.generated.ts');

// contract -> [artifact path under out/, functions, events]
const WANT = {
  MockERC20: ['MockERC20.sol/MockERC20.json',
    ['mint', 'decimals', 'symbol', 'balanceOf', 'allowance', 'approve'], ['Transfer']],
  Vault: ['Vault.sol/Vault.json',
    ['deposit', 'withdraw', 'approveConsumer', 'balance', 'totalBalance', 'reservedBalance', 'isAuthorisedConsumer', 'isUserApproved'],
    ['Deposited', 'WithdrawalInitiated', 'ConsumerApprovalSet', 'Reserved', 'ReservationReleased', 'CollateralLocked', 'CollateralReleased']],
  SpotMarket: ['SpotMarket.sol/SpotMarket.json',
    ['placeOrder', 'cancelOrder', 'baseAsset', 'quoteAsset', 'baseVault', 'quoteVault', 'MIN_ORDER_SIZE_BASE', 'MIN_ORDER_SIZE_QUOTE',
      'MAX_OPEN_ORDERS_PER_USER', 'MAX_HINT_STEPS', 'paused', 'getCurrentSlot', 'openOrdersByUser', 'findHint', 'quoteForBase', 'getOrder',
      'getOrderRecord', 'orderIdNonce', 'engine'],
    ['OrderReleased']],
  BatchAuction: ['BatchAuction.sol/BatchAuction.json', [], ['OrderPlaced', 'OrderCancelQueued']],
  BulletLoanRequest: ['BulletLoanRequest.sol/BulletLoanRequest.json',
    ['openRequest', 'bidRequest', 'cancel', 'release', 'finalise', 'loanOf', 'entryOf', 'deadlineOf', 'liveEntryOf', 'originationOf',
      'paused', 'single', 'group', 'vault', 'isOperator', 'MIN_LOAN_DURATION', 'MAX_LOAN_DURATION', 'MIN_AUCTION_DURATION',
      'MAX_AUCTION_DURATION', 'MAX_BID_STEP_BPS', 'MAX_REPAYMENT'],
    ['LoanOpened', 'EntryRecorded', 'EntryReleased', 'LoanEnded', 'LoanOriginated']],
  BulletLoanOffer: ['BulletLoanOffer.sol/BulletLoanOffer.json',
    ['openOffer', 'bidOffer', 'cancel', 'release', 'finalise', 'loanOf', 'entryOf', 'deadlineOf', 'liveEntryOf', 'originationOf',
      'paused', 'single', 'group', 'vault', 'isOperator', 'MIN_LOAN_DURATION', 'MAX_LOAN_DURATION', 'MIN_AUCTION_DURATION',
      'MAX_AUCTION_DURATION', 'MAX_REPAYMENT'],
    ['LoanOpened', 'EntryRecorded', 'EntryReleased', 'LoanEnded', 'LoanOriginated']],
  SingleAuction: ['SingleAuction.sol/SingleAuction.json', ['minimumNextBid', 'phase', 'getAuction', 'standing'], []],
  GroupAuction: ['GroupAuction.sol/GroupAuction.json', ['findHint', 'bidOf', 'getBid', 'getAuction', 'phase'], []],
  Obligation: ['Obligation.sol/Obligation.json',
    ['pay', 'collect', 'redeem', 'getObligation', 'payoff', 'getSet', 'debtAt', 'accrued', 'balanceOf', 'ownerOfPosition', 'creditKeys'],
    ['Paid', 'Collected', 'Redeemed']],
  Lien: ['Lien.sol/Lien.json', ['payoff', 'release', 'claim', 'getLien', 'creditKeys'], ['LienPaidOff', 'LienReleased', 'Claimed']],
};

const artefacts = {};
const abi = {};
for (const [name, [path, fns, evs]] of Object.entries(WANT)) {
  const file = join(OUT, path);
  if (!existsSync(file)) die(`${name}: no artifact at ${path}`);
  const raw = readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const full = json.abi;
  if (!Array.isArray(full)) die(`${name}: artifact has no abi`);
  artefacts[name] = { path, solc: json.metadata?.compiler?.version ?? null, abiSha256: createHash('sha256').update(JSON.stringify(full)).digest('hex') };
  const pick = [];
  for (const f of fns) {
    const hits = full.filter((x) => x.type === 'function' && x.name === f);
    if (!hits.length) die(`${name}.${f}: not in the build (abi-check)`);
    pick.push(...hits);
  }
  for (const e of evs) {
    const hits = full.filter((x) => x.type === 'event' && x.name === e);
    if (!hits.length) die(`${name} event ${e}: not in the build (abi-check)`);
    pick.push(...hits);
  }
  pick.push(...full.filter((x) => x.type === 'error'));
  abi[name] = pick;
}

const body = {
  contracts: { repo: 'gavel-contracts', commit: COMMIT },
  artefacts,
};
const text =
  `// GENERATED by scripts/sync-v2-abi.mjs from a forge build of gavel-contracts at ${COMMIT}. Do not edit.\n` +
  `// The functions and events the gavel-testnet write tools use, and every custom error, per contract.\n` +
  `export const V2_ABI_SOURCE = ${JSON.stringify(body, null, 2)} as const;\n\n` +
  Object.entries(abi).map(([n, a]) => `export const ${n}_ABI = ${JSON.stringify(a, null, 2)} as const;\n`).join('\n');

if (CHECK) {
  if (!existsSync(TARGET)) die('src/v2/abi.generated.ts does not exist; run without --check');
  if (readFileSync(TARGET, 'utf8') !== text) die(`src/v2/abi.generated.ts differs from the build at ${COMMIT}: rerun without --check and review`);
  console.log(`v2 ABI fragments up to date with gavel-contracts ${COMMIT} (${Object.keys(abi).length} contracts)`);
} else {
  writeFileSync(TARGET, text);
  const n = Object.values(abi).reduce((s, a) => s + a.length, 0);
  console.log(`wrote src/v2/abi.generated.ts: ${Object.keys(abi).length} contracts, ${n} entries; gavel-contracts ${COMMIT}`);
}
