import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress } from "@bitauth/libauth";
import { SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const cat = JSON.parse(fs.readFileSync(new URL("./token_state.json", import.meta.url))).category;
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const k = (p) => { const n = deriveHdPathRelative(acct, p, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const enc = (pub, t) => { const r = encodeCashAddress({ prefix: "bchtest", type: t ? "p2pkhWithTokens" : "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };
const src = k("9/0"), dst = k("0/0");
const p = new ElectrumNetworkProvider("chipnet");
const all = await p.getUtxos(enc(src.pub));
const tok = all.find((u) => u.token?.category === cat && u.token.amount >= 5000n);
const bch = all.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
const r = await new TransactionBuilder({ provider: p })
  .addInput(tok, new SignatureTemplate(src.priv).unlockP2PKH()).addInput(bch, new SignatureTemplate(src.priv).unlockP2PKH())
  .addOutput({ to: enc(dst.pub, true), amount: 1000n, token: { category: cat, amount: 5000n } })
  .addOutput({ to: enc(src.pub, true), amount: 1000n, token: { category: cat, amount: tok.token.amount - 5000n } })
  .addOutput({ to: enc(dst.pub), amount: 50000n })
  .addOutput({ to: enc(src.pub), amount: tok.satoshis + bch.satoshis - 52000n - 1500n })
  .send();
console.log("sent 5000 test tokens + 50000 sats to wallet receive/0:", r.txid, "category", cat);
process.exit(0);
