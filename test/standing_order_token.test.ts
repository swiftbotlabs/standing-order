import artifact from '../artifacts/solidcash/standing_order_token.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder, randomUtxo, randomToken } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import { secp256k1, hash160, encodeCashAddress, hexToBin } from '@bitauth/libauth';

const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0x22));
const pub = (p: Uint8Array) => secp256k1.derivePublicKeyCompressed(p) as Uint8Array;
const addr = (p: Uint8Array) => {
  const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: hash160(pub(p)) });
  return typeof r === 'string' ? r : r.address;
};

const merchantPriv = priv(1), subscriberPriv = priv(2), strangerPriv = priv(3);
const PER = 500n;        // tokens per period (e.g. 5.00 of a 2-decimal stablecoin)
const PERIOD = 6n;
const DUST = 1_000n;
const MAXFEE = 1_000n;
const SATS = 10_000n;

function setup(tokens: bigint, category?: string) {
  const provider = new MockNetworkProvider();
  const tok = randomToken({ amount: tokens });
  const cat = category ?? tok.category;
  const contract = new Contract(
    artifact as any,
    [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), hexToBin(cat).reverse(), PER, PERIOD, DUST, MAXFEE],
    { provider },
  );
  const utxo = { ...randomUtxo({ token: tok }), satoshis: SATS };
  provider.addUtxo(contract.address, utxo);
  return { provider, contract, utxo, cat: tok.category };
}

describe('StandingOrderToken.claim', () => {
  it('pays exactly one period of tokens and keeps the rest (and the BCH) in the contract', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER } })
      .addOutput({ to: contract.tokenAddress, amount: SATS - DUST - MAXFEE, token: { category: cat, amount: 5_000n - PER } });
    await expect(tx).not.toFailRequire();
  });

  it('refuses a claim before the period has passed', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) - 1 })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER } })
      .addOutput({ to: contract.tokenAddress, amount: SATS - DUST - MAXFEE, token: { category: cat, amount: 5_000n - PER } });
    await expect(tx).toFailRequire();
  });

  it('refuses paying the merchant more tokens than one period', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER * 2n } })
      .addOutput({ to: contract.tokenAddress, amount: SATS - DUST - MAXFEE, token: { category: cat, amount: 5_000n - 2n * PER } });
    await expect(tx).toFailRequire();
  });

  it('refuses draining the contract BCH through the merchant output', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: SATS - DUST - MAXFEE, token: { category: cat, amount: PER } })
      .addOutput({ to: contract.tokenAddress, amount: DUST, token: { category: cat, amount: 5_000n - PER } });
    await expect(tx).toFailRequire();
  });

  it('refuses sending the remaining tokens anywhere but the contract', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER } })
      .addOutput({ to: addr(strangerPriv), amount: SATS - DUST - MAXFEE, token: { category: cat, amount: 5_000n - PER } });
    await expect(tx).toFailRequire();
  });

  it('on the last claim pays all remaining tokens and the BCH to the merchant', async () => {
    const { provider, contract, utxo, cat } = setup(PER);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: SATS - MAXFEE, token: { category: cat, amount: PER } });
    await expect(tx).not.toFailRequire();
  });

  it('refuses a last claim that hands the leftover BCH to someone else', async () => {
    const { provider, contract, utxo, cat } = setup(PER);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER } })
      .addOutput({ to: addr(strangerPriv), amount: SATS - DUST - MAXFEE });
    await expect(tx).toFailRequire();
  });

  it('refuses a contract funded with a different token category', async () => {
    const other = randomToken({ amount: 1n }).category;
    const { provider, contract, utxo, cat } = setup(5_000n, other);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.claim(), { sequence: Number(PERIOD) })
      .addOutput({ to: addr(merchantPriv), amount: DUST, token: { category: cat, amount: PER } })
      .addOutput({ to: contract.tokenAddress, amount: SATS - DUST - MAXFEE, token: { category: cat, amount: 5_000n - PER } });
    await expect(tx).toFailRequire();
  });
});

describe('StandingOrderToken.cancel', () => {
  it('lets the subscriber take back all tokens and BCH at any time', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel(pub(subscriberPriv), new SignatureTemplate(subscriberPriv)))
      .addOutput({ to: addr(subscriberPriv), amount: SATS - MAXFEE, token: { category: cat, amount: 5_000n } });
    await expect(tx).not.toFailRequire();
  });

  it('refuses a cancel signed by anyone else', async () => {
    const { provider, contract, utxo, cat } = setup(5_000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(utxo, contract.unlock.cancel(pub(strangerPriv), new SignatureTemplate(strangerPriv)))
      .addOutput({ to: addr(strangerPriv), amount: SATS - MAXFEE, token: { category: cat, amount: 5_000n } });
    await expect(tx).toFailRequire();
  });
});
