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
| pause / resume on the packed record | `pause` stores the record negated (every rule that needs an active member, `collect` first, then refuses it with no extra lookup); `resume` moves the due height on, never earlier |
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
**Trust, stated plainly:** the merchant can end a membership early (the refund goes to the recovery address) but cannot take a
member's money; the member trusts the merchant not to release without reason, and must keep the recovery wallet safe, since whoever
holds it receives a release.

## Pause and resume (v3, 18 Nov)
A member can pause (by signature, no money moves): while paused, no period can be collected. `resume(from)` makes the next period
due at `from`, a height the chain has reached (CLTV) and never earlier than it was due before the pause, so the paused time is not
charged and nothing is skipped. A member who loses their key while paused can still be released to their recovery address. To keep
the contract under the 10,000-byte input-script limit (a separate `paused` mapping took it to 10,939 bytes), the pause flag is the
sign of the stored record. Top-up, withdraw and leave need an active (resumed) member.

## Tests
`npx --no-install solidhat test` (SolidHat compiles the pool contract, then runs vitest; the plain `npx --no-install vitest run -c vitest.config.mjs` still works): 16 tests on the production mock network (subscribe, caps on deposits, top-up,
collect never early, a final transaction lying about `due` is refused by the CLTV, batch of three in one tx, catch-up, no budget left,
redirect and inflate attempts, withdraw/leave only by the member, fragmented-pool liveness, release only by the merchant and only
to the recovery address, recovery address changed only by the member, pause blocks collect, resume never moves the due height
earlier or to a future height, only the member pauses or resumes, release of a paused member).
`python3 scripts/planted_controls.py`: 18 weakened copies of the contract, each must turn the suite red (all do).
`node scripts/pool_run.mjs simulate`: the mainnet sequence on a mock chain.

## On mainnet (v3, 18 Nov: pause and resume)
Run with our own keys (log: [pool_v3_mainnet.log](pool_v3_mainnet.log)); the release went to member 2's recovery address
`bitcoincash:qq63ztxw24rnv4l66v64a70gkj3rk053sy2n742xyd`.

Second explorer: every txid also links to 3xpl.com, which serves plain HTTP clients (Blockchair may block automated readers).

