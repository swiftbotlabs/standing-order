/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { hash160, binToHex } from '@bitauth/libauth';
import { compileFile } from '@solidcash/solidc';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { SignatureTemplate } from '@solidcash/solidcash';
import { withLocktime } from '../src/locktime.js';

const artifact = compileFile(process.env.POOL_SCASH ? new URL('file://' + process.env.POOL_SCASH) : new URL('../contracts/standing_order_pool.scash', import.meta.url)) as any;
const PRICE = 10_000n, PERIOD = 6n, K = 65536n, BASE = 1_000n;

async function setup() {
  const provider = new MockNetworkProvider({ profile: 'production' });
  const [merchant, alice, bob, carol, mallory] = await provider.getSigners(5, { fundingUtxos: 30, genesisFundingUtxos: 2 });
  const genesis = (await merchant.getUtxos()).filter((u: any) => u.vout === 0 && !u.token && u.satoshis >= 200_000n);
  const mpkh = hash160(merchant.publicKey);
  const { contract } = await StatefulContract.deploy(artifact, [mpkh, PRICE, PERIOD], {
    provider, fundingUtxo: genesis[0], funder: merchant.unlockP2PKH(), changeAddress: merchant.getAddress(), initialBalance: BASE,
  } as any);
  return { provider, merchant, alice, bob, carol, mallory, pool: contract as any, mpkh };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const pkh = (s: any) => hash160(s.publicKey);
// the order the covenant wants: keys compared as little-endian numbers (from the last byte)
const keyOrder = (a: Uint8Array, b: Uint8Array) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const sorted = (list: any[]) => [...list].sort((x, y) => keyOrder(pkh(x), pkh(y)));
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: any) => String(e?.message ?? e).slice(0, 300));
const height = (ctx: Ctx) => ctx.provider.getBlockHeight();
const sats = async (ctx: Ctx, s: any) => (await ctx.provider.getUtxos(s.getAddress())).filter((u: any) => !u.token).reduce((n: bigint, u: any) => n + u.satoshis, 0n);
const rec = async (ctx: Ctx, s: any) => BigInt(await ctx.pool.members(pkh(s)));
// every member names a recovery address (a backup wallet of theirs); by default carol's address stands in for it
const subscribe = async (ctx: Ctx, s: any, periods: bigint, by = s, recovery = ctx.carol) => {
  const h = BigInt(await height(ctx));
  return ctx.pool.connect(by).call.subscribe(pkh(s), pkh(recovery), h).withValue(periods * PRICE).setLocktime(Number(h)).send();
};
const release = (ctx: Ctx, signer: any, who: any, periods: bigint, transfer?: [Uint8Array, bigint]) => {
  let c = ctx.pool.connect(signer).call.release(pkh(who), periods, signer.publicKey, new SignatureTemplate(signer.privateKey));
  if (transfer) c = c.transfer(transfer[0], transfer[1]);
  return c.send();
};
const pause = (ctx: Ctx, signer: any, who: any) =>
  ctx.pool.connect(signer).call.pause(pkh(who), signer.publicKey, new SignatureTemplate(signer.privateKey)).send();
const resume = (ctx: Ctx, signer: any, who: any, from: bigint, locktime = Number(from)) =>
  withLocktime(locktime, () => ctx.pool.connect(signer).call.resume(pkh(who), from, signer.publicKey, new SignatureTemplate(signer.privateKey)).setLocktime(locktime).send());
const setRecovery = (ctx: Ctx, signer: any, who: any, recovery: any) =>
  ctx.pool.connect(signer).call.setRecovery(pkh(who), pkh(recovery), signer.publicKey, new SignatureTemplate(signer.privateKey)).send();
// `locktime` = the tx's nLockTime (what the chain has reached, from the covenant's view); `transfer` = a manual
// (attacker-chosen) payout instead of the SDK-derived one
const collect = (ctx: Ctx, by: any, list: any[], due: bigint, locktime = Number(due), transfer?: [Uint8Array, bigint], periods = 1n, ordered = true) =>
  withLocktime(locktime, () => {
    let c = ctx.pool.connect(by).call.collect((ordered ? sorted(list) : list).map(pkh), due, periods).setLocktime(locktime);
    if (transfer) c = c.transfer(transfer[0], transfer[1]);
    return c.send();
  });
