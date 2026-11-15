// StandingOrderPlus + PausedOrder: split payout, pause/resume, top-up, plan change, cancel.
// Every "refuses" case is paired with an accepted twin that differs in one thing, and the pause/resume round trip
// is checked by the libauth BCH 2026 VM on fully built transactions, not only by the mock matcher.
import artifact from '../artifacts/solidcash/standing_order_plus.json' with { type: 'json' };
import pausedArtifact from '../artifacts/solidcash/paused_order.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder, randomUtxo, HashType } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import { secp256k1, hash160, hash256, encodeCashAddress, binToHex, hexToBin, cashAddressToLockingBytecode } from '@bitauth/libauth';

const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0x44));
const pub = (p: Uint8Array) => secp256k1.derivePublicKeyCompressed(p) as Uint8Array;
const addr = (p: Uint8Array) => {
  const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub(p)) });
  return typeof r === 'string' ? r : r.address;
};
const lockOf = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === 'string') throw new Error(r); return r.bytecode; };

const merchantPriv = priv(1), subscriberPriv = priv(2), strangerPriv = priv(3), splitPriv = priv(4);
const AMOUNT = 10_000n, PERIOD = 6n, MAXFEE = 1_000n, SPLIT = 1_000n;
const ORDER_ID = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
const BAL = 100_000n;

function setup(split = SPLIT, value = BAL) {
  const provider = new MockNetworkProvider();
  const contract = new Contract(artifact as any, [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), AMOUNT, PERIOD, MAXFEE,
    hash160(pub(splitPriv)), split, ORDER_ID] as any, { provider });
  const utxo = { ...randomUtxo(), satoshis: value };
  provider.addUtxo(contract.address, utxo);
  // The paused covenant of THIS order: resumeTo = hash256(this order's redeem script).
  const paused = new Contract(pausedArtifact as any, [hash160(pub(subscriberPriv)), hash256(hexToBin(contract.bytecode))] as any, { provider });
  return { provider, contract, utxo, paused };
}
const coin = (p: Uint8Array, provider: MockNetworkProvider, sats = 5_000n) => {
  const u = { ...randomUtxo(), satoshis: sats };
  provider.addUtxo(addr(p), u);
  return u;
};
const signer = (p: Uint8Array, ht?: number) => new SignatureTemplate(p, ht as any).unlockP2PKH();

