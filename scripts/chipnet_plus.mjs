// Chipnet live run of StandingOrderPlus + PausedOrder (test coins only).
// usage: node scripts/chipnet_plus.mjs status | fund <sats> | claim | pause | resume | topup | cancel
// Keys: BLAZE test seed (SEED_FILE, never printed); subscriber m/44'/145'/0'/9/0, merchant 9/1, split payee 9/2.
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, hash256, hexToBin, encodeCashAddress } from "@bitauth/libauth";
import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const art = (f) => JSON.parse(fs.readFileSync(new URL(`../artifacts/solidcash/${f}.json`, import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (i) => { const n = deriveHdPathRelative(acct, `9/${i}`, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const sub = key(0), mer = key(1), spl = key(2);
const addr = (pub) => { const r = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };

const AMOUNT = 10_000n, SPLIT = 1_000n, PERIOD = 1n, MAXFEE = 2_000n;
const ORDER_ID = Uint8Array.from(Buffer.from(process.env.ORDER_ID || "0303030303030303", "hex"));
const provider = new ElectrumNetworkProvider("chipnet");
const order = new Contract(art("standing_order_plus"), [hash160(mer.pub), hash160(sub.pub), AMOUNT, PERIOD, MAXFEE, hash160(spl.pub), SPLIT, ORDER_ID], { provider });
const paused = new Contract(art("paused_order"), [hash160(sub.pub), hash256(hexToBin(order.bytecode))], { provider });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt = (u) => u.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}`).join(", ") || "none";
const ownCoin = async () => {
  const c = (await provider.getUtxos(addr(sub.pub))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!c) throw new Error("subscriber has no plain BCH coin"); return c;
};
const send = async (label, b) => { try { const r = await b.send(); log(label, r.txid); } catch (e) { log(label, "REJECTED:", String(e?.message || e).slice(0, 400)); process.exitCode = 3; } };

const [cmd, arg] = process.argv.slice(2);
const oU = await order.getUtxos(), pU = await paused.getUtxos();
log("order", order.address, "| paused", paused.address, "| height", await provider.getBlockHeight());
log("order utxos:", fmt(oU), "| paused utxos:", fmt(pU));
if (cmd === "status") {
  for (const [n, k] of [["subscriber", sub], ["merchant", mer], ["split", spl]]) log(n, addr(k.pub), fmt(await provider.getUtxos(addr(k.pub))));
} else if (cmd === "fund") {
  const amt = BigInt(arg || "60000"); const c = await ownCoin();
  await send("FUNDED", new TransactionBuilder({ provider }).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: amt }).addOutput({ to: addr(sub.pub), amount: c.satoshis - amt - 1_000n }));
} else if (cmd === "claim") {
  const u = oU[0]; const per = AMOUNT + SPLIT; const change = u.satoshis - per - MAXFEE;
  let b = new TransactionBuilder({ provider }).addInput(u, order.unlock.claim(), { sequence: Number(PERIOD) });
  if (change < per + MAXFEE) b = u.satoshis - MAXFEE >= per
    ? b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE - SPLIT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
    : b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE });
  else b = b.addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT }).addOutput({ to: order.address, amount: change });
  await send("CLAIMED", b);
} else if (cmd === "pause") {
  const u = oU[0], c = await ownCoin();
  await send("PAUSED", new TransactionBuilder({ provider }).addInput(u, order.unlock.pause()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT })   // pause pays the period in progress
    .addOutput({ to: paused.address, amount: u.satoshis - AMOUNT - SPLIT }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }));
} else if (cmd === "resume") {
  const u = pU[0], c = await ownCoin();
  await send("RESUMED", new TransactionBuilder({ provider }).addInput(u, paused.unlock.resume()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: order.address, amount: u.satoshis }).addOutput({ to: addr(sub.pub), amount: c.satoshis - MAXFEE }));
} else if (cmd === "topup") {
  const u = oU[0], c = await ownCoin(); const per = AMOUNT + SPLIT, add = per + per + MAXFEE;   // pays this period + adds one
  await send("TOPPED_UP", new TransactionBuilder({ provider }).addInput(u, order.unlock.topUp()).addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: addr(spl.pub), amount: SPLIT })
    .addOutput({ to: order.address, amount: u.satoshis - per + add }).addOutput({ to: addr(sub.pub), amount: c.satoshis - add - MAXFEE }));
} else if (cmd === "cancel") {
  const u = oU[0] || pU[0]; const fromPaused = !oU[0]; const c = await ownCoin();
  await send("CANCELLED", new TransactionBuilder({ provider }).addInput(u, (fromPaused ? paused : order).unlock.cancel())
    .addInput(c, new SignatureTemplate(sub.priv).unlockP2PKH()).addOutput({ to: addr(sub.pub), amount: u.satoshis + c.satoshis - MAXFEE }));
}
process.exit();