const withdraw = (ctx: Ctx, by: any, who: any, periods: bigint) => ctx.pool.connect(by).call.withdraw(pkh(who), periods).send();
const leave = (ctx: Ctx, by: any, who: any) => ctx.pool.connect(by).call.leave(pkh(who), by.publicKey, new SignatureTemplate(by.privateKey)).send();
const coins = async (ctx: Ctx) => (await ctx.provider.getUtxos(ctx.pool.satoshiContainer.address)).map((u: any) => u.satoshis).sort((a: bigint, b: bigint) => (a > b ? -1 : 1));

describe('StandingOrderPool: join', () => {
  it('subscribe keeps the whole deposit in the pool and records periods + first due height', async () => {
    const ctx = await setup();
    const h = BigInt(await height(ctx));
    expect(await outcome(subscribe(ctx, ctx.alice, 3n))).toBe('accepted');
    expect(await rec(ctx, ctx.alice)).toBe(h * K + 3n);
    expect((await ctx.pool.getState()).memberCount).toBe(1n);
    expect(await ctx.pool.satoshiContainer.getBalance()).toBe(BASE + 3n * PRICE);
  });

  it('refuses a second subscription for the same member, a deposit that is not whole periods, and a future start', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 2n);
    expect(await outcome(subscribe(ctx, ctx.alice, 1n))).not.toBe('accepted');
    const h = BigInt(await height(ctx));
    expect(await outcome(ctx.pool.connect(ctx.bob).call.subscribe(pkh(ctx.bob), pkh(ctx.carol), h).withValue(PRICE + 1n).setLocktime(Number(h)).send())).not.toBe('accepted');
    expect(await outcome(ctx.pool.connect(ctx.bob).call.subscribe(pkh(ctx.bob), pkh(ctx.carol), h).withValue(PRICE / 2n).setLocktime(Number(h)).send())).not.toBe('accepted');
    expect(await outcome(ctx.pool.connect(ctx.bob).call.subscribe(pkh(ctx.bob), pkh(ctx.carol), h + 50n).withValue(PRICE).setLocktime(Number(h)).send())).not.toBe('accepted');
    expect(await outcome(subscribe(ctx, ctx.bob, 1n))).toBe('accepted');   // control: the honest call passes
    expect((await ctx.pool.getState()).memberCount).toBe(2n);
  });

  it('topUp adds whole periods for any payer', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 1n);
    const r = await rec(ctx, ctx.alice);
    expect(await outcome(ctx.pool.connect(ctx.bob).call.topUp(pkh(ctx.alice)).withValue(2n * PRICE).send())).toBe('accepted');
    expect(await rec(ctx, ctx.alice)).toBe(r + 2n);
    expect(await outcome(ctx.pool.connect(ctx.bob).call.topUp(pkh(ctx.alice)).withValue(PRICE + 7n).send())).not.toBe('accepted');
    expect(await outcome(ctx.pool.connect(ctx.bob).call.topUp(pkh(ctx.carol)).withValue(PRICE).send())).not.toBe('accepted');
  });
});