describe('StandingOrderPlus.claim with a split', () => {
  it('pays the merchant one period and the split payee one split, change stays', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a claim before the period has passed', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) - 1 })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('refuses sending the split to anyone else', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(strangerPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('refuses a bigger split', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT * 2n })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - 2n * SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('refuses dropping the split output (merchant + change only)', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('without a split behaves like the plain order (merchant + change)', async () => {
    const { provider, contract, utxo } = setup(0n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - MAXFEE });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a third output that skims the fee allowance', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - SPLIT - MAXFEE })
      .addOutput({ to: addr(strangerPriv), amount: 800n });
    await expect(tx).toFailRequire();
  });
  it('on the last claim pays the split its share and the rest to the merchant', async () => {
    const { provider, contract, utxo } = setup(SPLIT, 15_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: 15_000n - MAXFEE - SPLIT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a last claim that leaves the split payee out (review R3)', async () => {
    const { provider, contract, utxo } = setup(SPLIT, 15_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: 15_000n - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('on a last claim too small to cover the split, the merchant takes what is left', async () => {
    const { provider, contract, utxo } = setup(SPLIT, 10_500n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: 10_500n - MAXFEE });
    await expect(tx).not.toFailRequire();
  });
});

describe('StandingOrderPlus.pause / PausedOrder.resume', () => {
  it('lets the subscriber pause: pays the period in progress, the rest goes to this order\'s paused covenant', async () => {
    const { provider, contract, utxo, paused } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.pause())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: paused.address, amount: BAL - AMOUNT - SPLIT - MAXFEE })
      .addOutput({ to: addr(subscriberPriv), amount: 4_000n });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a pause that does not pay the period in progress (review R2: clock reset)', async () => {
    const { provider, contract, utxo, paused } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.pause())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: paused.address, amount: BAL });
    await expect(tx).toFailRequire();
  });
  it('refuses a pause signed by anyone else', async () => {
    const { provider, contract, utxo, paused } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.pause())
      .addInput(coin(strangerPriv, provider), signer(strangerPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: paused.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('refuses a pause into a paused covenant of another order (resume would go elsewhere)', async () => {
    const { provider, contract, utxo } = setup();
    const other = new Contract(pausedArtifact as any, [hash160(pub(subscriberPriv)), new Uint8Array(32).fill(7)] as any, { provider });
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.pause())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: other.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('refuses a pause signed with sighash SINGLE|ANYONECANPAY (replayable)', async () => {
    const { provider, contract, utxo, paused } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.pause())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv, HashType.SIGHASH_SINGLE | HashType.SIGHASH_ANYONECANPAY))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: paused.address, amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
  it('a paused order cannot be claimed (no claim function on the paused covenant)', () => {
    const { paused } = setup();
    expect((paused.unlock as any).claim).toBeUndefined();
  });
  it('resume sends the funds back to the same order only', async () => {
    const { provider, contract, paused } = setup();
    const pu = { ...randomUtxo(), satoshis: BAL };
    provider.addUtxo(paused.address, pu);
    const ok = new TransactionBuilder({ provider })
      .addInput(pu, paused.unlock.resume())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: contract.address, amount: BAL })
      .addOutput({ to: addr(subscriberPriv), amount: 4_000n });
    await expect(ok).not.toFailRequire();
    const pu2 = { ...randomUtxo(), satoshis: BAL };
    provider.addUtxo(paused.address, pu2);
    const bad = new TransactionBuilder({ provider })
      .addInput(pu2, paused.unlock.resume())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(strangerPriv), amount: BAL });
    await expect(bad).toFailRequire();
  });
  it('refuses a resume by anyone else', async () => {
    const { provider, contract, paused } = setup();
    const pu = { ...randomUtxo(), satoshis: BAL };
    provider.addUtxo(paused.address, pu);
    const tx = new TransactionBuilder({ provider })
      .addInput(pu, paused.unlock.resume())
      .addInput(coin(merchantPriv, provider), signer(merchantPriv))
      .addOutput({ to: contract.address, amount: BAL });
    await expect(tx).toFailRequire();
  });
  it('lets the subscriber cancel while paused', async () => {
    const { provider, paused } = setup();
    const pu = { ...randomUtxo(), satoshis: BAL };
    provider.addUtxo(paused.address, pu);
    const tx = new TransactionBuilder({ provider })
      .addInput(pu, paused.unlock.cancel())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(subscriberPriv), amount: BAL + 4_000n });
    await expect(tx).not.toFailRequire();
  });
});

describe('StandingOrderPlus.topUp', () => {
  it('lets anyone top up: pays the period in progress, the order keeps at least what it had', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.topUp())
      .addInput(coin(strangerPriv, provider, 20_000n), signer(strangerPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a top-up that leaves the order with less than it had', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.topUp())
      .addInput(coin(strangerPriv, provider, 20_000n), signer(strangerPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - 1n });
    await expect(tx).toFailRequire();
  });
  it('refuses a top-up that skips paying the period (review R2: clock reset)', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.topUp())
      .addInput(coin(strangerPriv, provider, 20_000n), signer(strangerPriv))
      .addOutput({ to: contract.address, amount: BAL + 5_000n });
    await expect(tx).toFailRequire();
  });
  it('refuses a "top-up" that moves the order elsewhere', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.topUp())
      .addInput(coin(strangerPriv, provider, 20_000n), signer(strangerPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: addr(strangerPriv), amount: BAL });
    await expect(tx).toFailRequire();
  });
  it('refuses merging two UTXOs of the same order to skim one', async () => {
    const { provider, contract, utxo } = setup();
    const second = { ...randomUtxo(), satoshis: BAL };
    provider.addUtxo(contract.address, second);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.topUp())
      .addInput(second, contract.unlock.topUp())
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL })
      .addOutput({ to: addr(strangerPriv), amount: BAL - AMOUNT - SPLIT - MAXFEE });
    await expect(tx).toFailRequire();
  });
});

describe('StandingOrderPlus.changePlan', () => {
  const newPlan = (provider: MockNetworkProvider) => new Contract(artifact as any, [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)),
    AMOUNT * 2n, PERIOD, MAXFEE, hash160(pub(splitPriv)), SPLIT, ORDER_ID] as any, { provider });
  it('moves the balance to a new plan when merchant and subscriber both sign', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.changePlan())
      .addInput(coin(merchantPriv, provider), signer(merchantPriv))
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: newPlan(provider).address, amount: BAL })
      .addOutput({ to: addr(merchantPriv), amount: 4_500n })
      .addOutput({ to: addr(subscriberPriv), amount: 4_500n });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a plan change by the subscriber alone', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.changePlan())
      .addInput(coin(strangerPriv, provider), signer(strangerPriv))
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: newPlan(provider).address, amount: BAL });
    await expect(tx).toFailRequire();
  });
  it('refuses a plan change by the merchant alone', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.changePlan())
      .addInput(coin(merchantPriv, provider), signer(merchantPriv))
      .addInput(coin(strangerPriv, provider), signer(strangerPriv))
      .addOutput({ to: newPlan(provider).address, amount: BAL });
    await expect(tx).toFailRequire();
  });
  it('refuses moving the balance to a plain address', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.changePlan())
      .addInput(coin(merchantPriv, provider), signer(merchantPriv))
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(merchantPriv), amount: BAL });
    await expect(tx).toFailRequire();
  });
});

