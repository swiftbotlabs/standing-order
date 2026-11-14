import QRCode from 'qrcode';
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  type Plan, type Net, encodePlan, decodePlan, validatePlan, fundingTotal, buildFund, buildCancel, claimDue,
  orderState, broadcast, merchantHash, formatAmount, fundingTokens, PUSD, newOrderId,
} from './chain';
import { WizardSession, type WalletInfo } from './wizard';

const app = document.getElementById('app')!;
const session = new WizardSession();
const DEMO_MERCHANT = 'bitcoincash:qrddpp6vjr6fgp4rtuawae2qmm2ccmglzgg7rsxaza';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sats = (n: bigint) => `${n.toLocaleString()} sats`;
const explorer = (net: Net, txid: string) => net === 'mainnet' ? `https://explorer.bch.ninja/tx/${txid}` : `https://chipnet.bch.ninja/tx/${txid}`;
const periodText = (b: number) => b === 1 ? 'every block (~10 min)' : b === 144 ? 'every day' : b === 1008 ? 'every week' : b === 4320 ? 'every month' : `every ${b} blocks`;
const params = () => new URLSearchParams(location.hash.split('?')[1] || '');

function demoPlan(net: Net): Plan {
  return { v: 1, net, merchant: DEMO_MERCHANT, amount: 5_000n, period: 1, periods: 3, label: 'Standing Order demo (about 1 cent a block)' };
}

function render() {
  const route = location.hash.split('?')[0] || '#/';
  if (route === '#/new') return renderNew();
  if (route === '#/pay') return renderPay();
  if (route === '#/order') return renderOrder();
  if (route === '#/merchant') return renderMerchant();
  return renderHome();
}
window.addEventListener('hashchange', render);

// ---- home ------------------------------------------------------------------
function renderHome() {
  const demo = `#/pay?p=${encodePlan(demoPlan('mainnet'))}`;
  const demoChip = `#/pay?p=${encodePlan({ ...demoPlan('chipnet'), merchant: 'bchtest:qr2dds84kdmcmfhhc6lqcqrsaw9tspregqxwsz2ry3', label: 'Standing Order demo on chipnet (test coins)' })}`;
  app.innerHTML = `
  <section class="hero">
    <h1>Subscriptions that pay themselves.<br/>On Bitcoin Cash.</h1>
    <p class="lede">Fund a standing order once. The merchant can take one period's amount per period, never more and never
    early. Cancel any time and the rest comes straight back. No custody, no card on file.</p>
    <div class="cta">
      <a class="btn primary" href="${demo}">Try it: 1 cent a block</a>
      <a class="btn" href="#/new">Create a pay link</a>
    </div>
    <p class="muted small">No BCH handy? <a href="${demoChip}">Try it on chipnet</a> with free test coins.</p>
  </section>
  <section class="timeline" aria-label="How a standing order works">
    <svg viewBox="0 0 720 120" role="img" aria-labelledby="tl-t"><title id="tl-t">Fund once, paid each period, cancel any time</title>
      <line x1="40" y1="60" x2="680" y2="60" class="tl-line"/>
      <g class="tl-dot"><circle cx="60" cy="60" r="16"/><text x="60" y="66">1</text></g>
      <g class="tl-dot"><circle cx="250" cy="60" r="16"/><text x="250" y="66">2</text></g>
      <g class="tl-dot"><circle cx="440" cy="60" r="16"/><text x="440" y="66">3</text></g>
      <g class="tl-dot alt"><circle cx="640" cy="60" r="16"/><text x="640" y="66">✕</text></g>
      <text x="60" y="104" class="tl-l">Fund once</text>
      <text x="250" y="104" class="tl-l">Period 1 paid</text>
      <text x="440" y="104" class="tl-l">Period 2 paid</text>
      <text x="640" y="104" class="tl-l">Cancel: rest back</text>
      <text x="155" y="40" class="tl-s">one period</text><text x="345" y="40" class="tl-s">one period</text>
    </svg>
    <ol class="tl-list"><li><b>Fund once</b> into the covenant</li><li><b>Each period</b>: exactly one payment to the merchant</li><li><b>Cancel any time</b>: the rest comes back</li></ol>
  </section>
  <section class="steps">
    <div><b>Subscribe</b><p>Connect a wallet that supports WizardConnect (Selene, Paytaca) and fund the order. Your coins go into a covenant, not to us.</p></div>
    <div><b>It pays on schedule</b><p>After each period anyone can trigger the payment, and our relayer does it for the merchant. The contract allows exactly one period's amount.</p></div>
    <div><b>Cancel any time</b><p>One approval in your wallet returns everything still in the order. No one else can move it.</p></div>
  </section>
  <ul class="facts">
    <li><b>Non-custodial</b> covenant written in SolidCash</li>
    <li><b>BCH or PUSD</b> stablecoin plans</li>
    <li><b>Proven on chipnet</b>: early claims refused by the network</li>
    <li><b>Open source</b> on <a href="https://github.com/swiftbotlabs/standing-order" target="_blank" rel="noopener">GitHub</a></li>
  </ul>`;
}

