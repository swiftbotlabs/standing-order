// Offline proof that the XO template IS the Standing Order contract: same address as the solidcash build, and the
// template's claim / last-claim / cancel transactions pass (and tampered ones fail) the BCH 2026 VM. No network.
import fs from "node:fs";
import { generateTransaction, createVirtualMachineBch2026, hexToBin, binToHex, bigIntToVmNumber,
  hash160, secp256k1, generatePrivateKey, encodeTransactionBch, extractMissingVariables } from "@bitauth/libauth";

const body = JSON.parse(fs.readFileSync(new URL("./standing_order.body.json", import.meta.url), "utf8"));
import { compiler, compile } from "./lib/compiler.mjs";
const vm = createVirtualMachineBch2026(false);
const num = (n) => bigIntToVmNumber(BigInt(n));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// 1. same address as the solidcash-built contract (two vectors with different arguments)
const vec = [
  { m: "11".repeat(20), s: "22".repeat(20), amt: 20000n, per: 1n, fee: 1000n, oid: "0102030405060708" },
  { m: "ab".repeat(20), s: "cd".repeat(20), amt: 1234567n, per: 144n, fee: 2000n, oid: "0909090909090909" },
];
vec.forEach((v, i) => {
  const data = { bytecode: { merchantPkh: hexToBin(v.m), subscriberPkh: hexToBin(v.s), amountPerPeriod: num(v.amt), periodBlocks: num(v.per), maxFee: num(v.fee), orderId: hexToBin(v.oid) } };
  ok(binToHex(compile("standingOrderLockingBytecode", data)) === body.vectors[i].lockingBytecode, `vector ${i}: template address == solidcash address`);
  ok(binToHex(compile("standingOrderRedeemBytecode", data)) === body.vectors[i].redeemHex, `vector ${i}: template redeem script == solidcash redeem script`);
});

// 2. live-shaped order: real keys
const subPriv = generatePrivateKey(), merPriv = generatePrivateKey();
const subPkh = hash160(secp256k1.derivePublicKeyCompressed(subPriv)), merPkh = hash160(secp256k1.derivePublicKeyCompressed(merPriv));
const AMT = 20000n, PER = 2n, FEE = 1000n;
const base = { merchantPkh: merPkh, subscriberPkh: subPkh, amountPerPeriod: num(AMT), periodBlocks: num(PER), maxFee: num(FEE), orderId: hexToBin("a1b2c3d4e5f60718") };
const orderLock = compile("standingOrderLockingBytecode", { bytecode: base });
const merLock = compile("merchantLockingBytecode", { bytecode: base }), subLock = compile("subscriberLockingBytecode", { bytecode: base });
const outpoint = (n) => ({ outpointIndex: 0, outpointTransactionHash: hexToBin(String(n).padStart(64, "0")) });

function run(label, { inputs, outputs, sourceOutputs, expect }) {
  const g = generateTransaction({ version: 2, locktime: 0, inputs, outputs });
  if (!g.success) { ok(!expect, `${label} (could not build: ${JSON.stringify(g.errors).slice(0, 160)})`); return; }
  const res = vm.verify({ sourceOutputs, transaction: g.transaction });
  ok((res === true) === expect, `${label}: ${res === true ? "valid" : "rejected (" + String(res).slice(0, 90) + ")"}`);
}
function claim(label, { value = 100000n, seq = Number(PER), payTo = merLock, pay = AMT, changeTo = orderLock, change, extraOut, expect }) {
  const data = { bytecode: { ...base, orderSatoshis: num(value) } };
  const outs = [{ lockingBytecode: payTo, valueSatoshis: pay }];
  if (change !== null) outs.push({ lockingBytecode: changeTo, valueSatoshis: change ?? value - AMT - FEE });
  if (extraOut) outs.push(extraOut);
  run(label, { inputs: [{ ...outpoint(1), sequenceNumber: seq, unlockingBytecode: { compiler, data, script: "claimUnlockingBytecode", valueSatoshis: value } }],
    outputs: outs, sourceOutputs: [{ lockingBytecode: orderLock, valueSatoshis: value }], expect });
}
claim("claim after one period", { expect: true });
claim("claim before the period (sequence 1 < 2)", { seq: 1, expect: false });
claim("claim paying someone else", { payTo: subLock, expect: false });
claim("claim paying the merchant too much", { pay: AMT + 1n, change: 100000n - AMT - 1n - FEE, expect: false });
claim("claim sending the change elsewhere", { changeTo: merLock, expect: false });
claim("claim with a third output", { change: 100000n - AMT - FEE - 600n, extraOut: { lockingBytecode: merLock, valueSatoshis: 600n }, expect: false });
claim("last claim: remainder to merchant", { value: 30000n, pay: 29000n, change: null, expect: true });
claim("last claim keeping change in the order", { value: 30000n, pay: 20000n, change: 9000n, expect: false });

// 3. cancel: order coin + the subscriber's own coin (signed ALL), one refund output to the subscriber
function cancel(label, { key = subPriv, refundTo = subLock, expect }) {
  const value = 79000n, auth = 5000n;
  const authPkh = hash160(secp256k1.derivePublicKeyCompressed(key));
  const authLock = compile("subscriberLockingBytecode", { bytecode: { ...base, subscriberPkh: authPkh } });
  const data = { bytecode: { ...base, orderSatoshis: num(value), authSatoshis: num(auth) }, keys: { privateKeys: { subscriberKey: key } } };
  run(label, { inputs: [
      { ...outpoint(2), sequenceNumber: 0, unlockingBytecode: { compiler, data, script: "cancelUnlockingBytecode", valueSatoshis: value } },
      { ...outpoint(3), sequenceNumber: 0, unlockingBytecode: { compiler, data, script: "subscriberUnlockingBytecode", valueSatoshis: auth } }],
    outputs: [{ lockingBytecode: refundTo, valueSatoshis: value + auth - FEE }],
    sourceOutputs: [{ lockingBytecode: orderLock, valueSatoshis: value }, { lockingBytecode: authLock, valueSatoshis: auth }], expect });
}
cancel("cancel by the subscriber", { expect: true });
cancel("cancel signed by a stranger's coin", { key: merPriv, expect: false });
cancel("cancel refunding the merchant", { refundTo: merLock, expect: false });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
