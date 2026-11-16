// MAINNET run of StandingOrderPlus + PausedOrder with real BCH (tiny amounts, all payees are our own keys).
// usage: node scripts/mainnet_plus.mjs status | simulate | fund [sats] | claim | pause | resume | topup | cancel   [--dry]
//   --dry      build + VM-evaluate (debug()) against the live chain state, print the tx size and fee, do NOT broadcast
//   simulate   walk the whole lifecycle offline (fund -> claim -> pause -> resume -> refused claim -> topup -> claim -> cancel)
//              on virtual coins chained from each built tx, every step VM-evaluated; nothing is broadcast
// Keys: BLAZE wizard seed (SEED_FILE, never printed). Subscriber = the wizard wallet's receive key m/44'/145'/0'/0/0
// (bitcoincash:qrddpp..xaza, which holds the BCH), merchant m/44'/145'/0'/9/1, split payee 9/2 (all ours).
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, hash256, hexToBin, binToHex, encodeCashAddress } from "@bitauth/libauth";
import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const art = (f) => JSON.parse(fs.readFileSync(new URL(`../artifacts/solidcash/${f}.json`, import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (p) => { const n = deriveHdPathRelative(acct, p, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const sub = key("0/0"), mer = key("9/1"), spl = key("9/2");
const addr = (pub) => { const r = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };

const AMOUNT = 10_000n, SPLIT = 1_000n, PERIOD = 1n, MAXFEE = 2_000n;                 // 1 block per period; ~5 US cents a period
const ORDER_ID = Uint8Array.from(Buffer.from(process.env.ORDER_ID || "4d41494e4e455431", "hex")); // "MAINNET1"
const provider = new ElectrumNetworkProvider("mainnet");
const order = new Contract(art("standing_order_plus"), [hash160(mer.pub), hash160(sub.pub), AMOUNT, PERIOD, MAXFEE, hash160(spl.pub), SPLIT, ORDER_ID], { provider });
const paused = new Contract(art("paused_order"), [hash160(sub.pub), hash256(hexToBin(order.bytecode))], { provider });
const LOG = process.env.PLUS_LOG || "mainnet_plus.log";
const log = (...a) => { const l = [new Date().toISOString(), ...a].join(" "); console.log(l); if (!DRY && !SIM) fs.appendFileSync(LOG, l + "\n"); };
const fmt = (u) => u.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}`).join(", ") || "none";
const args = process.argv.slice(2); const DRY = args.includes("--dry"); const [cmd, arg] = args.filter((a) => !a.startsWith("--"));
const SIM = cmd === "simulate";
const txidOf = (hex) => binToHex(hash256(hexToBin(hex)).reverse());

// one step = a TransactionBuilder; dry/sim: VM-evaluate + report; live: broadcast
const run = async (label, b) => {
  try {
    if (DRY || SIM) {
      b.debug(); const hex = b.build(); const ins = b.inputs.reduce((s, i) => s + BigInt(i.satoshis), 0n);
      const outs = b.outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
      log(`${label} OK (not broadcast) size ${hex.length / 2} B fee ${ins - outs} sats outputs [${b.outputs.map((o) => o.amount).join(", ")}]`);
      return { txid: txidOf(hex), outs: b.outputs };
    }
    const r = await b.send(); log(label, r.txid, `https://blockchair.com/bitcoin-cash/transaction/${r.txid}`); return { txid: r.txid, outs: b.outputs };
  } catch (e) { log(label, "REJECTED:", String(e?.message || e).slice(0, 400)); process.exitCode = 3; return null; }
};
const subCoins = async () => (await provider.getUtxos(addr(sub.pub))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis));

const steps = {
  fund: (c, amt) => new TransactionBuilder({ provider }).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: amt }).addOutput({ to: addr(sub.pub), amount: c.satoshis - amt - 1_000n }),
  claim: (u) => { const per = AMOUNT + SPLIT; const change = u.satoshis - per - MAXFEE;
    let b = new TransactionBuilder({ provider }).addInput(u, order.unlock.claim(), { sequence: Number(PERIOD) });
    if (change < per + MAXFEE) return u.satoshis - MAXFEE >= per
      ? b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE - SPLIT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
      : b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE });
    return b.addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT }).addOutput({ to: order.address, amount: change }); },
  pause: (u, c) => new TransactionBuilder({ provider }).addInput(u, order.unlock.pause()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
    .addOutput({ to: paused.address, amount: u.satoshis - AMOUNT - SPLIT }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }),
  resume: (u, c) => new TransactionBuilder({ provider }).addInput(u, paused.unlock.resume()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: u.satoshis }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }),
  topup: (u, c) => { const per = AMOUNT + SPLIT, add = per + per + MAXFEE;
    return new TransactionBuilder({ provider }).addInput(u, order.unlock.topUp()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
      .addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
      .addOutput({ to: order.address, amount: u.satoshis - per + add }).addOutput({ to: addr(sub.pub), amount: c.satoshis - add - MAXFEE }); },
  cancel: (u, c, fromPaused) => new TransactionBuilder({ provider }).addInput(u, (fromPaused ? paused : order).unlock.cancel())
    .addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH()).addOutput({ to: addr(sub.pub), amount: u.satoshis + c.satoshis - MAXFEE }),
};

