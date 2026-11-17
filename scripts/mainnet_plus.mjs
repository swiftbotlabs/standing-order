// MAINNET run of StandingOrderPlus + PausedOrder with real BCH (tiny amounts, all payees are our own keys).
// usage: node scripts/mainnet_plus.mjs status | simulate | simulate-plan | fund [sats] | claim | pause | resume | topup | changeplan | cancel   [--dry] [--plan2]
//   --dry      build + VM-evaluate (debug()) against the live chain state, print the tx size and fee, do NOT broadcast
//   simulate   walk the whole lifecycle offline (fund -> claim -> pause -> resume -> refused claim -> topup -> claim -> cancel)
//              on virtual coins chained from each built tx, every step VM-evaluated; nothing is broadcast
//   simulate-plan  the same for a plan change: fund -> claim -> changeplan -> claim on plan 2 -> cancel plan 2
//   changeplan moves the live order's whole balance to PLAN 2 (double price, order id MAINNET2), signed by merchant AND subscriber
//   --hex      with --dry: write the raw tx hex to HEX_OUT (default claim_raw.hex) for broadcast by anyone, anywhere
//   --plan2    status / claim / pause / resume / topup / cancel act on the plan-2 order instead
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
const addr = (pub, tok) => { const r = encodeCashAddress({ prefix: "bitcoincash", type: tok ? "p2pkhWithTokens" : "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };

const AMOUNT = 10_000n, SPLIT = 1_000n, PERIOD = 1n, MAXFEE = 2_000n;                 // 1 block per period; ~5 US cents a period
const ORDER_ID = Uint8Array.from(Buffer.from(process.env.ORDER_ID || "4d41494e4e455431", "hex")); // "MAINNET1"
const provider = new ElectrumNetworkProvider("mainnet");
const AMOUNT2 = 20_000n, ORDER_ID2 = Uint8Array.from(Buffer.from(process.env.ORDER_ID2 || "4d41494e4e455432", "hex")); // plan 2: "MAINNET2"
const plusOrder = (amount, id) => new Contract(art("standing_order_plus"), [hash160(mer.pub), hash160(sub.pub), amount, PERIOD, MAXFEE, hash160(spl.pub), SPLIT, id], { provider });
const order1 = plusOrder(AMOUNT, ORDER_ID), order2 = plusOrder(AMOUNT2, ORDER_ID2);
const PLAN2 = process.argv.includes("--plan2");
let order = PLAN2 ? order2 : order1, PRICE = PLAN2 ? AMOUNT2 : AMOUNT;
let paused = new Contract(art("paused_order"), [hash160(sub.pub), hash256(hexToBin(order.bytecode))], { provider });
const LOG = process.env.PLUS_LOG || "mainnet_plus.log";
const log = (...a) => { const l = [new Date().toISOString(), ...a].join(" "); console.log(l); if (!DRY && !SIM) fs.appendFileSync(LOG, l + "\n"); };
const fmt = (u) => u.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}`).join(", ") || "none";
const args = process.argv.slice(2); const DRY = args.includes("--dry"); const [cmd, arg] = args.filter((a) => !a.startsWith("--"));
const SIM = cmd === "simulate" || cmd === "simulate-plan";
// --hex (with --dry): also write the signature-free raw claim to HEX_OUT so a third party can broadcast it with any tool
const HEX = args.includes("--hex"), HEX_OUT = process.env.HEX_OUT || "claim_raw.hex";
const txidOf = (hex) => binToHex(hash256(hexToBin(hex)).reverse());

// one step = a TransactionBuilder; dry/sim: VM-evaluate + report; live: broadcast
const run = async (label, b) => {
  try {
    if (DRY || SIM) {
      b.debug(); const hex = b.build(); const ins = b.inputs.reduce((s, i) => s + BigInt(i.satoshis), 0n);
      const outs = b.outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
      log(`${label} OK (not broadcast) size ${hex.length / 2} B fee ${ins - outs} sats outputs [${b.outputs.map((o) => o.amount).join(", ")}]`);
      if (HEX && !SIM) { fs.writeFileSync(HEX_OUT, hex + "\n"); console.log(`RAW TX HEX (${hex.length / 2} B, txid ${txidOf(hex)}) written to ${HEX_OUT}; anyone can broadcast it`); }
      return { txid: txidOf(hex), outs: b.outputs };
    }
    const r = await b.send(); log(label, r.txid, `https://blockchair.com/bitcoin-cash/transaction/${r.txid}`); return { txid: r.txid, outs: b.outputs };
  } catch (e) { log(label, "REJECTED:", String(e?.message || e).slice(0, 400)); process.exitCode = 3; return null; }
};
const subCoins = async () => (await provider.getUtxos(addr(sub.pub))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis));

