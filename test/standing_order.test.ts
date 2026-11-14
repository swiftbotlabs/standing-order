import artifact from '../artifacts/solidcash/standing_order.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder, randomUtxo } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import { secp256k1, hash160, encodeCashAddress } from '@bitauth/libauth';

// Fixed test keys (never funded on any real network).
const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0x11));
const pub = (p: Uint8Array) => secp256k1.derivePublicKeyCompressed(p) as Uint8Array;
const addr = (p: Uint8Array) => {
  const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub(p)) });
  return typeof r === 'string' ? r : r.address;
};

const merchantPriv = priv(1);
const subscriberPriv = priv(2);
const strangerPriv = priv(3);
const AMOUNT = 10_000n;   // per period
const PERIOD = 6n;        // blocks
const MAXFEE = 1_000n;

function setup(value: bigint) {
  const provider = new MockNetworkProvider();
  const contract = new Contract(
    artifact as any,
    [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), AMOUNT, PERIOD, MAXFEE],
    { provider },
  );
  const utxo = { ...randomUtxo(), satoshis: value };
  provider.addUtxo(contract.address, utxo);
  return { provider, contract, utxo };
}

describe('StandingOrder.claim', () => {
  it('pays exactly one period to the merchant and keeps the change in the contract', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: contract.address, amount: 100_000n - AMOUNT - MAXFEE });
    await expect(tx).not.toFailRequire();
  });

  it('refuses a claim before the period has passed', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) - 1 })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: contract.address, amount: 100_000n - AMOUNT - MAXFEE });
    await expect(tx).toFailRequire();
  });

  it('refuses paying the merchant more than one period', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT * 2n })
      .addOutput({ to: contract.address, amount: 100_000n - 2n * AMOUNT - MAXFEE });
    await expect(tx).toFailRequire();
  });

  it('refuses sending the change anywhere but the contract', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: AMOUNT })
      .addOutput({ to: addr(strangerPriv), amount: 100_000n - AMOUNT - MAXFEE });
    await expect(tx).toFailRequire();
  });

  it('refuses paying anyone but the merchant in output 0', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(strangerPriv), amount: AMOUNT })
      .addOutput({ to: contract.address, amount: 100_000n - AMOUNT - MAXFEE });
    await expect(tx).toFailRequire();
  });

  it('on the last claim pays out the remainder and ends the order', async () => {
    const { provider, contract, utxo } = setup(15_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: 15_000n - MAXFEE });
    await expect(tx).not.toFailRequire();
  });
});

describe('StandingOrder.cancel', () => {
  it('lets the subscriber take everything back at any time', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel(pub(subscriberPriv), new SignatureTemplate(subscriberPriv)))
      .addOutput({ to: addr(subscriberPriv), amount: 100_000n - MAXFEE });
    await expect(tx).not.toFailRequire();
  });

  it('refuses a cancel signed by anyone else', async () => {
    const { provider, contract, utxo } = setup(100_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel(pub(strangerPriv), new SignatureTemplate(strangerPriv)))
      .addOutput({ to: addr(strangerPriv), amount: 100_000n - MAXFEE });
    await expect(tx).toFailRequire();
  });
});
