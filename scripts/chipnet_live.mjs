// Chipnet live run of the BCH Standing Order (test coins only).
// usage: node scripts/chipnet_live.mjs status | fund <sats> | claim | cancel
// Keys: BLAZE test seed (secrets/blaze_wizard_seed.hex, never printed); subscriber m/44'/145'/0'/9/0, merchant .../9/1.
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress } from "@bitauth/libauth";
import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order.json", import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (i) => { const n = deriveHdPathRelative(acct, `9/${i}`, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const sub = key(0), mer = key(1);
const addr = (pub) => { const r = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };

const AMOUNT = 20_000n, PERIOD = 1n, MAXFEE = 1_000n;   // 1-block period for the test
const ORDER_ID = Uint8Array.from(Buffer.from(process.env.ORDER_ID || "0102030405060708", "hex"));
const provider = new ElectrumNetworkProvider("chipnet");
const contract = new Contract(artifact, [hash160(mer.pub), hash160(sub.pub), AMOUNT, PERIOD, MAXFEE, ORDER_ID], { provider });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt = (u) => u.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}`).join(", ") || "none";

const [cmd, arg] = process.argv.slice(2);
log("contract", contract.address, "| subscriber", addr(sub.pub), "| merchant", addr(mer.pub), "| height", await provider.getBlockHeight());
const cUtxos = await contract.getUtxos();
log("contract utxos:", fmt(cUtxos));
if (cmd === "status") {
  log("subscriber utxos:", fmt(await provider.getUtxos(addr(sub.pub))));
  log("merchant utxos:", fmt(await provider.getUtxos(addr(mer.pub))));
} else if (cmd === "fund") {
  const amt = BigInt(arg || "200000");
  const utxos = (await provider.getUtxos(addr(sub.pub))).filter((u) => !u.token);
  const total = utxos.reduce((a, u) => a + u.satoshis, 0n);
  let b = new TransactionBuilder({ provider });
  for (const u of utxos) b = b.addInput(u, new SignatureTemplate(sub.priv).unlockP2PKH());
  const fee = 1_000n;
  b = b.addOutput({ to: contract.address, amount: amt }).addOutput({ to: addr(sub.pub), amount: total - amt - fee });
  const r = await b.send();
  log("FUNDED", r.txid);
} else if (cmd === "claim") {
  const u = cUtxos[0];
  if (!u) throw new Error("no contract utxo");
  const change = u.satoshis - AMOUNT - MAXFEE;
  let b = new TransactionBuilder({ provider }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) });
  if (change < AMOUNT + MAXFEE) b = b.addOutput({ to: addr(mer.pub), amount: u.satoshis - MAXFEE });
  else b = b.addOutput({ to: addr(mer.pub), amount: AMOUNT }).addOutput({ to: contract.address, amount: change });
  try { const r = await b.send(); log("CLAIMED", r.txid); }
  catch (e) { log("CLAIM REJECTED:", String(e?.message || e).slice(0, 400)); process.exitCode = 3; }
} else if (cmd === "cancel") {
  const u = cUtxos[0];
  if (!u) throw new Error("no contract utxo");
  // Authorization: a coin from the subscriber's own address, spent as the last input.
  const own = (await provider.getUtxos(addr(sub.pub))).filter((x) => !x.token)[0];
  if (!own) throw new Error("subscriber has no plain BCH coin to authorize the cancel");
  const r = await new TransactionBuilder({ provider })
    .addInput(u, contract.unlock.cancel())
    .addInput(own, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: addr(sub.pub), amount: u.satoshis + own.satoshis - MAXFEE })
    .send();
  log("CANCELLED", r.txid);
}
try { await provider.disconnect?.(); } catch {}
process.exit(process.exitCode || 0);