const steps = {
  fund: (c, amt) => new TransactionBuilder({ provider }).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: amt }).addOutput({ to: addr(sub.pub), amount: c.satoshis - amt - 1_000n }),
  claim: (u) => { const per = PRICE + SPLIT; const change = u.satoshis - per - MAXFEE;
    let b = new TransactionBuilder({ provider }).addInput(u, order.unlock.claim(), { sequence: Number(PERIOD) });
    if (change < per + MAXFEE) return u.satoshis - MAXFEE >= per
      ? b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE - SPLIT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
      : b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE });
    return b.addOutput({ to: addr(mer.pub), amount: PRICE }).addOutput({ to: addr(spl.pub), amount: SPLIT }).addOutput({ to: order.address, amount: change }); },
  pause: (u, c) => new TransactionBuilder({ provider }).addInput(u, order.unlock.pause()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(mer.pub), amount: PRICE }).addOutput({ to: addr(spl.pub), amount: SPLIT })
    .addOutput({ to: paused.address, amount: u.satoshis - PRICE - SPLIT }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }),
  resume: (u, c) => new TransactionBuilder({ provider }).addInput(u, paused.unlock.resume()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: u.satoshis }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }),
  topup: (u, c) => { const per = PRICE + SPLIT, add = per + per + MAXFEE;
    return new TransactionBuilder({ provider }).addInput(u, order.unlock.topUp()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
      .addOutput({ to: addr(mer.pub), amount: PRICE }).addOutput({ to: addr(spl.pub), amount: SPLIT })
      .addOutput({ to: order.address, amount: u.satoshis - per + add }).addOutput({ to: addr(sub.pub), amount: c.satoshis - add - MAXFEE }); },
  // plan change: order coin first, a merchant coin second, a subscriber coin last; the whole balance moves to plan 2,
  // each party's coin comes back to it (the subscriber pays the fee)
  changeplan: (u, m, c) => new TransactionBuilder({ provider }).addInput(u, order1.unlock.changePlan())
    .addInput(m, new SignatureTemplate(mer.priv).unlockP2PKH()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order2.address, amount: u.satoshis }).addOutput({ to: addr(mer.pub), amount: m.satoshis })
    .addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }),
  cancel: (u, c, fromPaused) => new TransactionBuilder({ provider }).addInput(u, (fromPaused ? paused : order).unlock.cancel())
    .addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH()).addOutput({ to: addr(sub.pub), amount: u.satoshis + c.satoshis - MAXFEE }),
};

const usePlan = (n) => { order = n === 2 ? order2 : order1; PRICE = n === 2 ? AMOUNT2 : AMOUNT;
  paused = new Contract(art("paused_order"), [hash160(sub.pub), hash256(hexToBin(order.bytecode))], { provider }); };
const merCoins = async () => (await provider.getUtxos(addr(mer.pub))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis));
log(PLAN2 ? "PLAN 2" : "plan 1", "plan-2 order", order2.address);
log("order", order.address, "| paused", paused.address, "| subscriber", addr(sub.pub), "| merchant", addr(mer.pub), "| split", addr(spl.pub));
// the subscriber's BCH may sit on a token coin (PUSD change): send it to itself as the same token on a 1,000-sat coin + one plain BCH coin
const unwrapTx = async () => {
  const tc = (await provider.getUtxos(addr(sub.pub))).filter((x) => x.token && !x.token.nft).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!tc) throw new Error("no fungible-token coin to unwrap");
  return new TransactionBuilder({ provider }).addInput(tc, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(sub.pub, true), amount: 1_000n, token: tc.token })
    .addOutput({ to: addr(sub.pub), amount: tc.satoshis - 1_000n - 1_000n });
};
if (cmd === "unwrap") {
  if ((await subCoins()).some((x) => x.satoshis >= 100_000n)) throw new Error("a plain coin >= 100k sats already exists; nothing to unwrap");
  await run("UNWRAPPED", await unwrapTx());
} else if (cmd === "simulate-plan") {
  let c0 = (await subCoins()).find((x) => x.satoshis >= 100_000n);
  if (!c0) { const t = await run("SIM unwrap", await unwrapTx()); c0 = { txid: t.txid, vout: 1, satoshis: BigInt(t.outs[1].amount) }; }
  const m0 = (await merCoins())[0]; if (!c0 || !m0) throw new Error(`need a subscriber coin and a merchant coin (sub ${!!c0}, merchant ${!!m0})`);
  const vout = (tx, to) => { const i = tx.outs.findIndex((o) => o.to === to); return { txid: tx.txid, vout: i, satoshis: BigInt(tx.outs[i].amount) }; };
  usePlan(1);
  let t = await run("SIM fund", steps.fund(c0, BigInt(arg || "60000"))); let o = vout(t, order1.address), c = vout(t, addr(sub.pub));
  t = await run("SIM claim (plan 1)", steps.claim(o)); o = vout(t, order1.address);
  t = await run("SIM changeplan 1->2", steps.changeplan(o, m0, c)); o = vout(t, order2.address); c = vout(t, addr(sub.pub));
  usePlan(2);
  t = await run("SIM claim (plan 2)", steps.claim(o)); o = vout(t, order2.address);
  log("SIM plan-2 claim paid the merchant", t ? t.outs[0].amount : "n/a", "(plan 1 paid", String(AMOUNT) + ")");
  t = await run("SIM cancel (plan 2)", steps.cancel(o, c, false));
  log("SIM final subscriber refund", t ? t.outs[0].amount : "n/a");
} else if (SIM) {
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
  else if (cmd === "changeplan") { if (PLAN2) throw new Error("changeplan starts from plan 1 (drop --plan2)");
    if ((await order2.getUtxos()).length) throw new Error("plan 2 already holds a coin; refusing a second plan change");
    await run("PLAN_CHANGED", steps.changeplan(oU[0], (await merCoins())[0], cs[0])); }
  else if (cmd === "cancel") await run("CANCELLED", steps.cancel(oU[0] || pU[0], cs[0], !oU[0]));
  else throw new Error("unknown command");
}
process.exit();
