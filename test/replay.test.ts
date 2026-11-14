// cancel() is authorized by a coin from the subscriber's own address (the last input). These tests make sure a
// signature the subscriber made for something else (an offer, a pledge) can never be replayed to drain an order.
// The BCH cases are checked by the libauth BCH 2026 VM on the fully built transaction, not only by the mock matcher.
// Found by an adversarial security review on 14 Nov; see README "Hardening".
import artifact from '../artifacts/solidcash/standing_order.json' with { type: 'json' };
import tokenArtifact from '../artifacts/solidcash/standing_order_token.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder, randomUtxo, randomToken, HashType } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import {
  secp256k1, hash160, encodeCashAddress, decodeTransaction, hexToBin, cashAddressToLockingBytecode,
  createVirtualMachineBch2026,
} from '@bitauth/libauth';

const priv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0x33));
const pub = (p: Uint8Array) => secp256k1.derivePublicKeyCompressed(p) as Uint8Array;
const addr = (p: Uint8Array, tokens = false) => {
  const r = encodeCashAddress({ prefix: 'bchtest', type: tokens ? 'p2pkhWithTokens' : 'p2pkh', payload: hash160(pub(p)) });
  return typeof r === 'string' ? r : r.address;
};
const lb = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === 'string') throw new Error(r); return r.bytecode; };

const merchantPriv = priv(1), subscriberPriv = priv(2), strangerPriv = priv(3), campaignPriv = priv(4);
const AMOUNT = 10_000n, PERIOD = 6n, MAXFEE = 1_000n, ORDER_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const opts = { maximumFeeSatsPerByte: 1e12 } as any;

function setup(value: bigint) {
  const provider = new MockNetworkProvider();
  const contract = new Contract(artifact as any,
    [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), AMOUNT, PERIOD, MAXFEE, ORDER_ID], { provider });
  const utxo = { ...randomUtxo(), satoshis: value };
  provider.addUtxo(contract.address, utxo);
  return { provider, contract, utxo };
}

// An unlocking script the subscriber produced for a DIFFERENT transaction, replayed verbatim.
const replayed = (unlocking: Uint8Array) =>
  ({ generateLockingBytecode: () => lb(addr(subscriberPriv)), generateUnlockingBytecode: () => unlocking }) as any;

function signedElsewhere(coin: any, hashType: number, outputs: { to: string; amount: bigint }[]) {
  const transaction = {
    version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin(coin.txid), outpointIndex: coin.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
    outputs: outputs.map((o) => ({ lockingBytecode: lb(o.to), valueSatoshis: o.amount })),
  };
  const sourceOutputs = [{ lockingBytecode: lb(addr(subscriberPriv)), valueSatoshis: coin.satoshis }];
  return new SignatureTemplate(subscriberPriv, hashType).unlockP2PKH()
    .generateUnlockingBytecode({ transaction, sourceOutputs, inputIndex: 0 } as any);
}

// true = the network would accept the transaction; a string = the VM's rejection reason.
function vmVerify(hex: string, contractAddress: string, covenantSats: bigint, coinSats: bigint): true | string {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  const r = createVirtualMachineBch2026(true).verify({
    transaction: tx,
    sourceOutputs: [
      { lockingBytecode: lb(contractAddress), valueSatoshis: covenantSats },
      { lockingBytecode: lb(addr(subscriberPriv)), valueSatoshis: coinSats },
    ],
  });
  return r === true ? true : String(r);
}

