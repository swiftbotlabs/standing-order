// Chain logic for Standing Order: plans, the covenant, and the fund / claim / cancel transactions.
import {
  binToHex, hexToBin, hash160, hash256, stringify, encodeTransaction, cashAddressToLockingBytecode, decodeCashAddress, encodeCashAddress,
} from '@bitauth/libauth';
import { Contract, TransactionBuilder } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import {
  placeholderP2PKHUnlocker,
} from '@solidcash/solidcash/walletconnect';
import artifact from './standing_order.json';
import tokenArtifact from './standing_order_token.json';
import plusArtifact from './standing_order_plus.json';     // v2 BCH orders: split payout, pause/resume, top-up, plan change
import pausedArtifact from './paused_order.json';

export type Net = 'mainnet' | 'chipnet';
export const MAX_FEE = 1_000n;          // the most a claim / cancel may pay miners (sats)
export const DUST = 800n;               // never leave an output below this

export interface TokenSpec { category: string; symbol: string; decimals: number }   // category in wallet/display byte order
export const PUSD: TokenSpec = { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', symbol: 'PUSD', decimals: 2 }; // decimals: TO VERIFY (BCMR)
export const TOKEN_SATS_PER_PERIOD = DUST + MAX_FEE;   // BCH the token order keeps for each claim (dust to merchant + fee)

export interface Split { to: string; amount: bigint }   // a second payee each period (co-creator, affiliate, platform)
export interface Plan {
  v: 1 | 2;               // 1 = StandingOrder (old links), 2 = StandingOrderPlus (BCH: pause/resume, top-up, split)
  split?: Split;
  token?: TokenSpec;      // absent = the order is in BCH; present = amount is in token base units
  net: Net;
  merchant: string;       // merchant cashaddr (p2pkh)
  amount: bigint;         // sats per period
  period: number;         // blocks between claims
  periods: number;        // periods prefunded by the subscriber
  label: string;          // what the subscription is for
}

// ---- plan <-> link ---------------------------------------------------------
export function encodePlan(p: Plan): string {
  const json = JSON.stringify({ ...p, amount: p.amount.toString(), ...(p.split ? { split: { to: p.split.to, amount: p.split.amount.toString() } } : {}) });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodePlan(s: string): Plan {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
  const token = o.token && /^[0-9a-f]{64}$/.test(String(o.token.category)) ? { category: String(o.token.category), symbol: String(o.token.symbol || 'TOKEN').slice(0, 12), decimals: Math.max(0, Math.min(8, Number(o.token.decimals) || 0)) } : undefined;
  const v2 = o.v === 2 && !token;
  const split = v2 && o.split && BigInt(o.split.amount) > 0n ? { to: String(o.split.to), amount: BigInt(o.split.amount) } : undefined;
  const plan: Plan = { v: v2 ? 2 : 1, ...(token ? { token } : {}), ...(split ? { split } : {}), net: o.net === 'chipnet' ? 'chipnet' : 'mainnet', merchant: String(o.merchant),
    amount: BigInt(o.amount), period: Number(o.period), periods: Number(o.periods), label: String(o.label || '').slice(0, 80) };
  validatePlan(plan);
  return plan;
}
export function validatePlan(p: Plan): void {
  merchantHash(p.merchant, p.net);  // throws if not a p2pkh address on this network
  if (!p.token && p.amount < 1_000n) throw new Error('Amount per period must be at least 1,000 sats.');
  if (p.token && p.amount < 1n) throw new Error('Amount per period must be at least one token unit.');
  if (!Number.isInteger(p.period) || p.period < 1 || p.period > 65_535) throw new Error('Period must be 1 to 65,535 blocks.');
  if (!Number.isInteger(p.periods) || p.periods < 1 || p.periods > 120) throw new Error('Prepay 1 to 120 periods.');
  if (p.split) {
    if (p.v !== 2 || p.token) throw new Error('A split needs a BCH plan.');
    merchantHash(p.split.to, p.net);
    if (p.split.amount < 1_000n) throw new Error('A split must be at least 1,000 sats per period.');
  }
}
export const isPlus = (p: Plan) => p.v === 2 && !p.token;
// v2 claim transactions carry a ~1 kB redeem script, so v2 orders allow up to 2,000 sats of fee per claim.
export const PLUS_MAX_FEE = 2_000n;
export const feeOf = (p: Plan) => (isPlus(p) ? PLUS_MAX_FEE : MAX_FEE);
export const perPeriod = (p: Plan) => p.amount + (p.split?.amount ?? 0n);
export function merchantHash(addr: string, net: Net): Uint8Array {
  const prefix = net === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const a = addr.includes(':') ? addr : `${prefix}:${addr}`;
  const d = decodeCashAddress(a);
  if (typeof d === 'string') throw new Error('That is not a valid Bitcoin Cash address.');
  if (d.prefix !== prefix) throw new Error(`Use a ${net} address (${prefix}:...).`);
  if (d.type !== 'p2pkh' && d.type !== 'p2pkhWithTokens') throw new Error('Use a normal (P2PKH) wallet address.');
  return d.payload;
}
export function addressOfHash(h: Uint8Array, net: Net): string {
  const r = encodeCashAddress({ prefix: net === 'mainnet' ? 'bitcoincash' : 'bchtest', type: 'p2pkh', payload: h });
  return typeof r === 'string' ? r : r.address;
}

// ---- provider + contract ---------------------------------------------------
const providers = new Map<Net, ElectrumNetworkProvider>();
export function provider(net: Net): ElectrumNetworkProvider {
  if (!providers.has(net)) providers.set(net, new ElectrumNetworkProvider(net));
  return providers.get(net)!;
}
export function newOrderId(): Uint8Array { return crypto.getRandomValues(new Uint8Array(8)); }
export function orderContract(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Contract {
  if (plan.token) {
    // the covenant compares tokenCategory in the opposite byte order to the wallet/display hex (SolidCash finding 4)
    return new Contract(tokenArtifact as any,
      [merchantHash(plan.merchant, plan.net), subscriberHash, hexToBin(plan.token.category).reverse(), plan.amount,
        BigInt(plan.period), DUST, MAX_FEE, orderId],
      { provider: provider(plan.net) });
  }
  if (isPlus(plan)) {
    return new Contract(plusArtifact as any,
      [merchantHash(plan.merchant, plan.net), subscriberHash, plan.amount, BigInt(plan.period), PLUS_MAX_FEE,
        plan.split ? merchantHash(plan.split.to, plan.net) : new Uint8Array(20), plan.split?.amount ?? 0n, orderId],
      { provider: provider(plan.net) });
  }
  return new Contract(artifact as any,
    [merchantHash(plan.merchant, plan.net), subscriberHash, plan.amount, BigInt(plan.period), MAX_FEE, orderId],
    { provider: provider(plan.net) });
}
// Where a paused v2 order waits: PausedOrder(subscriber, hash256(order redeem script)). Only resume() back or cancel().
export function pausedContract(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Contract {
  const order = orderContract(plan, subscriberHash, orderId);
  return new Contract(pausedArtifact as any, [subscriberHash, hash256(hexToBin(order.bytecode))], { provider: provider(plan.net) });
}
export function fundingTotal(plan: Plan): bigint {
  // BCH order: every claim may spend up to MAX_FEE, so prefund amount + fee per period.
  // Token order: this is the BCH fee pool the order keeps (dust for each payout + fee), plus one dust for the last claim.
  return plan.token ? TOKEN_SATS_PER_PERIOD * BigInt(plan.periods) + DUST : (perPeriod(plan) + feeOf(plan)) * BigInt(plan.periods);
}
export const fundingTokens = (plan: Plan): bigint => plan.token ? plan.amount * BigInt(plan.periods) : 0n;
export function tokenAddressOfHash(h: Uint8Array, net: Net): string {
  const r = encodeCashAddress({ prefix: net === 'mainnet' ? 'bitcoincash' : 'bchtest', type: 'p2pkhWithTokens', payload: h });
  return typeof r === 'string' ? r : r.address;
}
export function formatAmount(plan: Plan, n: bigint): string {
  if (!plan.token) return `${n.toLocaleString()} sats`;
  const d = plan.token.decimals, base = 10n ** BigInt(d);
  const whole = n / base, frac = (n % base).toString().padStart(d, '0');
  return `${whole.toLocaleString()}${d ? '.' + frac : ''} ${plan.token.symbol}`;
}

// ---- WizardConnect wire helpers (why: README, "Wallets and WizardConnect") --------
// Wire format: the unsigned transaction as hex (every wallet decodes that; Paytaca does not read the object form),
// the rest as libauth extended JSON.
export const toWire = (wc: any) => JSON.parse(stringify({ ...wc, transaction: binToHex(encodeTransaction(wc.transaction)) }));

// ---- transactions ----------------------------------------------------------
export async function buildFund(plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array) {
  if (plan.token) return buildFundToken(plan, subscriberAddr, subscriberHash, orderId);
  const net = provider(plan.net);
  const utxos = (await net.getUtxos(subscriberAddr)).filter((u: any) => !u.token);
  const total = utxos.reduce((a: bigint, u: any) => a + u.satoshis, 0n);
  const fund = fundingTotal(plan);
  const fee = 400n + 150n * BigInt(utxos.length);
  const change = total - fund - fee;
  if (change < 0n) throw new Error(`Your wallet needs ${(fund + fee).toLocaleString()} sats; it has ${total.toLocaleString()}.`);
  const contract = orderContract(plan, subscriberHash, orderId);
  let b = new TransactionBuilder({ provider: net })
    .addInputs(utxos, placeholderP2PKHUnlocker(subscriberAddr))
    .addOutput({ to: contract.address, amount: fund });
  if (change >= DUST) b = b.addOutput({ to: subscriberAddr, amount: change });
  const wc = b.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Start a standing order: ${plan.amount.toLocaleString()} sats every ${plan.period} block(s) for "${plan.label}"`,
  });
  return { wc: toWire(wc), inputPaths: utxos.map((_: any, i: number) => [i, 'receive', 0]) as [number, string, number][], contract };
}

async function buildFundToken(plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array) {
  const net = provider(plan.net);
  const cat = plan.token!.category;
  const all = await net.getUtxos(subscriberAddr);
  const tok = all.filter((u: any) => u.token?.category === cat && !u.token?.nft);
  const bch = all.filter((u: any) => !u.token);
  const needTok = fundingTokens(plan), needSats = fundingTotal(plan);
  const haveTok = tok.reduce((a: bigint, u: any) => a + u.token.amount, 0n);
  if (haveTok < needTok) throw new Error(`Your wallet needs ${formatAmount(plan, needTok)}; it has ${formatAmount(plan, haveTok)}.`);
  const inputs = [...tok, ...bch];
  const satsIn = inputs.reduce((a: bigint, u: any) => a + u.satoshis, 0n);
  const fee = 500n + 150n * BigInt(inputs.length);
  const tokChange = haveTok - needTok;
  const tokChangeSats = tokChange > 0n ? DUST : 0n;
  const bchChange = satsIn - needSats - tokChangeSats - fee;
  if (bchChange < 0n) throw new Error(`Your wallet needs about ${(needSats + tokChangeSats + fee).toLocaleString()} sats of BCH for fees; it has ${satsIn.toLocaleString()}.`);
  const contract = orderContract(plan, subscriberHash, orderId);
  let b = new TransactionBuilder({ provider: net })
    .addInputs(inputs, placeholderP2PKHUnlocker(subscriberAddr))
    .addOutput({ to: contract.tokenAddress, amount: needSats, token: { category: cat, amount: needTok } });
  if (tokChange > 0n) b = b.addOutput({ to: tokenAddressOfHash(subscriberHash, plan.net), amount: tokChangeSats, token: { category: cat, amount: tokChange } });
  if (bchChange >= DUST) b = b.addOutput({ to: subscriberAddr, amount: bchChange });
  const wc = b.generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Start a standing order: ${formatAmount(plan, plan.amount)} every ${plan.period} block(s) for "${plan.label}"`,
  });
  return { wc: toWire(wc), inputPaths: inputs.map((_: any, i: number) => [i, 'receive', 0]) as [number, string, number][], contract };
}

// Anyone can send junk (dust, foreign tokens, NFTs) to a covenant address. Only coins that match the plan count as
// the order; the "main" coin is the one holding the most of the plan's asset.
export function orderUtxos(plan: Plan, utxos: any[]): any[] {
  return plan.token
    ? utxos.filter((u) => u.token?.category === plan.token!.category && !u.token?.nft && u.token.amount > 0n)
    : utxos.filter((u) => u.satoshis >= perPeriod(plan));   // by value: stray dust is ignored, an attached token is not a reason to lose the order
}
// Spending an order coin someone attached a token to: the builder must be told the token is dropped on purpose.
const burnOk = { allowImplicitFungibleTokenBurn: true, allowImplicitNftBurn: true } as any;
export function mainUtxo(plan: Plan, utxos: any[]): any | undefined {
  const key = (u: any) => (plan.token ? u.token.amount : u.satoshis) as bigint;
  return orderUtxos(plan, utxos).sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0))[0];
}