// ---- merchant: create a pay link ------------------------------------------
function renderNew() {
  app.innerHTML = `
  <section class="card">
    <h2>Create a pay link</h2>
    <form id="f" class="form">
      <label>What is it for <input name="label" maxlength="80" required placeholder="Pro plan, newsletter, coffee club..." /></label>
      <label>Your receiving address <input name="merchant" required placeholder="bitcoincash:q..." /></label>
      <div class="row">
        <label>Paid in
          <select name="currency" id="cur">
            <option value="bch">BCH (amount in sats)</option>
            <option value="pusd">PUSD stablecoin (amount in PUSD)</option>
            <option value="token">Other CashToken (base units)</option>
          </select>
        </label>
        <label>Amount per period <input name="amount" type="number" min="0.01" step="any" value="10000" required /></label>
        <label>Every
          <select name="period">
            <option value="1">block (~10 min, for testing)</option>
            <option value="144">day (144 blocks)</option>
            <option value="1008">week (1,008 blocks)</option>
            <option value="4320" selected>month (4,320 blocks)</option>
          </select>
        </label>
      </div>
      <div class="row" id="tokrow" hidden>
        <label>Token category <input name="category" pattern="[0-9a-f]{64}" placeholder="64 hex characters" /></label>
        <label>Symbol / decimals <input name="symbol" placeholder="TOKEN,0" /></label>
      </div>
      <label>Periods the subscriber prepays <input name="periods" type="number" min="1" max="120" value="12" required /></label>
      <label class="inline"><input type="checkbox" name="chipnet" /> Use chipnet (test coins)</label>
      <p class="err" id="err" hidden></p>
      <button class="btn primary" type="submit">Make link</button>
    </form>
    <div id="out" hidden class="out"></div>
  </section>`;
  const f = document.getElementById('f') as HTMLFormElement;
  const cur = document.getElementById('cur') as HTMLSelectElement;
  cur.addEventListener('change', () => { (document.getElementById('tokrow') as HTMLElement).hidden = cur.value !== 'token'; });
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const err = document.getElementById('err')!;
    try {
      const c = String(d.get('currency'));
      let token: Plan['token'];
      if (c === 'pusd') token = PUSD;
      if (c === 'token') {
        const [sym, dec] = String(d.get('symbol') || 'TOKEN,0').split(',');
        token = { category: String(d.get('category')).trim().toLowerCase(), symbol: (sym || 'TOKEN').trim().slice(0, 12), decimals: Number(dec || 0) };
        if (!/^[0-9a-f]{64}$/.test(token.category)) throw new Error('Token category must be 64 hex characters.');
      }
      const raw = String(d.get('amount')).trim();
      const amount = token ? BigInt(Math.round(Number(raw) * 10 ** token.decimals)) : BigInt(Math.round(Number(raw)));
      const plan: Plan = { v: 1, ...(token ? { token } : {}), net: d.get('chipnet') ? 'chipnet' : 'mainnet', merchant: String(d.get('merchant')).trim(),
        amount, period: Number(d.get('period')), periods: Number(d.get('periods')), label: String(d.get('label')).trim() };
      validatePlan(plan);
      const link = `${location.origin}${location.pathname}#/pay?p=${encodePlan(plan)}`;
      const out = document.getElementById('out')!;
      out.hidden = false; err.hidden = true;
      out.innerHTML = `<p>Share this link with your subscribers:</p><input readonly value="${esc(link)}" onclick="this.select()" />
        <p class="muted">${esc(plan.label)}: ${formatAmount(plan, plan.amount)} ${periodText(plan.period)}; the subscriber prepays ${plan.periods} periods (${prepayText(plan)}).</p>`;
    } catch (x: any) { err.hidden = false; err.textContent = x.message; }
  });
}

// ---- subscriber: pay -------------------------------------------------------
function prepayText(plan: Plan) {
  return plan.token ? `${formatAmount(plan, fundingTokens(plan))} plus ${sats(fundingTotal(plan))} of BCH for network fees`
    : `${sats(fundingTotal(plan))} including claim fees`;
}
function planCard(plan: Plan) {
  return `<div class="plan"><div class="label">${esc(plan.label)}</div>
    <div class="price">${esc(formatAmount(plan, plan.amount))} <span>${periodText(plan.period)}</span></div>
    <div class="muted">You prepay ${plan.periods} periods: ${esc(prepayText(plan))}. Pays to <code>${esc(plan.merchant)}</code>${plan.net === 'chipnet' ? ' on chipnet' : ''}.</div></div>`;
}

