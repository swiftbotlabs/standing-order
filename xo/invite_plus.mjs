// Standing Order Plus through XO invitations on chipnet, one engine session: fund -> claim (anyone) -> pause -> resume -> cancel.
// The subscriber is this XO wallet's first address: pause, resume and cancel are authorized by one of its own coins (last input).
// Each invitation is saved to invitations-plus/<n>-<action>.xo.json (serializeInvitation) for the blaze.xo.cash debug tool.
//   XO_MNEMONIC_FILE=<file> MERCHANT_PKH=<hex> SPLIT_PKH=<hex> node --import ./lib/no-native.mjs invite_plus.mjs
import "fake-indexeddb/auto";
import fs from "node:fs";
import crypto from "node:crypto";
import { Engine, XO_SUPPORTED_NETWORKS } from "@xo-cash/engine";
import { StorageType } from "@xo-cash/state";
import { p2pkhTemplate } from "@xo-cash/templates";
import { serializeInvitation } from "@xo-cash/utils";
import { ElectrumClient } from "@electrum-cash/network";
import { lockingBytecodeToCashAddress, hexToBin, binToHex, sha256, bigIntToVmNumber, decodeTransactionBch } from "@bitauth/libauth";
import T from "./standing-order-plus.template.mjs";
import { compile } from "./lib/compiler_plus.mjs";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const DIR = new URL("./invitations-plus/", import.meta.url);
const RUN = new URL("run.json", DIR);
const run = fs.existsSync(RUN) ? JSON.parse(fs.readFileSync(RUN, "utf8")) : { orderId: binToHex(crypto.randomBytes(8)), steps: [] };
const save = () => fs.writeFileSync(RUN, JSON.stringify(run, null, 1) + "\n");
const FUND = 20000n, AMT = 2000n, SPLIT = 1000n, FEE = 2000n, PER = 1; // split >= 546 (dust); maxFee covers ~1.3 kB covenant txs at 1 sat/B

const e = await Engine.create(fs.readFileSync(process.env.XO_MNEMONIC_FILE, "utf8").trim(), { network: XO_SUPPORTED_NETWORKS.chipnet, storageType: StorageType.INDEXEDDB, databaseFilename: "XO-standing-order-plus" });
const p2 = (await e.importTemplate(p2pkhTemplate)).templateIdentifier;
const so = (await e.importTemplate(T)).templateIdentifier;
await e.setDefaultPolicies({ change: { templateIdentifier: p2 }, receive: { templateIdentifier: p2 }, address: { templateIdentifier: p2 } });
const walletLock = await e.generateLockingBytecodeFromDefaultPolicy("address");
const subscriberPkh = walletLock.slice(6, 46); // P2PKH: 76 a9 14 <20 bytes> 88 ac
const TERMS = { merchantPkh: process.env.MERCHANT_PKH, subscriberPkh, amountPerPeriod: AMT, periodBlocks: PER, maxFee: FEE, splitPkh: process.env.SPLIT_PKH, splitAmount: SPLIT, orderId: run.orderId };
const num = (x) => bigIntToVmNumber(BigInt(x));
const termBytes = { merchantPkh: hexToBin(TERMS.merchantPkh), subscriberPkh: hexToBin(subscriberPkh), amountPerPeriod: num(AMT), periodBlocks: num(PER), maxFee: num(FEE), splitPkh: hexToBin(TERMS.splitPkh), splitAmount: num(SPLIT), orderId: hexToBin(run.orderId) };
const orderLock = binToHex(compile("plusLockingBytecode", { bytecode: termBytes })), pausedLock = binToHex(compile("pausedLockingBytecode", { bytecode: termBytes }));
const addr = (h) => lockingBytecodeToCashAddress({ bytecode: hexToBin(h), prefix: "bchtest" }).address;
log("template", so.slice(0, 12), "| subscriber (XO wallet)", addr(walletLock), "| order", addr(orderLock), "| paused", addr(pausedLock));

const ec = new ElectrumClient("standing-order-xo", "1.4.1", "chipnet.imaginary.cash"); await ec.connect();
const coinsAt = async (lockHex) => (await ec.request("blockchain.scripthash.listunspent", binToHex(sha256.hash(hexToBin(lockHex)).reverse()))).filter((u) => !u.token_data);
const tip = async () => (await ec.request("blockchain.headers.get_tip"))?.height;
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const waitFor = async (what, fn, every = 30000, max = 3600000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > max) throw new Error("timeout: " + what); await sleep(every); } };
const id = (inv) => inv.invitation.invitationIdentifier;
const vars = (role, extra = {}) => [...Object.entries(TERMS), ...Object.entries(extra)].map(([k, v]) => ({ variableIdentifier: k, roleIdentifier: role, value: v }));

