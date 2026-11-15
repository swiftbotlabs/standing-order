// Standing Order relayer: claims due periods for every registered order. Needs NO key: claims are signature-free
// and the covenant fixes amount, recipient and timing, so the worst a bug here can do is waste a claim fee.
// usage: node scripts/relayer.mjs once        (one pass, then exit)   - run by a systemd timer
import fs from "node:fs";
import { decodeCashAddress, encodeCashAddress, hexToBin } from "@bitauth/libauth";
import { Contract, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const API = process.env.SO_API || "https://standing-order.swiftbotlab.workers.dev";
const LOG = process.env.SO_LOG || "relayer.log";
const MAX_FEE = 1000n, PLUS_MAX_FEE = 2000n, DUST = 800n;   // v2 claim txs carry a ~1 kB redeem script
const bch = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order.json", import.meta.url)));
const tok = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order_token.json", import.meta.url)));
const plus = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order_plus.json", import.meta.url)));
const line = (s) => { const l = `${new Date().toISOString()} ${s}`; console.log(l); try { fs.appendFileSync(LOG, l + "\n"); } catch {} };
const providers = {};
const prov = (net) => (providers[net] ??= new ElectrumNetworkProvider(net));

function decodePlan(p) {
  const o = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const net = o.net === "chipnet" ? "chipnet" : "mainnet";
  const prefix = net === "mainnet" ? "bitcoincash" : "bchtest";
  const d = decodeCashAddress(o.merchant.includes(":") ? o.merchant : `${prefix}:${o.merchant}`);
  if (typeof d === "string" || d.prefix !== prefix || !d.type.startsWith("p2pkh")) throw new Error("bad merchant");
  const plan = { net, merchantHash: d.payload, amount: BigInt(o.amount), period: Number(o.period), token: o.token, v2: o.v === 2 && !o.token, splitHash: null, split: 0n };
  if (plan.v2 && o.split && BigInt(o.split.amount) > 0n) {
    const sd = decodeCashAddress(String(o.split.to).includes(":") ? String(o.split.to) : `${prefix}:${o.split.to}`);
    if (typeof sd === "string" || sd.prefix !== prefix || !sd.type.startsWith("p2pkh")) throw new Error("bad split");
    plan.splitHash = sd.payload; plan.split = BigInt(o.split.amount);
  }
  if (plan.amount < 1n || !(plan.period >= 1 && plan.period <= 65535)) throw new Error("bad plan");
  if (plan.token && !/^[0-9a-f]{64}$/.test(plan.token.category)) throw new Error("bad token");
  return plan;
}
const addr = (h, net, tokens) => { const r = encodeCashAddress({ prefix: net === "mainnet" ? "bitcoincash" : "bchtest", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: h }); return typeof r === "string" ? r : r.address; };

async function handle(o) {
  const plan = decodePlan(o.p);
  if (!o.o) return "legacy (no order id), skipped";
  const sub = hexToBin(o.s), oid = hexToBin(o.o);
  if (sub.length !== 20 || oid.length !== 8) throw new Error("bad subscriber/order id");
  const provider = prov(plan.net);
  const contract = plan.v2
    ? new Contract(plus, [plan.merchantHash, sub, plan.amount, BigInt(plan.period), PLUS_MAX_FEE, plan.splitHash ?? new Uint8Array(20), plan.split, oid], { provider })
    : plan.token
    ? new Contract(tok, [plan.merchantHash, sub, hexToBin(plan.token.category).reverse(), plan.amount, BigInt(plan.period), DUST, MAX_FEE, oid], { provider })
    : new Contract(bch, [plan.merchantHash, sub, plan.amount, BigInt(plan.period), MAX_FEE, oid], { provider });
  // Ignore junk sent to the covenant (dust, foreign tokens, NFTs): claim the coin holding the most of the plan's asset.
  const mine = (await contract.getUtxos()).filter((x) => plan.token
    ? x.token?.category === plan.token.category && !x.token?.nft && x.token.amount > 0n
    : x.satoshis >= plan.amount + plan.split);   // by value: ignore stray dust; keep a coin someone attached a token to
  const key = (x) => (plan.token ? x.token.amount : x.satoshis);
  const u = mine.sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0))[0];
  if (!u) return plan.v2 ? "empty or paused" : "empty";
  const hist = await provider.performRequest("blockchain.address.get_history", contract.address);
  const h = hist.find((x) => x.tx_hash === u.txid);
  if (!h || h.height <= 0) return "unconfirmed";
  const tip = await provider.getBlockHeight();
  if (h.height + plan.period > tip + 1) return `not due (${h.height + plan.period - tip - 1} blocks)`;
  let b = new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: true, allowImplicitNftBurn: true })
    .addInput(u, contract.unlock.claim(), { sequence: plan.period });
  if (plan.token) {
    const cat = plan.token.category, left = u.token?.amount ?? 0n, m = addr(plan.merchantHash, plan.net, true);
    if (left <= plan.amount) b = b.addOutput({ to: m, amount: u.satoshis - MAX_FEE, token: { category: cat, amount: left } });
    else b = b.addOutput({ to: m, amount: DUST, token: { category: cat, amount: plan.amount } })
      .addOutput({ to: contract.tokenAddress, amount: u.satoshis - DUST - MAX_FEE, token: { category: cat, amount: left - plan.amount } });
  } else {
    const per = plan.amount + plan.split, fee = plan.v2 ? PLUS_MAX_FEE : MAX_FEE;
    const m = addr(plan.merchantHash, plan.net, false), change = u.satoshis - per - fee;
    if (change < per + fee) {
      if (plan.split > 0n && u.satoshis - fee >= per)   // v2 last claim: the split payee still gets its share
        b = b.addOutput({ to: m, amount: u.satoshis - fee - plan.split }).addOutput({ to: addr(plan.splitHash, plan.net, false), amount: plan.split });
      else b = b.addOutput({ to: m, amount: u.satoshis - fee });
    } else {
      b = b.addOutput({ to: m, amount: plan.amount });
      if (plan.split > 0n) b = b.addOutput({ to: addr(plan.splitHash, plan.net, false), amount: plan.split });
      b = b.addOutput({ to: contract.address, amount: change });
    }
  }
  if (process.env.SO_TEST_FAIL_ONCE === "1" && !failedOnce.has(o.id)) { failedOnce.add(o.id); throw new Error("test: the transaction was rejected by network rules. non-BIP68-final (code 64)"); }
  const r = await b.send();
  return `CLAIMED ${r.txid}`;
}
const failedOnce = new Set();
// "non-BIP68-final" right after an order became due: the Electrum server's view (tip, coin height) ran ahead of the node that checks the
// relative timelock. Seen on chipnet 2026-11-15 15:03 and 15:08Z; the same claim went through minutes later. Retry those orders at the end
// of the pass with backoff and a fresh connection, inside a time budget that keeps the run well under the unit's 90 s timeout.
const NOT_FINAL = /non-BIP68-final/i;
const RETRY_DELAYS_MS = (process.env.SO_RETRY_DELAYS || "5000,10000,20000").split(",").map(Number);
const BUDGET_MS = Number(process.env.SO_RETRY_BUDGET_MS || 45000);

