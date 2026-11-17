// Standing Order Pool on a real chain (mainnet) or a full offline rehearsal (simulate).
// usage: node scripts/pool_run.mjs simulate | status | fund2 | prep | deploy | subscribe <sub|sub2> <periods> |
//        collect <periods> <sub|sub2>... | withdraw <sub|sub2> <periods> | release <sub|sub2> <periods> | leave <sub|sub2>
// v2 (recovery address + merchant release). The v1 run is kept in pool_mainnet.json/.log (contracts/v1/).
// Keys: the BLAZE wizard seed (SEED_FILE, never printed): sub = m/44'/145'/0'/0/0 (holds the BCH), sub2 = .../9/3,
// merchant = .../9/1 (the same merchant as the Plus mainnet run). All ours; tiny amounts. Pool facts -> pool_mainnet.json.
import fs from 'node:fs';
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, binToHex, hexToBin, encodeCashAddress } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { Signer, TransactionBuilder, SignatureTemplate } from '@solidcash/solidcash';
import { ElectrumNetworkProvider } from '@solidcash/solidcash/network/electrum';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { withLocktime } from '../src/locktime.mjs';

const PRICE = 2_000n, PERIOD = 1n, BASE = 1_000n, K = 65536n;     // 2,000 sats (~1 US cent) per one-block period
const STATE = process.env.POOL_STATE || 'pool_v2_mainnet.json', LOG = process.env.POOL_LOG || 'pool_v2_mainnet.log';
const [cmd, ...rest] = process.argv.slice(2);
const SIM = cmd === 'simulate';
const artifact = compileFile(new URL('../contracts/standing_order_pool.scash', import.meta.url));
const log = (...a) => { const l = [new Date().toISOString(), ...a].join(' '); console.log(l); if (!SIM) fs.appendFileSync(LOG, l + '\n'); };
const out = (r) => (r?.txid ? `${r.txid} https://blockchair.com/bitcoin-cash/transaction/${r.txid}` : String(r));

let provider, merchant, sub, sub2, backup;   // backup = the members' recovery wallet
const privs = new Map();   // live keys for leave() signatures (mock signers carry .privateKey)
if (SIM) {
  provider = new MockNetworkProvider({ profile: 'production' });
  [sub, merchant, sub2, backup] = await provider.getSigners(4, { fundingUtxos: 10, genesisFundingUtxos: 2 });
} else {
  provider = new ElectrumNetworkProvider('mainnet');
  const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE || '../.secrets/seed.hex', 'utf8').trim(), 'hex'));
  const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
  const key = (p) => deriveHdPathRelative(acct, p, { throwErrors: true }).privateKey;
  sub = new Signer(key('0/0'), provider); merchant = new Signer(key('9/1'), provider); sub2 = new Signer(key('9/3'), provider);
  backup = new Signer(key('9/4'), provider);
  privs.set(sub, key('0/0')); privs.set(sub2, key('9/3')); privs.set(merchant, key('9/1'));
}
const who = { sub, sub2 };
const pkh = (s) => hash160(s.publicKey);
const ctorArgs = () => [pkh(merchant), PRICE, PERIOD];
const saved = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
let poolCache;
const pool = () => (poolCache ??= StatefulContract.at(SIM ? simCategory : saved().categoryId, artifact, provider, { constructorArgs: ctorArgs() }));
let simCategory;
const coinsOf = async (s) => (await provider.getUtxos(s.getAddress())).filter((u) => !u.token);

