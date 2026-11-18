# Threat model: Standing Order Plus (one page)

**What is at stake.** The order coin: the subscriber's prepaid balance, held by `StandingOrderPlus` (or by `PausedOrder`
while paused). No server, relayer or website ever holds a key that can move it.

**Who can do what.**

| Actor | Can | Cannot |
|---|---|---|
| Anyone (relayer, merchant, stranger) | `claim()` once per `period` blocks; `topUp()` | take more than one period, claim early, send the change anywhere but the same covenant, add outputs, attach a token |
| Subscriber | `pause()`, `resume()`, `cancel()`; co-sign `changePlan()` | pause or resume without paying the period in progress; resume into any covenant but its own order |
| Merchant | receive one period per period; co-sign `changePlan()` | move the balance alone; change the price alone |
| Split payee | receive `splitAmount` with every period, including the last | anything else |
| Our relayer and dapp | build claim transactions; show state | sign for anyone (keyless); they only submit what the covenant already allows |

**Attacks considered, and what stops each one** (each named test runs the attack on the libauth 2026 VM and must be refused):

| Attack | Guard | Test |
|---|---|---|
| Claim twice in one period | relative timelock `this.age >= period` on the order coin itself | `standing_order_plus.test.ts` |
| Spend two order coins with one pair of outputs | a claim spends exactly one input | `standing_order_plus.test.ts` "merging two UTXOs" |
| Claimer adds an output and keeps up to `maxFee` | exact output count | `standing_order_plus.test.ts` "third output" |
| Replay a subscriber signature made with SINGLE/NONE/ANYONECANPAY to cancel or pause | authorizing coin must be the subscriber's P2PKH, signed ALL or ALL\|UTXOS | `replay.test.ts` |
| Mint a token onto the order coin so apps lose track of it | `tokenCategory == 0x` on every order output | `review_v2.test.ts` R1 |
| Pause/resume or top up to restart the clock and starve the merchant | pause and top up pay the period in progress first; resume only follows a paid pause | `review_v2.test.ts` R2 |
| Last claim skips the split payee | the last claim pays the split when the rest covers it | `review_v2.test.ts` R3 |
| `changePlan` to an anyone-can-spend script that looks like P2SH32 | output must equal `LockingBytecodeP2SH32(bytes32(...))` exactly | `review_v2.test.ts` R4 |
| Plan change by one party alone | merchant coin second and subscriber coin last, both signed over the whole tx | `standing_order_plus.test.ts` changePlan |
| Resume into a different covenant | `PausedOrder` stores `resumeTo` = hash of its own order; the order computes the paused address on chain | `standing_order_plus.test.ts` |
| Period above 65,535 (CSV sees only 16 bits) or a negative split | the contract checks its own terms | `review_v2.test.ts` R7 |
| Junk coins (dust, foreign tokens, NFTs) sent to a covenant to block claims | app and relayer pick the order coin by value and ignore junk | relayer + app logic |

**Accepted risks.**
- A claimer may spend up to `maxFee` (2,000 sats) of the order as the miner fee for each claim; that is the price of keyless claims.
- The subscriber's exposure is the prepaid balance; cancelling returns whatever has not been claimed.
- Losing the subscriber key locks cancel, pause and resume; claims still pay the merchant until the balance runs out.
- v1 orders funded before v2 can carry a minted token on their first claim's change; the app and relayer handle it (documented test).

**Reviews.** Two adversarial reviews of v1 (14 Nov) and one of v2 (15 Nov), internal (each by a reviewer that did not write the contract; not an outside audit): no theft path found; every weakness found is fixed
and has a regression test. Proven on mainnet: subscribe, split claim, pause, resume, top up, plan change, claim at the new
price and cancel, with real BCH (txids in the README).
