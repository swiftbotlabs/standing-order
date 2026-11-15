// control test: does chipnet accept a sequence=1 spend of a P2PKH coin right after its first confirmation?
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress } from "@bitauth/libauth";
import { SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE, "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const n = deriveHdPathRelative(acct, "9/0", { throwErrors: true }); const pub = deriveHdPublicNode(n).publicKey;
const a = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }); const addr = typeof a === "string" ? a : a.address;
const log = (...x) => console.log(new Date().toISOString(), ...x);
let p = new ElectrumNetworkProvider("chipnet");
const sig = new SignatureTemplate(n.privateKey);
const coins = (await p.getUtxos(addr)).filter((x) => !x.token && x.satoshis > 50000n).sort((x, y) => Number(y.satoshis - x.satoshis));
const c = coins[0];
const r = await new TransactionBuilder({ provider: p }).addInput(c, sig.unlockP2PKH()).addOutput({ to: addr, amount: 20000n }).addOutput({ to: addr, amount: c.satoshis - 21000n }).send();
log("FUNDED", r.txid);
let h = 0; while (h <= 0) { await new Promise((z) => setTimeout(z, 3000)); const hist = await p.performRequest("blockchain.scripthash.get_history", (await import("@bitauth/libauth")).binToHex((await import("@bitauth/libauth")).sha256.hash((await import("@bitauth/libauth")).cashAddressToLockingBytecode(addr).bytecode).reverse())).catch(() => []); const e = hist.find((x) => x.tx_hash === r.txid); h = e?.height ?? 0; }
log("confirmed at", h, "tip", await p.getBlockHeight());
for (let i = 0; i < 80; i++) {
  try { p = new ElectrumNetworkProvider("chipnet"); const u = { txid: r.txid, vout: 0, satoshis: 20000n };
    const t = await new TransactionBuilder({ provider: p }).addInput(u, sig.unlockP2PKH(), { sequence: 1 }).addOutput({ to: addr, amount: 19000n }).send();
    log("SEQ1 SPEND ACCEPTED", t.txid, "tip", await p.getBlockHeight()); break;
  } catch (e) { log("refused:", String(e.message || e).replace(/\s+/g, " ").slice(-80), "tip", await p.getBlockHeight()); await new Promise((z) => setTimeout(z, 15000)); }
}
process.exit(0);