log("order", order.address, "| paused", paused.address, "| subscriber", addr(sub.pub), "| merchant", addr(mer.pub), "| split", addr(spl.pub));
if (SIM) {
  // virtual coins: start from the real subscriber coin, then chain each built tx's outputs
  const c0 = (await subCoins())[0]; if (!c0) throw new Error("subscriber has no plain BCH coin");
  const vout = (tx, to) => { const i = tx.outs.findIndex((o) => o.to === to); return { txid: tx.txid, vout: i, satoshis: BigInt(tx.outs[i].amount) }; };
  const amt = BigInt(arg || "60000");
  let t = await run("SIM fund", steps.fund(c0, amt)); let o = vout(t, order.address), c = vout(t, addr(sub.pub));
  t = await run("SIM claim", steps.claim(o)); o = vout(t, order.address);
  t = await run("SIM pause", steps.pause(o, c)); const p = vout(t, paused.address); c = vout(t, addr(sub.pub));
  t = await run("SIM resume", steps.resume(p, c)); o = vout(t, order.address); c = vout(t, addr(sub.pub));
  t = await run("SIM topup", steps.topup(o, c)); o = vout(t, order.address); c = vout(t, addr(sub.pub));
  t = await run("SIM claim2", steps.claim(o)); o = vout(t, order.address);
  t = await run("SIM cancel", steps.cancel(o, c, false));
  log("SIM final subscriber refund", t ? t.outs[0].amount : "n/a");
} else if (cmd === "status") {
  const oU = await order.getUtxos(), pU = await paused.getUtxos();
  log("height", await provider.getBlockHeight(), "| order utxos:", fmt(oU), "| paused utxos:", fmt(pU));
  for (const [n, k] of [["subscriber", sub], ["merchant", mer], ["split", spl]]) log(n, addr(k.pub), fmt(await provider.getUtxos(addr(k.pub))));
} else {
  const oU = await order.getUtxos(), pU = await paused.getUtxos(); const cs = await subCoins();
  log("order utxos:", fmt(oU), "| paused utxos:", fmt(pU), "| subscriber coins:", fmt(cs));
  if (cmd === "fund") { if (oU.length || pU.length) throw new Error("order already funded; refusing a second fund"); await run("FUNDED", steps.fund(cs[0], BigInt(arg || "60000"))); }
  else if (cmd === "claim") await run("CLAIMED", steps.claim(oU[0]));
  else if (cmd === "pause") await run("PAUSED", steps.pause(oU[0], cs[0]));
  else if (cmd === "resume") await run("RESUMED", steps.resume(pU[0], cs[0]));
  else if (cmd === "topup") await run("TOPPED_UP", steps.topup(oU[0], cs[0]));
  else if (cmd === "cancel") await run("CANCELLED", steps.cancel(oU[0] || pU[0], cs[0], !oU[0]));
  else throw new Error("unknown command");
}
process.exit();
