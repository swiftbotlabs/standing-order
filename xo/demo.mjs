// Chipnet demo: a real Standing Order driven entirely by the XO template's scripts (standing-order.template.mjs).
// Every locking script, unlocking script and output value below is compiled from the template by libauth; the template is
// also imported into the XO engine (`import` step) to show XO accepts it. Test coins only.
//   node --import ./lib/no-native.mjs demo.mjs import            XO engine: import the template (validation)
//   node demo.mjs status | fund <sats> | claim | cancel
// Keys: SEED_FILE (BIP32 seed hex; never printed). Subscriber m/44'/145'/0'/9/0, merchant .../9/1 (the repo's chipnet test keys).
import fs from "node:fs";
import crypto from "node:crypto";
import { ElectrumClient } from "@electrum-cash/network";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, sha256, binToHex, hexToBin,
  bigIntToVmNumber, generateTransaction, encodeTransactionBch, encodeCashAddress, lockingBytecodeToCashAddress, swapEndianness, createVirtualMachineBch2026 } from "@bitauth/libauth";
import { compiler, compile, template } from "./lib/compiler.mjs";

const STATE = new URL("./demo-state.json", import.meta.url);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const [cmd, arg] = process.argv.slice(2);

if (cmd === "import") {
  await import("fake-indexeddb/auto");
  const { Engine, XO_SUPPORTED_NETWORKS } = await import("@xo-cash/engine");
  const { StorageType } = await import("@xo-cash/state");
  const mnemonic = fs.readFileSync(process.env.XO_MNEMONIC_FILE, "utf8").trim();
  const engine = await Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS.chipnet, storageType: StorageType.INDEXEDDB, databaseFilename: "XO-standing-order" });
  const { templateIdentifier } = await engine.importTemplate(template);
  const t = await engine.getTemplate(templateIdentifier);
  log("XO engine imported the template:", templateIdentifier, "| actions:", Object.keys(t.actions).join(", "), "| roles:", Object.keys(t.roles).join(", "));
  await engine.stop(); process.exit(0);
}

const seed = hexToBin(fs.readFileSync(process.env.SEED_FILE, "utf8").trim());
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (i) => { const n = deriveHdPathRelative(acct, `9/${i}`, { throwErrors: true }); return { priv: n.privateKey, pkh: hash160(deriveHdPublicNode(n).publicKey) }; };
const sub = key(0), mer = key(1);
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { orderId: binToHex(crypto.randomBytes(8)), txids: [] };
if (!fs.existsSync(STATE)) fs.writeFileSync(STATE, JSON.stringify(st, null, 1) + "\n");
const AMT = 20000n, PER = 1n, FEE = 1000n;
const num = (n) => bigIntToVmNumber(BigInt(n));
const base = { merchantPkh: mer.pkh, subscriberPkh: sub.pkh, amountPerPeriod: num(AMT), periodBlocks: num(PER), maxFee: num(FEE), orderId: hexToBin(st.orderId) };
const orderLock = compile("standingOrderLockingBytecode", { bytecode: base });
const subLock = compile("subscriberLockingBytecode", { bytecode: base }), merLock = compile("merchantLockingBytecode", { bytecode: base });
const addr = (lb) => lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bchtest" }).address;
const scripthash = (lb) => binToHex(sha256.hash(lb).reverse());

const ec = new ElectrumClient("standing-order-xo-demo", "1.4.1", process.env.ELECTRUM || "chipnet.imaginary.cash");
await ec.connect();
const rq = async (m, ...p) => { const r = await ec.request(m, ...p); if (r instanceof Error) throw r; return r; };
const utxos = async (lb) => (await rq("blockchain.scripthash.listunspent", scripthash(lb))).filter((u) => !u.token_data)
  .map((u) => ({ outpointTransactionHash: hexToBin(u.tx_hash), outpointIndex: u.tx_pos, value: BigInt(u.value), height: u.height }));