| Step | Transaction | Block | Size |
|---|---|---|---|
| deploy the v3 pool (2,000 sats per 1-block period) | [50ce1b7b](https://blockchair.com/bitcoin-cash/transaction/50ce1b7b26fb9ad07d74da81a7ffd1a05d803076138482d7fecf544c9ab517b2) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/50ce1b7b26fb9ad07d74da81a7ffd1a05d803076138482d7fecf544c9ab517b2)) | 977845 | 906 B |
| member 1 subscribes, 4 periods | [394487bc](https://blockchair.com/bitcoin-cash/transaction/394487bc7e623c894c07d80ba2e1eaec073685be5712771e4676db7f4a3b82f3) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/394487bc7e623c894c07d80ba2e1eaec073685be5712771e4676db7f4a3b82f3)) | 977845 | 11,498 B |
| member 2 subscribes, 4 periods | [29c1ebd3](https://blockchair.com/bitcoin-cash/transaction/29c1ebd3b62cd49e6352e1b4f600962ae23db5504db9bec3e9c516406fd9a767) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/29c1ebd3b62cd49e6352e1b4f600962ae23db5504db9bec3e9c516406fd9a767)) | 977845 | 11,395 B |
| collect from both members in one transaction | [5a306c5b](https://blockchair.com/bitcoin-cash/transaction/5a306c5bc686967c3c920485833cb6139ff1cc7a3cbaa5967b8a744c4009500e) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/5a306c5bc686967c3c920485833cb6139ff1cc7a3cbaa5967b8a744c4009500e)) | 977845 | 10,981 B |
| next period: collect from both again | [8059dc1a](https://blockchair.com/bitcoin-cash/transaction/8059dc1a42f5089021ac12ff609b59943c9d52d3de8afe45d469ff326c4ddaf5) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/8059dc1a42f5089021ac12ff609b59943c9d52d3de8afe45d469ff326c4ddaf5)) | 977846 | 10,981 B |
| catch-up: two periods from member 1 | [e3ba6144](https://blockchair.com/bitcoin-cash/transaction/e3ba61447bcfe4ea9667760bf1cc724b2a578b282bc6ab14e31f1750776d91a0) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/e3ba61447bcfe4ea9667760bf1cc724b2a578b282bc6ab14e31f1750776d91a0)) | 977848 | 10,625 B |
| **member 2 pauses** (a collect from member 2 right after was refused: `require: not a member`, nothing broadcast) | [0d84fe5a](https://blockchair.com/bitcoin-cash/transaction/0d84fe5a1bb8a404b87f123450cf1e5e307fa0e50f8324a6318d2472af70923e) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/0d84fe5a1bb8a404b87f123450cf1e5e307fa0e50f8324a6318d2472af70923e)) | 977848 | 9,802 B |
| **member 2 resumes** (next period due from the resume height) | [35a8c62e](https://blockchair.com/bitcoin-cash/transaction/35a8c62ea5863156fa34dc4ce49e71a5331eb70bd032a6af7ada785cff3b194e) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/35a8c62ea5863156fa34dc4ce49e71a5331eb70bd032a6af7ada785cff3b194e)) | 977849 | 10,175 B |
| member 2 withdraws 1 period | [d994e411](https://blockchair.com/bitcoin-cash/transaction/d994e41126eec44d8a782ff265e6424105c87c516a4f44d5d9d1f3958231b183) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/d994e41126eec44d8a782ff265e6424105c87c516a4f44d5d9d1f3958231b183)) | 977849 | 11,232 B |
| key-loss path: the merchant releases member 2's last period to the recovery address | [9cac3580](https://blockchair.com/bitcoin-cash/transaction/9cac35800ce85d2a99e3996d03294f05ce57559c81bf62827606649847ba0406) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/9cac35800ce85d2a99e3996d03294f05ce57559c81bf62827606649847ba0406)) | 977849 | 11,083 B |
| member 1 leaves | [ce5b37ae](https://blockchair.com/bitcoin-cash/transaction/ce5b37ae61e748d83683ff859cd6614e490679c8060a625af03149ac4be2e607) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/ce5b37ae61e748d83683ff859cd6614e490679c8060a625af03149ac4be2e607)) | 977849 | 10,582 B |

Final state: 0 members, paidTotal 12,000 sats, one 1,000-sat pool coin left. Each v3 call is 9.8-11.5 KB.

## On mainnet (v2, 17 Nov; the contract in `contracts/v2/`)
Run with our own keys, contract `bitcoincash:pvfw6fhv3rp925ejjrqshy75afuwaak0kuvtf35a05y8vdqq07wujd2a8mej2`
(log: [pool_v2_mainnet.log](pool_v2_mainnet.log)). The release went to member 2's recovery address
`bitcoincash:qq63ztxw24rnv4l66v64a70gkj3rk053sy2n742xyd`, a different key from the member's and the merchant's.

| Step | Transaction | Block | Size |
|---|---|---|---|
| deploy the v2 pool (2,000 sats per 1-block period) | [14bfd313](https://blockchair.com/bitcoin-cash/transaction/14bfd313d419c7532576df0ce9511ceb76e6195c75609106eade975a175ca84b) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/14bfd313d419c7532576df0ce9511ceb76e6195c75609106eade975a175ca84b)) | 977809 | 906 B |
| member 1 subscribes, 4 periods, naming a recovery address | [bb0356aa](https://blockchair.com/bitcoin-cash/transaction/bb0356aaa942cea929bbfe91b4a3b81601ef6cb65612c060e4794c8e1c1b7f2a) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/bb0356aaa942cea929bbfe91b4a3b81601ef6cb65612c060e4794c8e1c1b7f2a)) | 977809 | 11,232 B |
| member 2 subscribes, 4 periods, naming a recovery address | [90c1b383](https://blockchair.com/bitcoin-cash/transaction/90c1b38380d619a5f490cccaf9cd9bc17cd8de1f649c0908a6075bd428947eae) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/90c1b38380d619a5f490cccaf9cd9bc17cd8de1f649c0908a6075bd428947eae)) | 977809 | 11,129 B |
| collect from both members in one transaction (merchant +4,000) | [21496c9f](https://blockchair.com/bitcoin-cash/transaction/21496c9f08d04a1e974579a88b69446486e3f88fc0551a2b5e92b7231853de70) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/21496c9f08d04a1e974579a88b69446486e3f88fc0551a2b5e92b7231853de70)) | 977809 | 10,715 B |
| next period: collect from both again | [c9a0ba5e](https://blockchair.com/bitcoin-cash/transaction/c9a0ba5e0fb04af1464686bd1adfe55f60b3c96be3fea319e413bc5c09d09b2c) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/c9a0ba5e0fb04af1464686bd1adfe55f60b3c96be3fea319e413bc5c09d09b2c)) | 977810 | 10,715 B |
| catch-up: two periods from member 1 (paidTotal 12,000) | [5219cf21](https://blockchair.com/bitcoin-cash/transaction/5219cf21fe091a57b79a656f7e1ced79625a027591942a8c87bbe108cc304f95) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/5219cf21fe091a57b79a656f7e1ced79625a027591942a8c87bbe108cc304f95)) | 977812 | 10,359 B |
| member 2 withdraws 1 period | [53c0335c](https://blockchair.com/bitcoin-cash/transaction/53c0335cdb9915240283d16b1daa04c9cf040f51927b59fad332260280d16f0d) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/53c0335cdb9915240283d16b1daa04c9cf040f51927b59fad332260280d16f0d)) | 977812 | 10,966 B |
| **key-loss path**: the merchant releases member 2's last period, paid to member 2's recovery address | [36ce49fe](https://blockchair.com/bitcoin-cash/transaction/36ce49fef70152e7969c33c4a7b3454647a0aa872ab0af408d329b2ffe7da7ac) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/36ce49fef70152e7969c33c4a7b3454647a0aa872ab0af408d329b2ffe7da7ac)) | 977812 | 10,817 B |
| member 1 leaves | [edb9b093](https://blockchair.com/bitcoin-cash/transaction/edb9b0938dc805aa5bf213c5c0c516c3a4a8b7a96f00fbfbe7cbc09b0ebc2eff) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/edb9b0938dc805aa5bf213c5c0c516c3a4a8b7a96f00fbfbe7cbc09b0ebc2eff)) | 977812 | 10,316 B |
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
| deploy the pool (one covenant for the plan, 2,000 sats per 1-block period) | [ee41dc87](https://blockchair.com/bitcoin-cash/transaction/ee41dc87d88fbcf6d657058564270b9dc50b4cf3927352eeced69d9b334bd19a) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/ee41dc87d88fbcf6d657058564270b9dc50b4cf3927352eeced69d9b334bd19a)) | 977740 |
| member 1 subscribes, 4 periods | [cd565869](https://blockchair.com/bitcoin-cash/transaction/cd565869afc900a629d97f079a6252d7a606e8b56219bb6df4206aec233e6c5c) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/cd565869afc900a629d97f079a6252d7a606e8b56219bb6df4206aec233e6c5c)) | 977741 |
| member 2 subscribes, 3 periods | [d5644398](https://blockchair.com/bitcoin-cash/transaction/d5644398eaaedb4d02d4c83a2a890f18ae27fac47b73a4e5ac0251991953ee6b) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/d5644398eaaedb4d02d4c83a2a890f18ae27fac47b73a4e5ac0251991953ee6b)) | 977741 |
| collect from both members in one transaction (merchant +4,000) | [03b99ffa](https://blockchair.com/bitcoin-cash/transaction/03b99ffa4d2670ace06940f4f3a918203fdd83bc6f4ea0885e82f93fbe4f39c8) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/03b99ffa4d2670ace06940f4f3a918203fdd83bc6f4ea0885e82f93fbe4f39c8)) | 977741 |
| next period: collect from both again (paidTotal 8,000) | [22a8dc66](https://blockchair.com/bitcoin-cash/transaction/22a8dc66874b9676b9e7e4bd3baa03f65d353636d1e5b55753ed27b6a9ba2820) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/22a8dc66874b9676b9e7e4bd3baa03f65d353636d1e5b55753ed27b6a9ba2820)) | 977742 |
| catch-up: collect 2 missed periods from member 1 (paidTotal 12,000) | [c17e5f85](https://blockchair.com/bitcoin-cash/transaction/c17e5f858d029911e6bb1512092748dc08d8b6013c13257c48a877395d65fc39) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/c17e5f858d029911e6bb1512092748dc08d8b6013c13257c48a877395d65fc39)) | 977744 |
| member 2 withdraws 1 unused period | [6831bb3a](https://blockchair.com/bitcoin-cash/transaction/6831bb3ad7451d38d69f5c854e023d49dffd87b26b16ce58543ca5602d52ebe5) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/6831bb3ad7451d38d69f5c854e023d49dffd87b26b16ce58543ca5602d52ebe5)) | 977744 |
| member 1 leaves (record removed) | [efe62b44](https://blockchair.com/bitcoin-cash/transaction/efe62b4411dcaf382122f91ec07a3009de63be1e67f852f90d86b25afd22aa0d) ([3xpl](https://3xpl.com/bitcoin-cash/transaction/efe62b4411dcaf382122f91ec07a3009de63be1e67f852f90d86b25afd22aa0d)) | 977744 |

A collect tried right after the first one, before the next period, was refused by the contract (`require: member not due`; nothing broadcast).
Final state: 0 members, paidTotal 12,000 sats, one 1,000-sat pool coin left.

## SolidCash 0.51 notes
Four SDK issues met while building this (msg.value with a transfer, the CLTV derivation probe, tx.origin outside container calls,
container coins that never merge) and the workarounds: [UPSTREAM_ISSUE.md](UPSTREAM_ISSUE.md).
