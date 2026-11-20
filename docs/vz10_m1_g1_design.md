# VZ10 row M1, G1: the testnet MCP profile, its tools and design

**Status:** G1 RULED (operator, 2026-11-18): C1 to C7 each as recommended in §0. No code.
**Date:** 2026-11-18
**Runbook:** gavel-protocol-docs `operational/v2/planned/runbook_VZ10_v2_developer_surfaces_v0_1.md` v0.1 (main `ec19600`), §2, §3, §4a, §6.
**Branch:** gavel-mcp `vz10/m1-mcp-testnet`, from `origin/main` `a57185c`.
**Sources read:**
- gavel-indexer master `7386125` (`vz9-routes.js`, the 27 routes);
- gavel-contracts `a554ee0` (`src/`);
- VZ9's three deployment records at docs `ec19600`;
- gavel-mcp `a57185c` (`src/factory/envelope.ts`, `src/tools/factory/prepare.ts`, `src/upstream.ts`, `src/profiles.ts`, `src/tools/index.ts`, `scripts/`);
- the live testnet API, `/v1/core/v2`, read on 2026-11-18;
- aletheia-docs `origin/main` `f355599` (`agent_listing_copy_v1.md`, `aletheia_design_principles.md` §2, `regulatory_positioning.md` §3);
- gavel-frontend-mainnet `SignPage.jsx` and `signIntent.js`.

Framing throughout: describe, don't recommend. Read tools return data, write tools return unsigned calldata, and the human signs. No tool ranks, scores, sorts by rate or forecasts.

---

## 0. Summary of the choices (each goes to the operator with a recommendation)

| # | Choice | Recommendation |
|---|---|---|
| C1 | The read-tool list (§2) | 18 tools over `/v1/core/v2` only, with no chain reads. The four gaps go to the operator as missing routes (§2.4). |
| C2 | Which write tools come first (§3) | Wave 1 at G3: the vault, spot, and the bullet loan from opening to repayment and collection (19 tools). Waves 2 and 3 follow as their own G3 diffs. |
| C3 | The signing route for struct, array and `bytes` arguments (§4) | **Both.** Every blueprint carries the raw `{to, data, value, chainId}`. A testnet `/sign` page (G4) refuses by default, decodes, and hands the transaction to the user's own wallet. Its link is emitted only once that page is live. |
| C4 | The host name (§5) | `mcp-testnet.thegavel.io`, after `api-testnet.thegavel.io`. |
| C5 | Whether any v1 tool joins (§6) | None. The profile is V2 only. |
| C6 | Where the addresses come from (§7) | A generator script in gavel-mcp reads VZ9's three records with `git show` at a pinned docs commit, as the site's `sync-deployments.mjs` does, and writes a committed table. A check compares that table with the live `/deployment` route. |
| C7 | The server instructions (§8) | The draft in §8, as an addition to `agent_listing_copy_v1.md` §8. |

## 1. The profile

- **Id:** `gavel-testnet`, chosen by `MCP_PROFILE`, with a fail-closed allowlist as today.
- **serverInfo.name:** `gavel-testnet-mcp`. **serverVersion:** 0.1.0.
- **logService:** `gavel-testnet-mcp`, distinct from the other two services, so its client counter is its own.
- **Unit:** a new systemd unit with its own port and `.env`, built from its own working tree, at G5.

**Files touched outside the new ones.** All changes are additive, and none changes the `gavel` or `observatory` profile:

| File | Change | Note |
|---|---|---|
| `src/profiles.ts` | `ProfileId` gains `'gavel-testnet'`; a `PROFILES` entry, the instructions constant and the allowlist | Strictly needed to register a profile |
| `src/tools/index.ts` | One `registerV2Tools(s)` call | The `scopeTo` branch for x402 and metering stays observatory-only, so the new profile takes no x402 path |
| `src/factory/envelope.ts` | Two additive type widenings: `Prerequisite.type` gains `'vault_deposit'` and `'vault_consumer_approval'`; `Deeplinks.eip681` becomes `string \| null` with a reason | Existing tools are unchanged. The V2 tools pass their own `deeplinks` into `buildEnvelope`, so `walletAgnosticUrl`'s `thegavel.io/sign` is untouched |
| `scripts/check-profiles.mjs` | The third profile | |
| `package.json` | Script entries for the generator and checks | ⚠ LG2's branch also changes `package.json`. A merge may need a trivial hand-resolve; planning should know |