export async function buildCancel(plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array) {
  let contract = orderContract(plan, subscriberHash, orderId);
  let utxos = orderUtxos(plan, await contract.getUtxos()).slice(0, 20);
  if (!utxos.length && isPlus(plan)) {   // a paused v2 order is cancelled from its paused covenant
    contract = pausedContract(plan, subscriberHash, orderId);
    utxos = orderUtxos(plan, await contract.getUtxos()).slice(0, 20);
  }
  if (!utxos.length) throw new Error('Nothing left in this order.');
  const net = provider(plan.net);
  // The subscriber authorizes a cancel by spending one of their own plain BCH coins as the LAST input. The wallet
  // signs that coin like any payment, so every BCH wallet can cancel; the covenant inputs need no signature.
  // Prefer the smallest confirmed coin of at least 1,000 sats; fall back to the largest coin.
  const own = (await net.getUtxos(subscriberAddr)).filter((u: any) => !u.token);
  if (!own.length) throw new Error(`To cancel, your wallet needs a little plain BCH at ${subscriberAddr}; it proves the cancel is yours and comes back in the same transaction.`);
  const bySats = (a: any, b: any) => (a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0);
  const good = own.filter((u: any) => (u.height ?? 0) > 0 && u.satoshis >= 1000n).sort(bySats);
  const key = good[0] ?? own.sort(bySats)[own.length - 1];
  let b = new TransactionBuilder({ provider: net, ...burnOk });
  let total = 0n;
  for (const u of utxos) { b = b.addInput(u, contract.unlock.cancel()); total += u.satoshis; }
  b = b.addInput(key, placeholderP2PKHUnlocker(subscriberAddr));
  total += key.satoshis;
  // Fee at a little over 1 sat/byte: each covenant input carries its redeem script (~250 bytes v1 BCH, ~322 token, ~850 v2).
  const back = total - 400n - BigInt(contract.bytecode.length / 2 + 80) * BigInt(utxos.length);
  if (plan.token) {
    const tokens = utxos.reduce((a: bigint, u: any) => a + u.token.amount, 0n);
    b = b.addOutput({ to: tokenAddressOfHash(subscriberHash, plan.net), amount: back, token: { category: plan.token.category, amount: tokens } });
  } else b = b.addOutput({ to: subscriberAddr, amount: back });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: 'Cancel the standing order and take back what is left' });
  return { wc: toWire(wc), inputPaths: [[utxos.length, 'receive', 0]] as [number, string, number][] };
}

