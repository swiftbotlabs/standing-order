// Chipnet live run of the TOKEN Standing Order (a test fungible token standing in for PUSD).
// usage: node scripts/chipnet_token_live.mjs genesis | status | fund | claim | cancel
// state (token category, no keys) in scripts/token_state.json. Test coins only.
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress, hexToBin } from "@bitauth/libauth";
import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const STATE = new URL("./token_state.json", import.meta.url);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : {};
const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order_token.json", import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (i) => { const n = deriveHdPathRelative(acct, `9/${i}`, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const sub = key(0), mer = key(1);
const enc = (pub, tokens) => { const r = encodeCashAddress({ prefix: "bchtest", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };
const PER = 500n, PERIOD = 1n, DUST = 1_000n, MAXFEE = 1_000n;
const provider = new ElectrumNetworkProvider("chipnet");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const [cmd] = process.argv.slice(2);

if (cmd === "genesis") {
  const u = (await provider.getUtxos(enc(sub.pub))).find((x) => !x.token && x.vout === 0 && x.satoshis >= 20_000n);
  if (!u) throw new Error("need a vout-0 BCH utxo for token genesis");
  const r = await new TransactionBuilder({ provider })
    .addInput(u, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: enc(sub.pub, true), amount: 2_000n, token: { category: u.txid, amount: 1_000_000n } })
    .addOutput({ to: enc(sub.pub), amount: u.satoshis - 2_000n - 1_000n })
    .send();
  fs.writeFileSync(STATE, JSON.stringify({ category: u.txid, genesis: r.txid }, null, 2));
  log("GENESIS", r.txid, "category", u.txid);
  process.exit(0);
}
if (!state.category) throw new Error("run genesis first");
// NOTE (finding 4): the contract compares tokenCategory in the opposite byte order to the SDK's hex.
const contract = new Contract(artifact, [hash160(mer.pub), hash160(sub.pub), hexToBin(state.category).reverse(), PER, PERIOD, DUST, MAXFEE, Uint8Array.from(Buffer.from(process.env.ORDER_ID || "0102030405060708", "hex"))], { provider });
log("contract", contract.tokenAddress, "| category", state.category.slice(0, 12), "| height", await provider.getBlockHeight());
const cu = await contract.getUtxos();
const show = (us) => us.map((x) => `${x.txid.slice(0, 10)}:${x.vout} ${x.satoshis}${x.token ? ` +${x.token.amount}tok` : ""}`).join(", ") || "none";
log("contract utxos:", show(cu));

if (cmd === "status") {
  log("subscriber:", show(await provider.getUtxos(enc(sub.pub))));
  log("merchant:", show(await provider.getUtxos(enc(mer.pub))));
} else if (cmd === "fund") {
  const all = await provider.getUtxos(enc(sub.pub));
  const tok = all.find((x) => x.token?.category === state.category);
  const bch = all.filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!tok || !bch) throw new Error("need a token utxo and a BCH utxo");
  const fundTokens = 1_500n;   // three periods of 500
  const r = await new TransactionBuilder({ provider })
    .addInput(tok, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addInput(bch, new SignatureTemplate(sub.priv).unlockP2PKH())
    .addOutput({ to: contract.tokenAddress, amount: 10_000n, token: { category: state.category, amount: fundTokens } })
    .addOutput({ to: enc(sub.pub, true), amount: 1_000n, token: { category: state.category, amount: tok.token.amount - fundTokens } })
    .addOutput({ to: enc(sub.pub), amount: tok.satoshis + bch.satoshis - 10_000n - 1_000n - 1_500n })
    .send();
  log("FUNDED", r.txid);
} else if (cmd === "claim") {
  const u = cu[0]; if (!u) throw new Error("no contract utxo");
  const left = u.token.amount;
  let b = new TransactionBuilder({ provider }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) });
  if (left <= PER) b = b.addOutput({ to: enc(mer.pub, true), amount: u.satoshis - MAXFEE, token: { category: state.category, amount: left } });
  else b = b.addOutput({ to: enc(mer.pub, true), amount: DUST, token: { category: state.category, amount: PER } })
            .addOutput({ to: contract.tokenAddress, amount: u.satoshis - DUST - MAXFEE, token: { category: state.category, amount: left - PER } });
  try { const r = await b.send(); log("CLAIMED", r.txid); } catch (e) { log("CLAIM REJECTED:", String(e?.message || e).slice(0, 300)); process.exitCode = 3; }
} else if (cmd === "cancel") {
  const u = cu[0]; if (!u) throw new Error("no contract utxo");
  const r = await new TransactionBuilder({ provider })
    .addInput(u, contract.unlock.cancel(sub.pub, new SignatureTemplate(sub.priv)))
    .addOutput({ to: enc(sub.pub, true), amount: u.satoshis - MAXFEE, token: { category: state.category, amount: u.token.amount } })
    .send();
  log("CANCELLED", r.txid);
}
try { await provider.disconnect?.(); } catch {}
process.exit(process.exitCode || 0);