describe('StandingOrderPool: collect', () => {
  it('pays one period to the merchant, never early, whoever triggers it', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 3n);
    const due = (await rec(ctx, ctx.alice)) / K;
    const m0 = await sats(ctx, ctx.merchant);
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due))).toBe('accepted');
    expect(await sats(ctx, ctx.merchant) - m0).toBe(PRICE);
    expect(await rec(ctx, ctx.alice)).toBe((due + PERIOD) * K + 2n);
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due))).not.toBe('accepted');                       // already paid
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due + PERIOD, Number(due + PERIOD - 1n)))).not.toBe('accepted'); // early
    // a final tx (nLockTime = the current height) that claims a later `due`: the covenant's CLTV refuses it
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due + PERIOD, Number(due)))).not.toBe('accepted');
    await ctx.provider.mine(Number(PERIOD));
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due + PERIOD))).toBe('accepted');
    expect(await sats(ctx, ctx.merchant) - m0).toBe(2n * PRICE);
    expect((await ctx.pool.getState()).paidTotal).toBe(2n * PRICE);
  });

  it('batch: one transaction collects from three members, one payout of 3 x price', async () => {
    const ctx = await setup();
    for (const s of [ctx.alice, ctx.bob, ctx.carol]) await subscribe(ctx, s, 4n);
    const due = BigInt(await height(ctx));
    const m0 = await sats(ctx, ctx.merchant);
    const tx: any = await collect(ctx, ctx.mallory, [ctx.alice, ctx.bob, ctx.carol], due);
    expect(await sats(ctx, ctx.merchant) - m0).toBe(3n * PRICE);
    const payouts = (await ctx.provider.getUtxos(ctx.merchant.getAddress())).filter((u: any) => u.txid === tx.txid);
    expect(payouts.map((u: any) => u.satoshis)).toEqual([3n * PRICE]);
    for (const s of [ctx.alice, ctx.bob, ctx.carol]) expect((await rec(ctx, s)) % K).toBe(3n);
    // the same three listed out of order: refused on chain (the order check stops a member being listed twice)
    await ctx.provider.mine(Number(PERIOD));
    const rev = sorted([ctx.alice, ctx.bob, ctx.carol]).reverse();
    expect(await outcome(collect(ctx, ctx.mallory, rev, due + PERIOD, Number(due + PERIOD), undefined, 1n, false))).not.toBe('accepted');
    expect(await outcome(collect(ctx, ctx.mallory, rev, due + PERIOD))).toBe('accepted');   // control: sorted, accepted
  });

  it('catch-up: periods = 2 takes two periods from a member who is two behind, and is refused when only one is due', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 4n);
    const start = (await rec(ctx, ctx.alice)) / K;
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], start, Number(start), undefined, 2n))).not.toBe('accepted');
    await ctx.provider.mine(Number(PERIOD));
    const m0 = await sats(ctx, ctx.merchant);
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], start + PERIOD, Number(start + PERIOD), undefined, 2n))).toBe('accepted');
    expect(await sats(ctx, ctx.merchant) - m0).toBe(2n * PRICE);
    expect(await rec(ctx, ctx.alice)).toBe((start + 2n * PERIOD) * K + 2n);
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], start + PERIOD, Number(start + PERIOD), undefined, 3n))).not.toBe('accepted'); // 3 > left 2 and not due
  });

  it('refuses a member with no prepaid period left, and a member who is not due by `due`', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 1n);
    await subscribe(ctx, ctx.carol, 5n);                     // carol's budget sits in the same pool
    const due = BigInt(await height(ctx));
    expect(await outcome(collect(ctx, ctx.merchant, [ctx.alice], due))).toBe('accepted');
    await ctx.provider.mine(Number(PERIOD));
    expect(await outcome(collect(ctx, ctx.merchant, [ctx.alice], due + PERIOD))).not.toBe('accepted');   // budget used up: carol's money stays hers
    expect((await rec(ctx, ctx.carol)) % K).toBe(5n);
    await ctx.provider.mine(3);
    await subscribe(ctx, ctx.bob, 2n);                       // bob's first due is now, later than `due`
    expect(await outcome(collect(ctx, ctx.merchant, [ctx.bob], due))).not.toBe('accepted');
  });

  it('nobody can redirect or inflate the payout (manual transfer outputs)', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 3n);
    const due = BigInt(await height(ctx));
    const thief = ctx.mallory.getLockingBytecode();
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due, Number(due), [thief, PRICE]))).not.toBe('accepted');
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due, Number(due), [ctx.merchant.getLockingBytecode(), 2n * PRICE]))).not.toBe('accepted');
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due, Number(due), [ctx.merchant.getLockingBytecode(), PRICE]))).toBe('accepted'); // control
  });
});