// The subscriber's own plain coin that authorizes pause / resume (spent as the LAST input; it comes back as change).
async function subscriberCoin(plan: Plan, subscriberAddr: string) {
  const own = (await provider(plan.net).getUtxos(subscriberAddr)).filter((u: any) => !u.token);
  if (!own.length) throw new Error(`Your wallet needs a little plain BCH at ${subscriberAddr}; it proves the request is yours and comes back in the same transaction.`);
  const bySats = (a: any, b: any) => (a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0);
  const good = own.filter((u: any) => (u.height ?? 0) > 0 && u.satoshis >= 2000n).sort(bySats);
  return good[0] ?? own.sort(bySats)[own.length - 1];
}
// v2 pause (pays the period in progress, the rest -> this order's paused covenant) or resume (paused covenant -> the same
// order; the next claim waits one full period). The fee comes out of the subscriber's coin.
export async function buildPauseResume(kind: 'pause' | 'resume', plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array) {
  if (!isPlus(plan)) throw new Error('This order type cannot be paused.');
  const order = orderContract(plan, subscriberHash, orderId), paused = pausedContract(plan, subscriberHash, orderId);
  const from = kind === 'pause' ? order : paused, to = kind === 'pause' ? paused : order;
  const u = mainUtxo(plan, await from.getUtxos());
  if (!u) throw new Error(kind === 'pause' ? 'Nothing to pause.' : 'This order is not paused.');
  const fee = feeOf(plan);
  if (kind === 'pause' && u.satoshis - perPeriod(plan) - fee < perPeriod(plan) + fee)
    throw new Error('Less than two periods are left, so there is nothing to pause: let it finish or cancel.');
  const key = await subscriberCoin(plan, subscriberAddr);
  const txFee = BigInt(from.bytecode.length / 2) + 600n;   // ~1 sat/byte: the covenant input carries its redeem script
  let b = new TransactionBuilder({ provider: provider(plan.net), ...burnOk })
    .addInput(u, kind === 'pause' ? order.unlock.pause() : paused.unlock.resume())
    .addInput(key, placeholderP2PKHUnlocker(subscriberAddr));
  let rest = u.satoshis;
  if (kind === 'pause') {   // the period in progress is paid first, so pausing never delays the merchant
    b = b.addOutput({ to: addressOfHash(merchantHash(plan.merchant, plan.net), plan.net), amount: plan.amount });
    if (plan.split) b = b.addOutput({ to: addressOfHash(merchantHash(plan.split.to, plan.net), plan.net), amount: plan.split.amount });
    rest = u.satoshis - perPeriod(plan);
  }
  if (key.satoshis - txFee >= DUST) b = b.addOutput({ to: to.address, amount: rest }).addOutput({ to: subscriberAddr, amount: key.satoshis - txFee });
  else b = b.addOutput({ to: to.address, amount: rest + key.satoshis - txFee });
  const wc = b.generateWcTransactionObject({ broadcast: false,
    userPrompt: kind === 'pause' ? 'Pause the standing order (pays the current period, then no payments until you resume)' : 'Resume the standing order' });
  return { wc: toWire(wc), inputPaths: [[1, 'receive', 0]] as [number, string, number][] };
}
// v2 top-up: pays the period in progress and adds `periods` more (the order ends with more than it had).
export async function buildTopUp(plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array, periods = 1) {
  if (!isPlus(plan)) throw new Error('This order type cannot be topped up.');
  const order = orderContract(plan, subscriberHash, orderId);
  const u = mainUtxo(plan, await order.getUtxos());
  if (!u) throw new Error('Nothing in this order to top up (it may be paused or finished).');
  const per = perPeriod(plan);
  const add = per + (per + feeOf(plan)) * BigInt(periods);   // replaces the period paid now, plus the new periods
  const own = (await provider(plan.net).getUtxos(subscriberAddr)).filter((x: any) => !x.token);
  const total = own.reduce((a: bigint, x: any) => a + x.satoshis, 0n);
  const txFee = BigInt(order.bytecode.length / 2) + 400n + 150n * BigInt(own.length);
  const change = total - add - txFee;
  if (change < 0n) throw new Error(`Your wallet needs ${(add + txFee).toLocaleString()} sats; it has ${total.toLocaleString()}.`);
  let b = new TransactionBuilder({ provider: provider(plan.net), ...burnOk }).addInput(u, order.unlock.topUp())
    .addInputs(own, placeholderP2PKHUnlocker(subscriberAddr))
    .addOutput({ to: addressOfHash(merchantHash(plan.merchant, plan.net), plan.net), amount: plan.amount });
  if (plan.split) b = b.addOutput({ to: addressOfHash(merchantHash(plan.split.to, plan.net), plan.net), amount: plan.split.amount });
  b = b.addOutput({ to: order.address, amount: u.satoshis - per + add });
  if (change >= DUST) b = b.addOutput({ to: subscriberAddr, amount: change });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: `Pay this period now and add ${periods} more to the standing order` });
  return { wc: toWire(wc), inputPaths: own.map((_: any, i: number) => [i + 1, 'receive', 0]) as [number, string, number][] };
}

