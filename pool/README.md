# Standing Order Pool (stateful SolidCash, built 17 Nov 2026 in the BLAZE window)

One stateful covenant per merchant plan that keeps every subscriber's budget, instead of one covenant coin per subscription:

| SolidCash feature | Where in `contracts/standing_order_pool.scash` |
|---|---|
| state variables (`memberCount`, `paidTotal`) | contract body |
| verified mapping as an on-chain subscriber register: `mapping(bytes20 => int) members`, record = `nextDue * 65536 + periodsLeft` | `subscribe`, `topUp`, `collect`, `withdraw`, `leave` |
| covenant loop (`for` over a calldata array, mapping read + write per turn) | `collect`: up to 16 members in one transaction, one payout to the merchant |
| satoshi container (`msg.value` deposits, `this.transfer`) | `subscribe` / `topUp` deposit, `collect` / `withdraw` pay out |
| `payable` functions, events (`Subscribed`, `Collected`, `Withdrawn`), a custom `modifier` (`validPlan`) | throughout |
| absolute timelock `tx.time >= due` (CLTV on nLockTime) | `subscribe` (start reached), `collect` (due reached) |
| `tx.origin` (the first standard P2PKH input) | `withdraw`: the member's own coin must be spent in the same transaction |
| `checkSig` + `hash160` | `leave` |
| `unsafe_int` ordering check | `collect`: members listed in ascending key order, so nobody is listed (and paid for) twice |
| `library` with `internal pure` functions | `PoolRecord.pack / nextDue / periodsLeft`: the packed member record |
| `enum` in an event | `Move { Subscribed, ToppedUp, Withdrawn, Released, RecoveryChanged, Left }` in `MemberMoved` |
| `abstract contract` + inheritance (`is`) | `PoolTerms`: errors, the `MemberMoved` event and the `wholePeriods` modifier, inherited by the pool |
| custom `error`s + `revert` | `NotAMember`, `NotTheMerchant`, `BadPeriods` |
| `mapping(bytes20 => bytes20)` | `recoveryOf`: each member's recovery address |

