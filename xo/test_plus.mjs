// Offline proof for the Plus template: same addresses as the solidcash build (order and paused covenants), and its claim / pause /
// resume / cancel transactions pass the BCH 2026 VM while tampered ones fail. No network.
import fs from "node:fs";
import { generateTransaction, createVirtualMachineBch2026, hexToBin, binToHex, bigIntToVmNumber, hash160, secp256k1, generatePrivateKey } from "@bitauth/libauth";
import { compiler, compile } from "./lib/compiler_plus.mjs";

const body = JSON.parse(fs.readFileSync(new URL("./standing_order_plus.body.json", import.meta.url), "utf8"));
const vm = createVirtualMachineBch2026(false);
const num = (n) => bigIntToVmNumber(BigInt(n));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };

// 1. addresses equal the solidcash build
[{ m: "11", s: "22", amt: 20000n, per: 1n, fee: 1000n, sp: "33", sa: 1000n, oid: "0102030405060708" },
 { m: "ab", s: "cd", amt: 1234567n, per: 144n, fee: 2000n, sp: "ef", sa: 0n, oid: "0909090909090909" }].forEach((v, i) => {
  const d = { bytecode: { merchantPkh: hexToBin(v.m.repeat(20)), subscriberPkh: hexToBin(v.s.repeat(20)), amountPerPeriod: num(v.amt), periodBlocks: num(v.per),
    maxFee: num(v.fee), splitPkh: hexToBin(v.sp.repeat(20)), splitAmount: num(v.sa), orderId: hexToBin(v.oid) } };
  ok(binToHex(compile("plusLockingBytecode", d)) === body.vectors.plus[i].lockingBytecode, `vector ${i}: Plus address == solidcash build`);
});
// paused covenant: PausedOrder(subscriber, resumeTo) equals the solidcash build for the same arguments
const pv = body.vectors.paused[0];
ok(pv.redeemHex.endsWith(body.pausedBodyHex), "PausedOrder body == the PAUSED_TEMPLATE constant inside StandingOrderPlus");

// 2. a live-shaped order
const key = () => { const k = generatePrivateKey(); return { k, pkh: hash160(secp256k1.derivePublicKeyCompressed(k)) }; };
const sub = key(), mer = key(), spl = key(), stranger = key();
const AMT = 20000n, SPLIT = 1000n, FEE = 1000n, PER = 2n;
const base = { merchantPkh: mer.pkh, subscriberPkh: sub.pkh, amountPerPeriod: num(AMT), periodBlocks: num(PER), maxFee: num(FEE), splitPkh: spl.pkh, splitAmount: num(SPLIT), orderId: hexToBin("a1b2c3d4e5f60718") };
const L = (id, extra = {}) => compile(id, { bytecode: { ...base, ...extra } });
const order = L("plusLockingBytecode"), paused = L("pausedLockingBytecode"), merL = L("merchantLockingBytecode"), splL = L("splitLockingBytecode"), subL = L("subscriberLockingBytecode");
const op = (n) => ({ outpointIndex: 0, outpointTransactionHash: hexToBin(String(n).padStart(64, "0")) });
function run(label, inputs, outputs, sourceOutputs, expect) {
  const g = generateTransaction({ version: 2, locktime: 0, inputs, outputs });
  if (!g.success) return ok(!expect, `${label} (build failed: ${JSON.stringify(g.errors).slice(0, 120)})`);
  const r = vm.verify({ sourceOutputs, transaction: g.transaction });
  ok((r === true) === expect, `${label}: ${r === true ? "valid" : "rejected"}`);
}
const covIn = (n, script, value, seq = 0, extra = {}) => ({ ...op(n), sequenceNumber: seq, unlockingBytecode: { compiler, data: { bytecode: { ...base, ...extra } }, script, valueSatoshis: value } });
const authIn = (n, who, value) => ({ ...op(n), sequenceNumber: 0, unlockingBytecode: { compiler, data: { keys: { privateKeys: { authKey: who.k } } }, script: "authUnlockingBytecode", valueSatoshis: value } });
const authLock = (who) => compile("authLockingBytecode", { keys: { privateKeys: { authKey: who.k } } });
const V = 100000n, A = 5000n, rest = V - AMT - SPLIT - FEE;

