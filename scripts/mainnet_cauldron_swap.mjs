// Buy a few PUSD units on MAINNET from a Cauldron constant-product pool, for the PUSD Standing Order demo (tiny amounts).
// usage: node scripts/mainnet_cauldron_swap.mjs <units> [--dry]      e.g. 5 = 0.05 PUSD
//   --dry   build the trade and VERIFY it in the BCH 2026 VM against the live pool coin; nothing is broadcast
// How it stays safe:
// - The pool list comes from Cauldron's public indexer, but the indexer is only a hint (untrusted data). The pool coin's
//   locking bytecode is read from the chain, and the pool's redeem script is taken from the chain too: the last push of the input
//   that created the current pool coin (a previous trade) or, for a fresh pool, the whitepaper template with the owner's pkh.
//   It is accepted only if hash256(redeem) equals the P2SH32 hash in the pool coin.
// - The trade follows the contract's own rule: (newValue - fee) * newTokens >= oldValue * oldTokens, fee = |dV| * 3 / 1000.
//   The VM check proves the pool accepts it before anything is sent.
// Keys: BLAZE wizard seed (SEED_FILE, never printed). Payer = m/44'/145'/0'/0/0 (qrddpp..xaza); tokens go to its token address.
import fs from "node:fs";
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, hash256, hexToBin, binToHex,
  encodeCashAddress, decodeTransaction, createVirtualMachineBch2026, cashAddressToLockingBytecode } from "@bitauth/libauth";
import { SignatureTemplate, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const PUSD = "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544";
const INDEXER = `https://indexer.cauldron.quest/cauldron/pool/active?token=${PUSD}`;
const args = process.argv.slice(2); const DRY = args.includes("--dry");
const UNITS = BigInt(args.find((a) => /^\d+$/.test(a)) || "5");
if (UNITS < 1n || UNITS > 100n) throw new Error("buy between 1 and 100 units (0.01-1.00 PUSD) for the demo");
const LOG = process.env.SWAP_LOG || "mainnet_cauldron_swap.log";
const log = (...a) => { const l = [new Date().toISOString(), ...a].join(" "); console.log(l); if (!DRY) fs.appendFileSync(LOG, l + "\n"); };

const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || ".secrets/seed.hex", "utf8").trim(), "hex"));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const n = deriveHdPathRelative(acct, "0/0", { throwErrors: true }); const me = { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey };
const enc = (tokens) => { const r = encodeCashAddress({ prefix: "bitcoincash", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: hash160(me.pub) }); return typeof r === "string" ? r : r.address; };
const provider = new ElectrumNetworkProvider("mainnet");

// Cauldron contract (whitepaper appendix), parameterised by the owner's pkh; used only if the chain shows no previous redeem script.
const OP = { DEPTH: 0x74, IF: 0x63, DUP: 0x76, HASH160: 0xa9, EQUALVERIFY: 0x88, CHECKSIG: 0xac, ELSE: 0x67, ENDIF: 0x68, INPUTINDEX: 0xc0,
  OUTPUTTOKENCATEGORY: 0xd1, UTXOTOKENCATEGORY: 0xce, TXVERSION: 0xc2, OUTPUTBYTECODE: 0xcd, UTXOBYTECODE: 0xc7, UTXOVALUE: 0xc6,
  UTXOTOKENAMOUNT: 0xd0, MUL: 0x95, OUTPUTVALUE: 0xcc, SUB: 0x94, ABS: 0x90, DIV: 0x96, SWAP: 0x7c, OUTPUTTOKENAMOUNT: 0xd3, GTE: 0xa2 };
const templateRedeem = (pkh) => Uint8Array.from([OP.DEPTH, OP.IF, OP.DUP, OP.HASH160, 0x14, ...pkh, OP.EQUALVERIFY, OP.CHECKSIG, OP.ELSE,
  OP.INPUTINDEX, OP.OUTPUTTOKENCATEGORY, OP.INPUTINDEX, OP.UTXOTOKENCATEGORY, OP.EQUALVERIFY, OP.TXVERSION, 0x52, OP.EQUALVERIFY,
  OP.INPUTINDEX, OP.OUTPUTBYTECODE, OP.INPUTINDEX, OP.UTXOBYTECODE, OP.EQUALVERIFY,
  OP.INPUTINDEX, OP.UTXOVALUE, OP.INPUTINDEX, OP.UTXOTOKENAMOUNT, OP.MUL,
  OP.INPUTINDEX, OP.UTXOVALUE, OP.INPUTINDEX, OP.OUTPUTVALUE, OP.SUB, OP.ABS, 0x53, OP.MUL, 0x02, 0xe8, 0x03, OP.DIV,
  OP.INPUTINDEX, OP.OUTPUTVALUE, OP.SWAP, OP.SUB, OP.INPUTINDEX, OP.OUTPUTTOKENAMOUNT, OP.MUL, OP.SWAP, OP.GTE, OP.ENDIF]);
