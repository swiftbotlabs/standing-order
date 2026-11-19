// Standing Order Plus as an XO wallet template: the in-window covenant (contracts/standing_order_plus.scash) with a split payee,
// pause (the balance moves to this order's own PausedOrder covenant), resume and cancel. Same port method as the v1 template:
// the compiled bodies come from standing_order_plus.body.json (extract_plus.mjs) and the constructor arguments are pushed in front,
// exactly as the solidcash SDK does, so every address equals the original contract's.
// The subscriber's authorization is not a key in this template: the contract wants the LAST input to be a coin of the subscriber's own
// P2PKH address signed over the whole transaction, so the subscriber's XO wallet simply adds one of its own coins (and its change).
import fs from "node:fs";

const { plusBodyHex, pausedBodyHex } = JSON.parse(fs.readFileSync(new URL("./standing_order_plus.body.json", import.meta.url), "utf8"));
const SEL = { claim: "0xa443c5e4", pause: "0x2138ec0c", cancel: "0x61d66248", resume: "0x2b5fb2f5" }; // solidc ABI selectors

const variable = (name, description, type) => ({ name, description, type });
const NOT_TRACKED = { subscriber: { relevant: false }, merchant: { relevant: false }, splitPayee: { relevant: false }, service: { relevant: false } };
const TRACKED = { subscriber: { relevant: true }, merchant: { relevant: false }, splitPayee: { relevant: false }, service: { relevant: true } };
const NO_BALANCE = { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 };
const TERMS = ["merchantPkh", "subscriberPkh", "amountPerPeriod", "periodBlocks", "maxFee", "splitPkh", "splitAmount", "orderId"];
const one = (role) => ({ participants: [{ role, slots: { min: 1, max: 1 } }] });
const out = (name, description, icon, lockingScript, valueSatoshis, extra = {}) => ({ name, description, icon, lockingScript, valueSatoshis, token: null, ...extra });