function renderPay() {
  let plan: Plan;
  try { plan = decodePlan(params().get('p') || ''); } catch (x: any) { app.innerHTML = `<section class="card"><p class="err">This pay link is not valid: ${esc(x.message)}</p></section>`; return; }
  document.getElementById('netbadge')!.textContent = plan.net === 'chipnet' ? ' · chipnet' : '';
  app.innerHTML = `<section class="card">${planCard(plan)}<div id="wallet"></div><p class="err" id="err" hidden></p></section>`;
  const box = document.getElementById('wallet')!;
  const err = document.getElementById('err')!;
  const showErr = (m: string) => { err.hidden = false; err.textContent = m; };

  const connected = (w: WalletInfo) => {
    box.innerHTML = `<p class="ok">Connected: ${esc(w.name)} · <code>${esc(w.address)}</code></p>
      <ol class="next"><li>Your wallet asks you to approve one transaction that funds the order.</li>
      <li>After each period the merchant is paid exactly ${esc(formatAmount(plan, plan.amount))}, automatically.</li>
      <li>You can cancel from the order page at any time and get the rest back.</li></ol>
      <button class="btn primary" id="sub">Subscribe</button>`;
    document.getElementById('sub')!.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true; btn.textContent = 'Check your wallet...'; err.hidden = true;
      try {
        const oid = newOrderId();
        const { wc, inputPaths } = await buildFund(plan, w.address, w.hash, oid);
        const hex = await session.sign(wc, inputPaths);
        const txid = await broadcast(plan.net, hex);
        // register the order so the relayer can collect due payments for the merchant (best effort, never blocks)
        fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: params().get('p'), s: binToHex(w.hash), o: binToHex(oid) }) }).catch(() => {});
        location.hash = `#/order?p=${params().get('p')}&s=${binToHex(w.hash)}&o=${binToHex(oid)}&tx=${txid}`;
      } catch (x: any) { showErr(x.message || String(x)); btn.disabled = false; btn.textContent = 'Subscribe'; }
    });
  };
  const connect = () => {
    box.innerHTML = `<div class="connect"><canvas id="qr"></canvas><div>
      <p><b>Connect your wallet</b><br/>Scan with a WizardConnect wallet (Selene, Paytaca...) or open it on this device.</p>
      <a class="btn" id="open">Open wallet app</a> <button class="btn ghost" id="copy">Copy link</button>
      <p class="muted" id="st">Waiting for your wallet...</p></div></div>`;
    const uri = session.start(plan.net, (s) => { const st = document.getElementById('st'); if (st && s) st.textContent = s === 'connected' ? 'Relay connected. Approve in your wallet...' : `Relay: ${s}`; },
      connected, () => connect());
    QRCode.toCanvas(document.getElementById('qr') as HTMLCanvasElement, uri, { width: 200, margin: 1 });
    (document.getElementById('open') as HTMLAnchorElement).href = uri;
    document.getElementById('copy')!.addEventListener('click', () => navigator.clipboard?.writeText(uri));
  };
  connect();
}