async function finish(n, action, inv, covenantIndex = 0) {
  const own = await e.listOwnInputIndexes(id(inv));
  for (const i of new Set([...own, covenantIndex].filter((x) => x !== null))) inv = await e.signInvitation(id(inv), i);
  let r;
  for (let attempt = 1; ; attempt++) {
    try { r = await e.executeAction(id(inv), { broadcastTransaction: true }); break; }
    catch (err) {
      const msg = String(err.message) + " " + String(err.cause ?? "");
      log(action, "broadcast refused (attempt " + attempt + "):", msg.slice(0, 200));
      if (attempt >= 20 || !/BIP68/.test(msg)) throw err;
      await sleep(60000);
    }
  }
  const ser = r.builtTransaction?.serializedTransaction;
  const txid = binToHex(sha256.hash(sha256.hash(hexToBin(ser))).reverse());
  const tx = decodeTransactionBch(hexToBin(ser));
  const stored = await e.getInvitation(id(inv));
  const file = `${n}-${action}.xo.json`;
  fs.writeFileSync(new URL(file, DIR), serializeInvitation(stored.invitation) + "\n");
  run.steps.push({ n, action, txid, invitation: "invitations-plus/" + file, inputs: tx.inputs.length, outputs: tx.outputs.map((o) => [addr(binToHex(o.lockingBytecode)), String(o.valueSatoshis)]), at: new Date().toISOString() }); save();
  log(action.toUpperCase(), txid, "| saved", file);
  return txid;
}
// the subscriber's own coin at the wallet's first address, added LAST (the contract's authorization), plus change back to that address
async function addAuth(inv, { change = true } = {}) {
  const coin = await waitFor("a coin at the subscriber address", async () => (await coinsAt(walletLock)).sort((a, b) => a.value - b.value).find((c) => c.value >= 2000));
  inv = await e.appendInvitation(id(inv), { inputs: [{ outpointTransactionHash: hexToBin(coin.tx_hash), outpointIndex: coin.tx_pos }] });
  // The authorizing coin comes back whole to the subscriber's address; the covenant output already leaves maxFee for the miners.
  // (addChangeToInvitation would treat that maxFee as spare and return it, leaving too little fee for a ~1.4 kB covenant spend.)
  if (change) inv = await e.appendInvitation(id(inv), { outputs: [{ lockingBytecode: hexToBin(walletLock), valueSatoshis: BigInt(coin.value) }] });
  return { inv, coin };
}
// The engine only spends coins of scripts it tracks, and it starts tracking a script when an invitation is CREATED with an
// output that pays it. A restarted engine has forgotten the order, so before spending a covenant coin we create (and never
// execute) a draft invitation whose output is that covenant; the draft is archived right away.
async function track(action, outputIdentifier, lockHex, extra) {
  const draft = await e.createInvitation({ templateIdentifier: so, actionIdentifier: action, roleIdentifier: action === "claim" ? "service" : "subscriber",
    variables: vars(action === "claim" ? "service" : "subscriber", extra), outputs: [{ outputIdentifier, lockingBytecode: hexToBin(lockHex) }] });
  await e.archiveInvitation(id(draft));
}
const covenantCoin = async (lockHex, minAge = 0) => waitFor("covenant coin", async () => {
  const [c] = await coinsAt(lockHex); if (!c || c.height <= 0) return null;
  return (await tip()) >= c.height + minAge ? c : null;
});
const done = (a) => run.steps.some((s) => s.action === a);

