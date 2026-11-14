import fs from "node:fs";
import * as L from "@bitauth/libauth";
import { Contract, TransactionBuilder, randomUtxo, SignatureTemplate } from "@solidcash/solidcash";
import { MockNetworkProvider } from "@solidcash/solidcash/network/mock";
import { placeholderPublicKey, placeholderSignature } from "@solidcash/solidcash/walletconnect";
import { signWcTransaction } from "@bch-wc2/privkey-connector";
const { binToHex, hash160, stringify, secp256k1 } = L;
const parseExt = (s) => JSON.parse(s, (k, v) => typeof v === "string" && /^<bigint: \d+n>$/.test(v) ? BigInt(v.slice(9, -2)) : typeof v === "string" && /^<Uint8Array: 0x[0-9a-f]*>$/.test(v) ? L.hexToBin(v.slice(15, -1)) : v);
const priv = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0x33)); const pub = secp256k1.derivePublicKeyCompressed(priv);
const artifact = JSON.parse(fs.readFileSync("artifacts/solidcash/standing_order.json"));
const provider = new MockNetworkProvider();
const c = new Contract(artifact, [new Uint8Array(20).fill(1), hash160(pub), 20000n, 1n, 1000n], { provider });
const u = { ...randomUtxo(), satoshis: 60000n }; provider.addUtxo(c.address, u);
const mk = (unl) => new TransactionBuilder({ provider }).addInput(u, unl).addOutput({ to: c.address, amount: 59000n });
// A) SDK's own signing (known good in tests)
const goodHex = mk(c.unlock.cancel(pub, new SignatureTemplate(priv))).build();
// B) placeholder -> wire -> revive -> privkey-connector
const wc = parseExt(stringify(mk(c.unlock.cancel(placeholderPublicKey(), placeholderSignature())).generateWcTransactionObject({ broadcast: false })));
// FIX: for an OP_INVOKE-dispatched function the covered bytecode is the function body, not the redeem script
const unlHex = binToHex(wc.transaction.inputs[0].unlockingBytecode);
const sel = unlHex.startsWith("04") ? unlHex.slice(2, 10) : null;
if (process.env.FIX === "1" && sel && artifact.functionBodies?.[sel]) wc.sourceOutputs[0].contract.redeemScript = L.hexToBin(artifact.functionBodies[sel]);
const signed = signWcTransaction(wc, { privateKey: priv, pubkeyCompressed: pub });
const vm = L.createVirtualMachineBch2026();
for (const [name, hex] of [["sdk", goodHex], ["wc", binToHex(signed)]]) {
  const tx = L.decodeTransaction(L.hexToBin(hex));
  const r = vm.verify({ sourceOutputs: wc.sourceOutputs.map((s) => ({ lockingBytecode: s.lockingBytecode, valueSatoshis: s.valueSatoshis, ...(s.token ? { token: s.token } : {}) })), transaction: tx });
  console.log(name, "verify:", r === true ? "OK" : r);
}
const a = binToHex(L.decodeTransaction(L.hexToBin(goodHex)).inputs[0].unlockingBytecode), b = binToHex(L.decodeTransaction(signed).inputs[0].unlockingBytecode);
console.log("sdk unlocking head:", a.slice(0, 20), "sig hashtype byte:", a.slice(140, 142));
console.log("wc  unlocking head:", b.slice(0, 20), "sig hashtype byte:", b.slice(140, 142));
