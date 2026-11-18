# Standing Order

[![solidhat tests](https://img.shields.io/badge/solidhat%20tests-77%20passing-2ea44f)](#tests) [![mainnet](https://img.shields.io/badge/mainnet-full%20lifecycle%20proven-0ac18e)](#proven-on-mainnet-real-bch) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Subscriptions that pay themselves, on Bitcoin Cash.** Live: https://standing-order.swiftbotlab.workers.dev/

**Cancelled means cancelled.** The coins carry the rules, not the company: one payment a period, never early, never more, and
when you cancel, everything not yet paid comes back. No server of ours holds a key; if our site went dark, every order
would keep its rules: anyone can still trigger a payment, the subscriber can still cancel with the MIT scripts in this repo, and
the order list is public JSON ([/api/orders/all](https://standing-order.swiftbotlab.workers.dev/api/orders/all)). Three moments on mainnet, with real BCH:

| | |
|---|---|
| **The network says no** | we tried to pull a payment early 10 times; consensus refused every one (`non-BIP68-final`, [run log](proofs/mainnet_plus_2026-11-16.log)) |
| **A stranger can collect, nobody can steal** | a signature-free claim built offline and broadcast through a public block explorer, not our relayer, paid exactly what the plan says: [cba7e44a](https://blockchair.com/bitcoin-cash/transaction/cba7e44a1cc53762890bbd7a4d5fbfd05e7a0670432113a05ce9430e8c35b1be) |
| **Cancel, and the money comes home** | one transaction returns the unclaimed balance: [a68c39cb](https://blockchair.com/bitcoin-cash/transaction/a68c39cb4df5e71eb7d3e3f2ecddc70c4569ffdc8f70192f113b8dfbb81ce9f9) (BCH), [aa3a8aa6](https://blockchair.com/bitcoin-cash/transaction/aa3a8aa6cc382b3178b8fa421420212c8d812acf1d95aeb52c217c71b0971607) (PUSD) |

**Watch it on mainnet (36 s):** [the walkthrough](https://standing-order.swiftbotlab.workers.dev/film/walk60.mp4): a merchant makes a pay link, a wallet
subscribes with one approval, the relayer pays the merchant one period, the subscriber cancels and gets the rest back (real BCH, the live site).
**Run the tests:** `npm ci && npx --no-install solidhat test` (77 solidhat tests) · `cd pool && npm ci && npx --no-install vitest run -c vitest.config.mjs` (16 Pool tests) = 93.
**Watch the 17-second film:** [Coins with rules](https://standing-order.swiftbotlab.workers.dev/film/) (also on [YouTube Shorts](https://youtube.com/shorts/p8m_4ubXscg)).

A subscriber funds a standing order once. The merchant can take one period's amount per period, never more and never
early. The subscriber can cancel any time and the rest comes straight back. No custody: the funds sit in a covenant
that only enforces those rules. Plans can be priced in BCH or in a CashToken stablecoin such as PUSD.

Built for BCH BLAZE 2026 (Mainnet track, SolidCash bounty). Started on 14 Nov 2026, a few hours before the 14:00 UTC
kick-off; the tag `pre-kickoff` marks the state at kick-off.

## For judges: one minute
- **Try it:** open https://standing-order.swiftbotlab.workers.dev/ (it opens on **mainnet**, labelled beside the logo), press
  **Connect wallet** at the top right (WizardConnect: Selene, Paytaca, Cashonize), then **Try it: 1 cent a block**. Chipnet pages
  are marked "Chipnet · test coins".
- **Watch it:** the [17-second film](https://standing-order.swiftbotlab.workers.dev/film/), and the 2-minute demo on the home page (real chipnet flow; a real Paytaca sign request).
- **Proof on mainnet:** subscribe, split claim, pause, resume, top up, claim, cancel with real BCH, txids [below](#proven-on-mainnet-real-bch).
- **What if something goes wrong:** merchant stops delivering, early pulls, a one-sided price change, our site gone: [each case with its proof](#what-if-something-goes-wrong).
- **Stateful SolidCash:** [Standing Order Pool](#standing-order-pool-one-stateful-covenant-per-plan-solidcash-051-17-nov): mapping register, covenant loop, satoshi container, events, CLTV, `tx.origin`; run on mainnet.
- **Security on one page:** [THREAT_MODEL.md](THREAT_MODEL.md): who can do what, every attack considered and the test that runs it.
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


## What if something goes wrong?
Every failure we planned for, what happens, and the proof: a mainnet transaction, a refusal from the network, or a test that
runs the attack on the 2026 VM. None of it depends on us: the rules live in the covenant, and no server of ours holds a key.

| If... | What happens | Proof |
|---|---|---|
| The merchant stops delivering | The subscriber presses Cancel. Everything not yet claimed comes back in one transaction; the merchant keeps only periods already paid. No dispute, no support ticket. Only the subscriber can cancel. | mainnet cancel [a68c39cb](https://blockchair.com/bitcoin-cash/transaction/a68c39cb4df5e71eb7d3e3f2ecddc70c4569ffdc8f70192f113b8dfbb81ce9f9); PUSD order cancel, 2 of 3 units back [aa3a8aa6](https://blockchair.com/bitcoin-cash/transaction/aa3a8aa6cc382b3178b8fa421420212c8d812acf1d95aeb52c217c71b0971607); test [refuses a cancel by the merchant](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L329) |
| Anyone (the merchant included) pulls early or twice | The network refuses it: the period is a relative timelock on the order coin itself, and every claim restarts it. | on mainnet we tried 10 early claims; all 10 were refused `non-BIP68-final` ([run log](proofs/mainnet_plus_2026-11-16.log)); test [refuses a claim before the period has passed](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L51) |
| A claim takes more, adds an output or merges two coins | Refused: the amount, the recipients and the change back to the same covenant are fixed. | tests [third output](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L94), [merging two UTXOs](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L262) |
| One side wants a new price or period | `changePlan()` needs the merchant **and** the subscriber, both signing the whole transaction; either one alone is refused. | mainnet: claim at 10,000 sats, both sign the change [aa44737d](https://blockchair.com/bitcoin-cash/transaction/aa44737d7e1aafe3e3453a4b2fb0f5a318cc87d1e41ba2b31a1c898e9c074fd6), claim at the new 20,000 sats [cf2c6f4c](https://blockchair.com/bitcoin-cash/transaction/cf2c6f4cf39f021c8a4a077287aac454dd432fde188c05f6037ed029b91cb600); tests [subscriber alone](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L291), [merchant alone](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L300) |
| Our site, relayer or company disappears | The money stays in the covenant and the rules still hold. Anyone can still claim (no signature needed) and the subscriber can still cancel, with the MIT-licensed scripts in this repo. | mainnet claim built offline (`scripts/mainnet_plus.mjs claim --dry --hex`) and broadcast through a public block explorer, not our relayer: [cba7e44a](https://blockchair.com/bitcoin-cash/transaction/cba7e44a1cc53762890bbd7a4d5fbfd05e7a0670432113a05ce9430e8c35b1be) ([log](proofs/mainnet_thirdparty_claim_2026-11-17.log)) |
| The subscriber pauses or tops up to restart the clock | Pause and top-up must pay the period in progress first, so the merchant never waits longer. Resume only goes back to the same order. | mainnet pause that paid the period [57dbfffb](https://blockchair.com/bitcoin-cash/transaction/57dbfffb83e4bc19b06e1dc46f61ea2c6333aead487bbbde2e732992628df07d); test [pause pays the period in progress](https://github.com/swiftbotlabs/standing-order/blob/main/test/review_v2.test.ts#L67) |
| The balance runs out | The last claim pays what is left (the split payee's share included) and the order ends. No overdraft, no debt, no failed-card retries. | test [last claim](https://github.com/swiftbotlabs/standing-order/blob/main/test/standing_order_plus.test.ts#L104) |
| Someone sends a token or dust to the order | No token may ride on the order coin; the app and relayer pick the order coin by value and ignore junk. | test [mints a token onto the change](https://github.com/swiftbotlabs/standing-order/blob/main/test/review_v2.test.ts#L50) |
| The subscriber loses their key | Claims keep paying the merchant until the balance is used up; cancel and pause need that key (an accepted risk). | [THREAT_MODEL.md](THREAT_MODEL.md) |

The full list of attacks and their guards is in [THREAT_MODEL.md](THREAT_MODEL.md). We build in public: every commit is on
GitHub ([what changed in the BLAZE window](https://github.com/swiftbotlabs/standing-order/compare/pre-kickoff...main)), every
mainnet run's log is in [`proofs/`](proofs/), and progress goes out on X ([@swiftbotlab](https://x.com/swiftbotlab)).

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

## Standing Order Pool: one stateful covenant per plan (SolidCash 0.51, 17 Nov)
[`pool/`](pool/) keeps every subscriber of a plan in one stateful covenant instead of one coin per subscription: a verified
mapping is the on-chain subscriber register, a covenant loop collects up to 16 members in one transaction with one payout to the
merchant, a catch-up collects missed periods, deposits sit in the satoshi container, an absolute timelock (`tx.time`) sets each
member's due block, and `withdraw` / `leave` can only pay the member back (`tx.origin` + `checkSig`). **Key loss** (v2): each member names
a recovery address; if they lose their key, the merchant can release their unspent periods only to that address. **Pause / resume**
(v3): while paused nothing can be collected; resuming never charges the paused time. Syntax used besides:
a `library`, an `enum` in an event, an `abstract contract` base, custom `error`s with `revert` (a plain failing script on chain). 16 tests, 18 planted controls,
and a full run on **mainnet** (deploy, two members, a two-member collect, a catch-up, a withdraw, a leave; a collect tried before
the next period was refused): [v1 txids](pool/README.md#on-mainnet-v1-the-contract-in-contractsv1); v2 on mainnet including a key-loss release to
the recovery address: [v2 txids](pool/README.md#on-mainnet-v2-17-nov-the-contract-in-contractsv2); v3 on mainnet with a pause, a refused collect
from the paused member, and a resume: [v3 txids](pool/README.md#on-mainnet-v3-18-nov-pause-and-resume).

## Built in the BLAZE window (14-22 Nov) vs. before kick-off
The tag `pre-kickoff` (14 Nov, 13:35 UTC, before the 14:00 UTC start) is the base; everything below it is new in the window.

| Part | Before kick-off (`pre-kickoff`) | In the window |
|---|---|---|
| Contracts | `StandingOrder` (BCH) and `StandingOrderToken` (CashTokens): claim one period per period, cancel | **`StandingOrderPlus` + `PausedOrder`**: split payee, pause/resume, top up, two-party plan change, on-chain computed paused address, token-poisoning and clock-reset guards |
| Tests | 35 solidhat tests (v1 + replay attacks) | **+42 tests** (`standing_order_plus.test.ts` 33 incl. VM-verified pause, resume, claim round trip; `review_v2.test.ts` 9 VM regressions for the v2 review findings); planted controls for every guard |
| Proof | chipnet runs of v1 | **mainnet**: the whole Plus lifecycle with real BCH, a two-party plan change, and a PUSD stablecoin order (below); chipnet web-code e2e of Plus |
| Dapp + relayer | v1 pay links, subscribe, cancel, keyless relayer | v2 pay links with split, Pause / Resume / Add a period on the order page, cancel from paused, relayer claims v2 and waits out BIP68 holds, 14 Nov banner |
| Upstream SolidCash | PR [#1](https://github.com/solidcash/solidcash/pull/1) (WalletConnect covered bytecode) | issue [#2](https://github.com/solidcash/solidcash/issues/2): five findings with reproductions; the first follow-up PR (findings 1-3: example pragmas, awaited matchers, docs) is ready and opens once #1 is reviewed (one open PR at a time) |
| Security | two reviews of v1 | a third review of v2: no theft path; four weaknesses fixed, each with a regression test |
| Media | deck | the 2-minute demo film on the home page |
| **Lines of code** (`git diff pre-kickoff main`, no lockfiles or build output) | contracts 138, tests 514 (35 tests), scripts 457, dapp `web/src` 677 | contracts **+175** (313 now), tests **+543** (1,057 now, 77 tests), scripts **+471**, dapp **+259 / -41** |

**In-window commits** (UTC dates; the full list is the compare link below):
- [8e0b98e](https://github.com/swiftbotlabs/standing-order/commit/8e0b98e) 15 Nov: Standing Order Plus (v2): split payee, pause/resume, top-up, plan change; security-review fixes with regression tests
- [be8ffc7](https://github.com/swiftbotlabs/standing-order/commit/be8ffc7) 15 Nov: relayer waits out BIP68 holds (a claim refused as not final is retried)
- [3b5cb22](https://github.com/swiftbotlabs/standing-order/commit/3b5cb22) 16 Nov: mainnet: the full Plus lifecycle with real BCH
- [0fc3820](https://github.com/swiftbotlabs/standing-order/commit/0fc3820) 16 Nov: WizardConnect button top right, connected wallet reused by pay pages
- [d1439a8](https://github.com/swiftbotlabs/standing-order/commit/d1439a8) 16 Nov: mainnet: PUSD stablecoin order (subscribe, claim, cancel)
- [935e687](https://github.com/swiftbotlabs/standing-order/commit/935e687) 17 Nov: mainnet: two-party plan change
- [ef19d61](https://github.com/swiftbotlabs/standing-order/commit/ef19d61) 17 Nov: one-page threat model
- [ee38b79](https://github.com/swiftbotlabs/standing-order/commit/ee38b79) 17 Nov: "What if something goes wrong?" with proofs; Standing Order Pool (stateful SolidCash) and its mainnet run
- [697caca](https://github.com/swiftbotlabs/standing-order/commit/697caca) 17 Nov: home: "Cancelled means cancelled" with the 17 s film and three mainnet moments
- [08228f7](https://github.com/swiftbotlabs/standing-order/commit/08228f7) 17 Nov: Pool v2: key-loss recovery address, library, enum, abstract base, custom errors

Compare it yourself: [pre-kickoff...main](https://github.com/swiftbotlabs/standing-order/compare/pre-kickoff...main). Threat model on one page: [THREAT_MODEL.md](THREAT_MODEL.md).

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
- plan change (17 Nov 2026): fund [b183c8e0…](https://blockchair.com/bitcoin-cash/transaction/b183c8e087d31c3a228fdbe8f1550975e9d59902b430fb198af63eb0ae93c1ed), claim at 10,000 sats [1c777988…](https://blockchair.com/bitcoin-cash/transaction/1c7779888f3b4e6c43d3608ff1a76632a3834cc0e657aa0f7da4c17a5169f965), merchant + subscriber move the order to a new plan [aa44737d…](https://blockchair.com/bitcoin-cash/transaction/aa44737d7e1aafe3e3453a4b2fb0f5a318cc87d1e41ba2b31a1c898e9c074fd6), claim at the new price of 20,000 sats [cf2c6f4c…](https://blockchair.com/bitcoin-cash/transaction/cf2c6f4cf39f021c8a4a077287aac454dd432fde188c05f6037ed029b91cb600), cancel [2b04feee…](https://blockchair.com/bitcoin-cash/transaction/2b04feeefca6b1abc959dff6b2af81d8aa4c458e725afb7149faaf09ab1ab8a5).

Reproduce: `node scripts/mainnet_plus.mjs simulate` (offline, VM-checked), then the live steps in `scripts/mainnet_plus.mjs`.

Stablecoin order on **mainnet** (PUSD, a CashToken; 16 Nov 2026), token Standing Order `bitcoincash:r0a8lv0dczfw977g93zvt6kmj26qgesp869ayq0hr3azq3rnuma3y4wxe3m4l`,
1 PUSD unit (0.01 PUSD) a block, 3 periods prepaid:
- buy 5 PUSD units on Cauldron (pool redeem script proven from chain, trade VM-checked before broadcast): [9ee16268bd5f93b85f3536b531733d803a020364d4481dbcb949bbd2a6b89413](https://blockchair.com/bitcoin-cash/transaction/9ee16268bd5f93b85f3536b531733d803a020364d4481dbcb949bbd2a6b89413)
- subscribe (3 PUSD units into the token covenant): [46ef7ca31f76e77361a955d5304f75e77c811fc02dac94ce0303282a014007cc](https://blockchair.com/bitcoin-cash/transaction/46ef7ca31f76e77361a955d5304f75e77c811fc02dac94ce0303282a014007cc)
- claim (exactly 1 PUSD unit to the merchant, no signature): [8408a375e6221b748bd1dc7f544987be69347579bf26d0afaa6e9458bad6ee9d](https://blockchair.com/bitcoin-cash/transaction/8408a375e6221b748bd1dc7f544987be69347579bf26d0afaa6e9458bad6ee9d)
- cancel (the 2 remaining PUSD units back to the subscriber): [aa3a8aa6cc382b3178b8fa421420212c8d812acf1d95aeb52c217c71b0971607](https://blockchair.com/bitcoin-cash/transaction/aa3a8aa6cc382b3178b8fa421420212c8d812acf1d95aeb52c217c71b0971607)

Reproduce: `node scripts/mainnet_cauldron_swap.mjs 5 --dry` and `node scripts/mainnet_pusd.mjs fund --dry` (VM-checked, no broadcast).

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
A separate adversarial review (internal, by a reviewer that did not write the contract; not an outside audit) found no way to take funds. It found four weaknesses, all fixed with tests that run
the attack on the 2026 VM (`test/review_v2.test.ts`):
1. anyone could attach a newly minted token to the order coin, which made apps treat the order as gone: order coins
   must now carry no token, and the app and relayer pick the order coin by value;
2. pause/resume and top-up restarted the claim clock without paying: both now pay the period in progress;
3. the split payee missed the final period: the last claim now pays it;
4. `changePlan` accepted any 35-byte script starting `aa20`: it now requires a real P2SH32.
Known v1 limitation (orders funded before v2): the first claim of a v1 order can carry a minted token; the app and relayer
handle such a coin and drop the token.