try {
  if (!done("fund")) {
    await waitFor("wallet coins", async () => (await e.listSpendableUnspentOutputs({ templateIdentifier: p2 })).length > 0, 15000, 600000);
    const coins = (await e.listSpendableUnspentOutputs({ templateIdentifier: p2 })).sort((a, b) => Number(b.valueSatoshis) - Number(a.valueSatoshis));
    let inv = await e.createInvitation({ templateIdentifier: so, actionIdentifier: "fund", roleIdentifier: "subscriber" });
    inv = await e.appendInvitation(id(inv), { variables: vars("subscriber", { fundSatoshis: FUND }), outputs: [{ outputIdentifier: "orderFunding", roleIdentifier: "subscriber" }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ outpointTransactionHash: hexToBin(coins[0].outpointTransactionHash), outpointIndex: coins[0].outpointIndex }] });
    inv = await e.addChangeToInvitation(id(inv), walletLock);
    await finish(1, "fund", inv, null);
  }
  if (!done("claim")) {
    const c = await covenantCoin(orderLock, PER + 1);
    let inv = await e.createInvitation({ templateIdentifier: so, actionIdentifier: "claim", roleIdentifier: "service" });
    inv = await e.appendInvitation(id(inv), { variables: vars("service", { orderSatoshis: BigInt(c.value) }),
      outputs: [{ outputIdentifier: "merchantPayment", roleIdentifier: "service" }, { outputIdentifier: "splitPayment", roleIdentifier: "service" },
        { outputIdentifier: "orderChange", roleIdentifier: "service", lockingBytecode: hexToBin(orderLock) }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ inputIdentifier: "orderClaimInput", roleIdentifier: "service", outpointTransactionHash: hexToBin(c.tx_hash), outpointIndex: c.tx_pos }] });
    await finish(2, "claim", inv);
  }
  if (!done("pause")) {
    const c = await covenantCoin(orderLock, 0);
    await track("claim", "orderChange", orderLock, { orderSatoshis: BigInt(c.value) });
    let inv = await e.createInvitation({ templateIdentifier: so, actionIdentifier: "pause", roleIdentifier: "subscriber" });
    inv = await e.appendInvitation(id(inv), { variables: vars("subscriber", { orderSatoshis: BigInt(c.value) }),
      outputs: [{ outputIdentifier: "merchantPayment", roleIdentifier: "subscriber" }, { outputIdentifier: "splitPayment", roleIdentifier: "subscriber" },
        { outputIdentifier: "pausedOrder", roleIdentifier: "subscriber", lockingBytecode: hexToBin(pausedLock) }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ inputIdentifier: "orderPauseInput", roleIdentifier: "subscriber", outpointTransactionHash: hexToBin(c.tx_hash), outpointIndex: c.tx_pos }] });
    ({ inv } = await addAuth(inv));
    await finish(3, "pause", inv);
  }
  if (!done("resume")) {
    const c = await covenantCoin(pausedLock, 0);
    await track("pause", "pausedOrder", pausedLock, { orderSatoshis: BigInt(c.value) });
    let inv = await e.createInvitation({ templateIdentifier: so, actionIdentifier: "resume", roleIdentifier: "subscriber" });
    inv = await e.appendInvitation(id(inv), { variables: vars("subscriber", { pausedSatoshis: BigInt(c.value) }),
      outputs: [{ outputIdentifier: "resumedOrder", roleIdentifier: "subscriber", lockingBytecode: hexToBin(orderLock) }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ inputIdentifier: "pausedResumeInput", roleIdentifier: "subscriber", outpointTransactionHash: hexToBin(c.tx_hash), outpointIndex: c.tx_pos }] });
    ({ inv } = await addAuth(inv));
    await finish(4, "resume", inv);
  }
  if (!done("cancel")) {
    const c = await covenantCoin(orderLock, 0);
    await track("claim", "orderChange", orderLock, { orderSatoshis: BigInt(c.value) });
    const auth = (await coinsAt(walletLock)).sort((a, b) => a.value - b.value).find((x) => x.value >= 2000);
    let inv = await e.createInvitation({ templateIdentifier: so, actionIdentifier: "cancel", roleIdentifier: "subscriber" });
    inv = await e.appendInvitation(id(inv), { variables: vars("subscriber", { orderSatoshis: BigInt(c.value), authSatoshis: BigInt(auth.value) }),
      outputs: [{ outputIdentifier: "subscriberRefund", roleIdentifier: "subscriber" }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ inputIdentifier: "orderCancelInput", roleIdentifier: "subscriber", outpointTransactionHash: hexToBin(c.tx_hash), outpointIndex: c.tx_pos }] });
    inv = await e.appendInvitation(id(inv), { inputs: [{ outpointTransactionHash: hexToBin(auth.tx_hash), outpointIndex: auth.tx_pos }] });
    await finish(5, "cancel", inv);
  }
  log("done", JSON.stringify(run.steps.map((s) => [s.action, s.txid])));
} catch (err) { log("ERROR", String(err?.message || err).slice(0, 800)); process.exitCode = 3; }
await ec.disconnect(true); await e.stop(); process.exit(process.exitCode || 0);
