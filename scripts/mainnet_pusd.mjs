// MAINNET run of the TOKEN Standing Order priced in PUSD (ParyonUSD, 2 decimals per its BCMR), tiny amounts, our own keys only.
// usage: node scripts/mainnet_pusd.mjs status | fund | claim | cancel   [--dry]
//   --dry   build + VM-evaluate (debug()) against the live chain state and print size/fee; nothing is broadcast
// Plan: 0.01 PUSD (1 base unit) every block, 3 periods prepaid; the covenant keeps a small BCH pool for claim fees.
// Keys: BLAZE wizard seed (SEED_FILE, never printed). Subscriber m/44'/145'/0'/0/0 (holds the BCH and must hold >= 3 PUSD units),
// merchant m/44'/145'/0'/9/1 (ours). The contract compares tokenCategory in the reversed byte order (SolidCash finding 4).
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress, hexToBin } from "@bitauth/libauth";
import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";   // decimals 2 (BCMR: Paytaca indexer, checked 2026-11-17)
const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order_token.json", import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (p) => { const n = deriveHdPathRelative(acct, p, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const sub = key("0/0"), mer = key("9/1");
const enc = (pub, tokens) => { const r = encodeCashAddress({ prefix: "bitcoincash", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };
const PER = 1n, PERIODS = 3n, PERIOD = 1n, DUST = 1_000n, MAXFEE = 1_000n;
const ORDER_ID = Uint8Array.from(Buffer.from(process.env.ORDER_ID || "5055534431303031", "hex"));   // "PUSD1001"
const provider = new ElectrumNetworkProvider("mainnet");
const LOG = process.env.PUSD_LOG || "mainnet_pusd.log";
const args = process.argv.slice(2); const DRY = args.includes("--dry"); const [cmd] = args.filter((a) => !a.startsWith("--"));
const log = (...a) => { const l = [new Date().toISOString(), ...a].join(" "); console.log(l); if (!DRY) fs.appendFileSync(LOG, l + "\n"); };
const show = (us) => us.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}${x.token ? ` +${x.token.amount} ${x.token.category === PUSD ? "PUSD-units" : "tok"}` : ""}`).join(", ") || "none";
const contract = new Contract(artifact, [hash160(mer.pub), hash160(sub.pub), hexToBin(PUSD).reverse(), PER, PERIOD, DUST, MAXFEE, ORDER_ID], { provider });

const run = async (label, b) => {
  try {
    if (DRY) { b.debug(); const hex = b.build(); log(`${label} OK (not broadcast) size ${hex.length / 2} B`); return; }
    const r = await b.send(); log(label, r.txid, `https://blockchair.com/bitcoin-cash/transaction/${r.txid}`);
  } catch (e) { log(label, "REJECTED:", String(e?.message || e).slice(0, 300)); process.exitCode = 3; }
};

log("PUSD order", contract.tokenAddress, "| subscriber", enc(sub.pub), "| merchant", enc(mer.pub), DRY ? "| DRY" : "");
const cu = (await contract.getUtxos()).filter((x) => x.token?.category === PUSD);
log("order coins:", show(cu));
if (cmd === "status") {
  log("subscriber:", show(await provider.getUtxos(enc(sub.pub))));
  log("merchant:", show(await provider.getUtxos(enc(mer.pub))));
} else if (cmd === "fund") {
  const all = await provider.getUtxos(enc(sub.pub));
  const tok = all.filter((x) => x.token?.category === PUSD && !x.token.nft).sort((a, b) => Number(b.token.amount - a.token.amount))[0];
  const bch = all.filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!tok || tok.token.amount < PER * PERIODS) throw new Error(`need >= ${PER * PERIODS} PUSD units at ${enc(sub.pub)} (have ${tok?.token.amount ?? 0n})`);
  if (!bch) throw new Error("need a plain BCH coin for the fee pool");
  const pool = DUST + (PERIODS + 1n) * MAXFEE;   // pays every claim's fee and the last claim's dust
  let b = new TransactionBuilder({ provider })
    .addInput(tok, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addInput(bch, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: contract.tokenAddress, amount: pool, token: { category: PUSD, amount: PER * PERIODS } });
  if (tok.token.amount > PER * PERIODS) b = b.addOutput({ to: enc(sub.pub, true), amount: DUST, token: { category: PUSD, amount: tok.token.amount - PER * PERIODS } });
  const used = pool + (tok.token.amount > PER * PERIODS ? DUST : 0n) + 1_500n;
  b = b.addOutput({ to: enc(sub.pub), amount: tok.satoshis + bch.satoshis - used });
  await run("FUNDED", b);
} else if (cmd === "claim") {
  const u = cu[0]; if (!u) throw new Error("no PUSD order coin");
  const left = u.token.amount;
  let b = new TransactionBuilder({ provider }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) });
  if (left <= PER) b = b.addOutput({ to: enc(mer.pub, true), amount: u.satoshis - MAXFEE, token: { category: PUSD, amount: left } });
  else b = b.addOutput({ to: enc(mer.pub, true), amount: DUST, token: { category: PUSD, amount: PER } })
    .addOutput({ to: contract.tokenAddress, amount: u.satoshis - DUST - MAXFEE, token: { category: PUSD, amount: left - PER } });
  await run("CLAIMED", b);
} else if (cmd === "cancel") {
  const u = cu[0]; if (!u) throw new Error("no PUSD order coin");
  const own = (await provider.getUtxos(enc(sub.pub))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!own) throw new Error("subscriber has no plain BCH coin to authorize the cancel");
  await run("CANCELLED", new TransactionBuilder({ provider })
    .addInput(u, contract.unlock.cancel())
    .addInput(own, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: enc(sub.pub, true), amount: u.satoshis + own.satoshis - MAXFEE, token: { category: PUSD, amount: u.token.amount } }));
} else {
  console.log("usage: node scripts/mainnet_pusd.mjs status | fund | claim | cancel [--dry]");
}
try { await provider.disconnect?.(); } catch {}
process.exit(process.exitCode || 0);
