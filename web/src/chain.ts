// Chain logic for Standing Order: plans, the covenant, and the fund / claim / cancel transactions.
import {
  binToHex, hexToBin, hash160, stringify, cashAddressToLockingBytecode, decodeCashAddress, encodeCashAddress,
} from '@bitauth/libauth';
import { Contract, TransactionBuilder } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import {
  placeholderP2PKHUnlocker, placeholderPublicKey, placeholderSignature,
} from '@solidcash/solidcash/walletconnect';
import artifact from './standing_order.json';
import tokenArtifact from './standing_order_token.json';

export type Net = 'mainnet' | 'chipnet';
export const MAX_FEE = 1_000n;          // the most a claim / cancel may pay miners (sats)
export const DUST = 800n;               // never leave an output below this

export interface TokenSpec { category: string; symbol: string; decimals: number }   // category in wallet/display byte order
export const PUSD: TokenSpec = { category: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544', symbol: 'PUSD', decimals: 2 }; // decimals: TO VERIFY (BCMR)
export const TOKEN_SATS_PER_PERIOD = DUST + MAX_FEE;   // BCH the token order keeps for each claim (dust to merchant + fee)

export interface Plan {
  v: 1;
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
  const json = JSON.stringify({ ...p, amount: p.amount.toString() });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodePlan(s: string): Plan {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
  const token = o.token && /^[0-9a-f]{64}$/.test(String(o.token.category)) ? { category: String(o.token.category), symbol: String(o.token.symbol || 'TOKEN').slice(0, 12), decimals: Math.max(0, Math.min(8, Number(o.token.decimals) || 0)) } : undefined;
  const plan: Plan = { v: 1, ...(token ? { token } : {}), net: o.net === 'chipnet' ? 'chipnet' : 'mainnet', merchant: String(o.merchant),
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
}
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
  return new Contract(artifact as any,
    [merchantHash(plan.merchant, plan.net), subscriberHash, plan.amount, BigInt(plan.period), MAX_FEE, orderId],
    { provider: provider(plan.net) });
}
export function fundingTotal(plan: Plan): bigint {
  // BCH order: every claim may spend up to MAX_FEE, so prefund amount + fee per period.
  // Token order: this is the BCH fee pool the order keeps (dust for each payout + fee), plus one dust for the last claim.
  return plan.token ? TOKEN_SATS_PER_PERIOD * BigInt(plan.periods) + DUST : (plan.amount + MAX_FEE) * BigInt(plan.periods);
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

// ---- WizardConnect wire helpers (see /data/blaze/STATUS.md for why) --------
export const toWire = (o: unknown) => JSON.parse(stringify(o));
export function fixCoveredBytecode(wc: any): any {
  // SolidCash: a signature inside an OP_INVOKE'd function covers the FUNCTION BODY; wallets use contract.redeemScript.
  wc.sourceOutputs.forEach((so: any, i: number) => {
    if (!so.contract) return;
    const unl = binToHex(wc.transaction.inputs[i].unlockingBytecode);
    const sel = unl.startsWith('04') ? unl.slice(2, 10) : null;
    const bodies = (artifact as any).functionBodies as Record<string, string> | undefined;
    if (sel && bodies?.[sel]) so.contract.redeemScript = hexToBin(bodies[sel]);
  });
  return wc;
}

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

export async function buildCancel(plan: Plan, subscriberAddr: string, subscriberHash: Uint8Array, orderId: Uint8Array) {
  const contract = orderContract(plan, subscriberHash, orderId);
  const utxos = await contract.getUtxos();
  if (!utxos.length) throw new Error('Nothing left in this order.');
  let b = new TransactionBuilder({ provider: provider(plan.net) });
  let total = 0n;
  for (const u of utxos) { b = b.addInput(u, contract.unlock.cancel(placeholderPublicKey(), placeholderSignature())); total += u.satoshis; }
  const back = total - 300n - 200n * BigInt(utxos.length);
  if (plan.token) {
    const tokens = utxos.reduce((a: bigint, u: any) => a + (u.token?.amount ?? 0n), 0n);
    b = b.addOutput({ to: tokenAddressOfHash(subscriberHash, plan.net), amount: back, token: { category: plan.token.category, amount: tokens } });
  } else b = b.addOutput({ to: subscriberAddr, amount: back });
  const wc = fixCoveredBytecode(b.generateWcTransactionObject({ broadcast: false, userPrompt: 'Cancel the standing order and take back what is left' }));
  return { wc: toWire(wc), inputPaths: utxos.map((_: any, i: number) => [i, 'receive', 0]) as [number, string, number][] };
}

// Anyone may claim a due period: no signature, so the page itself can broadcast it.
export async function claimDue(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Promise<string> {
  const contract = orderContract(plan, subscriberHash, orderId);
  const [u] = await contract.getUtxos();
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
  const change = u.satoshis - plan.amount - MAX_FEE;
  let b = new TransactionBuilder({ provider: provider(plan.net) })
    .addInput(u, contract.unlock.claim(), { sequence: plan.period });
  if (change < plan.amount + MAX_FEE) b = b.addOutput({ to: merchant, amount: u.satoshis - MAX_FEE });
  else b = b.addOutput({ to: merchant, amount: plan.amount }).addOutput({ to: contract.address, amount: change });
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
  history: { txid: string; height: number }[];
}
export async function orderState(plan: Plan, subscriberHash: Uint8Array, orderId: Uint8Array): Promise<OrderState> {
  const contract = orderContract(plan, subscriberHash, orderId);
  const net = provider(plan.net);
  const [utxos, tip, history] = await Promise.all([
    contract.getUtxos(), net.getBlockHeight(),
    (net as any).performRequest('blockchain.address.get_history', contract.address).catch(() => []),
  ]);
  const u = utxos[0];
  const sats = utxos.reduce((a: bigint, x: any) => a + x.satoshis, 0n);
  const balance = plan.token ? utxos.reduce((a: bigint, x: any) => a + (x.token?.amount ?? 0n), 0n) : sats;
  let utxoHeight = 0;
  if (u) {
    const h = (history as any[]).find((x) => x.tx_hash === u.txid);
    utxoHeight = h && h.height > 0 ? h.height : 0;
  }
  const nextClaimIn = !u ? 0 : utxoHeight === 0 ? plan.period : Math.max(0, utxoHeight + plan.period - (tip + 1));
  const periodsLeft = plan.token
    ? Number((balance + plan.amount - 1n) / plan.amount)
    : Number(balance / (plan.amount + MAX_FEE)) + (balance % (plan.amount + MAX_FEE) > MAX_FEE ? 1 : 0);
  return { address: plan.token ? contract.tokenAddress : contract.address, balance, sats, utxoHeight, tip, nextClaimIn, periodsLeft,
    history: (history as any[]).map((x) => ({ txid: x.tx_hash, height: x.height })).reverse() };
}

export async function broadcast(net: Net, hex: string): Promise<string> {
  return provider(net).sendRawTransaction(hex);
}
export { hash160, cashAddressToLockingBytecode };
