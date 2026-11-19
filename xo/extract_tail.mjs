// Derives the contract body that follows the six constructor-argument pushes in StandingOrder's redeem script,
// using the project's own compiled artifact + the solidcash SDK. Checks that it does not depend on the arguments.
import fs from "node:fs";
import { Contract } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
import { binToHex, encodeDataPush, bigIntToVmNumber, flattenBinArray } from "@bitauth/libauth";
const artifact = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order.json", import.meta.url)));
const provider = new ElectrumNetworkProvider("chipnet");
const pushNum = (n) => (n >= 1n && n <= 16n) ? Uint8Array.of(0x50 + Number(n)) : n === 0n ? Uint8Array.of(0) : encodeDataPush(bigIntToVmNumber(n));
function tailFor(m, s, amt, per, fee, oid) {
  const c = new Contract(artifact, [m, s, amt, per, fee, oid], { provider });
  const full = c.bytecode;
  const prefix = binToHex(flattenBinArray([encodeDataPush(oid), pushNum(fee), pushNum(per), pushNum(amt), encodeDataPush(s), encodeDataPush(m)]));
  if (!full.startsWith(prefix)) throw new Error("argument prefix mismatch for " + [amt, per, fee]);
  return { tail: full.slice(prefix.length), lock: typeof c.lockingBytecode === "string" ? c.lockingBytecode : binToHex(Uint8Array.from(Object.values(c.lockingBytecode))), full };
}
const a = tailFor(new Uint8Array(20).fill(0x11), new Uint8Array(20).fill(0x22), 20000n, 1n, 1000n, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
const b = tailFor(new Uint8Array(20).fill(0xab), new Uint8Array(20).fill(0xcd), 1234567n, 144n, 2000n, Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9));
if (a.tail !== b.tail) throw new Error("contract body depends on the arguments");
fs.writeFileSync(new URL("./standing_order.body.json", import.meta.url), JSON.stringify({ source: "contracts/standing_order.scash", compiler: artifact.compiler, bodyHex: a.tail, vectors: [a, b].map((v, i) => ({ i, lockingBytecode: v.lock, redeemHex: v.full })) }, null, 1) + "\n");
console.log("body bytes", a.tail.length / 2, "ok");
process.exit(0);
