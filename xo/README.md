# Standing Order on XO

The Standing Order covenant, ported to an **XO wallet template**: [`standing-order.template.mjs`](standing-order.template.mjs).

**Before / after.** The contract is the one we wrote before the BLAZE kick-off: `contracts/standing_order.scash` is byte-for-byte the
same file as at the tag [`pre-kickoff`](https://github.com/swiftbotlabs/standing-order/blob/pre-kickoff/contracts/standing_order.scash). Before, orders were built by our own
solidcash scripts and dapp. After, the same covenant is an XO template, so any XO wallet can fund an order, trigger a due payment or cancel.

| | Before (pre-kickoff) | After (XO) |
|---|---|---|
| Contract | `contracts/standing_order.scash`, SolidCash | the same compiled contract, unchanged |
| Who builds the transactions | our scripts (`scripts/chipnet_live.mjs`) and our dapp | the template: every script and output value is CashAssembly in the template |
| Address of an order | P2SH32 from the solidcash SDK | identical P2SH32, checked by `test.mjs` for two argument sets |
| Actions | fund, claim, cancel | `fund`, `claim`, `lastClaim`, `cancel`, with roles `subscriber`, `merchant`, `service` (anyone) |

## How the port works

Modelled on XO's `faucetCashTemplate` (same shape: a coin that waits a number of blocks, pays out, returns the rest to itself).
- `standingOrderRedeemBytecode` pushes the six constructor arguments (`orderId maxFee periodBlocks amountPerPeriod subscriberPkh merchantPkh`)
  in front of the compiled contract body, exactly as the solidcash SDK does. The body is read from `standing_order.body.json`, which
  `extract_tail.mjs` derives from the project's own compiled artifact (and checks that it does not depend on the arguments).
- `claim` spends the order coin with `sequenceNumber: $(<periodBlocks>)` and the claim selector; output 0 pays the merchant
  `amountPerPeriod`, output 1 returns `orderSatoshis - amountPerPeriod - maxFee` to the same covenant. `lastClaim` pays the remainder.
- `cancel` spends the order coin with the cancel selector plus one of the subscriber's own coins, signed `all_outputs`, as the last input;
  one output refunds everything to the subscriber.
- The `service` role needs no key: anyone can trigger a due payment, nobody can redirect it.

## Proof

**Offline, against the BCH 2026 VM** (`npm ci && npm test`, no network): 15 checks pass.
- template address and redeem script == the solidcash build (2 argument sets);
- claim after one period: valid; before the period, to someone else, too much, change elsewhere, a third output: all rejected;
- last claim: valid; last claim keeping change: rejected;
- cancel by the subscriber: valid; with a stranger's coin, or refunding the merchant: rejected.

**XO engine** (`node --import ./lib/no-native.mjs demo.mjs import`): the engine (`@xo-cash/engine@0.1.1-next.18029697917`, chipnet)
imports the template: actions `fund, claim, lastClaim, cancel`, roles `subscriber, merchant, service`. The invitations below were made with it.

## Through XO invitations (chipnet)

The whole order lifecycle, each step one **XO invitation** created, filled, signed and executed by the XO engine
(`@xo-cash/engine@0.1.1-next.18029697917`) with this template. The invitations are saved in [`invitations/`](invitations/)
(`serializeInvitation` output): paste one into the debug tool at [blaze.xo.cash](https://blaze.xo.cash) to inspect it.

**To open or join them:** first import the template file [`standing-order.template.json`](standing-order.template.json) (Import
template in blaze.xo.cash or any XO wallet). It imports as template `bd50bcd19dae15e28291b2d2fec2e66f808f41781cfc921d4f6f168cc44586f2`,
the identifier every invitation references. **Use a chipnet account** in the tool: the invitations are chipnet transactions, and a
mainnet account shows network-mismatch warnings for them. The file is written by `node export_template.mjs` with XO's own `serializeTemplate`
(it keeps the template's bigints), and `node --import ./lib/no-native.mjs check_template_id.mjs` re-imports it and checks the identifier.

| # | Action (role) | Invitation | Transaction |
|---|---|---|---|
| 1 | `fund` (subscriber): 45,000 sats into the order; the engine picks the wallet's coins, adds change, signs | [1-fund.xo.json](invitations/1-fund.xo.json) | [6cac3b95…](https://chipnet.chaingraph.cash/tx/6cac3b95e9dba8ab6e8b67f1b70a242e704911c71d8590d04948280ce75e4c2f) |
| 2 | `claim` (service: anyone, no key): 20,000 to the merchant, 24,000 back into the order | [2-claim.xo.json](invitations/2-claim.xo.json) | [ff9d539a…](https://chipnet.chaingraph.cash/tx/ff9d539a08d4ddbf21e5b5f7136ee5ea534f2e27668d6bdd761e87ae2f8ea5d4) |
| 3 | `lastClaim` (service), the follow-up: too little left for another period, so the remainder minus the fee (23,000) goes to the merchant and the order ends | [3-lastClaim.xo.json](invitations/3-lastClaim.xo.json) | [90bd3f2d…](https://chipnet.chaingraph.cash/tx/90bd3f2d6847de02af165f083d027b639ec7a245bcb50e81846726e9f908be91) |

Both claims were first refused by the node with `non-BIP68-final` (the order coin's relative timelock was not yet met in its view)
and accepted on a retry a few minutes later: the period is enforced by the network, not by our code. `invitations/run.json` lists the steps with their times.

Reproduce (chipnet; any BIP39 test mnemonic):
```bash
cd xo && npm ci
export XO_MNEMONIC_FILE=<file with a test mnemonic>
export MERCHANT_PKH=<20-byte hex> SUBSCRIBER_PKH=<20-byte hex>     # who is paid / who may cancel
node --import ./lib/no-native.mjs invite.mjs   # prints the XO wallet address; send it ~50,000 chipnet sats; the script then
                                               # waits for the coins, funds, waits one period, claims, waits, last-claims
```
Run it in one go: the demo keeps the XO state in memory (`fake-indexeddb`), so a restart forgets which coins the wallet tracks.

**Also on chipnet, built directly from the template with libauth** (`node demo.mjs fund 60000 | claim | cancel`; 20,000 sats per 1-block period, max fee 1,000):

| Step | Transaction |
|---|---|
| fund 60,000 sats into the order | [7dab4bf2…](https://chipnet.chaingraph.cash/tx/7dab4bf2e7fae317b3a38ca3cd733727872c2fde34ed6e914e1a4823731e095c) |
| claim one period: 20,000 to the merchant, 39,000 back to the order | [14fefbea…](https://chipnet.chaingraph.cash/tx/14fefbea07686ffa2039a1d59d4cd421baa98b0cb1ff7bd11e6d97afe4aa9fff) |
| cancel: the rest back to the subscriber | [2366dca6…](https://chipnet.chaingraph.cash/tx/2366dca6ebe66a339b3ad5adbea31e98ee01be4db225acff2879b26b056ca4c7) |

Before the claim confirmed, the network refused the early payment (`non-BIP68-final`): the period is enforced by consensus.

## Run it

```bash
cd xo && npm ci
npm test                                                     # offline, 15 checks
SEED_FILE=<seed hex file> node demo.mjs status               # chipnet; fund <sats> | claim | cancel
XO_MNEMONIC_FILE=<file> node --import ./lib/no-native.mjs demo.mjs import   # XO engine import
```
`lib/no-native.mjs` only stubs the native SQLite modules the XO state package loads at start-up; the demo uses IndexedDB storage
(`fake-indexeddb`), so nothing native is built or downloaded.

## What we hit while porting (for the XO team)

1. XO templates store scripts as strings while libauth templates use `{ script }` objects with `unlocks`; to test a template with libauth's
   compiler we had to wrap them (`lib/compiler.mjs`).
2. `@xo-cash/state` imports native SQLite at load time even when IndexedDB storage is chosen.
3. A covenant input of a role that holds no key (anyone may trigger a claim) is only accepted once the engine tracks the order's
   script hash; that tracking lives in the engine's state, so a fresh engine cannot claim an order it did not see funded.
4. A covenant compiled by another toolchain (SolidCash) has no CashAssembly source; we embed its body as a hex literal after the argument
   pushes. A documented "bytecode + constructor args" pattern would make such ports easier.
