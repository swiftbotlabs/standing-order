# Standing Order

**Subscriptions that pay themselves, on Bitcoin Cash.** Live: https://standing-order.swiftbotlab.workers.dev/

A subscriber funds a standing order once. The merchant can take one period's amount per period, never more and never
early. The subscriber can cancel any time and the rest comes straight back. No custody: the funds sit in a covenant
that only enforces those rules. Plans can be priced in BCH or in a CashToken stablecoin such as PUSD.

Built for BCH BLAZE 2026 (Mainnet track, SolidCash bounty).

## How it works

| Step | Who | What happens on chain |
|---|---|---|
| Subscribe | subscriber (WizardConnect wallet) | funds a `StandingOrder` covenant with N periods (+ claim fees) |
| Claim | anyone (our relayer, the page, the merchant) | after `period` blocks, pays the merchant exactly one period; the change must return to the same covenant |
| Cancel | subscriber only | spends the covenant back to the subscriber; authorized by a coin from the subscriber's own address in the same transaction |

The period check is a relative timelock (`this.age >= period`) on the covenant's own UTXO, so every claim restarts the
clock: at most one claim per period, enforced by consensus, not by our server.

## Contracts (SolidCash)
- `contracts/standing_order.scash` (BCH): `claim()` / `cancel()`, 277 bytes with its arguments.
- `contracts/standing_order_token.scash` (fungible CashTokens, e.g. PUSD): same rules in tokens; the covenant keeps a small
  BCH pool for fees; the last claim pays the remaining tokens and BCH to the merchant, 348 bytes with its arguments.

## Tests
```
npm install
npx --no-install solidhat test     # 35 tests (both contracts); replay attacks checked by the libauth 2026 VM
```
Negative tests were proven with planted controls (flipping an expectation turns the suite red).

## Proven on chipnet (contract logic; these runs predate the per-subscription orderId and the coin-authorized cancel, which change the address and the cancel input only)
- Early claim refused by the network; claim after one confirmed block paid the merchant exactly 20,000 sats
  (026fb3adafab7578cf0ac187fcd96ce01337e1e465d8cb2facd77cbab6bf20d5); immediate re-claim refused; cancel refunded
  (6f5d17649dd984871aa63fd2b9ba46708e9ba28c2dc775e702d480e4cb654177).
- Token order: claim paid exactly 500 tokens (4da3b5215547088ea806469a9fa69c2d0aceb244b32358cb90aa7062a95b9d2f);
  re-claim refused; cancel refunded tokens + BCH (8a1071df1d547253957e60f2150ab6bf6472e27bce33415a1ff0e36e359dfd07).
- Over WizardConnect: subscribe signed by a wallet (cc9acc9d437df09b41f2e7382e48e607d96849c792d8266895458b13e80173b2) and
  cancel signed by the wallet (0cd7464af4f629a5488193efb194c083919c559dbe190174970bb40ae686e4a7).
- The relayer collected a browser-made order on its own (940720a945287eb9589c9cd6900ecded841871ef3e41753867af5048bca4e44f).

## Cancel works in any wallet
`cancel()` has no signature inside the contract. The last input of a cancel must be a coin from the subscriber's own
address, signed with sighash ALL or ALL|UTXOS (the contract reads the sighash byte), and the only output must pay the
subscriber. The wallet signs that coin like any payment. Wallets therefore never sign a covenant input, which is what
most wallets get wrong for multi-function contracts (see finding 7 below).

Tested with a real wallet (Paytaca on Android, connected over WizardConnect to the site on a desktop browser, chipnet):
subscribe ac6110e15de19d48011e376a28248a03f840f96ce05841d22473ecfd6ad8c38f, cancel
2b0f2f6cdcf2f413d100ae9a79e3bba85603df7c8a4119e7b656d7fbf9c759db. Headless wallet run of the same flow
(`scripts/e2e_wizard.mjs`): subscribe c348ded702cea2d850a67697db8a8ba7b8ce4be3811d188d9b0ab6f39e5606e2, cancel
a214f4811c2d49127ca2a603fbd4e08b40f187a6c3483e6f8f44aee1cf88f088.

## Web app (`web/`)
Vite + TypeScript, no framework. Pay-link generator, WizardConnect connect (QR or open link), subscribe, order status,
collect, cancel, merchant view. `web/worker.js` serves the app and a small order registry; `scripts/relayer.mjs` claims
due periods (it holds no keys).

## SolidCash findings
`notes/SOLIDCASH_FINDINGS.md` lists what we hit while building, with repros. The most important: WalletConnect /
WizardConnect wallets could not sign functions of multi-function contracts, because signatures inside an `OP_INVOKE`d
function cover the function body while `getWcContractInfo()` passed the full redeem script. Wallets add to it: Paytaca
always covers the full redeem script taken from the unlocking bytecode. We first worked around it in the request
(`scripts/archive/`), then removed the need entirely with the cancel design above; a fix is prepared for upstream.

## License
MIT

## Order ids
Every subscription gets a random 8-byte `orderId` constructor argument (unused by the logic). It gives each order its own
covenant address, so subscribing twice to the same plan creates two independent orders instead of one covenant that could
be claimed twice per period.

## Hardening (found by an adversarial review, 14 Nov)
A claim must spend exactly **one** input and create exactly two outputs (one on the last claim). Without the input rule,
one transaction could spend two UTXOs of the same covenant, satisfy both with one pair of outputs, and send the second
UTXO elsewhere; without the output rule, a claimer could add a third output and keep up to `maxFee`. Both attacks are
tests in `test/` (they succeed against the earlier contracts and fail now).

A second review attacked the coin-authorized cancel: if `cancel()` only checked that the last input belongs to the
subscriber, any signature the subscriber made with SINGLE, NONE or ANYONECANPAY (an open offer, a crowdfunding pledge)
could be replayed next to the covenant to drain it. `cancel()` now requires sighash ALL or ALL|UTXOS on that input and a
single output to the subscriber; `test/replay.test.ts` replays such signatures and checks the libauth 2026 VM rejects
them (all of them pass against the earlier version). The app and relayer also ignore junk coins sent to a covenant
(dust, foreign tokens, NFTs), so nobody can block a claim or a cancel that way.
