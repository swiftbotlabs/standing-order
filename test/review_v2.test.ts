// Regression tests from the 15 Nov security review of v2 (StandingOrderPlus / PausedOrder). Each attack the reviewer
// proved on the 2026 VM is now REFUSED; each has an accepted twin (control) so a refusal is not an accident.
import artifact from '../artifacts/solidcash/standing_order_plus.json' with { type: 'json' };
import pausedArtifact from '../artifacts/solidcash/paused_order.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder, randomUtxo } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import { secp256k1, hash160, hash256, encodeCashAddress, hexToBin, cashAddressToLockingBytecode,
  decodeTransaction, createVirtualMachineBch2026 } from '@bitauth/libauth';

const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0x44));
const pub = (p: Uint8Array) => secp256k1.derivePublicKeyCompressed(p) as Uint8Array;
const addr = (p: Uint8Array) => { const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub(p)) }); return typeof r === 'string' ? r : r.address; };
const lockOf = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === 'string') throw new Error(r); return r.bytecode; };
const merchantPriv = priv(1), subscriberPriv = priv(2), strangerPriv = priv(3), splitPriv = priv(4);
// The dapp's numbers: MAX_FEE 1,000; amount and split >= 1,000.
const AMOUNT = 10_000n, PERIOD = 6n, MAXFEE = 1_000n, SPLIT = 1_000n, PER = AMOUNT + SPLIT;
const ORDER_ID = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
const opts = { maximumFeeSatsPerByte: 1e12 } as any;
const signer = (p: Uint8Array) => new SignatureTemplate(p).unlockP2PKH();

function order(period = PERIOD, split = SPLIT) {
  const provider = new MockNetworkProvider();
  const contract = new Contract(artifact as any, [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), AMOUNT, period, MAXFEE,
    hash160(pub(splitPriv)), split, ORDER_ID] as any, { provider });
  const paused = new Contract(pausedArtifact as any, [hash160(pub(subscriberPriv)), hash256(hexToBin(contract.bytecode))] as any, { provider });
  return { provider, contract, paused };
}
type Src = { lock: Uint8Array; sats: bigint };
function vm(hex: string, sources: Src[], standard = true): true | string {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  const r = createVirtualMachineBch2026(standard).verify({ transaction: tx, sourceOutputs: sources.map((s) => ({ lockingBytecode: s.lock, valueSatoshis: s.sats })) });
  return r === true ? true : String(r);
}

const BAL = (PER + MAXFEE) * 12n;
const paid = (b: TransactionBuilder) => b.addOutput({ to: addr(merchantPriv), amount: AMOUNT }).addOutput({ to: addr(splitPriv), amount: SPLIT });

describe('R1 token poisoning is refused (order coin must carry no token)', () => {
  const claimTx = (token: boolean) => {
    const { contract } = order();
    const u = { ...randomUtxo(), vout: 0, satoshis: BAL };    // funding output 0: the case where minting is possible
    const b = paid(new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) }));
    const hex = (token ? b.addOutput({ to: contract.tokenAddress, amount: BAL - PER - MAXFEE, token: { category: u.txid, amount: 1n } })
      : b.addOutput({ to: contract.address, amount: BAL - PER - MAXFEE })).build();
    return vm(hex, [{ lock: lockOf(contract.address), sats: BAL }]);
  };
  it('control: the plain first claim is valid on the VM', () => { expect(claimTx(false)).toBe(true); });
  it('a claim that mints a token onto the change is refused', () => { expect(claimTx(true)).not.toBe(true); });
  it('a topUp that mints a token or NFT onto the order coin is refused (and the plain topUp is valid)', () => {
    for (const poison of [false, true]) {
      const { contract } = order();
      const u = { ...randomUtxo(), vout: 3, satoshis: BAL };
      const c = { ...randomUtxo(), vout: 0, satoshis: 30_000n };
      const b = paid(new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts }).addInput(u, contract.unlock.topUp()).addInput(c, signer(strangerPriv)));
      const hex = (poison
        ? b.addOutput({ to: contract.tokenAddress, amount: BAL, token: { category: c.txid, amount: 0n, nft: { capability: 'none', commitment: '' } } as any })
        : b.addOutput({ to: contract.address, amount: BAL })).build();
      const r = vm(hex, [{ lock: lockOf(contract.address), sats: BAL }, { lock: lockOf(addr(strangerPriv)), sats: 30_000n }]);
      if (poison) expect(r).not.toBe(true); else expect(r).toBe(true);
    }
  });
});

