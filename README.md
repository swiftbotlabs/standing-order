# Standing Order

[![solidhat tests](https://img.shields.io/badge/solidhat%20tests-77%20passing-2ea44f)](#tests) [![mainnet](https://img.shields.io/badge/mainnet-full%20lifecycle%20proven-0ac18e)](#proven-on-mainnet-real-bch) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Subscriptions that pay themselves, on Bitcoin Cash.** Live: https://standing-order.swiftbotlab.workers.dev/

A subscriber funds a standing order once. The merchant can take one period's amount per period, never more and never
early. The subscriber can cancel any time and the rest comes straight back. No custody: the funds sit in a covenant
that only enforces those rules. Plans can be priced in BCH or in a CashToken stablecoin such as PUSD.

Built for BCH BLAZE 2026 (Mainnet track, SolidCash bounty). Started on 14 Nov 2026, a few hours before the 14:00 UTC
kick-off; the tag `pre-kickoff` marks the state at kick-off.

## For judges: one minute
- **Try it:** open https://standing-order.swiftbotlab.workers.dev/ (it opens on **mainnet**, labelled beside the logo), press
  **Connect wallet** at the top right (WizardConnect: Selene, Paytaca, Cashonize), then **Try it: 1 cent a block**. Chipnet pages
  are marked "Chipnet · test coins".
- **Watch it:** the 2-minute film on the home page (real chipnet flow; a real Paytaca sign request).
- **Proof on mainnet:** subscribe, split claim, pause, resume, top up, claim, cancel with real BCH, txids [below](#proven-on-mainnet-real-bch).
- **What is new in the BLAZE window:** Standing Order Plus (v2 covenant) + 42 tests + a third security review, [table](#built-in-the-blaze-window-14-22-nov-vs-before-kick-off).
- **SolidCash features, each linked to its line:**

| Feature | Where |
|---|---|
| `internal` functions (OP_DEFINE / OP_INVOKE subroutines) | [`signedBy`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L33), [`paysOnePeriod`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L44) |
| custom `modifier` | [`onlySubscriber` in StandingOrderPlus](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L57), [in PausedOrder](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/paused_order.scash#L18) |
| `bytes constant` / `int constant` | [`PAUSED_TEMPLATE`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L30), [`MAX_FEE`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/paused_order.scash#L15) |
| relative timelock `this.age` | [`claim()`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L64) |
| covenant construction `LockingBytecodeP2SH32(hash256(...))` | [`pause()` computes its own paused address](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L100), [`resume()` only back to its order](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/paused_order.scash#L33), [`changePlan()`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L121) |
| token introspection (`tokenCategory`) | [no token may ride on the order coin](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L87); fungible-token plans in [`standing_order_token.scash`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_token.scash) |
| `require` messages | throughout, e.g. [`"one claim per period"`](https://github.com/swiftbotlabs/standing-order/blob/main/contracts/standing_order_plus.scash#L64) |
| solidhat (`solidcash.config.mjs`, `solidhat test`) | [`test/`](https://github.com/swiftbotlabs/standing-order/blob/main/test) - 77 tests |


## How it works

| Step | Who | What happens on chain |
|---|---|---|
| Subscribe | subscriber (WizardConnect wallet) | funds a `StandingOrder` covenant with N periods (+ claim fees) |
| Claim | anyone (our relayer, the page, the merchant) | after `period` blocks, pays the merchant exactly one period; the change must return to the same covenant |
| Cancel | subscriber only | spends the covenant back to the subscriber; authorized by a coin from the subscriber's own address in the same transaction |

The period check is a relative timelock (`this.age >= period`) on the covenant's own UTXO, so every claim restarts the
clock: at most one claim per period, enforced by consensus, not by our server.

## Standing Order Plus (v2, all new BCH orders): pause, resume, top up, split, plan change
`contracts/standing_order_plus.scash` + `contracts/paused_order.scash`, built in the BLAZE window:

| Function | Who | What it enforces |
|---|---|---|
| `claim()` | anyone | one period per `period` blocks: merchant gets `amountPerPeriod`, an optional **split payee** (co-creator, affiliate, platform fee) gets `splitAmount`; the change must return to the same covenant, carrying no token |
| `pause()` | subscriber | pays the period in progress, then moves the rest to this order's `PausedOrder`; that address is computed **on chain** from the order's own hash (`hash256(0x20 + self + 0x14 + subscriber + PAUSED_TEMPLATE)`), and no one can claim from it |
| `PausedOrder.resume()` | subscriber | only back to the exact order it came from (`resumeTo`); the next claim waits one full period |
| `topUp()` | anyone | pays the period in progress and leaves the order with at least what it had |
| `changePlan()` | merchant **and** subscriber | moves the balance to a new order (new price, period or split); both sign the whole transaction |
| `cancel()` | subscriber | everything back, from the order or from its paused covenant |

Every move of the order coin restarts its clock (UTXO age), so every move other than cancel pays the period in progress
first: pausing, resuming or topping up can never keep the merchant waiting. SolidCash features used: a custom
`modifier`, `internal` functions (OP_DEFINE / OP_INVOKE subroutines), a `bytes constant` template, `require` messages,
`LockingBytecodeP2SH32` + `hash256` covenant construction, `this.age`, token introspection (`tokenCategory == 0x`).
Sizes: 1,005 bytes (order) and 274 bytes (paused) with their arguments; v2 claims allow up to 2,000 sats of fee.

## Built in the BLAZE window (14-22 Nov) vs. before kick-off
The tag `pre-kickoff` (14 Nov, 13:35 UTC, before the 14:00 UTC start) is the base; everything below it is new in the window.

| Part | Before kick-off (`pre-kickoff`) | In the window |
|---|---|---|
| Contracts | `StandingOrder` (BCH) and `StandingOrderToken` (CashTokens): claim one period per period, cancel | **`StandingOrderPlus` + `PausedOrder`**: split payee, pause/resume, top up, two-party plan change, on-chain computed paused address, token-poisoning and clock-reset guards |
| Tests | 35 solidhat tests (v1 + replay attacks) | **+42 tests** (`standing_order_plus.test.ts` 33 incl. VM-verified pause, resume, claim round trip; `review_v2.test.ts` 9 VM regressions for the v2 review findings); planted controls for every guard |
| Proof | chipnet runs of v1 | **mainnet**: the whole Plus lifecycle with real BCH (below); chipnet web-code e2e of Plus |
| Dapp + relayer | v1 pay links, subscribe, cancel, keyless relayer | v2 pay links with split, Pause / Resume / Add a period on the order page, cancel from paused, relayer claims v2 and waits out BIP68 holds, 14 Nov banner |
| Upstream SolidCash | PR [#1](https://github.com/solidcash/solidcash/pull/1) (WalletConnect covered bytecode) | issue [#2](https://github.com/solidcash/solidcash/issues/2): five findings with reproductions; the first follow-up PR (findings 1-3: example pragmas, awaited matchers, docs) is ready and opens once #1 is reviewed (one open PR at a time) |
| Security | two reviews of v1 | a third review of v2: no theft path; four weaknesses fixed, each with a regression test |
| Media | deck | the 2-minute demo film on the home page |

## Contracts (SolidCash), v1
- `contracts/standing_order.scash` (BCH): `claim()` / `cancel()`, 277 bytes with its arguments.
- `contracts/standing_order_token.scash` (fungible CashTokens, e.g. PUSD): same rules in tokens; the covenant keeps a small
  BCH pool for fees; the last claim pays the remaining tokens and BCH to the merchant, 348 bytes with its arguments.

## Tests
```
npm install
npx --no-install solidhat test     # 77 tests; replay and v2 attacks checked by the libauth 2026 VM
```
Negative tests were proven with planted controls (flipping an expectation turns the suite red).

## Proven on mainnet (real BCH)
Standing Order Plus on Bitcoin Cash **mainnet** with real BCH (16 Nov 2026), order `bitcoincash:pwz68enmzkwje6nu6f78wflmc0syxsc6aepmqze46f5h6den33j8u6vrf834k`, 10,000 sats a block to the merchant plus a 1,000-sat split payee:
- subscribe (fund the order): [a813b51e39f81bc541fc9c42faf0a57b0f6ff677f468fc8ee52970a87d2e0efd](https://blockchair.com/bitcoin-cash/transaction/a813b51e39f81bc541fc9c42faf0a57b0f6ff677f468fc8ee52970a87d2e0efd)
- claim after one block, merchant and split payee paid in one transaction, no signature: [83989cdd83e57dd7d1799f9282a3d77e6622edb324bd364de663bae8d5037aa0](https://blockchair.com/bitcoin-cash/transaction/83989cdd83e57dd7d1799f9282a3d77e6622edb324bd364de663bae8d5037aa0)
- pause (pays the period in progress, moves the rest to this order's PausedOrder): [57dbfffb83e4bc19b06e1dc46f61ea2c6333aead487bbbde2e732992628df07d](https://blockchair.com/bitcoin-cash/transaction/57dbfffb83e4bc19b06e1dc46f61ea2c6333aead487bbbde2e732992628df07d)
- resume: [3cfa46b1391f642a0869be9745407eb007ccf14d54d064adaa651e3d98e47b4e](https://blockchair.com/bitcoin-cash/transaction/3cfa46b1391f642a0869be9745407eb007ccf14d54d064adaa651e3d98e47b4e) (an immediate claim right after was refused by the network: the period restarts)
- top up (anyone may add periods): [f56cc6293c6a81ec4830f123d2333dea4b177ebd0e83eb390b520eba2fe4f68e](https://blockchair.com/bitcoin-cash/transaction/f56cc6293c6a81ec4830f123d2333dea4b177ebd0e83eb390b520eba2fe4f68e)
- second claim: [bcbd439c8357f70c811926979fc3f91b564aa4b04f1b693565d31578f4b6a7e3](https://blockchair.com/bitcoin-cash/transaction/bcbd439c8357f70c811926979fc3f91b564aa4b04f1b693565d31578f4b6a7e3)
- cancel (remainder back to the subscriber, no signature, coin-authorized): [a68c39cb4df5e71eb7d3e3f2ecddc70c4569ffdc8f70192f113b8dfbb81ce9f9](https://blockchair.com/bitcoin-cash/transaction/a68c39cb4df5e71eb7d3e3f2ecddc70c4569ffdc8f70192f113b8dfbb81ce9f9)

Reproduce: `node scripts/mainnet_plus.mjs simulate` (offline, VM-checked), then the live steps in `scripts/mainnet_plus.mjs`.

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
(`scripts/archive/`), then removed the need entirely with the cancel design above. Upstream fix: https://github.com/solidcash/solidcash/pull/1.

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

## Security review of v2 (15 Nov)
An independent adversarial review found no way to take funds. It found four weaknesses, all fixed with tests that run
the attack on the 2026 VM (`test/review_v2.test.ts`):
1. anyone could attach a newly minted token to the order coin, which made apps treat the order as gone: order coins
   must now carry no token, and the app and relayer pick the order coin by value;
2. pause/resume and top-up restarted the claim clock without paying: both now pay the period in progress;
3. the split payee missed the final period: the last claim now pays it;
4. `changePlan` accepted any 35-byte script starting `aa20`: it now requires a real P2SH32.
Known v1 limitation (orders funded before v2): the first claim of a v1 order can carry a minted token; the app and relayer
handle such a coin and drop the token.