const vm = createVirtualMachineBch2026(true); // standard rules, as a node would apply them
async function send(label, inputs, outputs, sourceOutputs) {
  const g = generateTransaction({ version: 2, locktime: 0, inputs, outputs });
  if (!g.success) throw new Error(label + " build: " + JSON.stringify(g.errors).slice(0, 400));
  const v = vm.verify({ sourceOutputs, transaction: g.transaction });
  if (v !== true) throw new Error(label + " local VM: " + v);
  const txid = await rq("blockchain.transaction.broadcast", binToHex(encodeTransactionBch(g.transaction)));
  st.txids.push({ step: label, txid, at: new Date().toISOString() }); fs.writeFileSync(STATE, JSON.stringify(st, null, 1) + "\n");
  log(label.toUpperCase(), txid, "https://chipnet.chaingraph.cash/tx/" + txid);
}
const subIn = (u, data) => ({ outpointTransactionHash: u.outpointTransactionHash, outpointIndex: u.outpointIndex, sequenceNumber: 0,
  unlockingBytecode: { compiler, data, script: "subscriberUnlockingBytecode", valueSatoshis: u.value } });
const keys = { privateKeys: { subscriberKey: sub.priv } };

log("order", addr(orderLock), "| subscriber", addr(subLock), "| merchant", addr(merLock), "| orderId", st.orderId);
const order = await utxos(orderLock);
log("order coins:", order.map((u) => `${binToHex(u.outpointTransactionHash).slice(0, 10)}:${u.outpointIndex} ${u.value} h${u.height}`).join(", ") || "none");
try {
  if (cmd === "fund") {
    const amt = BigInt(arg || "60000");
    const coins = (await utxos(subLock)).sort((a, b) => Number(b.value - a.value));
    const picked = []; let total = 0n;
    for (const c of coins) { picked.push(c); total += c.value; if (total >= amt + FEE + 546n) break; }
    if (total < amt + FEE + 546n) throw new Error("subscriber has too little: " + total);
    const data = { bytecode: { ...base, fundSatoshis: num(amt) }, keys };
    await send("fund", picked.map((c) => subIn(c, data)),
      [{ lockingBytecode: orderLock, valueSatoshis: amt }, { lockingBytecode: subLock, valueSatoshis: total - amt - FEE }],
      picked.map((c) => ({ lockingBytecode: subLock, valueSatoshis: c.value })));
  } else if (cmd === "claim") {
    const u = order[0]; if (!u) throw new Error("no order coin");
    const data = { bytecode: { ...base, orderSatoshis: num(u.value) } };
    const last = u.value - AMT - FEE < AMT + FEE;
    const outs = last ? [{ lockingBytecode: merLock, valueSatoshis: u.value - FEE }]
      : [{ lockingBytecode: merLock, valueSatoshis: AMT }, { lockingBytecode: orderLock, valueSatoshis: u.value - AMT - FEE }];
    await send(last ? "last claim" : "claim", [{ outpointTransactionHash: u.outpointTransactionHash, outpointIndex: u.outpointIndex, sequenceNumber: Number(PER),
      unlockingBytecode: { compiler, data, script: "claimUnlockingBytecode", valueSatoshis: u.value } }], outs, [{ lockingBytecode: orderLock, valueSatoshis: u.value }]);
  } else if (cmd === "cancel") {
    const u = order[0]; if (!u) throw new Error("no order coin");
    const own = (await utxos(subLock)).sort((a, b) => Number(a.value - b.value)).find((c) => c.value >= 1000n);
    if (!own) throw new Error("subscriber has no coin to authorize the cancel");
    const data = { bytecode: { ...base, orderSatoshis: num(u.value), authSatoshis: num(own.value) }, keys };
    await send("cancel", [{ outpointTransactionHash: u.outpointTransactionHash, outpointIndex: u.outpointIndex, sequenceNumber: 0,
        unlockingBytecode: { compiler, data, script: "cancelUnlockingBytecode", valueSatoshis: u.value } }, subIn(own, data)],
      [{ lockingBytecode: subLock, valueSatoshis: u.value + own.value - FEE }],
      [{ lockingBytecode: orderLock, valueSatoshis: u.value }, { lockingBytecode: subLock, valueSatoshis: own.value }]);
  } else if (cmd !== "status") throw new Error("usage: status | fund <sats> | claim | cancel");
} catch (e) { log("ERROR", String(e?.message || e).slice(0, 500)); process.exitCode = 3; }
await ec.disconnect(true); process.exit(process.exitCode || 0);