const t0 = Date.now();
let cursor = null, n = 0, claimed = 0, errors = 0;
const deferred = [];
async function pages() {
  if (process.env.SO_ORDERS_FILE) return [{ orders: JSON.parse(fs.readFileSync(process.env.SO_ORDERS_FILE, "utf8")) }];
  const out = [];
  do {
    const page = await fetch(`${API}/api/orders/all${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`).then((r) => r.json());
    out.push(page); cursor = page.cursor;
  } while (cursor);
  return out;
}
for (const page of await pages()) {
  for (const o of page.orders || []) {
    n++;
    try { const r = await handle(o); if (r.startsWith("CLAIMED")) claimed++; line(`order ${o.id.slice(0, 8)} ${o.net}: ${r}`); }
    catch (e) {
      const m = String(e?.message || e);
      if (NOT_FINAL.test(m)) { deferred.push(o); line(`order ${o.id?.slice(0, 8)} ${o.net}: not final yet at the node (non-BIP68-final), will retry`); }
      else { errors++; line(`order ${o.id?.slice(0, 8)} ERROR ${m.slice(0, 160)}`); }
    }
  }
}
let retried = 0;
for (let i = 0; i < RETRY_DELAYS_MS.length && deferred.length; i++) {
  if (Date.now() - t0 + RETRY_DELAYS_MS[i] > BUDGET_MS) { line(`retry budget reached (${BUDGET_MS} ms); ${deferred.length} order(s) left for the next pass`); break; }
  await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
  for (const k of Object.keys(providers)) { try { await providers[k].disconnect?.(); } catch {} delete providers[k]; }   // fresh connection, no cached listings
  for (const o of deferred.splice(0)) {
    retried++;
    try { const r = await handle(o); if (r.startsWith("CLAIMED")) claimed++; line(`order ${o.id.slice(0, 8)} ${o.net}: retry ${i + 1}: ${r}`); }
    catch (e) {
      const m = String(e?.message || e);
      if (NOT_FINAL.test(m)) { deferred.push(o); line(`order ${o.id?.slice(0, 8)} ${o.net}: retry ${i + 1}: still not final`); }
      else { errors++; line(`order ${o.id?.slice(0, 8)} ERROR on retry ${i + 1}: ${m.slice(0, 160)}`); }
    }
  }
}
errors += deferred.length;
line(`pass done: orders=${n} claimed=${claimed} errors=${errors} retried=${retried} not_final_left=${deferred.length} ms=${Date.now() - t0}`);
process.exit(0);