**Not touched:**
- `src/x402.ts` and `src/tools/protocol/reference.ts` (LG2's), `src/tools/factory/prepare.ts`, `src/upstream.ts`, `server.json`, `server.observatory.json`;
- the v1 network bug at `prepare.ts` lines 156, 475 and 580, which is on planning's raise list.

`upstreamGet(path, { network: 'arbitrum-sepolia' })` already reaches `GAVEL_API_TESTNET_BASE_URL`, and refuses rather than serve mainnet data under a testnet label.

**No registry listing is proposed.** `server.json` and the MCP registry stay for the mainnet servers; a testnet listing would be a separate decision.

---

## 2. Read tools (C1)

### 2.1 Common shape

Every read tool:
- takes `network` only implicitly: the profile is Arbitrum Sepolia, so there is no `network` argument;
- refuses an argument it does not take, by name, as the observatory does;
- returns this block:

```
{
  provenance: {
    chain: { id: 421614, name: 'arbitrum-sepolia', testnet: true },
    indexedTo,            // from the route; the block the indexer has read to
    source,               // 'indexer' | 'scenario-file'
    abiCommit,            // the ABI commit the indexer decoded with
    deployment: { records: { stage3, s3m, bond03 }, docsCommit },   // §7: what the addresses were generated from
    ownAccount: { available, registered, note },                     // as served
    route: ['/v1/core/v2/…'],                                        // every route this answer called
  },
  sample: {
    rows, limit, truncated,               // truncated = the route returned `limit` rows or a `next` cursor
    window,                               // { from, to } where the route has one
    distinctAddresses,                    // over the returned rows' party fields
    ownAccountRows,                       // rows with a true flag
    ownAccountShare,                      // ownAccountRows / rows, or null with reason when ownAccount.available is false or every flag is null
  },
  disclosure: 'Arbitrum Sepolia test network. Test tokens with no value; contracts unaudited. Most activity is own-account.',
  data: …                                  // the route's rows, field names as served, integers as decimal strings
}
```

**Rules:**
- **Order is the route's.** Every list route is newest first by block. No tool re-sorts, and none sorts by rate or price.
- **No "best".** Where a route serves `bestBid` (the engine's standing bid), the field is passed through and described as "the standing bid as the engine records it". It is never presented as a recommendation.
- **Structured absence.** Where a figure would be degenerate, the tool returns `{ absent: { reason, threshold, observed } }` and never a zero. Examples: `get_curve` with `n = 0` (today's live value); a spot market with no cleared batch.
- **Own-account flags.** A null flag means unknown, never "no", as the indexer's own rule says. On 2026-11-18 the register reads `available: true, registered: 19`.

### 2.2 The tools, per product

| # | Product | Tool | Route(s) | Response (`data`) |
|---|---|---|---|---|
| R1 | All | `get_deployment` | `/deployment` and the generated table (§7) | Contracts: name, address, product, role, `superseded`, `followed`, deploy block. Tokens: symbol and decimals. The 16 spot and bill markets. The chain id. The record shas the table was generated from. |
| R2 | All | `get_tape` | `/tape` (`since`, `product`, `kind`, `cursor`, `limit`); `/tape/figures` with `figures: true` | Event rows `{at, kind, address, contract, product, block, tx, logIndex, ids, ownAccount}`, plus `next`. The figures: `distinctAddresses7d`, `actions24h`, `breached7d`, `bondMinted7d` and the window. |
| R3 | Core: vault, obligations, liens | `get_account` | `/accounts/:a/holdings`, `/vault-events`, `/held-units` and `/bond`; `/bullet-loans/opened?opener`; `/bullet-loans/entries?owner`; `/protection/policies?account`; `/futures?account`. A `sections` argument chooses which | Claims (obligation id, units, set id, escrowed in a sale); obligor positions (set id, custody); vault events; held units with the function that claims them; BOND events; loans opened; entries; policies; futures. **No balances**: see gap G-1. |
| R4 | Core | `get_contract_events` | `/events` (contract by name from the table or by address; event name; `t1`–`t3`; block range; cursor) | Decoded `args`, `blockNumber`, `transactionHash`, `logIndex`, `at`, `from`. This is the raw history of an obligation, a lien or a set while no state route exists (G-2). |
| R5 | Engines | `list_auctions` | `/auctions?state=open\|closed&product` | Open: engine, auction id, product, controller, loan id, opener, amount, term, bids, the standing bid, and an `end` note. Closed adds: size, bid quantity, bid-to-cover, clearing rate, range, distinct bidders, status, `isPrice` and `notPriceReason` as served. |
| R6 | Engines | `get_auction_bids` | `/auctions/:engine/:auctionId/bids` | Bids in sequence order, newest first: bidder, price num/den, size, block, tx, ownAccount. |
| R7 | Bullet loan | `list_bullet_loans` | `/bullet-loans/opened` (`opener`), `/bullet-loans/entries` (`owner`) | Loans: contract, loan id, side (request or offer), opening, opener, engine, auction id, status, originations `{ref, setId, lienId}`. Entries: loan id, entry id, owner, size, repayment, released. |
| R8 | Bullet loan and bill | `get_curve` | `/curve` | The observed points as served: bullet-loan rates `{num, den}` with term and set id; bill clearing prices per market and slot. Also `n`, `span`, `distinctCounterparties`, `ownAccountShare`. **No fit and no interpolation.** An absence below a threshold (proposed: `n < 1` for points; any summary below 5 points is not computed). |
| R9 | Spot | `list_spot_markets` | The generated table (s3m record); with `last: true`, `/spot/:m/last` per market | The 6 pairs and 10 bill series: name or series k, SpotMarket address, engine market id, base and quote with decimals, and params (minimum sizes, slot durations, open-order cap). Optionally each market's last cleared batch. The order is the record's, never by price or volume. |
| R10 | Spot | `get_spot_market` | `/spot/:m/batches`, `/spot/:m/last`; `/spot/:m/clearing-pages` with `pages: true` | Batches: slot, slot id, status, clearing price, matched base volume, `lowVolume`, fills, orders placed buy/sell, cleared at. Clearing pages: keeper, steps, credited, keeper paid, gas. |
| R11 | Future | `list_future_offers` | `/calendar/futures-offers` | Offers grouped by reference date: offer id, maker, maker side, quantity, forward price, cap per unit, expires at, status. |
| R12 | Future | `list_futures` | `/futures?account` | Future id, offer id, long, short, both set and obligation ids, reference key, opened, settled. |
| R13 | Insurance and liquidation cover | `list_cover_offers` | `/protection/offers?open&adapter` | Offer id, underwriter, product, terms (asset, capacity, premium bps, cover grace, pay delay, adapter, collateral key, minimum collateral, maximum loan grace, due window, expiry), remaining, close status. Liquidation cover is the same route filtered by a MorphoCoverAdapter address from the table. **Today: 0 offers.** |
| R14 | Insurance and the bill | `list_policies` | `/protection/policies?account&role` | Policy id, offer id, product, kind, insured, beneficiary, seller, cover set/id, loan id or ref, units, cover, premium, phase, and ownAccount for insured and seller. |
| R15 | The bill | `get_bill_series` | `/bills/:k/backing`, `/bills/:k/policies`, and the table for `D_k`, the bill token and the series' SpotMarket | The series k, its date `D_k` from the record (`SERIES_EPOCH + k × 7 days`), backing events, policies, and the market address to pass to `get_spot_market`. |
| R16 | Secondary | `list_secondary_sales` | `/secondary/sales?market&state` | Market, auction id, kind (lot or position), seller, size, latest end, status, winner, price. **Today: 0 sales.** |
| R17 | Secondary | `get_secondary_sale_bids` | `/secondary/:market/:auctionId/bids` | Bids, and escrowed-bid events. |
| R18 | Calendar | `get_calendar` | `/calendar?from&to`; `/calendar/scenario` with `scenario: true` | Dated rows: loan due, future reference time `T`, cover window end. The route's own `absent` note (bill `D_k` is not in the events; R15 gives it from the record). The scenario adds the fleet's published scenario document, `source: 'scenario-file'`, `indexedTo: null`. |

**Route coverage:** 26 of the 27 routes.

**`/logs` is not wrapped.** It serves raw `eth_getLogs` bytes for the site's `logs()`. R4 serves the same events decoded, which is what an agent can read.

**ClockAuction and SealedFront** have no product at `a554ee0`. R5 shows only auctions whose `product` is set, which is the route's own filter.

### 2.3 Live state, 2026-11-18

- `indexedTo` 330462590.
- The last 500 tape rows are all spot: 452 orders placed, 30 cancelled, 18 batches cleared.
- 56 closed auctions, all spot: 21 settled with a price and 35 expired.
- The curve has `n = 0`.
- There are no protection offers, no policies and no secondary sales.
- The read tools describe exactly this. The G2 harness asserts the shapes, not the counts.

### 2.4 Gaps: missing routes, for the operator, not this row

| Gap | What is missing | Effect without it |
|---|---|---|
| G-1 | A vault balance per account: free, reserved and locked per asset (`Vault.balance`, `totalBalance`) | `get_account` shows vault events but no balance. The write tools read balances from the chain for their own checks (§3.1), as `prepare.ts` does. |
| G-2 | The state of an obligation, a set or a lien by id (status, payoff, `debtAt`, due date, lien status) | R4 gives the history, not the state. The write tools read the state from the chain for their checks. |
| G-3 | BOND's state: listed loan tokens, prices and their lapse (`BondListing.assetPrice`), caps, supply | No read tool for BOND beyond the account's events. The BOND write tools (wave 3) read the chain. |
| G-4 | A liquidation-cover account: `healthOf`, `frozen`, `coverTerms` | Wave 3 reads the chain. |

The recommendation keeps read tools on `/v1/core/v2` only, as §4a.2 says, and raises G-1 to G-4. The alternative is chain reads inside the read tools. That is faster to ship, but it puts a second source beside the indexer, with its own `indexedTo` problem.

---

## 3. Write tools (C2)

### 3.1 Common shape and checks

Each tool returns the existing envelope (`buildEnvelope`):
- `intent`, `summary_for_user`, `parameters_you_supplied`, `context`, `prerequisites`, `transaction`, `deeplinks`, `warnings`, `expires_at` (10 minutes), and `disclosure` = `REGULATORY_NOTICE` verbatim;
- `REGULATORY_NOTICE` is also appended to every write tool's description;
- chain id 421614 and addresses from the generated table only (§7);
- `value` is always `0`, since no V2 function is payable.

**V2 has three kinds of prerequisite, not one.** Each is emitted only when the chain says it is short, and each in exact amounts:

1. **`erc20_approval`:** `approve(spender, exact)` to the contract that pulls. The spender differs by action: the Vault (deposit; lock shortfalls), Obligation (pay from wallet), Lien (payoff from wallet), a secondary market (wallet-routed bid), BondProtocol (stake), or a MorphoCoverAdapter (supply, repay). It is **never unlimited**.
2. **`vault_deposit`:** `Vault.deposit(user, assetKey, amount, 0x)`, where an action reserves from free vault balance and the free balance is short by `amount`. The asset key is `0x01 ‖ 11 zero bytes ‖ token`.
3. **`vault_consumer_approval`:** `Vault.approveConsumer(product, true)`, where the user has not approved this product (`isUserApproved`). The tool also checks `isAuthorisedConsumer(product)`, and refuses if governance has not whitelisted it.

ERC-1155 claim units add a fourth: `Obligation.setApprovalForAll(product, true)`. It is an all-units approval by the standard's design and has no exact-amount form, so the tool says so in a warning and names the revoke tool.

**Every tool:**
- validates addresses and decimals, with `toBaseUnits` refusing silent truncation;
- reads the chain only for the checks (balances, allowances, approvals, state);
- turns a revert it can foresee into a **hard error** naming the contract's own custom error;
- turns a condition that may move before the send into a **soft warning**.

`*For` (operator) variants are not wrapped in waves 1 and 2. The user's wallet is the signer, so the plain function is the right one.

### 3.2 Wave 1: the vault, spot and the bullet loan (recommended for G3)

| # | Tool | Contract.function | Arguments | Hard errors checked before encoding | Soft warnings | Prerequisites |
|---|---|---|---|---|---|---|
| W1 | `prepare_test_token_mint` | MockERC20 `mint` (mWBTC, mUSDC; signature to confirm at G3) | to, amount | Token is one of the record's mocks | "Test tokens with no value" | none |
| W2 | `prepare_vault_deposit` | Vault `deposit(address user, bytes32 asset, uint256 amount, bytes params)` | Scalars plus `bytes` `0x` | `NotAccountHolder` (user ≠ signer), `InvalidAmount`, ERC-20 only (`InvalidAsset`), wallet balance ≥ amount | none | `erc20_approval` (Vault, exact) |
| W3 | `prepare_vault_withdraw` | Vault `withdraw(address user, bytes32 asset, uint256 amount, bytes externalDestination)` | Scalars plus `bytes` `abi.encode(dest)` | `InsufficientBalance` (free < amount; reserved and locked are not free), `InvalidAddress` (destination is 0 or the vault) | Funds reserved by open orders or offers are not free | none |
| W4 | `prepare_vault_product_approval` | Vault `approveConsumer(address consumer, bool approved)` | Scalar | Consumer is a V2 product in the table; `isAuthorisedConsumer` | Revoking while orders or offers are open makes later moves revert | none |
| W5 | `prepare_spot_order` | SpotMarket `placeOrder(uint8 side, uint256 amountBase, uint256 limitPrice, uint256 expiresAtSlot, uint256 hintPrev)` | Scalar | Market in the table; `OrderBelowMinSize` and `OrderBelowMinQuote` from the record's params; `InvalidPrice`; `ExpiresAtNotInFuture` against `getCurrentSlot`; `UserOrderCapReached` (`openOrdersByUser`); `EnforcedPause` | Clears in a batch at one price, or not at all (`lowVolume`). `hintPrev` from `findHint` may go stale | `vault_deposit` (sell: base; buy: `floor(amountBase × limitPrice / 1e18)` quote); `vault_consumer_approval` |
| W6 | `prepare_spot_cancel` | SpotMarket `cancelOrder(uint256 orderId)` | Scalar | `OrderNotFound`, `NotOrderOwner` | The cancel is usually **queued**; the reservation is released at the next drain or clear. The gas limit must be at least about 155k (`InsufficientGas`) | none |
| W7 | `prepare_bullet_request_open` | BulletLoanRequest `openRequest(address borrower, RequestTerms t, bool many)` | **Struct with nested `bytes`** (`lockParams = abi.encode(depositor, bytes32[] assets, uint256[] amounts)`) | `InvalidTerms` codes 1, 2, 4, 5, 6, 10, 11 (amounts, `maxRepayment`, term 7 days to 30 years, auction 1 to 7 days, bid step ≤ 10%, depositor = borrower); legs strictly ascending, 1 to 16; `EnforcedPause` | The terms hash is returned in `context`, since bidders need it. Collateral is locked until settlement | `erc20_approval` (Vault, per leg: leg amount − free); `vault_consumer_approval` |
| W8 | `prepare_bullet_request_bid` | BulletLoanRequest `bidRequest(address lender, uint256 loanId, uint256 quantity, uint256 repayment, uint256 minFill, uint256 hintPrev, bytes32 expectedTerms)` | Scalar | `WrongState`, `TermsChanged` (`expectedTerms` read from the opening), codes 20 to 22, `StepNotMet` and `BeyondLimit` against `minimumNextBid`, `PrincipalCannotBid` | A lower repayment is a more competitive bid. It may be outbid before the end, and the end is the engine's `deadlineOf` | `vault_deposit` (principal); `vault_consumer_approval` |
| W9 | `prepare_bullet_offer_open` | BulletLoanOffer `openOffer(address lender, OfferTerms t, bool many)` | **Struct** (scalar fields) | `InvalidTerms` codes 1 to 7, 10, 11; `InsufficientBalance` | Principal is reserved until a fill or cancel | `vault_deposit`; `vault_consumer_approval` |
| W10 | `prepare_bullet_offer_bid` | BulletLoanOffer `bidOffer(address borrower, uint256 loanId, uint256 loanSize, uint256 repayment, uint256 minFill, uint256 hintPrev, bytes32 expectedTerms)` | Scalar | `WrongState`, `TermsChanged`, code 30, `QuantityOutOfRange` (`minLoan`..`maxLoan`), `BeyondLimit` (floor) | Offer to one: every bid locks a full new `need = floor(loanSize × 1e18 / loanToCollateral)` until the displaced entry is released | `erc20_approval` (Vault, `need − free`); `vault_consumer_approval` |
| W11 | `prepare_bullet_cancel` | Bullet `cancel(uint256 loanId)` | Scalar | Opener is the signer; `WrongState`; `CancelNotAllowed` after the first bid | Escrow returns to free vault balance, not the wallet | none |
| W12 | `prepare_bullet_entry_release` | Bullet `release(uint256 entryId)` | Scalar | `NotReleasable` | Anyone may call it; the escrow returns to the entry owner's vault | none |
| W13 | `prepare_bullet_finalise` | Bullet `finalise(uint256 loanId, uint256 maxSteps)` | Scalar | Past `deadlineOf`; `Stalled` | Anyone may call it, and the fleet's keepers usually do. The tool is for a user who does not wait | none |
| W14 | `prepare_obligation_pay` | Obligation `pay(uint256 obligationId, uint256 amount, uint8 source)` | Scalar | `InvalidStatus`, `MustPayWhole` (amount ≥ `payoff`), `PaymentAboveOwed`; **a bound bullet set that has breached is refused here, and W15 is named** | none | WALLET: `erc20_approval` (Obligation, exact `payoff`). VAULT: `vault_consumer_approval` (Obligation) |
| W15 | `prepare_lien_payoff` | Lien `payoff(uint256 lienId, uint256 maxAmount, uint8 source)` | Scalar | `InvalidStatus`, `SetNotBreached`, `PayoffAboveMax` | `debtAt` may move between the quote and the send, so `maxAmount` is the user's cap | WALLET: `erc20_approval` (Lien, `maxAmount`). VAULT: `vault_consumer_approval` (Lien) |
| W16 | `prepare_lien_release` | Lien `release(uint256 lienId)` | Scalar | `SetNotDischarged`, `InvalidStatus` | Anyone may call it, and keepers usually do | none |
| W17 | `prepare_lien_claim` | Lien `claim(uint256 lienId)` | Scalar | `NotPositionOwner`, `InvalidStatus` (still active), `NothingToClaim` | Collateral lands in the vault; W3 withdraws it | none |
| W18 | `prepare_obligation_collect` | Obligation `collect(uint256 obligationId, bytes32 key, address destination, bool toVault)` | Scalar | `accrued(id, holder, key) > 0`; `InvalidAddress` | none | none |
| W19 | `prepare_obligation_redeem` | Obligation `redeem(uint256 obligationId, address destination, bool toVault)` | Scalar | `NotFinal`, `InvalidUnits` (zero units) | Burns every unit held | none |

That is 19 tools. Three of them (W2, W3, W7) carry `bytes`, and two of them (W7, W9) structs.

### 3.3 Wave 2: the future, insurance and the bill, and the secondary market

| Tool | Contract.function | Arguments | Main hard errors | Approvals |
|---|---|---|---|---|
| `prepare_future_offer` | FutureOrchestrator `offer(OfferTerms)` | **Struct** (scalars) | `InvalidTerms` (samples odd and ≤ max; lookback bounds), `InvalidExpiry` (`refTime` within the bounds; `expiresAt`) | `vault_deposit` (cap = `floor(quantity × capPerUnit / 1e18)`); `vault_consumer_approval` |
| `prepare_future_take` | `take(uint256 offerId)` | Scalar | `OfferNotOpen` (`offerEnd`), `PrincipalCannotTake`, `NotAllowed` (named taker); soft: the maker's consumer approval is still in place | `erc20_approval` (Vault, `cap − free`); `vault_consumer_approval` |
| `prepare_future_cancel` | `cancelOffer(uint256 offerId)` | Scalar | `OfferNotOpen`, `NotMaker` | none |
| `prepare_cover_offer` | CoverOrchestrator `createOffer(OfferTerms)` | **Struct** | `InvalidOffer` bounds (premium 1 to 10,000 bps, grace, pay delay, due window, expiry; Gavel or adapter shape) | `vault_deposit` (capacity); `vault_consumer_approval` |
| `prepare_cover_offer_cancel` | `cancelOffer(uint256)` | Scalar | `NotUnderwriter`, `OfferNotOpen` | none |
| `prepare_loan_protection` | `insure(offerId, loanId, units, beneficiary, Expected e)` | Scalars plus a **struct** (`Expected`, copied from `getOffer`) | `OfferExpired`, `TermsMismatch`, `LoanNotInsurable` codes 1 to 9, `CollateralBelowFloor`, `DueOutOfRange`, `InsufficientCapacity`, `PremiumAboveMax` (`quote`) | `setApprovalForAll` (orchestrator); `vault_deposit` (premium); `vault_consumer_approval` |
| `prepare_bill_deposit` | BillPackager `deposit(offerId, loanId, units, recipient, Expected e)` | Scalars plus a **struct** | `OfferNotBillable`, `InvalidSeries`, `OfferEnded`, `CoverTooSmall`, and the insure errors | `setApprovalForAll` (packager); `vault_deposit` (premium); `vault_consumer_approval` |
| `prepare_bill_redeem` | BillPackager `redeem(uint256 k, uint256 amount, address destination)` | Scalar | `SeriesNotFinal`; the bill balance in the wallet (bills in the vault must be withdrawn first) | none |
| *(bill trading)* | The spot tools, W5 and W6, on the series' SpotMarket | — | — | — |
| `prepare_held_units_claim` | CoverOrchestrator `claimUnits(policyId, destination)` or ClaimLotMarket `claimUnits(id, destination)`, chosen from `/held-units`' `claim` field | Scalar | `NotHeldFor`, `NoUnitsHeld` | none |
| `prepare_claim_lot_sale` | ClaimLotMarket `createAuction(id, units, paymentToken, reservePrice, duration, expectedAsset, expectedDueAt)` | Scalar | `ExpectedMismatch`, `InvalidItemState`, `InvalidDuration`, `EndBeyondLatest` | `setApprovalForAll` (market) |
| `prepare_position_sale` | ObligorPositionMarket `createAuction(setId, paymentToken, reservePrice, duration, expectedMaxDebt)` | Scalar | `InvalidItemState`, `DebtAboveMax`, `EndBeyondLatest` | ERC-721 `approve(market, setId)` (exact token) |
| `prepare_secondary_bid` | Secondary `bid(auctionId, amount, expectedItem, expectedPaymentToken, maxDebt)` | Scalar | `AuctionClosed` or `AuctionEnded`, `ExpectedMismatch`, below `minimumBid` | **The route is decided off-chain and stated.** Vault path: consumer approval and free balance. Wallet path: `erc20_approval` (market, exact). A soft warning covers a balance change switching the path at execution |
| `prepare_secondary_cancel` | `cancelAuction(auctionId)` | Scalar | `NotSeller`, `CannotCancelWithBids` | none |
| `prepare_refund_claim` | Secondary `claimRefund(token, destination)` | Scalar | `NoRefundAvailable` | none |

That is 14 tools.

### 3.4 Wave 3: liquidation cover, BOND and approvals

- **Liquidation cover:** MorphoCoverAdapter `openAccount`, `supplyCollateral`, `borrow`, `arm`, `disarm`, `repay`, `repayAll`, `withdrawCollateral`, and CoverOrchestrator `insureVia`.
  - The adapters run on MockMorpho, have no `*For` variants, and pull their tokens with the adapter as spender.
  - `repayAll` cannot be exact, because interest accrues before the pull. Its approval carries a stated buffer, and that is a disclosed exception to "exact amounts".
- **BOND:** BondProtocol `registerSet`, `commit` and `registerExternal`, each with an exact `erc20_approval` (BondProtocol, stake).
  - These carry a lapse warning. On 2026-11-18 the seeded prices lapse on 2026-11-21 at about 14:42 to 14:45 UTC unless new clearings occur. After that, BTC-collateralised loans count 0 and mint nothing, without reverting.
  - BOND has no user mint or redeem: minting happens through the keeper's `resolveObligation`.
- **Revocations and operators:** a revoke for `setApprovalForAll` and `approveConsumer`.
  - `setOperatorApproval` per contract (design principles §7) is **held back**. A tool that grants an operator authority over a user's positions is the one place a blueprint widens what someone else can do. It needs its own copy and its own decision.

That is about 12 tools.

**Not wrapped, in any wave:**
- the keeper-only functions: Spot `clear`, `drain`, `expireEmptySlot`; Lien `enforce`; `settle`, `finalise` and `settleMany` on insurance and the bill; Bullet `executeFill` and `expire`; BondProtocol `resolve*` and `observe`; the future's `settle` and `expireOffer`;
- `Obligation.createSet` and `createContingentSet`, which products call;
- the engines, which only their controller (a product) may call.

### 3.5 Proof at G3

Each tool is proven on an anvil fork of Arbitrum Sepolia:
- the blueprint, with its prerequisites, is signed in the test only by an anvil test account;
- the test asserts the state change its `summary_for_user` states (balances, reservations, events);
- every hard error is tested once.

Nothing is sent to Sepolia.

---

## 4. The signing route (C3)

**The problem.** `eip681()` carries scalars only. Of wave 1, W2, W3 and W7 (`bytes`, and a struct with nested `bytes`) and W9 (a struct) cannot be expressed. Of wave 2, every insurance and future write has a struct. These are most of the important actions.

| Option | What the user gets | Trade-off |
|---|---|---|
| (a) The raw transaction only | `{to, data, value, chainId}` for every blueprint; `eip681: null` with a reason where it cannot carry the arguments | Works in any wallet that accepts raw calldata, and in agent wallets. A person in an ordinary browser wallet has no way to paste calldata, so for them it is a dead end. |
| (b) A sign page only | A link to a testnet `/sign` page | One more hop; useless to a headless agent wallet. |
| **(c) Both (recommended)** | The raw transaction always; `eip681` where the arguments are scalar; and `wallet_agnostic_url` to `https://testnet.thegavel.io/sign?to=…&data=…&value=0&chainId=421614` | The headless path and the person path both work. |

**The page** (G4) copies mainnet's `SignPage.jsx` and `signIntent.js` pattern. Its default is refusal:
1. `to` must be a V2 address from the same generated table;
2. the selector must be one this profile publishes;
3. an `approve` must name a V2 spender (Vault, Obligation, Lien, a secondary market, BondProtocol, a MorphoCoverAdapter); `setApprovalForAll` must name a V2 product;
4. `value` must be 0 and `chainId` must be 421614.

It then **decodes the calldata against the ABI, structs included, and shows every argument**, and the user's own wallet signs. It signs nothing itself.

**Timing.** Until G4's page is live, `wallet_agnostic_url` is `null`. Mainnet's link pointed at a missing page for a week; this repeats nothing. The base URL comes from the profile's environment, not from the hard-coded `thegavel.io/sign`.

## 5. The host name (C4)

| Option | Note |
|---|---|
| **`mcp-testnet.thegavel.io` (recommended)** | Matches `api-testnet.thegavel.io`. One label, so the existing certificate pattern and the manifest's naming hold. |
| `mcp.testnet.thegavel.io` | Nests under `testnet.`; a second-level label, so a new certificate name and a new DNS pattern. |
| `testnet.thegavel.io/mcp` | A path on the site's host, behind the site's nginx. It couples the MCP's uptime and headers to the site's. |

## 6. v1 tools (C5)

The brief's default is **none**, and I recommend it. The v1 testnet tools:
- read v1's contracts (`check_wallet_status`, `get_book`, `prepare_*`), which would mislead on a V2 profile;
- or are network-free catalogues (`list_wallet_options`, `list_fiat_onramps`). Fiat on-ramps have no meaning for mock tokens.

`list_wallet_options` is the only arguable one. A wallet must speak Arbitrum Sepolia, and that catalogue does not say whether one does. So it stays off too.

## 7. Where the addresses come from (C6)

| Option | Source | Note |
|---|---|---|
| **(a) Recommended:** a generator, `scripts/sync-v2-deployment.mjs` | Reads the three records at a pinned docs commit with `git show`, as the site's `sync-deployments.mjs` does: the Stage 3 md's Contracts and Tokens tables, `arbitrum_sepolia_vz9_s3m.json` (machine-readable: `pairs[6]`, `billSeries[10]`, `engine`, `vault`, `billPackager`) and the BOND v0.3 md | Writes `src/v2/deployment.generated.ts` with each record's sha256 and the docs commit, which is served in every `provenance.deployment`. `--check` fails if the file is stale, and checks against the live `/deployment` route (every V2 address present; `superseded` agrees). Superseded contracts (VZ8's core and AO; BOND v0.2) are carried and marked, never encoded against. |
| (b) | Copy the indexer's `deployments/vz9.testnet.json` | Already cross-checked against the broadcasts and the chain. But it couples gavel-mcp to the indexer's repository layout, and its generator needs the gavel-contracts broadcasts and an RPC. |
| (c) | Read `/deployment` at runtime | No generated file, but the write tools' addresses would then depend on an HTTP answer at encoding time. A wrong or compromised answer would become calldata. |

**The ABIs** are generated the same way: fragments for each function in §3, from a gavel-contracts build at `a554ee0`, with an `--abi-check` that fails on any difference. They are not hand-typed. The v1 lesson in `agent_listing_copy_v1.md` §4.5 ("a hand-maintained table with no test") applies.

## 8. The server instructions (C7)

**The draft**, for `agent_listing_copy_v1.md` as a new §8 "The Gavel testnet server (V2)". It is written fresh in V2 vocabulary, as the file's §0 scope note requires. None of §1 to §6 is reused, except §2.2's entity sentence, which is quoted verbatim (D3's substance in one line).

> This server exposes Aletheia Analytics' data product for Gavel V2 on Arbitrum Sepolia, a test network: the module core (the vault, obligations and liens), the auction engines, and the products built on them — the bullet loan, spot markets, the cash-settled future, loan protection and the insured bill, liquidation cover, the secondary market and BOND. Its tokens are test tokens with no value and its contracts are unaudited. Every tool here either returns observed data or returns an unsigned transaction blueprint. Nothing on this server signs, submits or broadcasts a transaction, and no tool takes custody of funds or receives a mandate — a blueprint is calldata the caller's own wallet may choose to sign.
>
> Read the provenance fields before treating any figure as a market reference. Activity on this testnet is predominantly own-account: responses carry the block the indexer has read to, the number of rows observed, the distinct addresses among them and the own-account share where the register allows it. A null own-account flag means unknown, not no. Where a figure would be degenerate on the observed data, the response returns a structured absence naming the threshold and the observed count rather than a zero.
>
> Nothing here is advice. Tools that return catalogues do not rank their entries and list them in the order they occurred, never by rate or price; tools that return distributions report what was observed with the sample size, and do not forecast a fill, a rate, a time-to-fill or a return. A blueprint is built from the parameters the caller supplied; this server does not choose a market, a size, a price or a term.
>
> Aletheia Analytics SASU operates this interface and data product; the Gavel Protocol is autonomous, permissionless code with no operating entity.

**Notes for the operator:**
- **No cross-pointer is added.** OB2 §0.5 budgets exactly one cross-link each way between the Gavel and observatory servers. A pointer from this server to `mcp.thegavel.io`, or to the observatory, would be new, and is left out rather than spent.
- **"Unaudited" matches the testnet site's label**: "On testnet (v2, unaudited)".
- **Measured:** 1,787 characters over four paragraphs (711, 511, 414, 145). The §2.2 mainnet block is 1,303. The diff then goes to `aletheia-docs` on `docs/vz10-m1-copy`, and planning merges it.

---

## 9. For planning (raise-list items found at G1)

1. **The TW2 condition for G4 may already be met.** gavel-frontend-testnet `origin/main` `d2a40b9` is "Merge tw2/p10-logs: TW2 Phases 6, 8 and 10 … passed Gate X", and aletheia-docs `f355599` merges TW2 Phases 6, 7, 8 and 10. Planning should confirm before G4.
2. **LG2's footprint differs from the brief.** `origin/lg2/identified-paid-access` against `origin/main` changes `src/x402.ts`, `package.json` and `scripts/check-x402-gate.mjs`, not `src/tools/protocol/reference.ts`. This row touches none of the three, except `package.json`'s script entries (§1).
3. **gavel-mcp's local `main` is stale**, at `4297457` against `origin/main` `a57185c`. This row branched from `origin/main`.
4. **The missing routes G-1 to G-4** (§2.4) are for the operator, for gavel-indexer.
5. **BOND's seeded prices lapse on 2026-11-21**, about 14:42 to 14:45 UTC, unless the fleet clears on markets 4, 5 and 8. This affects any BOND demonstration after that date.
6. **The entity line, against the testnet's ownership.** VZ9's record says the deployer EOA owns every owned V2 contract on Sepolia. Those contracts include the vault's consumer whitelist, the pause, BOND's listings and the spot parameters. The §8 instructions keep §2.2's sentence ("autonomous, permissionless code with no operating entity") unchanged, since it is canon. Planning should confirm that canon is content with it on a testnet whose owner keys are a single EOA, or should give a testnet qualification for the operator to rule on.
