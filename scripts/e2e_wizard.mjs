// End-to-end test on CHIPNET: dapp (this script) <-> WizardConnect relay <-> headless wallet (child process).
// 1) subscribe: fund a Standing Order from the wallet's receive/0 address, signed by the wallet over WizardConnect
// 2) cancel: the contract's cancel(pk, sig) with placeholders, filled by the wallet over WizardConnect
// Test coins only. usage: node scripts/e2e_wizard.mjs
import fs from "node:fs";
import { spawn } from "node:child_process";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress, binToHex, hexToBin, stringify } from "@bitauth/libauth";
// WizardConnect wire format = libauth extended JSON (<Uint8Array: 0x..>, <bigint: Xn>), see @wizardconnect/core serialize.js
const toWire = (o) => JSON.parse(stringify(o));
// SolidCash finding 7: for an OP_INVOKE-dispatched function, signatures cover the FUNCTION BODY, but
// generateWcTransactionObject() passes the full redeem script, which wallets use as covered bytecode.
// Swap in the function body (selected by the 4-byte selector at the start of the unlocking bytecode).
function fixCoveredBytecode(wc, artifact) {
  wc.sourceOutputs.forEach((so, i) => {
    if (!so.contract) return;
    const unl = binToHex(wc.transaction.inputs[i].unlockingBytecode);
    const sel = unl.startsWith("04") ? unl.slice(2, 10) : null;
    if (sel && artifact.functionBodies?.[sel]) so.contract.redeemScript = hexToBin(artifact.functionBodies[sel]);
  });
  return wc;
}

import { Contract, SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
import { placeholderP2PKHUnlocker, placeholderPublicKey, placeholderSignature } from "@solidcash/solidcash/walletconnect";
import { initiateDappRelay } from "@wizardconnect/core";
import { DappConnectionManager } from "@wizardconnect/dapp";

const log = (...a) => console.log(new Date().toISOString(), "[dapp]", ...a);
// A single relay socket failing must not kill the session (the other relay keeps it alive).
process.on("uncaughtException", (e) => {
  if (/WebSocket/i.test(String(e?.message))) { log("relay socket error (ignored):", e.message); return; }
  log("FATAL", String(e?.stack || e)); process.exit(1);
});
const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order.json", import.meta.url)));
const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const node = (p) => deriveHdPathRelative(acct, p, { throwErrors: true });
const pubOf = (n) => deriveHdPublicNode(n).publicKey;
const addr = (pub) => { const r = encodeCashAddress({ prefix: "bchtest", type: "p2pkh", payload: hash160(pub) }); return typeof r === "string" ? r : r.address; };
const faucetKey = node("9/0"), merchantKey = node("9/1"), userNode = node("0/0");
const userAddr = addr(pubOf(userNode));
const provider = new ElectrumNetworkProvider("chipnet");
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + what)), ms));

// 0) make sure the wallet's receive/0 address holds test coins (moved from our faucet key, unconfirmed is fine)
let userUtxos = (await provider.getUtxos(userAddr)).filter((u) => !u.token);
if (userUtxos.reduce((a, u) => a + u.satoshis, 0n) < 100_000n) {
  const src = (await provider.getUtxos(addr(pubOf(faucetKey)))).filter((u) => !u.token);
  const total = src.reduce((a, u) => a + u.satoshis, 0n);
  let b = new TransactionBuilder({ provider });
  for (const u of src) b = b.addInput(u, new SignatureTemplate(faucetKey.privateKey).unlockP2PKH());
  const r = await b.addOutput({ to: userAddr, amount: 300_000n }).addOutput({ to: addr(pubOf(faucetKey)), amount: total - 300_000n - 1_000n }).send();
  log("topped up wallet receive/0:", r.txid);
  await new Promise((r) => setTimeout(r, 4000));
  userUtxos = (await provider.getUtxos(userAddr)).filter((u) => !u.token);
}
log("wallet receive/0", userAddr, "utxos", userUtxos.length);