describe('StandingOrderPool: withdraw', () => {
  it('only the member can withdraw; all of it ends the membership, other budgets untouched', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.bob, 6n);                       // a big coin in the pool, so only the rule can refuse
    await subscribe(ctx, ctx.alice, 3n);
    const due = BigInt(await height(ctx));
    await collect(ctx, ctx.merchant, [ctx.alice], due);
    expect(await outcome(withdraw(ctx, ctx.mallory, ctx.alice, 1n))).not.toBe('accepted');
    expect(await outcome(withdraw(ctx, ctx.merchant, ctx.alice, 1n))).not.toBe('accepted');
    expect(await outcome(withdraw(ctx, ctx.alice, ctx.alice, 3n))).not.toBe('accepted');   // only 2 left
    const tx: any = await withdraw(ctx, ctx.alice, ctx.alice, 2n);
    const back = (await ctx.provider.getUtxos(ctx.alice.getAddress())).filter((u: any) => u.txid === tx.txid).map((u: any) => u.satoshis);
    expect(back).toContain(2n * PRICE);
    expect(await rec(ctx, ctx.alice)).toBe(0n);
    expect((await ctx.pool.getState()).memberCount).toBe(1n);
    expect(await ctx.pool.satoshiContainer.getBalance()).toBe(BASE + 6n * PRICE);     // bob's budget untouched
    expect(await outcome(withdraw(ctx, ctx.alice, ctx.alice, 1n))).not.toBe('accepted');   // nothing left
  });

  it('liveness: when pool coins are fragmented, a member still gets every period back, in parts', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 3n);    // pool coins: 30,000 (alice) + base
    await subscribe(ctx, ctx.bob, 2n);      // + 20,000 (bob)
    const due = BigInt(await height(ctx));
    await collect(ctx, ctx.merchant, [ctx.alice, ctx.bob], due);   // 20,000 out of the largest coin -> 10,000 + 20,000
    expect((await coins(ctx)).slice(0, 2)).toEqual([2n * PRICE, PRICE]);
    expect((await rec(ctx, ctx.alice)) % K).toBe(2n);
    // alice's 2 periods (20,000) come back in one go from the 20,000 coin
    expect(await outcome(withdraw(ctx, ctx.alice, ctx.alice, 2n))).toBe('accepted');
    // bob's last period comes back from the 10,000 coin
    expect(await outcome(withdraw(ctx, ctx.bob, ctx.bob, 1n))).toBe('accepted');
    expect(await ctx.pool.satoshiContainer.getBalance()).toBe(BASE);
    expect((await ctx.pool.getState()).memberCount).toBe(0n);
  });
});

describe('StandingOrderPool: membership end', () => {
  it('a member whose budget is used up can leave; leave is refused while periods are left, and for anyone else', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 1n);
    expect(await outcome(leave(ctx, ctx.alice, ctx.alice))).not.toBe('accepted');
    await collect(ctx, ctx.merchant, [ctx.alice], BigInt(await height(ctx)));
    expect(await outcome(leave(ctx, ctx.mallory, ctx.alice))).not.toBe('accepted');
    expect(await outcome(leave(ctx, ctx.alice, ctx.alice))).toBe('accepted');
    expect(await rec(ctx, ctx.alice)).toBe(0n);
    expect((await ctx.pool.getState()).memberCount).toBe(0n);
  });
});

describe('StandingOrderPool: key loss (recovery address)', () => {
  it("the merchant can release a member's unspent periods only to the member's recovery address, in parts", async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.carol, 6n);                               // a big coin in the pool, so only the rule can refuse
    await subscribe(ctx, ctx.alice, 3n, ctx.alice, ctx.bob);          // alice names bob's address as her backup wallet
    expect(binToHex(await ctx.pool.recoveryOf(pkh(ctx.alice)))).toBe(binToHex(pkh(ctx.bob)));
    const b0 = await sats(ctx, ctx.bob);
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 1n))).toBe('accepted');
    expect(await sats(ctx, ctx.bob) - b0).toBe(PRICE);
    expect((await rec(ctx, ctx.alice)) % K).toBe(2n);
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 3n))).not.toBe('accepted');          // only 2 left
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 2n))).toBe('accepted');              // the rest ends the membership
    expect(await sats(ctx, ctx.bob) - b0).toBe(3n * PRICE);
    expect(await rec(ctx, ctx.alice)).toBe(0n);
    expect((await ctx.pool.getState()).memberCount).toBe(1n);                                      // carol stays
    expect(await ctx.pool.satoshiContainer.getBalance()).toBe(BASE + 6n * PRICE);                // carol's budget untouched
  });

  it('nobody but the merchant can release, and a release cannot be redirected', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 2n, ctx.alice, ctx.bob);
    expect(await outcome(release(ctx, ctx.mallory, ctx.alice, 1n))).not.toBe('accepted');           // a stranger's key
    expect(await outcome(release(ctx, ctx.alice, ctx.alice, 1n))).not.toBe('accepted');             // the member's own key is not the merchant's
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 1n, [ctx.merchant.getLockingBytecode(), PRICE]))).not.toBe('accepted');
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 1n, [ctx.mallory.getLockingBytecode(), PRICE]))).not.toBe('accepted');
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 1n, [ctx.bob.getLockingBytecode(), PRICE]))).toBe('accepted'); // control
  });

  it('only the member can change the recovery address; a release then follows the new address', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 2n, ctx.alice, ctx.bob);
    expect(await outcome(setRecovery(ctx, ctx.mallory, ctx.alice, ctx.mallory))).not.toBe('accepted');
    expect(await outcome(setRecovery(ctx, ctx.merchant, ctx.alice, ctx.merchant))).not.toBe('accepted');
    expect(await outcome(setRecovery(ctx, ctx.alice, ctx.alice, ctx.carol))).toBe('accepted');
    expect(binToHex(await ctx.pool.recoveryOf(pkh(ctx.alice)))).toBe(binToHex(pkh(ctx.carol)));
    const c0 = await sats(ctx, ctx.carol);
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 2n))).toBe('accepted');
    expect(await sats(ctx, ctx.carol) - c0).toBe(2n * PRICE);
  });
});