export const standingOrderPlusTemplate = {
  $schema: "https://libauth.org/schemas/wallet-template-v0.schema.json",
  name: "Standing Order Plus",
  description: "A subscription that can't charge you after you cancel, with a split payee and pause/resume: each period anyone may trigger one payment (merchant + split payee); the subscriber can pause (the rest moves to a paused covenant only they can resume or cancel), resume, or cancel at any time.",
  icon: "standing-order",
  version: "1",
  supported: ["BCH_2026_05"],
  resources: [{ name: "Original contracts", description: "contracts/standing_order_plus.scash and contracts/paused_order.scash (SolidCash), built in the BLAZE window.", url: "https://github.com/swiftbotlabs/standing-order" }],
  roles: {
    subscriber: { name: "Subscriber", description: "Funds the order; pauses, resumes or cancels it with a coin of their own address.", icon: "subscriber" },
    merchant: { name: "Merchant", description: "Receives one payment per period.", icon: "merchant" },
    splitPayee: { name: "Split payee", description: "Receives a fixed share each period (co-creator, affiliate, platform fee).", icon: "merchant" },
    service: { name: "Trigger", description: "Anyone: selects the order coin and broadcasts a due payment. Needs no key; cannot redirect funds.", icon: "service" },
  },
  start: [],
  actions: {
    fund: { name: "Start a standing order", description: "Lock $(<fundSatoshis>) satoshis in the order covenant.", icon: "subscriber",
      roles: { subscriber: { requirements: { variables: [...TERMS, "fundSatoshis"] } } }, requirements: one("subscriber"), transaction: "fundTransaction" },
    claim: { name: "Pay one period", description: "Pay the merchant and the split payee one period; the rest stays in the order.", icon: "service",
      roles: { service: { requirements: { variables: [...TERMS, "orderSatoshis"] } } }, requirements: one("service"), transaction: "claimTransaction" },
    pause: { name: "Pause", description: "Pay the period in progress and move the rest to this order's paused covenant.", icon: "subscriber",
      roles: { subscriber: { requirements: { variables: [...TERMS, "orderSatoshis"] } } }, requirements: one("subscriber"), transaction: "pauseTransaction" },
    resume: { name: "Resume", description: "Move the paused balance back into the same order; the next payment waits a full period.", icon: "subscriber",
      roles: { subscriber: { requirements: { variables: [...TERMS, "pausedSatoshis"] } } }, requirements: one("subscriber"), transaction: "resumeTransaction" },
    cancel: { name: "Cancel", description: "Everything left in the order goes back to the subscriber.", icon: "subscriber",
      roles: { subscriber: { requirements: { variables: [...TERMS, "orderSatoshis", "authSatoshis"] } } }, requirements: one("subscriber"), transaction: "cancelTransaction" },
  },
  transactions: {
    fundTransaction: { name: "Standing order funded", description: "$(<fundSatoshis>) satoshis locked in the order.", icon: "subscriber",
      inputs: [], outputs: [{ output: "orderFunding", outputIndex: 0 }] },
    claimTransaction: { name: "Period paid", description: "Merchant and split payee paid one period.", icon: "service",
      inputs: [{ input: "orderClaimInput", inputIndex: 0 }],
      outputs: [{ output: "merchantPayment", outputIndex: 0 }, { output: "splitPayment", outputIndex: 1 }, { output: "orderChange", outputIndex: 2 }] },
    pauseTransaction: { name: "Order paused", description: "The period in progress was paid; the rest waits in the paused covenant.", icon: "subscriber",
      inputs: [{ input: "orderPauseInput", inputIndex: 0 }],
      outputs: [{ output: "merchantPayment", outputIndex: 0 }, { output: "splitPayment", outputIndex: 1 }, { output: "pausedOrder", outputIndex: 2 }] },
    resumeTransaction: { name: "Order resumed", description: "The balance is back in the same order.", icon: "subscriber",
      inputs: [{ input: "pausedResumeInput", inputIndex: 0 }], outputs: [{ output: "resumedOrder", outputIndex: 0 }] },
    cancelTransaction: { name: "Order cancelled", description: "Everything left went back to the subscriber.", icon: "subscriber",
      inputs: [{ input: "orderCancelInput", inputIndex: 0 }], outputs: [{ output: "subscriberRefund", outputIndex: 0 }] },
  },
  inputs: {
    orderClaimInput: { name: "Order coin", description: "Must be at least one period old.", icon: "standing-order",
      valueSatoshis: "$(<orderSatoshis>)", token: null, sequenceNumber: "$(<periodBlocks>)", unlockingScript: "claimUnlockingBytecode" },
    orderPauseInput: { name: "Order coin", description: "Paused by the subscriber (their own coin must be the last input).", icon: "standing-order",
      valueSatoshis: "$(<orderSatoshis>)", token: null, unlockingScript: "pauseUnlockingBytecode" },
    pausedResumeInput: { name: "Paused order coin", description: "Resumed by the subscriber (their own coin must be the last input).", icon: "standing-order",
      valueSatoshis: "$(<pausedSatoshis>)", token: null, unlockingScript: "resumeUnlockingBytecode" },
    orderCancelInput: { name: "Order coin", description: "Cancelled by the subscriber (their own coin must be the last input).", icon: "standing-order",
      valueSatoshis: "$(<orderSatoshis>)", token: null, unlockingScript: "cancelUnlockingBytecode" },
  },
  outputs: {
    orderFunding: out("Standing order", "The funded order.", "standing-order", "plusContract", "$(<fundSatoshis>)"),
    merchantPayment: out("Merchant payment", "One period.", "merchant", "merchantLockingScript", "$(<amountPerPeriod>)"),
    splitPayment: out("Split payment", "The split payee's share of the period.", "merchant", "splitLockingScript", "$(<splitAmount>)"),
    orderChange: out("Order remainder", "Stays in the order for the next periods.", "standing-order", "plusContract", "$(remainingAfterPeriod)", { selectable: false, roles: NOT_TRACKED }),
    pausedOrder: out("Paused order", "The rest, in this order's paused covenant.", "standing-order", "pausedContract", "$(remainingAfterPeriod)", { selectable: false, roles: NOT_TRACKED }),
    resumedOrder: out("Resumed order", "The paused balance, back in the same order.", "standing-order", "plusContract", "$(resumedSatoshis)", { selectable: false, roles: NOT_TRACKED }),
    subscriberRefund: out("Refund", "The order's balance and the authorizing coin, minus the fee, back to the subscriber.", "subscriber", "subscriberLockingScript", "$(refundSatoshis)"),
  },
  lockingScripts: {
    plusContract: { name: "Standing Order Plus covenant", description: "P2SH32 of the compiled StandingOrderPlus with this order's terms.", icon: "standing-order",
      lockingType: "p2s", lockingBytecode: "plusLockingBytecode", state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: TRACKED },
    pausedContract: { name: "Paused order covenant", description: "P2SH32 of PausedOrder(subscriber, resumeTo = this order).", icon: "standing-order",
      lockingType: "p2s", lockingBytecode: "pausedLockingBytecode", state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: TRACKED },
    merchantLockingScript: { name: "Merchant address", description: "P2PKH of the merchant.", icon: "merchant", lockingType: "p2s", lockingBytecode: "merchantLockingBytecode",
      state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: NOT_TRACKED },
    splitLockingScript: { name: "Split payee address", description: "P2PKH of the split payee.", icon: "merchant", lockingType: "p2s", lockingBytecode: "splitLockingBytecode",
      state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: NOT_TRACKED },
    subscriberLockingScript: { name: "Subscriber address", description: "P2PKH of the subscriber.", icon: "subscriber", lockingType: "p2s", lockingBytecode: "subscriberLockingBytecode",
      state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: NOT_TRACKED },
  },
  scripts: {
    // constructor arguments reversed (orderId ... merchant), then the compiled body, as solidcash builds the redeem script
    plusRedeemBytecode: `<orderId> <splitAmount> <splitPkh> <maxFee> <periodBlocks> <amountPerPeriod> <subscriberPkh> <merchantPkh> 0x${plusBodyHex}`,
    plusLockingBytecode: "OP_HASH256 <$(<plusRedeemBytecode> OP_HASH256)> OP_EQUAL",
    // PausedOrder(subscriber, resumeTo): resumeTo is this order's script hash, exactly what pause() computes on chain
    pausedRedeemBytecode: `<$(<plusRedeemBytecode> OP_HASH256)> <subscriberPkh> 0x${pausedBodyHex}`,
    pausedLockingBytecode: "OP_HASH256 <$(<pausedRedeemBytecode> OP_HASH256)> OP_EQUAL",
    claimUnlockingBytecode: `<${SEL.claim}> <plusRedeemBytecode>`,
    pauseUnlockingBytecode: `<${SEL.pause}> <plusRedeemBytecode>`,
    cancelUnlockingBytecode: `<${SEL.cancel}> <plusRedeemBytecode>`,
    resumeUnlockingBytecode: `<${SEL.resume}> <pausedRedeemBytecode>`,
    merchantLockingBytecode: "OP_DUP OP_HASH160 <merchantPkh> OP_EQUALVERIFY OP_CHECKSIG",
    splitLockingBytecode: "OP_DUP OP_HASH160 <splitPkh> OP_EQUALVERIFY OP_CHECKSIG",
    subscriberLockingBytecode: "OP_DUP OP_HASH160 <subscriberPkh> OP_EQUALVERIFY OP_CHECKSIG",
    remainingAfterPeriod: "<orderSatoshis> <amountPerPeriod> OP_SUB <splitAmount> OP_SUB <maxFee> OP_SUB",
    resumedSatoshis: "<pausedSatoshis> <maxFee> OP_SUB",
    // the cancel has exactly one output, so the subscriber's authorizing coin is refunded in it too
    refundSatoshis: "<orderSatoshis> <authSatoshis> OP_ADD <maxFee> OP_SUB",
  },
  variables: {
    merchantPkh: variable("Merchant", "HASH160 of the merchant's public key (20 bytes).", "bytes"),
    subscriberPkh: variable("Subscriber", "HASH160 of the subscriber's public key (20 bytes): their own coin authorizes pause, resume and cancel.", "bytes"),
    amountPerPeriod: variable("Amount per period", "Satoshis paid to the merchant each period.", "satoshis"),
    periodBlocks: variable("Period (blocks)", "Blocks between payments (relative timelock, 1-65535).", "integer"),
    maxFee: variable("Max fee", "Most satoshis a transaction may leave to miners (the paused covenant allows at most 2,000).", "satoshis"),
    splitPkh: variable("Split payee", "HASH160 of the split payee's public key (20 bytes).", "bytes"),
    splitAmount: variable("Split per period", "Satoshis paid to the split payee each period.", "satoshis"),
    orderId: variable("Order id", "8 random bytes: gives every order its own address.", "bytes"),
    orderSatoshis: variable("Order coin value", "Value of the order coin being spent.", "satoshis"),
    pausedSatoshis: variable("Paused coin value", "Value of the paused order coin being resumed.", "satoshis"),
    fundSatoshis: variable("Funding", "Satoshis locked when the order starts.", "satoshis"),
    authSatoshis: variable("Authorizing coin value", "Value of the subscriber's own coin that authorizes the cancel (refunded in the same output).", "satoshis"),
  },
  icons: ["standing-order", "subscriber", "merchant", "service"].map((name) => ({ name, hash: "0000000000000000000000" })),
};
export default standingOrderPlusTemplate;
