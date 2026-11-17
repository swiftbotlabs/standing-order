# Upstream issue draft for solidcash/solidcash (SolidCash 0.51.0, MockNetworkProvider profile 'production')

Title: Stateful calls: msg.value + this.transfer() always fail; CLTV + transfer probe ignores setLocktime; tx.origin without a container fails; payable deposits fragment the satoshi container

Found while building a stateful subscription pool (verified mapping + covenant loop + satoshi container). Each item has a
minimal contract; all on `@solidcash/solidc` / `@solidcash/solidcash` 0.51.0, `MockNetworkProvider({ profile: 'production' })`,
deployed with `StatefulContract.deploy(..., { initialBalance: 5000n })`.

## 1. Reading `msg.value` in a function that also calls `this.transfer()` always fails

```solidity
pragma solidcash ^0.51.0;
contract D(bytes20 merchant) {
    int public n;
    function topUp(int expect) payable {
        require(msg.value == expect, "mv");
        this.n = this.n + 1;
        this.transfer(new LockingBytecodeP2PKH(merchant), 600);
    }
}
```
`pool.connect(a).call.topUp(e).withValue(20000n).send()` fails for every `e` in {20000, 19400, -600, 0} with
`VM failed at ip 114 opcode 192: Program failed an OP_VERIFY operation.; input 0` (it never reaches the "mv" require), and the
same without `.withValue()`. Removing the `msg.value` read makes the same call pass; removing the transfer makes it pass too.
Writing `msg.value` into state instead gives `Auto-derivation oscillation detected`.

## 2. `require(tx.time >= n)` + `this.transfer()`: the derivation probe ignores `.setLocktime(n)`

```solidity
function collect(bytes20 who, int due) {
    require(tx.time >= due, "not due yet");
    this.transfer(new LockingBytecodeP2PKH(merchant), price);
}
```
`.call.collect(who, h).setLocktime(h).send()` fails with `require: not due yet`. Without the transfer, or without the
CLTV line, it passes. The transfer-derivation probe seems to be built with nLockTime 0 and only the final tx gets the
override. Workaround that proves it: raising `TransactionBuilder#locktime` for every build inside the call
(prototype patch of `buildLibauthTransaction`) makes it pass, and the covenant still refuses an early call.
Suggested fix: carry `locktimeOverride` into the probe builder (as `stb-register-stateful-inputs` already does for the final one).

## 3. `tx.origin` in a function that spends no satoshi container fails

`require(tx.origin == new LockingBytecodeP2PKH(subscriber))` works in a function with `this.transfer()`, but in a function
with no transfer (only a vmap delete / state write) the honest call fails:
`messageBus: BCH-2026 preflight failed at input 0: Program failed an OP_VERIFY operation.` Removing the `tx.origin` line makes it pass.

## 4. Payable deposits fragment the satoshi container for good

`.withValue(v)` on a function that spends no container adds a NEW coin at the container address
(`addContainerDepositOutput`). The container's merge path admits a single input per lock, and
`loadCreateBuilderSatoshiContainer` spends only the largest coin, so a later `this.transfer(x)` fails with
`Total transfer amount (x) exceeds satoshi container balance (largest coin)` although the container holds more in total.
Three deposits of 20,000 -> a transfer of 30,000 is impossible forever. A payable function that also transfers would merge
the deposit into the recreated coin, but that hits item 1. Ideas: let a call spend several container coins (aggregate
conservation), or a `consolidate` entry that merges N coins of the same container into one.

Repro tests: github.com/swiftbotlabs/standing-order (pool/) `test/pool.test.ts` and the notes above. Happy to turn any of these into a PR with a test.