run("claim: merchant + split + change", [covIn(1, "claimUnlockingBytecode", V, Number(PER), { orderSatoshis: num(V) })],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: splL, valueSatoshis: SPLIT }, { lockingBytecode: order, valueSatoshis: rest }], [{ lockingBytecode: order, valueSatoshis: V }], true);
run("claim with the split sent to the merchant", [covIn(1, "claimUnlockingBytecode", V, Number(PER), { orderSatoshis: num(V) })],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: merL, valueSatoshis: SPLIT }, { lockingBytecode: order, valueSatoshis: rest }], [{ lockingBytecode: order, valueSatoshis: V }], false);
run("claim before the period", [covIn(1, "claimUnlockingBytecode", V, 1, { orderSatoshis: num(V) })],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: splL, valueSatoshis: SPLIT }, { lockingBytecode: order, valueSatoshis: rest }], [{ lockingBytecode: order, valueSatoshis: V }], false);
run("pause: period paid, rest to this order's paused covenant, subscriber change",
  [covIn(2, "pauseUnlockingBytecode", V, 0, { orderSatoshis: num(V) }), authIn(3, sub, A)],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: splL, valueSatoshis: SPLIT }, { lockingBytecode: paused, valueSatoshis: rest }, { lockingBytecode: subL, valueSatoshis: A - 500n }],
  [{ lockingBytecode: order, valueSatoshis: V }, { lockingBytecode: authLock(sub), valueSatoshis: A }], true);
run("pause authorized by a stranger's coin",
  [covIn(2, "pauseUnlockingBytecode", V, 0, { orderSatoshis: num(V) }), authIn(3, stranger, A)],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: splL, valueSatoshis: SPLIT }, { lockingBytecode: paused, valueSatoshis: rest }],
  [{ lockingBytecode: order, valueSatoshis: V }, { lockingBytecode: authLock(stranger), valueSatoshis: A }], false);
run("pause sending the rest to the subscriber instead of the paused covenant",
  [covIn(2, "pauseUnlockingBytecode", V, 0, { orderSatoshis: num(V) }), authIn(3, sub, A)],
  [{ lockingBytecode: merL, valueSatoshis: AMT }, { lockingBytecode: splL, valueSatoshis: SPLIT }, { lockingBytecode: subL, valueSatoshis: rest }],
  [{ lockingBytecode: order, valueSatoshis: V }, { lockingBytecode: authLock(sub), valueSatoshis: A }], false);
run("resume: the paused balance back into the same order",
  [covIn(4, "resumeUnlockingBytecode", rest, 0, { pausedSatoshis: num(rest) }), authIn(5, sub, A)],
  [{ lockingBytecode: order, valueSatoshis: rest - FEE }, { lockingBytecode: subL, valueSatoshis: A - 500n }],
  [{ lockingBytecode: paused, valueSatoshis: rest }, { lockingBytecode: authLock(sub), valueSatoshis: A }], true);
run("resume into another order",
  [covIn(4, "resumeUnlockingBytecode", rest, 0, { pausedSatoshis: num(rest) }), authIn(5, sub, A)],
  [{ lockingBytecode: L("plusLockingBytecode", { orderId: hexToBin("ffffffffffffffff") }), valueSatoshis: rest - FEE }],
  [{ lockingBytecode: paused, valueSatoshis: rest }, { lockingBytecode: authLock(sub), valueSatoshis: A }], false);
run("cancel: one refund to the subscriber",
  [covIn(6, "cancelUnlockingBytecode", V, 0, { orderSatoshis: num(V), authSatoshis: num(A) }), authIn(7, sub, A)],
  [{ lockingBytecode: subL, valueSatoshis: V + A - FEE }], [{ lockingBytecode: order, valueSatoshis: V }, { lockingBytecode: authLock(sub), valueSatoshis: A }], true);
run("cancel refunding the merchant",
  [covIn(6, "cancelUnlockingBytecode", V, 0, { orderSatoshis: num(V), authSatoshis: num(A) }), authIn(7, sub, A)],
  [{ lockingBytecode: merL, valueSatoshis: V + A - FEE }], [{ lockingBytecode: order, valueSatoshis: V }, { lockingBytecode: authLock(sub), valueSatoshis: A }], false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