// A CashTokens genesis must spend an outpoint with index 0. If sub has no plain coin at vout 0 (e.g. after fund2 put change at
// vout 1), prep() sends sub's largest coin to itself as the ONLY output (vout 0, ~250 sats fee). deploy() calls it when needed.
const GENESIS_MIN = 20_000n;
async function vout0Coin() {
  return (await coinsOf(sub)).filter((u) => u.vout === 0 && u.satoshis >= GENESIS_MIN).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
}
async function prep() {
  const have = await vout0Coin();
  if (have) { log('PREP not needed: vout-0 coin', `${have.txid.slice(0, 10)}:0 ${have.satoshis}`); return have; }
  const c = (await coinsOf(sub)).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  if (!c) throw new Error('sub has no coin to prep from');
  const r = await new TransactionBuilder({ provider }).addInput(c, sub.unlockP2PKH())
    .addOutput({ to: sub.getAddress(), amount: c.satoshis - 300n }).send();
  log('PREP self-send to vout 0', out(r));
  for (let i = 0; i < 30; i++) { const g = await vout0Coin(); if (g) return g; await new Promise((res) => setTimeout(res, 2000)); }
  throw new Error('prep coin not visible yet; run deploy again in a minute');
}
async function deploy() {
  const g = await prep();
  const r = await StatefulContract.deploy(artifact, ctorArgs(), {
    provider, fundingUtxo: g, funder: sub.unlockP2PKH(), changeAddress: sub.getAddress(), initialBalance: BASE,
  });
  const categoryId = r.categoryId;
  if (SIM) simCategory = categoryId; else fs.writeFileSync(STATE, JSON.stringify({ categoryId, address: r.contract.getAddress ? await r.contract.getAddress() : null, deployTx: r.tx?.txid ?? null, price: String(PRICE), period: String(PERIOD) }, null, 1));
  log('DEPLOYED category', categoryId, 'tx', r.tx?.txid ?? '?');
  poolCache = undefined;
}
async function status() {
  const p = await pool(); const st = await p.getState(); const h = await provider.getBlockHeight();
  const recs = {}; for (const [n, s] of Object.entries(who)) { const r = BigInt(await p.members(pkh(s))); recs[n] = r ? `nextDue ${r / K} left ${r % K}` : 'not a member'; }
  const coins = (await provider.getUtxos(p.satoshiContainer.address)).map((u) => u.satoshis);
  log(`height ${h} members ${st.memberCount} paidTotal ${st.paidTotal} pool coins [${coins.join(', ')}] ${JSON.stringify(recs)}`);
  return { h, recs };
}
async function subscribe(n, periods) {
  const p = await pool(); const h = await provider.getBlockHeight();
  const r = await p.connect(who[n]).call.subscribe(pkh(who[n]), pkh(backup), BigInt(h)).withValue(BigInt(periods) * PRICE).setLocktime(h).send();
  log('SUBSCRIBE', n, periods, 'periods', out(r)); return r;
}
async function collect(periods, names) {
  const p = await pool(); const h = await provider.getBlockHeight();
  // the covenant wants the keys in ascending order, compared as little-endian numbers (from the last byte)
  const ord = (a, b) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const keys = names.map((n) => pkh(who[n])).sort(ord);
  const r = await withLocktime(h, () => p.connect(merchant).call.collect(keys, BigInt(h), BigInt(periods)).setLocktime(h).send());
  log('COLLECT', periods, 'period(s) from', names.join('+'), out(r)); return r;
}
async function withdraw(n, periods) {
  const p = await pool();
  const r = await p.connect(who[n]).call.withdraw(pkh(who[n]), BigInt(periods)).send();
  log('WITHDRAW', n, periods, out(r)); return r;
}
async function fund2() {
  const c = (await coinsOf(sub)).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  const r = await new TransactionBuilder({ provider }).addInput(c, sub.unlockP2PKH())
    .addOutput({ to: sub.getAddress(), amount: c.satoshis - 60_000n - 500n }).addOutput({ to: sub2.getAddress(), amount: 60_000n }).send();   // change first: vout 0 stays a genesis coin
  log('FUND2 60000 to sub2', out(r)); return r;
}
async function release(n, periods) {   // key-loss path: the merchant signs; the covenant pays the member's recovery wallet only
  const p = await pool();
  const r = await p.connect(merchant).call.release(pkh(who[n]), BigInt(periods), merchant.publicKey, new SignatureTemplate(privs.get(merchant) ?? merchant.privateKey)).send();
  log('RELEASE', n, periods, 'to recovery', backup.getAddress(), out(r)); return r;
}
async function leave(n) {
  const p = await pool(); const s = who[n];
  const r = await p.connect(s).call.leave(pkh(s), s.publicKey, new SignatureTemplate(privs.get(s) ?? s.privateKey)).send();
  log('LEAVE', n, out(r)); return r;
}
const step = async (label, f) => { try { await f(); } catch (e) { log(label, 'REFUSED:', String(e?.message ?? e).slice(0, 300)); process.exitCode = 3; } };

if (SIM) {
  // Model the live wallet: sub holds one big coin at vout 1 (as after a payment with change last), so deploy must prep a vout-0 coin.
  const all = (await coinsOf(sub)); let tb = new TransactionBuilder({ provider });
  for (const c of all) tb = tb.addInput(c, sub.unlockP2PKH());
  const tot = all.reduce((n, c) => n + c.satoshis, 0n);
  await tb.addOutput({ to: sub2.getAddress(), amount: 60_000n }).addOutput({ to: sub.getAddress(), amount: tot - 60_000n - 5_000n }).send();
  if ((await coinsOf(sub)).some((u) => u.vout === 0)) throw new Error('simulate setup: sub still has a vout-0 coin');
  await deploy();
  await subscribe('sub', 4); await subscribe('sub2', 4); await status();
  await collect(1, ['sub', 'sub2']); await status();
  await step('early collect (expect refusal)', () => collect(1, ['sub']));
  process.exitCode = 0;
  await provider.mine(1); await collect(1, ['sub', 'sub2']); await status();
  await provider.mine(2); await collect(2, ['sub']); await status();
  await withdraw('sub2', 1); await status();
  await release('sub2', 1); await status();
  await leave('sub'); await status();
  log('SIM DONE');
} else if (cmd === 'status') await status();
else if (cmd === 'fund2') await fund2();
else if (cmd === 'prep') await prep();
else if (cmd === 'deploy') { if (saved()) throw new Error(`${STATE} exists: already deployed`); await deploy(); }
else if (cmd === 'subscribe') await step('SUBSCRIBE', () => subscribe(rest[0], Number(rest[1])));
else if (cmd === 'collect') await step('COLLECT', () => collect(Number(rest[0]), rest.slice(1)));
else if (cmd === 'withdraw') await step('WITHDRAW', () => withdraw(rest[0], Number(rest[1])));
else if (cmd === 'release') await step('RELEASE', () => release(rest[0], Number(rest[1])));
else if (cmd === 'leave') await step('LEAVE', () => leave(rest[0]));
else console.log('usage: see header');
process.exit(process.exitCode ?? 0);