## The rules it enforces
- The merchant is paid `price` at most once per `period` per member, never before `nextDue`; `periods > 1` catches up a member who is behind.
- Collected sats go only to the merchant's P2PKH; anyone can trigger `collect` (merchant, relayer, member) and the outcome is the same.
- A deposit is always whole periods, so every pool coin stays a whole number of periods and a member can always get the rest back, in parts if the pool's coins are fragmented (test "liveness").
- `withdraw` pays only `LockingBytecodeP2PKH(member)`. It needs a coin from the member's own address in the same transaction:
  SolidCash compiles `tx.origin` to the first input whose coin is a 25-byte standard P2PKH script (token-free, not the pool's own input),
  and spending such a coin needs the member's signature. A caller can never redirect the refund.

## Key loss: the recovery address (v2, 17 Nov)
Each member names a recovery address when joining: another wallet of their own (cold storage, a second phone). The member can
change it with a signature (`setRecovery`). If the member loses their key, the merchant can `release` the unspent periods, in parts
if needed, **only to that recovery address**: the covenant pays nowhere else, so the merchant can only give up income, never take a
member's money. Without the merchant, the prepaid periods simply keep paying the merchant as before.

## Tests
`npx --no-install vitest run -c vitest.config.mjs`: 14 tests on the production mock network (subscribe, caps on deposits, top-up,
collect never early, a final transaction lying about `due` is refused by the CLTV, batch of three in one tx, catch-up, no budget left,
redirect and inflate attempts, withdraw/leave only by the member, fragmented-pool liveness, release only by the merchant and only
to the recovery address, recovery address changed only by the member).
`python3 scripts/planted_controls.py`: 14 weakened copies of the contract, each must turn the suite red (all do).
`node scripts/pool_run.mjs simulate`: the mainnet sequence on a mock chain.

## On mainnet (v2, 17 Nov)
Run with our own keys, contract `bitcoincash:pvfw6fhv3rp925ejjrqshy75afuwaak0kuvtf35a05y8vdqq07wujd2a8mej2`
(log: [pool_v2_mainnet.log](pool_v2_mainnet.log)). The release went to member 2's recovery address
`bitcoincash:qq63ztxw24rnv4l66v64a70gkj3rk053sy2n742xyd`, a different key from the member's and the merchant's.

| Step | Transaction | Block | Size |
|---|---|---|---|
| deploy the v2 pool (2,000 sats per 1-block period) | [14bfd313](https://blockchair.com/bitcoin-cash/transaction/14bfd313d419c7532576df0ce9511ceb76e6195c75609106eade975a175ca84b) | 977809 | 906 B |
| member 1 subscribes, 4 periods, naming a recovery address | [bb0356aa](https://blockchair.com/bitcoin-cash/transaction/bb0356aaa942cea929bbfe91b4a3b81601ef6cb65612c060e4794c8e1c1b7f2a) | 977809 | 11,232 B |
| member 2 subscribes, 4 periods, naming a recovery address | [90c1b383](https://blockchair.com/bitcoin-cash/transaction/90c1b38380d619a5f490cccaf9cd9bc17cd8de1f649c0908a6075bd428947eae) | 977809 | 11,129 B |
| collect from both members in one transaction (merchant +4,000) | [21496c9f](https://blockchair.com/bitcoin-cash/transaction/21496c9f08d04a1e974579a88b69446486e3f88fc0551a2b5e92b7231853de70) | 977809 | 10,715 B |
| next period: collect from both again | [c9a0ba5e](https://blockchair.com/bitcoin-cash/transaction/c9a0ba5e0fb04af1464686bd1adfe55f60b3c96be3fea319e413bc5c09d09b2c) | 977810 | 10,715 B |
| catch-up: two periods from member 1 (paidTotal 12,000) | [5219cf21](https://blockchair.com/bitcoin-cash/transaction/5219cf21fe091a57b79a656f7e1ced79625a027591942a8c87bbe108cc304f95) | 977812 | 10,359 B |
| member 2 withdraws 1 period | [53c0335c](https://blockchair.com/bitcoin-cash/transaction/53c0335cdb9915240283d16b1daa04c9cf040f51927b59fad332260280d16f0d) | 977812 | 10,966 B |
| **key-loss path**: the merchant releases member 2's last period, paid to member 2's recovery address | [36ce49fe](https://blockchair.com/bitcoin-cash/transaction/36ce49fef70152e7969c33c4a7b3454647a0aa872ab0af408d329b2ffe7da7ac) | 977812 | 10,817 B |
| member 1 leaves | [edb9b093](https://blockchair.com/bitcoin-cash/transaction/edb9b0938dc805aa5bf213c5c0c516c3a4a8b7a96f00fbfbe7cbc09b0ebc2eff) | 977812 | 10,316 B |
Final state: 0 members, paidTotal 12,000 sats, one 1,000-sat pool coin left.

**Cost, stated plainly:** every v2 call is a ~10.3-11.2 KB transaction (fee ~10.3-11.4k sats at 1 sat/byte, about 2 US cents),
1.3-1.5x the same v1 call (collect 10,905 vs 8,206 sats; subscribe 11,422 vs 7,690): each spend carries the larger v2 contract,
its state and two verified mappings.
That is a fixed cost per call: one `collect` serves up to 16 members. Custom errors compile to a plain failing script in SolidCash
(the compiler type-checks their arguments but does not put them on chain), so they name the failure in the source and the tests only.

## On mainnet (v1, the contract in `contracts/v1/`)
Run of 17 Nov 2026 with our own keys, contract `bitcoincash:p0puu77vgjg476htngm94zcu2rtpq9g89jk30qwwjffx208xse0zgcmjp4cml` (log: [pool_mainnet.log](pool_mainnet.log)).

| Step | Transaction | Block |
|---|---|---|
| deploy the pool (one covenant for the plan, 2,000 sats per 1-block period) | [ee41dc87](https://blockchair.com/bitcoin-cash/transaction/ee41dc87d88fbcf6d657058564270b9dc50b4cf3927352eeced69d9b334bd19a) | 977740 |
| member 1 subscribes, 4 periods | [cd565869](https://blockchair.com/bitcoin-cash/transaction/cd565869afc900a629d97f079a6252d7a606e8b56219bb6df4206aec233e6c5c) | 977741 |
| member 2 subscribes, 3 periods | [d5644398](https://blockchair.com/bitcoin-cash/transaction/d5644398eaaedb4d02d4c83a2a890f18ae27fac47b73a4e5ac0251991953ee6b) | 977741 |
| collect from both members in one transaction (merchant +4,000) | [03b99ffa](https://blockchair.com/bitcoin-cash/transaction/03b99ffa4d2670ace06940f4f3a918203fdd83bc6f4ea0885e82f93fbe4f39c8) | 977741 |
| next period: collect from both again (paidTotal 8,000) | [22a8dc66](https://blockchair.com/bitcoin-cash/transaction/22a8dc66874b9676b9e7e4bd3baa03f65d353636d1e5b55753ed27b6a9ba2820) | 977742 |
| catch-up: collect 2 missed periods from member 1 (paidTotal 12,000) | [c17e5f85](https://blockchair.com/bitcoin-cash/transaction/c17e5f858d029911e6bb1512092748dc08d8b6013c13257c48a877395d65fc39) | 977744 |
| member 2 withdraws 1 unused period | [6831bb3a](https://blockchair.com/bitcoin-cash/transaction/6831bb3ad7451d38d69f5c854e023d49dffd87b26b16ce58543ca5602d52ebe5) | 977744 |
| member 1 leaves (record removed) | [efe62b44](https://blockchair.com/bitcoin-cash/transaction/efe62b4411dcaf382122f91ec07a3009de63be1e67f852f90d86b25afd22aa0d) | 977744 |

A collect tried right after the first one, before the next period, was refused by the contract (`require: member not due`; nothing broadcast).
Final state: 0 members, paidTotal 12,000 sats, one 1,000-sat pool coin left.

## SolidCash 0.51 notes
Four SDK issues met while building this (msg.value with a transfer, the CLTV derivation probe, tx.origin outside container calls,
container coins that never merge) and the workarounds: [UPSTREAM_ISSUE.md](UPSTREAM_ISSUE.md).
