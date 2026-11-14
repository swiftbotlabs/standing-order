// Standing Order relayer: claims due periods for every registered order. Needs NO key: claims are signature-free
// and the covenant fixes amount, recipient and timing, so the worst a bug here can do is waste a claim fee.
// usage: node scripts/relayer.mjs once        (one pass, then exit)   - run by a systemd timer
import fs from "node:fs";
import { decodeCashAddress, encodeCashAddress, hexToBin } from "@bitauth/libauth";
import { Contract, TransactionBuilder } from "@solidcash/solidcash";
import { ElectrumNetworkProvider } from "@solidcash/solidcash/network/electrum";

const API = process.env.SO_API || "https://standing-order.swiftbotlab.workers.dev";
const LOG = process.env.SO_LOG || "relayer.log";
const MAX_FEE = 1000n, DUST = 800n;
const bch = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order.json", import.meta.url)));
const tok = JSON.parse(fs.readFileSync(new URL("../artifacts/solidcash/standing_order_token.json", import.meta.url)));
const line = (s) => { const l = `${new Date().toISOString()} ${s}`; console.log(l); try { fs.appendFileSync(LOG, l + "\n"); } catch {} };
const providers = {};
const prov = (net) => (providers[net] ??= new ElectrumNetworkProvider(net));

function decodePlan(p) {
  const o = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  const net = o.net === "chipnet" ? "chipnet" : "mainnet";
  const prefix = net === "mainnet" ? "bitcoincash" : "bchtest";
  const d = decodeCashAddress(o.merchant.includes(":") ? o.merchant : `${prefix}:${o.merchant}`);
  if (typeof d === "string" || d.prefix !== prefix || !d.type.startsWith("p2pkh")) throw new Error("bad merchant");
  const plan = { net, merchantHash: d.payload, amount: BigInt(o.amount), period: Number(o.period), token: o.token };
  if (plan.amount < 1n || !(plan.period >= 1 && plan.period <= 65535)) throw new Error("bad plan");
  if (plan.token && !/^[0-9a-f]{64}$/.test(plan.token.category)) throw new Error("bad token");
  return plan;
}
const addr = (h, net, tokens) => { const r = encodeCashAddress({ prefix: net === "mainnet" ? "bitcoincash" : "bchtest", type: tokens ? "p2pkhWithTokens" : "p2pkh", payload: h }); return typeof r === "string" ? r : r.address; };

async function handle(o) {
  const plan = decodePlan(o.p);
  const sub = hexToBin(o.s);
  if (sub.length !== 20) throw new Error("bad subscriber");
  const provider = prov(plan.net);
  const contract = plan.token
    ? new Contract(tok, [plan.merchantHash, sub, hexToBin(plan.token.category).reverse(), plan.amount, BigInt(plan.period), DUST, MAX_FEE], { provider })
    : new Contract(bch, [plan.merchantHash, sub, plan.amount, BigInt(plan.period), MAX_FEE], { provider });
  const [u] = await contract.getUtxos();
  if (!u) return "empty";
  const hist = await provider.performRequest("blockchain.address.get_history", contract.address);
  const h = hist.find((x) => x.tx_hash === u.txid);
  if (!h || h.height <= 0) return "unconfirmed";
  const tip = await provider.getBlockHeight();
  if (h.height + plan.period > tip + 1) return `not due (${h.height + plan.period - tip - 1} blocks)`;
  let b = new TransactionBuilder({ provider }).addInput(u, contract.unlock.claim(), { sequence: plan.period });
  if (plan.token) {
    const cat = plan.token.category, left = u.token?.amount ?? 0n, m = addr(plan.merchantHash, plan.net, true);
    if (left <= plan.amount) b = b.addOutput({ to: m, amount: u.satoshis - MAX_FEE, token: { category: cat, amount: left } });
    else b = b.addOutput({ to: m, amount: DUST, token: { category: cat, amount: plan.amount } })
      .addOutput({ to: contract.tokenAddress, amount: u.satoshis - DUST - MAX_FEE, token: { category: cat, amount: left - plan.amount } });
  } else {
    const m = addr(plan.merchantHash, plan.net, false), change = u.satoshis - plan.amount - MAX_FEE;
    if (change < plan.amount + MAX_FEE) b = b.addOutput({ to: m, amount: u.satoshis - MAX_FEE });
    else b = b.addOutput({ to: m, amount: plan.amount }).addOutput({ to: contract.address, amount: change });
  }
  const r = await b.send();
  return `CLAIMED ${r.txid}`;
}

let cursor = null, n = 0, claimed = 0, errors = 0;
do {
  const page = await fetch(`${API}/api/orders/all${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`).then((r) => r.json());
  for (const o of page.orders || []) {
    n++;
    try { const r = await handle(o); if (r.startsWith("CLAIMED")) claimed++; line(`order ${o.id.slice(0, 8)} ${o.net}: ${r}`); }
    catch (e) { errors++; line(`order ${o.id?.slice(0, 8)} ERROR ${String(e?.message || e).slice(0, 160)}`); }
  }
  cursor = page.cursor;
} while (cursor);
line(`pass done: orders=${n} claimed=${claimed} errors=${errors}`);
process.exit(0);