const lastPush = (bc) => {   // last data push of an unlocking bytecode (P2SH redeem script)
  let i = 0, last = null;
  while (i < bc.length) {
    const op = bc[i++]; let len = 0;
    if (op >= 1 && op <= 75) len = op; else if (op === 0x4c) len = bc[i++]; else if (op === 0x4d) { len = bc[i] | (bc[i + 1] << 8); i += 2; }
    else if (op === 0x4e) { len = bc[i] | (bc[i + 1] << 8) | (bc[i + 2] << 16) | (bc[i + 3] << 24); i += 4; } else continue;
    last = bc.slice(i, i + len); i += len;
  }
  return last;
};
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const pools = (await (await fetch(INDEXER)).json()).active || [];
if (!pools.length) throw new Error("indexer lists no active PUSD pool");
const hint = pools.sort((a, b) => b.tokens - a.tokens)[0];   // deepest pool = least price impact
const txHex = await provider.getRawTransaction(hint.txid); const tx = decodeTransaction(hexToBin(txHex));
const out = tx.outputs[hint.tx_pos];
const lb = out.lockingBytecode;
if (!(lb.length === 35 && lb[0] === 0xaa && lb[1] === 0x20 && lb[34] === 0x87)) throw new Error("pool coin is not P2SH32");
if (!out.token || binToHex(out.token.category) !== PUSD || out.token.nft) throw new Error("pool coin does not hold PUSD");
const p2shHash = lb.slice(2, 34);
let redeem = null, source = "";
for (const inp of tx.inputs) { const r = lastPush(inp.unlockingBytecode); if (r && eq(hash256(r), p2shHash)) { redeem = r; source = "chain (previous trade)"; break; } }
if (!redeem) { const t = templateRedeem(hexToBin(hint.owner_pkh)); if (eq(hash256(t), p2shHash)) { redeem = t; source = "whitepaper template"; } }
if (!redeem) throw new Error("could not prove the pool's redeem script (hash mismatch): refusing to trade");
const live = await provider.getUtxosForLockingBytecode(binToHex(lb));
if (!live.some((u) => u.txid === hint.txid && u.vout === hint.tx_pos)) throw new Error("the indexer's pool coin is already spent: run again in a moment");

const V = out.valueSatoshis, T = out.token.amount, K = V * T;
const T2 = T - UNITS; if (T2 <= 0n) throw new Error("pool too small");
let V2 = (K + T2 - 1n) / T2;   // first guess, then add the fee until the contract's inequality holds
for (let i = 0; i < 64; i++) { const fee = (V2 - V) * 3n / 1000n; if ((V2 - fee) * T2 >= K) break; V2 += 1n + (V2 - V) / 300n; }
const cost = V2 - V;
log(`pool ${hint.txid.slice(0, 10)}:${hint.tx_pos} (${source}) ${V} sats / ${T} units; buy ${UNITS} units for ${cost} sats (${(Number(cost) / Number(UNITS)).toFixed(0)} sats/unit)`);
if (cost > 50_000n) throw new Error(`refusing: ${cost} sats is more than the 50,000-sat cap for this demo`);

const poolUtxo = { txid: hint.txid, vout: hint.tx_pos, satoshis: V, token: { category: PUSD, amount: T } };
const poolUnlocker = {
  generateLockingBytecode: () => lb,
  generateUnlockingBytecode: () => Uint8Array.from([...(redeem.length <= 75 ? [redeem.length] : redeem.length <= 255 ? [0x4c, redeem.length] : [0x4d, redeem.length & 255, redeem.length >> 8]), ...redeem]),
};
const mine = (await provider.getUtxos(enc(false))).filter((x) => !x.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
if (!mine) throw new Error("payer has no plain BCH coin");
const FEE = 1_500n, TOKEN_DUST = 1_000n;
const b = new TransactionBuilder({ provider })
  .addInput(poolUtxo, poolUnlocker)                                  // pool must be input 0 -> output 0 (same index)
  .addInput(mine, new SignatureTemplate(me.priv).unlockP2PKH())
  .addOutput({ to: lb, amount: V2, token: { category: PUSD, amount: T2 } })
  .addOutput({ to: enc(true), amount: TOKEN_DUST, token: { category: PUSD, amount: UNITS } })
  .addOutput({ to: enc(false), amount: mine.satoshis - cost - TOKEN_DUST - FEE });
const hex = await b.build();
const built = decodeTransaction(hexToBin(hex));
const sourceOutputs = [
  { lockingBytecode: lb, valueSatoshis: V, token: { category: hexToBin(PUSD), amount: T } },
  { lockingBytecode: cashAddressToLockingBytecode(enc(false)).bytecode, valueSatoshis: mine.satoshis },
];
const ok = createVirtualMachineBch2026().verify({ transaction: built, sourceOutputs });
if (ok !== true) throw new Error(`VM refused the trade: ${ok}`);
log(`VM OK: ${hex.length / 2} B, pool -> ${V2} sats / ${T2} units, ${UNITS} PUSD units to ${enc(true)}`);
if (DRY) { log("DRY: not broadcast"); process.exit(0); }
const txid = await provider.sendRawTransaction(hex);
log("SWAPPED", txid, `https://blockchair.com/bitcoin-cash/transaction/${txid}`);
try { await provider.disconnect?.(); } catch {}
process.exit(0);
