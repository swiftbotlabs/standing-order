// Standing Order Worker: serves the dapp (static assets) and a tiny public order registry.
//   POST /api/orders   {p: <encoded plan>, s: <subscriber hash160 hex>}  -> register an order (validated, rate limited)
//   GET  /api/orders?merchant=<cashaddr>                                  -> orders paying that merchant
//   GET  /api/orders/all?cursor=<c>                                       -> page of all orders (for the relayer)
// Nothing here can move money: claims need no key and the covenant fixes amount and timing; the registry only says
// which orders exist. Untrusted input is size-capped, shape-checked and never interpreted.
const MAX_BODY = 4096;
const PER_IP_PER_DAY = 30;
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

function b64urlToJson(s) {
  if (typeof s !== 'string' || s.length < 10 || s.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad plan');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const txt = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  return JSON.parse(txt);
}
function checkPlan(o) {
  // shape only; the relayer re-validates fully (address checksum, contract on chain) before acting
  if (!o || o.v !== 1) throw new Error('bad plan');
  if (o.net !== 'mainnet' && o.net !== 'chipnet') throw new Error('bad net');
  const prefix = o.net === 'mainnet' ? 'bitcoincash:' : 'bchtest:';
  if (typeof o.merchant !== 'string' || !new RegExp(`^(${prefix})?[qpzr][0-9a-z]{41,60}$`).test(o.merchant)) throw new Error('bad merchant');
  if (!/^\d{1,18}$/.test(String(o.amount))) throw new Error('bad amount');
  if (!Number.isInteger(o.period) || o.period < 1 || o.period > 65535) throw new Error('bad period');
  if (!Number.isInteger(o.periods) || o.periods < 1 || o.periods > 120) throw new Error('bad periods');
  if (o.token && !/^[0-9a-f]{64}$/.test(String(o.token.category))) throw new Error('bad token');
  return { net: o.net, merchant: o.merchant.includes(':') ? o.merchant : prefix + o.merchant };
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (url.pathname === '/api/orders' && request.method === 'POST') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_BODY) return json({ error: 'too large' }, 413);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:${day}:${await sha256hex(ip)}`;
      const used = Number((await env.SO_ORDERS.get(rlKey)) || 0);
      if (used >= PER_IP_PER_DAY) return json({ error: 'rate limited' }, 429);
      let body;
      try { body = JSON.parse((await request.text()).slice(0, MAX_BODY)); } catch { return json({ error: 'bad json' }, 400); }
      try {
        if (typeof body.s !== 'string' || !/^[0-9a-f]{40}$/.test(body.s)) throw new Error('bad subscriber');
        const { net, merchant } = checkPlan(b64urlToJson(body.p));
        const id = (await sha256hex(`${body.p}|${body.s}`)).slice(0, 32);
        const rec = JSON.stringify({ p: body.p, s: body.s, net, merchant, t: Date.now() });
        await env.SO_ORDERS.put(`o:${id}`, rec);
        await env.SO_ORDERS.put(`m:${merchant}:${id}`, rec);
        await env.SO_ORDERS.put(rlKey, String(used + 1), { expirationTtl: 172800 });
        return json({ ok: true, id });
      } catch (e) { return json({ error: String(e.message || e) }, 400); }
    }

    if (url.pathname === '/api/orders' && request.method === 'GET') {
      const merchant = url.searchParams.get('merchant') || '';
      if (!/^(bitcoincash|bchtest):[qpzr][0-9a-z]{41,60}$/.test(merchant)) return json({ error: 'merchant=<cashaddr with prefix>' }, 400);
      const list = await env.SO_ORDERS.list({ prefix: `m:${merchant}:`, limit: 200 });
      const orders = await Promise.all(list.keys.map(async (k) => JSON.parse(await env.SO_ORDERS.get(k.name))));
      return json({ orders });
    }

    if (url.pathname === '/api/orders/all' && request.method === 'GET') {
      const list = await env.SO_ORDERS.list({ prefix: 'o:', limit: 200, cursor: url.searchParams.get('cursor') || undefined });
      const orders = await Promise.all(list.keys.map(async (k) => ({ id: k.name.slice(2), ...JSON.parse(await env.SO_ORDERS.get(k.name)) })));
      return json({ orders, cursor: list.list_complete ? null : list.cursor });
    }
    return json({ error: 'not found' }, 404);
  },
};
