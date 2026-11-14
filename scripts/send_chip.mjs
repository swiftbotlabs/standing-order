import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress } from "@bitauth/libauth";
import { SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const [to, amt] = process.argv.slice(2);
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const n = deriveHdPathRelative(acct, "9/0", { throwErrors: true });
const pub = deriveHdPublicNode(n).publicKey;
const from = (() => { const r = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; })();
const p = new ElectrumNetworkProvider("chipnet");
const u = (await p.getUtxos(from)).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
const r = await new TransactionBuilder({ provider: p }).addInput(u, new SignatureTemplate(n.privateKey).unlockP2PKH())
  .addOutput({ to, amount: BigInt(amt) }).addOutput({ to: from, amount: u.satoshis - BigInt(amt) - 800n }).send();
console.log("sent", amt, "to", to, r.txid);
process.exit(0);
