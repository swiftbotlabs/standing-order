// Body extraction for StandingOrderPlus and PausedOrder (same method as extract_tail.mjs): the compiled redeem script minus the
// constructor-argument pushes, checked to be independent of the arguments. Writes standing_order_plus.body.json.
import fs from "node:fs";
import { Contract } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";
import { binToHex, encodeDataPush, bigIntToVmNumber, flattenBinArray } from "@bitauth/libauth";
const art = (n) => JSON.parse(fs.readFileSync(new URL(`../artifacts/solidcash/${n}.json`, import.meta.url)));
const provider = new ElectrumNetworkProvider("chipnet");
const pushNum = (n) => (n >= 1n && n <= 16n) ? Uint8Array.of(0x50 + Number(n)) : n === 0n ? Uint8Array.of(0) : encodeDataPush(bigIntToVmNumber(n));
const hex = (b) => typeof b === "string" ? b : binToHex(Uint8Array.from(Object.values(b)));
function plus(m, s, amt, per, fee, sp, sa, oid) {
  const c = new Contract(art("standing_order_plus"), [m, s, amt, per, fee, sp, sa, oid], { provider });
  const prefix = binToHex(flattenBinArray([encodeDataPush(oid), pushNum(sa), encodeDataPush(sp), pushNum(fee), pushNum(per), pushNum(amt), encodeDataPush(s), encodeDataPush(m)]));
  if (!c.bytecode.startsWith(prefix)) throw new Error("plus prefix mismatch");
  return { body: c.bytecode.slice(prefix.length), lock: hex(c.lockingBytecode), redeem: c.bytecode };
}
function paused(s, resumeTo) {
  const c = new Contract(art("paused_order"), [s, resumeTo], { provider });
  const prefix = binToHex(flattenBinArray([encodeDataPush(resumeTo), encodeDataPush(s)]));
  if (!c.bytecode.startsWith(prefix)) throw new Error("paused prefix mismatch");
  return { body: c.bytecode.slice(prefix.length), lock: hex(c.lockingBytecode), redeem: c.bytecode };
}
const b = (n, x) => new Uint8Array(n).fill(x);
const a = plus(b(20, 0x11), b(20, 0x22), 20000n, 1n, 1000n, b(20, 0x33), 1000n, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
const c = plus(b(20, 0xab), b(20, 0xcd), 1234567n, 144n, 2000n, b(20, 0xef), 0n, Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9));
if (a.body !== c.body) throw new Error("plus body depends on the arguments");
const p1 = paused(b(20, 0x22), b(32, 0x44)), p2 = paused(b(20, 0x55), b(32, 0x66));
if (p1.body !== p2.body) throw new Error("paused body depends on the arguments");
fs.writeFileSync(new URL("./standing_order_plus.body.json", import.meta.url), JSON.stringify({
  sources: ["contracts/standing_order_plus.scash", "contracts/paused_order.scash"], plusBodyHex: a.body, pausedBodyHex: p1.body,
  vectors: { plus: [a, c].map((v) => ({ lockingBytecode: v.lock, redeemHex: v.redeem })), paused: [p1, p2].map((v) => ({ lockingBytecode: v.lock, redeemHex: v.redeem })) } }, null, 1) + "\n");
console.log("plus body", a.body.length / 2, "bytes; paused body", p1.body.length / 2, "bytes; paused body == PAUSED_TEMPLATE:", fs.readFileSync(new URL("../contracts/standing_order_plus.scash", import.meta.url), "utf8").includes(p1.body));
process.exit(0);