describe('StandingOrder.cancel: replayed subscriber signatures are refused (VM-verified)', () => {
  const coin = { ...randomUtxo(), satoshis: 5_000n };

  it('SINGLE|ANYONECANPAY offer cannot be used to take the order', () => {
    const { contract, utxo } = setup(100_000n);
    const sig = signedElsewhere(coin, HashType.SIGHASH_SINGLE | HashType.SIGHASH_ANYONECANPAY, [{ to: addr(subscriberPriv), amount: 6_000n }]);
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, replayed(sig))
      .addOutput({ to: addr(strangerPriv), amount: 98_000n })
      .addOutput({ to: addr(subscriberPriv), amount: 6_000n })
      .build();
    expect(vmVerify(hex, contract.address, 100_000n, 5_000n)).not.toBe(true);
  });

  it('NONE|ANYONECANPAY signature cannot be used to take the order', () => {
    const { contract, utxo } = setup(100_000n);
    const sig = signedElsewhere(coin, HashType.SIGHASH_NONE | HashType.SIGHASH_ANYONECANPAY, [{ to: addr(campaignPriv), amount: 4_000n }]);
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, replayed(sig))
      .addOutput({ to: addr(strangerPriv), amount: 104_000n })
      .build();
    expect(vmVerify(hex, contract.address, 100_000n, 5_000n)).not.toBe(true);
  });

  it('ALL|ANYONECANPAY pledge cannot pull the order into someone else\'s campaign', () => {
    const { contract, utxo } = setup(100_000n);
    const sig = signedElsewhere(coin, HashType.SIGHASH_ALL | HashType.SIGHASH_ANYONECANPAY, [{ to: addr(campaignPriv), amount: 104_000n }]);
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, replayed(sig))
      .addOutput({ to: addr(campaignPriv), amount: 104_000n })
      .build();
    expect(vmVerify(hex, contract.address, 100_000n, 5_000n)).not.toBe(true);
  });

  it('a subscriber-signed cancel that pays someone else is refused', () => {
    const { contract, utxo } = setup(100_000n);
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, new SignatureTemplate(subscriberPriv, HashType.SIGHASH_ALL | HashType.SIGHASH_UTXOS).unlockP2PKH())
      .addOutput({ to: addr(strangerPriv), amount: 104_000n })
      .build();
    expect(vmVerify(hex, contract.address, 100_000n, 5_000n)).not.toBe(true);
  });

  for (const [name, ht] of [['ALL', HashType.SIGHASH_ALL], ['ALL|UTXOS', HashType.SIGHASH_ALL | HashType.SIGHASH_UTXOS]] as const) {
    it(`a real cancel signed ${name} is accepted by the VM`, () => {
      const { contract, utxo } = setup(100_000n);
      const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
        .addInput(utxo, contract.unlock.cancel())
        .addInput(coin, new SignatureTemplate(subscriberPriv, ht).unlockP2PKH())
        .addOutput({ to: addr(subscriberPriv), amount: 104_000n })
        .build();
      expect(vmVerify(hex, contract.address, 100_000n, 5_000n)).toBe(true);
    });
  }
});

describe('StandingOrderToken.cancel: replayed subscriber signatures are refused (VM-verified)', () => {
  function setupToken() {
    const tok = randomToken({ amount: 5_000n });
    const contract = new Contract(tokenArtifact as any,
      [hash160(pub(merchantPriv)), hash160(pub(subscriberPriv)), hexToBin(tok.category).reverse(), 500n, PERIOD, 1_000n, MAXFEE, ORDER_ID],
      { provider: new MockNetworkProvider() });
    const utxo = { ...randomUtxo({ token: tok }), satoshis: 10_000n };
    const coin = { ...randomUtxo(), satoshis: 5_000n };
    return { contract, utxo, cat: tok.category, coin };
  }
  // Source outputs in libauth's own representation: take the token encoding from a decoded output of the same category.
  function verifyToken(hex: string, contract: any, utxo: any, tokenOut: number): true | string {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === 'string') throw new Error(tx);
    const token = { ...tx.outputs[tokenOut].token!, amount: utxo.token.amount };
    const r = createVirtualMachineBch2026(true).verify({
      transaction: tx,
      sourceOutputs: [
        { lockingBytecode: lb(contract.address), valueSatoshis: utxo.satoshis, token },
        { lockingBytecode: lb(addr(subscriberPriv)), valueSatoshis: 5_000n },
      ],
    });
    return r === true ? true : String(r);
  }

  it('SINGLE|ANYONECANPAY offer cannot be used to take the tokens', () => {
    const { contract, utxo, cat, coin } = setupToken();
    const sig = signedElsewhere(coin, HashType.SIGHASH_SINGLE | HashType.SIGHASH_ANYONECANPAY, [{ to: addr(subscriberPriv), amount: 6_000n }]);
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, replayed(sig))
      .addOutput({ to: addr(strangerPriv, true), amount: 8_000n, token: { category: cat, amount: 5_000n } })
      .addOutput({ to: addr(subscriberPriv), amount: 6_000n })
      .build();
    expect(verifyToken(hex, contract, utxo, 0)).not.toBe(true);
  });

  it('a real cancel signed ALL|UTXOS returns tokens and BCH to the subscriber', () => {
    const { contract, utxo, cat, coin } = setupToken();
    const hex = new TransactionBuilder({ provider: new MockNetworkProvider(), ...opts })
      .addInput(utxo, contract.unlock.cancel())
      .addInput(coin, new SignatureTemplate(subscriberPriv, HashType.SIGHASH_ALL | HashType.SIGHASH_UTXOS).unlockP2PKH())
      .addOutput({ to: addr(subscriberPriv, true), amount: 14_000n, token: { category: cat, amount: 5_000n } })
      .build();
    expect(verifyToken(hex, contract, utxo, 0)).toBe(true);
  });
});