// ---- order status ----------------------------------------------------------
async function renderOrder() {
  const p = params();
  let plan: Plan; let sub: Uint8Array; let oid: Uint8Array;
  try { plan = decodePlan(p.get('p') || ''); sub = hexToBin(p.get('s') || ''); oid = hexToBin(p.get('o') || ''); if (sub.length !== 20 || oid.length !== 8) throw new Error('bad order'); }
  catch (x: any) { app.innerHTML = `<section class="card"><p class="err">This order link is not valid.</p></section>`; return; }
  merchantHash(plan.merchant, plan.net);
  const tx = p.get('tx');
  app.innerHTML = `<section class="card">${planCard(plan)}
    ${tx ? `<p class="ok" id="started">Order started. <a href="${explorer(plan.net, tx)}" target="_blank" rel="noopener">View transaction</a></p>` : ''}
    <div id="state" class="state">Loading order...</div>
    <div class="actions"><button class="btn" id="collect">Collect due payment</button> <button class="btn ghost" id="cancel">Cancel order</button></div>
    <p class="err" id="err" hidden></p><p class="muted" id="msg"></p></section>`;
  const stateEl = document.getElementById('state')!, err = document.getElementById('err')!, msg = document.getElementById('msg')!;
  const refresh = async () => {
    try {
      const s = await orderState(plan, sub, oid);
      stateEl.innerHTML = `<div class="kv"><span>Left in the order</span><b>${esc(formatAmount(plan, s.balance))}</b></div>
        <div class="kv"><span>Periods left</span><b>${s.periodsLeft}</b></div>
        <div class="kv"><span>Next payment</span><b>${s.balance === 0n ? 'order closed' : s.utxoHeight === 0 ? 'after the funding confirms' : s.nextClaimIn === 0 ? 'due now' : `in ${s.nextClaimIn} block(s)`}</b></div>
        <div class="kv"><span>Contract</span><code>${esc(s.address)}</code></div>
        <details><summary>History (${s.history.length})</summary>${s.history.map((h) => `<div><a href="${explorer(plan.net, h.txid)}" target="_blank" rel="noopener">${h.txid.slice(0, 16)}...</a> ${h.height > 0 ? `block ${h.height}` : 'unconfirmed'}</div>`).join('')}</details>`;
      (document.getElementById('collect') as HTMLButtonElement).disabled = !(s.balance > 0n && s.utxoHeight > 0 && s.nextClaimIn === 0);
      (document.getElementById('cancel') as HTMLButtonElement).disabled = s.balance === 0n;
      const started = document.getElementById('started'); if (started) started.hidden = s.balance === 0n && s.history.length > 1;
    } catch (x: any) { stateEl.textContent = `Could not load the order: ${x.message}`; }
  };
  document.getElementById('collect')!.addEventListener('click', async () => {
    err.hidden = true;
    try { const t = await claimDue(plan, sub, oid); msg.innerHTML = `Payment sent to the merchant. <a href="${explorer(plan.net, t)}" target="_blank" rel="noopener">View</a>`; refresh(); }
    catch (x: any) { err.hidden = false; err.textContent = /rejected/.test(x.message) ? 'Not due yet: the network refuses a claim before the period has passed.' : x.message; }
  });
  document.getElementById('cancel')!.addEventListener('click', async () => {
    err.hidden = true;
    if (!session.wallet) { err.hidden = false; err.textContent = 'Open the pay link again and connect the subscriber wallet to cancel.'; return; }
    try {
      const { wc, inputPaths } = await buildCancel(plan, session.wallet.address, sub, oid);
      const t = await broadcast(plan.net, await session.sign(wc, inputPaths));
      msg.innerHTML = `Cancelled; the rest is back in your wallet. <a href="${explorer(plan.net, t)}" target="_blank" rel="noopener">View</a>`; refresh();
    } catch (x: any) { err.hidden = false; err.textContent = x.message; }
  });
  refresh();
  const timer = setInterval(() => { if (!location.hash.startsWith('#/order')) clearInterval(timer); else refresh(); }, 30_000);
}

// ---- merchant: orders paying an address ------------------------------------
async function renderMerchant() {
  const addr = (params().get('addr') || '').trim();
  app.innerHTML = `<section class="card"><h2>Your subscribers</h2>
    <form id="mf" class="form"><label>Your receiving address <input name="addr" value="${esc(addr)}" placeholder="bitcoincash:q..." required /></label>
    <button class="btn" type="submit">Show orders</button></form><div id="ml" class="state"></div></section>`;
  (document.getElementById('mf') as HTMLFormElement).addEventListener('submit', (e) => {
    e.preventDefault(); location.hash = `#/merchant?addr=${encodeURIComponent(String(new FormData(e.target as HTMLFormElement).get('addr')).trim())}`;
  });
  if (!addr) return;
  const list = document.getElementById('ml')!;
  list.textContent = 'Loading...';
  try {
    const r = await fetch(`/api/orders?merchant=${encodeURIComponent(addr)}`).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    if (!r.orders.length) { list.textContent = 'No orders yet for this address.'; return; }
    const rows = await Promise.all(r.orders.map(async (o: any) => {
      try {
        if (!o.o) return ''; const plan = decodePlan(o.p); const st = await orderState(plan, hexToBin(o.s), hexToBin(o.o));
        const due = st.balance > 0n && st.utxoHeight > 0 && st.nextClaimIn === 0;
        return `<div class="kv"><span>${esc(plan.label)} · ${esc(formatAmount(plan, plan.amount))} ${periodText(plan.period)}</span>
          <b>${st.balance === 0n ? 'closed' : `${esc(formatAmount(plan, st.balance))} left${due ? ' · due' : ''}`}</b></div>
          <div class="muted"><a href="#/order?p=${o.p}&s=${o.s}&o=${o.o}">open order</a></div>`;
      } catch { return ''; }
    }));
    list.innerHTML = rows.join('') || 'No valid orders.';
  } catch (x: any) { list.textContent = `Could not load orders: ${x.message}`; }
}

render();
