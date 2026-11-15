// Chipnet end-to-end of the WEB code paths for v2 orders (web/src/chain.ts), signed the way a WizardConnect wallet signs
// (@bch-wc2/privkey-connector on the wire object). Test coins only. Run: SEED_FILE=... npx vite-node scripts/e2e_v2.ts
import fs from 'node:fs';
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPathRelative, deriveHdPublicNode, hash160, encodeCashAddress, binToHex } from '@bitauth/libauth';
import { signWcTransaction } from '@bch-wc2/privkey-connector';
import { parseExtendedJson } from '@wizardconnect/core';
import { SignatureTemplate, TransactionBuilder } from '@solidcash/solidcash';
import { type Plan, buildFund, buildPauseResume, buildTopUp, buildCancel, orderState, broadcast, newOrderId, provider } from '../src/chain';

const seed = Uint8Array.from(Buffer.from(fs.readFileSync(process.env.SEED_FILE!, 'utf8').trim(), 'hex'));
const acct = deriveHdPath(deriveHdPrivateNodeFromSeed(seed, { throwErrors: true }), "m/44'/145'/0'", { throwErrors: true });
const key = (i: number) => { const n = deriveHdPathRelative(acct, `9/${i}`, { throwErrors: true }); return { priv: n.privateKey, pub: deriveHdPublicNode(n).publicKey }; };
const addr = (pub: Uint8Array) => { const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub) }); return typeof r === 'string' ? r : r.address; };
const faucet = key(0), split = key(2), user = key(3);   // faucet: one mid-size coin of the test subscriber key
const userAddr = addr(user.pub), userHash = hash160(user.pub);
const net = provider('chipnet');
const log = (...a: any[]) => console.log(new Date().toISOString(), ...a);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallet = async (built: { wc: any }) => {        // what the wallet does: revive the wire JSON, sign, return hex
  const tx = parseExtendedJson(JSON.stringify(built.wc)) as any;
  return binToHex(signWcTransaction(tx, { privateKey: user.priv, pubkeyCompressed: user.pub }));
};

// 0) give the web subscriber (9/3) test coins from the merchant test key (9/1), unconfirmed is fine
const have = (await net.getUtxos(userAddr)).filter((u: any) => !u.token).reduce((a: bigint, u: any) => a + u.satoshis, 0n);
if (have < 60_000n) {
  const src = (await net.getUtxos(addr(faucet.pub))).filter((u: any) => !u.token && u.satoshis >= 100_000n).slice(0, 1);
  const total = src.reduce((a: bigint, u: any) => a + u.satoshis, 0n);
  let b = new TransactionBuilder({ provider: net });
  for (const u of src) b = b.addInput(u, new SignatureTemplate(faucet.priv).unlockP2PKH());
  b = b.addOutput({ to: userAddr, amount: 70_000n }).addOutput({ to: addr(faucet.pub), amount: total - 70_000n - 1_500n });

  log('FAUCET', (await b.send()).txid); await wait(4000);
}
const plan: Plan = { v: 2, net: 'chipnet', merchant: 'bchtest:qr2dds84kdmcmfhhc6lqcqrsaw9tspregqxwsz2ry3', amount: 5_000n, period: 1, periods: 3,
  label: 'v2 web e2e', split: { to: addr(split.pub), amount: 1_000n } };
const oid = newOrderId();
const step = async (label: string, f: () => Promise<{ wc: any }>) => {
  const txid = await broadcast('chipnet', await wallet(await f()));
  log(label, txid); await wait(4000);
  const s = await orderState(plan, userHash, oid);
  log('   state: balance', s.balance.toString(), 'paused', s.paused, 'address', s.address);
  return txid;
};
log('order id', binToHex(oid));
await step('SUBSCRIBED', () => buildFund(plan, userAddr, userHash, oid));
await step('PAUSED', () => buildPauseResume('pause', plan, userAddr, userHash, oid));
await step('RESUMED', () => buildPauseResume('resume', plan, userAddr, userHash, oid));
await step('TOPPED_UP', () => buildTopUp(plan, userAddr, userHash, oid, 1));
await step('PAUSED_AGAIN', () => buildPauseResume('pause', plan, userAddr, userHash, oid));
await step('CANCELLED_FROM_PAUSED', () => buildCancel(plan, userAddr, userHash, oid));
process.exit(0);