describe('R2 pausing, resuming or topping up can no longer starve the merchant', () => {
  it('pause pays the period in progress (VM): accepted with the payment, refused without', () => {
    for (const pays of [true, false]) {
      const { contract, paused } = order();
      const u = { ...randomUtxo(), satoshis: BAL }, c = { ...randomUtxo(), satoshis: 5_000n };
      let b = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts }).addInput(u, contract.unlock.pause()).addInput(c, signer(subscriberPriv));
      if (pays) b = paid(b);
      const hex = b.addOutput({ to: paused.address, amount: pays ? BAL - PER - MAXFEE : BAL }).addOutput({ to: addr(subscriberPriv), amount: 4_000n }).build();
      const r = vm(hex, [{ lock: lockOf(contract.address), sats: BAL }, { lock: lockOf(addr(subscriberPriv)), sats: 5_000n }]);
      if (pays) expect(r).toBe(true); else expect(r).not.toBe(true);
    }
  });
});

describe('R3 the split payee is paid on the last claim', () => {
  const ONE = PER + MAXFEE;   // exactly one period left
  it('last claim paying merchant + split: valid; merchant taking everything: refused (VM)', () => {
    const { contract } = order();
    const u = { ...randomUtxo(), satoshis: ONE };
    const ok = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT }).addOutput({ to: addr(splitPriv), amount: SPLIT }).build();
    const bad = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts }).addInput(u, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: ONE - MAXFEE }).build();
    expect(vm(ok, [{ lock: lockOf(contract.address), sats: ONE }])).toBe(true);
    expect(vm(bad, [{ lock: lockOf(contract.address), sats: ONE }])).not.toBe(true);
  });
});

describe('R4 changePlan only moves the balance to a real P2SH32 covenant', () => {
  it('OP_HASH256 <32> OP_NIP (anyone-can-spend, starts with aa20) is refused', async () => {
    const { provider, contract } = order();
    const u = { ...randomUtxo(), satoshis: BAL }; provider.addUtxo(contract.address, u);
    const coin = (p: Uint8Array) => { const c = { ...randomUtxo(), satoshis: 5_000n }; provider.addUtxo(addr(p), c); return c; };
    const bare = Uint8Array.from([0xaa, 0x20, ...new Uint8Array(32).fill(5), 0x77]);
    const tx = new TransactionBuilder({ provider })
      .addInput(u, contract.unlock.changePlan()).addInput(coin(merchantPriv), signer(merchantPriv)).addInput(coin(subscriberPriv), signer(subscriberPriv))
      .addOutput({ to: bare, amount: BAL } as any);
    await expect(tx).toFailRequireWith(/P2SH32/);
  });
});

describe('R7 the contract checks its own terms', () => {
  it('a period above 65,535 cannot be claimed (CSV would only see the low 16 bits)', async () => {
    const { provider, contract } = order(65_542n);
    const u = { ...randomUtxo(), satoshis: BAL }; provider.addUtxo(contract.address, u);
    const tx = paid(new TransactionBuilder({ provider }).addInput(u, contract.unlock.claim(), { sequence: 6 })).addOutput({ to: contract.address, amount: BAL - PER - MAXFEE });
    await expect(tx).toFailRequireWith(/period out of range/);
  });
  it('a negative split cannot turn topUp into a withdrawal', async () => {
    const { provider, contract } = order(PERIOD, -50_000n);
    const u = { ...randomUtxo(), satoshis: BAL }; provider.addUtxo(contract.address, u);
    const tx = new TransactionBuilder({ provider }).addInput(u, contract.unlock.topUp())
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT }).addOutput({ to: contract.address, amount: BAL - 60_000n })
      .addOutput({ to: addr(strangerPriv), amount: 50_000n });
    await expect(tx).toFailRequireWith(/bad terms/);
  });
});

import v1Artifact from '../artifacts/solidcash/standing_order.json' with { type: 'json' };
describe('Known v1 limitation (orders funded before v2): a token can ride on the change of the FIRST claim', () => {
  it('still VM-valid for v1 (fixed in v2; the dapp and relayer now treat such a coin as the order and drop the token)', () => {
    const c = new Contract(v1Artifact as any, [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), AMOUNT, PERIOD, MAXFEE, ORDER_ID] as any,
      { provider: new MockNetworkProvider() });
    const B = (AMOUNT + MAXFEE) * 12n;
    const u = { ...randomUtxo(), vout: 0, satoshis: B };
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(u, c.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: c.tokenAddress, amount: B - AMOUNT - MAXFEE, token: { category: u.txid, amount: 1n } })
      .build();
    expect(vm(hex, [{ lock: lockOf(c.address), sats: B }])).toBe(true);
  });
});