// 1) WizardConnect session
const mgr = new DappConnectionManager("Standing Order (test)", "https://standing-order.swiftbotlab.workers.dev/icon.png", { session: false });
let relayRef = null;
// The status callback must feed the manager: updateConnection() is what attaches the message listener.
const relay = initiateDappRelay((st) => { log("relay status", st?.status); mgr.updateConnection(relayRef?.client ?? null, st); });
relayRef = relay;
mgr.updateConnection(relay.client, { status: "connecting" });
mgr.attachRelay(relay);
mgr.on("messagereceived", (m) => log("msg in:", m?.action));
mgr.on("messagesent", (m) => log("msg out:", m?.action));
const ready = new Promise((res) => mgr.on("walletready", res));
const wallet = spawn("node", [process.env.WALLET_JS || "../wizard-wallet/wallet.mjs", "connect", relay.uri, "5"], {
  cwd: process.env.WALLET_DIR || "../wizard-wallet", env: { ...process.env, WIZ_ALLOW_SIGN: "1" }, stdio: ["ignore", "pipe", "pipe"],
});
wallet.stdout.on("data", (d) => process.stdout.write(String(d).split("\n").filter((l) => l && !l.startsWith("[relay]")).map((l) => "   [wallet] " + l + "\n").join("")));
const exit = (code) => { try { wallet.kill(); } catch {} try { relay.cleanup(); } catch {} setTimeout(() => process.exit(code), 500); };
try {
  await Promise.race([ready, timeout(60000, "walletready")]);
  log("wallet ready:", mgr.walletName, "protocol", mgr.protocol);
  const userPub = mgr.getPubkey(0, 0n);
  if (!userPub || binToHex(userPub) !== binToHex(pubOf(userNode))) throw new Error("wallet receive/0 pubkey mismatch");
  log("wallet receive/0 pubkey matches");

  // 2) subscribe = fund the covenant (subscriber = the wallet's key)
  const contract = new Contract(artifact, [hash160(pubOf(merchantKey)), hash160(userPub), 20_000n, 1n, 1_000n, crypto.getRandomValues(new Uint8Array(8))], { provider });
  const total = userUtxos.reduce((a, u) => a + u.satoshis, 0n);
  const fund = new TransactionBuilder({ provider })
    .addInputs(userUtxos, placeholderP2PKHUnlocker(userAddr))
    .addOutput({ to: contract.address, amount: 60_000n })
    .addOutput({ to: userAddr, amount: total - 60_000n - 1_500n });
  const wcFund = fund.generateWcTransactionObject({ broadcast: false, userPrompt: "Subscribe: 20,000 sats per block, up to 3 periods" });
  const signedFund = await Promise.race([
    mgr.signTransaction({ transaction: toWire(wcFund), inputPaths: userUtxos.map((_, i) => [i, "receive", 0]) }),
    timeout(90000, "sign fund"),
  ]);
  if (signedFund.error) throw new Error("wallet refused fund: " + signedFund.error);
  const fundTxid = await provider.sendRawTransaction(signedFund.signedTransaction);
  log("SUBSCRIBED (covenant funded via WizardConnect):", fundTxid, "contract", contract.address);
  await new Promise((r) => setTimeout(r, 5000));

  // 3) cancel via the contract's cancel(pk, sig), placeholders filled by the wallet
  const cu = (await contract.getUtxos())[0];
  if (!cu) throw new Error("contract utxo not visible yet");
  const cancel = new TransactionBuilder({ provider })
    .addInput(cu, contract.unlock.cancel(placeholderPublicKey(), placeholderSignature()))
    .addOutput({ to: userAddr, amount: cu.satoshis - 1_000n });
  const wcCancel = fixCoveredBytecode(cancel.generateWcTransactionObject({ broadcast: false, userPrompt: "Cancel the standing order and take back the rest" }), artifact);
  const signedCancel = await Promise.race([
    mgr.signTransaction({ transaction: toWire(wcCancel), inputPaths: [[0, "receive", 0]] }),
    timeout(90000, "sign cancel"),
  ]);
  if (signedCancel.error) throw new Error("wallet refused cancel: " + signedCancel.error);
  const cancelTxid = await provider.sendRawTransaction(signedCancel.signedTransaction);
  log("CANCELLED (contract spent with the wallet's signature):", cancelTxid);
  exit(0);
} catch (e) {
  log("E2E FAILED:", String(e?.stack || e).slice(0, 800));
  exit(1);
}