describe('StandingOrderPlus.cancel', () => {
  it('lets the subscriber take everything back', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin(subscriberPriv, provider), signer(subscriberPriv))
      .addOutput({ to: addr(subscriberPriv), amount: BAL + 4_000n });
    await expect(tx).not.toFailRequire();
  });
  it('refuses a cancel by the merchant', async () => {
    const { provider, contract, utxo } = setup();
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin(merchantPriv, provider), signer(merchantPriv))
      .addOutput({ to: addr(merchantPriv), amount: BAL + 4_000n });
    await expect(tx).toFailRequire();
  });
});

// Full transactions checked by the libauth BCH 2026 VM (what a node runs), not only the mock matcher.
import { decodeTransaction, createVirtualMachineBch2026 } from '@bitauth/libauth';
import { readFileSync } from 'node:fs';
const opts = { maximumFeeSatsPerByte: 1e12 } as any;
function vm(hex: string, sources: { address: string; sats: bigint }[]): true | string {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  const r = createVirtualMachineBch2026(true).verify({
    transaction: tx, sourceOutputs: sources.map((s) => ({ lockingBytecode: lockOf(s.address), valueSatoshis: s.sats })),
  });
  return r === true ? true : String(r);
}

describe('StandingOrderPlus: VM-verified round trip', () => {
  it('pause, then resume back into the same order, then claim after a full period: all valid on the 2026 VM', () => {
    const { contract, utxo, paused } = setup();
    const c1 = { ...randomUtxo(), satoshis: 5_000n };
    const pauseHex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.pause())
      .addInput(c1, signer(subscriberPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: paused.address, amount: BAL - AMOUNT - SPLIT - MAXFEE })
      .addOutput({ to: addr(subscriberPriv), amount: 4_000n })
      .build();
    expect(vm(pauseHex, [{ address: contract.address, sats: BAL }, { address: addr(subscriberPriv), sats: 5_000n }])).toBe(true);

    const pu = { ...randomUtxo(), satoshis: BAL }, c2 = { ...randomUtxo(), satoshis: 5_000n };
    const resumeHex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(pu, paused.unlock.resume())
      .addInput(c2, signer(subscriberPriv))
      .addOutput({ to: contract.address, amount: BAL })
      .addOutput({ to: addr(subscriberPriv), amount: 4_000n })
      .build();
    expect(vm(resumeHex, [{ address: paused.address, sats: BAL }, { address: addr(subscriberPriv), sats: 5_000n }])).toBe(true);

    const back = { ...randomUtxo(), satoshis: BAL };
    const claimHex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(back, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: contract.address, amount: BAL - AMOUNT - SPLIT - MAXFEE })
      .build();
    expect(vm(claimHex, [{ address: contract.address, sats: BAL }])).toBe(true);
  });

  it('a pause signed by a stranger is rejected by the VM', () => {
    const { contract, utxo, paused } = setup();
    const c1 = { ...randomUtxo(), satoshis: 5_000n };
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.pause())
      .addInput(c1, signer(strangerPriv))
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(splitPriv), amount: SPLIT })
      .addOutput({ to: paused.address, amount: BAL - AMOUNT - SPLIT - MAXFEE })
      .build();
    expect(vm(hex, [{ address: contract.address, sats: BAL }, { address: addr(strangerPriv), sats: 5_000n }])).not.toBe(true);
  });

  it('PAUSED_TEMPLATE in the contract matches the compiled PausedOrder (no stale address)', () => {
    const src = readFileSync(new URL('../contracts/standing_order_plus.scash', import.meta.url), 'utf8');
    const embedded = /PAUSED_TEMPLATE = 0x([0-9a-f]+);/.exec(src)![1];
    const { paused } = setup();
    expect(paused.bytecode.endsWith(embedded)).toBe(true);
    expect(paused.bytecode.length).toBe(2 * (1 + 32 + 1 + 20) + embedded.length);
  });
});