describe('StandingOrderPool: pause and resume', () => {
  it('a paused member cannot be collected from; resume moves the next due height on and collection continues', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.alice, 3n);
    const due = (await rec(ctx, ctx.alice)) / K;
    expect(await outcome(pause(ctx, ctx.alice, ctx.alice))).toBe('accepted');
    expect(await rec(ctx, ctx.alice)).toBe(-(due * K + 3n));                                       // stored negated while paused
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], due))).not.toBe('accepted');        // due, but paused
    await ctx.provider.mine(10);
    const now = BigInt(await height(ctx));
    expect(await outcome(resume(ctx, ctx.alice, ctx.alice, due - 1n))).not.toBe('accepted');      // earlier than it was due
    expect(await outcome(resume(ctx, ctx.alice, ctx.alice, now + 5n, Number(now)))).not.toBe('accepted'); // a future height (CLTV)
    expect(await outcome(resume(ctx, ctx.alice, ctx.alice, now))).toBe('accepted');
    expect(await rec(ctx, ctx.alice)).toBe(now * K + 3n);                                          // paused time not charged
    const m0 = await sats(ctx, ctx.merchant);
    expect(await outcome(collect(ctx, ctx.mallory, [ctx.alice], now))).toBe('accepted');
    expect(await sats(ctx, ctx.merchant) - m0).toBe(PRICE);
  });

  it('only the member can pause or resume; a paused member can still be released to the recovery address', async () => {
    const ctx = await setup();
    await subscribe(ctx, ctx.carol, 6n);                             // a big coin in the pool
    await subscribe(ctx, ctx.alice, 3n, ctx.alice, ctx.bob);
    expect(await outcome(pause(ctx, ctx.mallory, ctx.alice))).not.toBe('accepted');
    expect(await outcome(pause(ctx, ctx.merchant, ctx.alice))).not.toBe('accepted');
    expect(await outcome(pause(ctx, ctx.alice, ctx.alice))).toBe('accepted');
    expect(await outcome(pause(ctx, ctx.alice, ctx.alice))).not.toBe('accepted');                  // already paused
    const now = BigInt(await height(ctx));
    expect(await outcome(resume(ctx, ctx.mallory, ctx.alice, now))).not.toBe('accepted');
    const b0 = await sats(ctx, ctx.bob);
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 1n))).toBe('accepted');             // key lost while paused
    expect(await rec(ctx, ctx.alice) < 0n).toBe(true);                                            // still paused, 2 left
    expect((-(await rec(ctx, ctx.alice))) % K).toBe(2n);
    expect(await outcome(release(ctx, ctx.merchant, ctx.alice, 2n))).toBe('accepted');
    expect(await sats(ctx, ctx.bob) - b0).toBe(3n * PRICE);
    expect(await rec(ctx, ctx.alice)).toBe(0n);
  });
});