// Anyone may claim a due period: no signature, so the page itself can broadcast it.
export async function claimDue(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Promise<string> {
  const contract = orderContract(plan, subscriberHash, orderId);
  const u = mainUtxo(plan, await contract.getUtxos());
  if (!u) throw new Error('Nothing left in this order.');
  const merchant = addressOfHash(merchantHash(plan.merchant, plan.net), plan.net);
  if (plan.token) {
    const cat = plan.token.category, left = u.token?.amount ?? 0n;
    const mTok = tokenAddressOfHash(merchantHash(plan.merchant, plan.net), plan.net);
    let t = new TransactionBuilder({ provider: provider(plan.net) }).addInput(u, contract.unlock.claim(), { sequence: plan.period });
    if (left <= plan.amount) t = t.addOutput({ to: mTok, amount: u.satoshis - MAX_FEE, token: { category: cat, amount: left } });
    else t = t.addOutput({ to: mTok, amount: DUST, token: { category: cat, amount: plan.amount } })
      .addOutput({ to: contract.tokenAddress, amount: u.satoshis - DUST - MAX_FEE, token: { category: cat, amount: left - plan.amount } });
    return (await t.send()).txid;
  }
  const per = perPeriod(plan), fee = feeOf(plan), change = u.satoshis - per - fee;
  let b = new TransactionBuilder({ provider: provider(plan.net), ...burnOk })
    .addInput(u, contract.unlock.claim(), { sequence: plan.period });
  if (change < per + fee) {
    // last claim; a v2 split payee still gets its share when the rest covers it
    if (isPlus(plan) && plan.split && u.satoshis - fee >= per)
      b = b.addOutput({ to: merchant, amount: u.satoshis - fee - plan.split.amount })
        .addOutput({ to: addressOfHash(merchantHash(plan.split.to, plan.net), plan.net), amount: plan.split.amount });
    else b = b.addOutput({ to: merchant, amount: u.satoshis - fee });
  } else {
    b = b.addOutput({ to: merchant, amount: plan.amount });
    if (plan.split) b = b.addOutput({ to: addressOfHash(merchantHash(plan.split.to, plan.net), plan.net), amount: plan.split.amount });
    b = b.addOutput({ to: contract.address, amount: change });
  }
  const r = await b.send();
  return r.txid;
}

export interface OrderState {
  address: string;
  balance: bigint;          // sats (BCH order) or token units (token order)
  sats: bigint;
  utxoHeight: number;        // 0 = unconfirmed
  tip: number;
  nextClaimIn: number;       // blocks until the next claim is allowed (0 = due now)
  periodsLeft: number;
  paused: boolean;           // v2: the balance sits in the paused covenant (no claims until resumed)
  closed: boolean;           // was funded and holds nothing now (claimed out or cancelled)
  history: { txid: string; height: number }[];
}
export async function orderState(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Promise<OrderState> {
  let contract = orderContract(plan, subscriberHash, orderId);
  const net = provider(plan.net);
  const getHistory = (address: string) => (net as any).performRequest('blockchain.address.get_history', address).catch(() => []);
  let paused = false;
  let pausedHistory: any[] = [];
  if (isPlus(plan) && !orderUtxos(plan, await contract.getUtxos()).length) {
    const p = pausedContract(plan, subscriberHash, orderId);
    if (orderUtxos(plan, await p.getUtxos()).length) { contract = p; paused = true; }
    else pausedHistory = await getHistory(p.address);   // closed or empty: was it last held by the paused covenant?
  }
  const [utxos, tip, history] = await Promise.all([contract.getUtxos(), net.getBlockHeight(), getHistory(contract.address)]);
  // A v2 order lives at two addresses (order and paused covenant): show one history, and for a closed order the contract that held it last.
  const pending = (h: number) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
  const lastHeight = (hs: any[]) => hs.reduce((m: number, x: any) => Math.max(m, pending(x.height)), -1);
  let address = plan.token ? contract.tokenAddress : contract.address;
  if (pausedHistory.length && lastHeight(pausedHistory) >= lastHeight(history as any[])) address = pausedContract(plan, subscriberHash, orderId).address;
  const allHistory = [...(history as any[]), ...pausedHistory.filter((x: any) => !(history as any[]).some((y: any) => y.tx_hash === x.tx_hash))]
    .sort((a: any, b: any) => pending(a.height) - pending(b.height));
  const mine = orderUtxos(plan, utxos);
  const u = mainUtxo(plan, utxos);
  const sats = mine.reduce((a: bigint, x: any) => a + x.satoshis, 0n);
  const balance = plan.token ? mine.reduce((a: bigint, x: any) => a + x.token.amount, 0n) : sats;
  let utxoHeight = 0;
  if (u) {
    const h = (history as any[]).find((x) => x.tx_hash === u.txid);
    utxoHeight = h && h.height > 0 ? h.height : 0;
  }
  const nextClaimIn = !u || paused ? 0 : utxoHeight === 0 ? plan.period : Math.max(0, utxoHeight + plan.period - (tip + 1));
  const per = perPeriod(plan);
  const periodsLeft = plan.token
    ? Number((balance + plan.amount - 1n) / plan.amount)
    : Number(balance / (per + feeOf(plan))) + (balance % (per + feeOf(plan)) > feeOf(plan) ? 1 : 0);
  return { address, balance, sats, utxoHeight, tip, nextClaimIn, periodsLeft, paused,
    closed: balance === 0n && allHistory.length > 0,
    history: allHistory.map((x: any) => ({ txid: x.tx_hash, height: x.height })).reverse() };
}

export async function broadcast(net: Net, hex: string): Promise<string> {
  return provider(net).sendRawTransaction(hex);
}
export { hash160, cashAddressToLockingBytecode };
