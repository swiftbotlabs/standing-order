// Standing Order as an XO wallet template (libauth wallet-template v0 + XO roles/actions).
// The covenant is the same compiled contract as contracts/standing_order.scash (solidc 0.50.0): its body is read from
// standing_order.body.json (made by extract_tail.mjs from the project's artifact), and the six constructor arguments are
// pushed in front of it exactly as the solidcash SDK does, so the address equals the original contract's address.
import fs from "node:fs";

const { bodyHex } = JSON.parse(fs.readFileSync(new URL("./standing_order.body.json", import.meta.url), "utf8"));
const CLAIM = "0xa443c5e4", CANCEL = "0x61d66248"; // function selectors from the solidc ABI

const variable = (name, description, type) => ({ name, description, type });
// XO: which roles track a locking script. The subscriber and any trigger (service) track the order coin so the engine can
// spend it by its own rules; the merchant only receives.
const ROLES = { subscriber: { relevant: false }, merchant: { relevant: false }, service: { relevant: false } };
const ORDER_ROLES = { subscriber: { relevant: true }, merchant: { relevant: false }, service: { relevant: true } };
const NO_BALANCE = { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 };

export const standingOrderTemplate = {
  $schema: "https://libauth.org/schemas/wallet-template-v0.schema.json",
  name: "Standing Order",
  description: "A subscription that can't charge you after you cancel: the subscriber funds a covenant once; after each period anyone may trigger one payment of a fixed amount to the merchant, the rest stays locked for the subscriber, who can cancel and take it back at any time.",
  icon: "standing-order",
  version: "1",
  supported: ["BCH_2026_05"],
  resources: [{ name: "Original contract", description: "contracts/standing_order.scash (SolidCash) in this repository, tag pre-kickoff.", url: "https://github.com/swiftbotlabs/standing-order" }],
  roles: {
    subscriber: { name: "Subscriber", description: "Funds the order and may cancel it.", icon: "subscriber" },
    merchant: { name: "Merchant", description: "Receives one payment per period.", icon: "merchant" },
    service: { name: "Trigger", description: "Anyone: selects the order coin and broadcasts a due payment. Needs no key; cannot redirect funds.", icon: "service" },
  },
  start: [],
  actions: {
    fund: {
      name: "Start a standing order", description: "Lock $(<fundSatoshis>) satoshis in the order covenant.", icon: "subscriber",
      roles: { subscriber: { requirements: { variables: ["merchantPkh", "subscriberPkh", "amountPerPeriod", "periodBlocks", "maxFee", "orderId", "fundSatoshis"] } } },
      requirements: { participants: [{ role: "subscriber", slots: { min: 1, max: 1 } }] },
      transaction: "fundTransaction",
    },
    claim: {
      name: "Pay one period", description: "Pay $(<amountPerPeriod>) satoshis to the merchant; the rest returns to the order.", icon: "service",
      roles: { service: { requirements: { variables: ["merchantPkh", "subscriberPkh", "amountPerPeriod", "periodBlocks", "maxFee", "orderId", "orderSatoshis"] } } },
      requirements: { participants: [{ role: "service", slots: { min: 1, max: 1 } }] },
      transaction: "claimTransaction",
    },
    lastClaim: {
      name: "Pay the last period", description: "Too little is left for another full period plus change: pay the remainder (minus the fee) to the merchant; the order ends.", icon: "service",
      roles: { service: { requirements: { variables: ["merchantPkh", "subscriberPkh", "amountPerPeriod", "periodBlocks", "maxFee", "orderId", "orderSatoshis"] } } },
      requirements: { participants: [{ role: "service", slots: { min: 1, max: 1 } }] },
      transaction: "lastClaimTransaction",
    },
    cancel: {
      name: "Cancel", description: "The subscriber takes back everything left in the order.", icon: "subscriber",
      roles: { subscriber: { requirements: { secrets: ["subscriberKey"], variables: ["merchantPkh", "subscriberPkh", "amountPerPeriod", "periodBlocks", "maxFee", "orderId", "orderSatoshis", "authSatoshis"] } } },
      requirements: { participants: [{ role: "subscriber", slots: { min: 1, max: 1 } }] },
      transaction: "cancelTransaction",
    },
  },
  transactions: {
    fundTransaction: { name: "Standing order funded", description: "$(<fundSatoshis>) satoshis locked in the order.", icon: "subscriber",
      inputs: [], outputs: [{ output: "orderFunding", outputIndex: 0 }] },
    claimTransaction: { name: "Period paid", description: "$(<amountPerPeriod>) satoshis paid to the merchant.", icon: "service",
      inputs: [{ input: "orderInput", inputIndex: 0 }],
      outputs: [{ output: "merchantPayment", outputIndex: 0 }, { output: "orderChange", outputIndex: 1 }] },
    lastClaimTransaction: { name: "Last period paid", description: "The order paid out its remainder and ended.", icon: "service",
      inputs: [{ input: "orderInput", inputIndex: 0 }],
      outputs: [{ output: "merchantLastPayment", outputIndex: 0 }] },
    cancelTransaction: { name: "Order cancelled", description: "Everything left went back to the subscriber.", icon: "subscriber",
      inputs: [{ input: "orderCancelInput", inputIndex: 0 }, { input: "subscriberAuthInput", inputIndex: 1 }],
      outputs: [{ output: "subscriberRefund", outputIndex: 0 }] },
  },
  inputs: {
    orderInput: { name: "Order coin", description: "The order covenant's coin; it must be at least one period old.", icon: "standing-order",
      valueSatoshis: "$(<orderSatoshis>)", token: null, sequenceNumber: "$(<periodBlocks>)", unlockingScript: "claimUnlockingBytecode" },
    orderCancelInput: { name: "Order coin", description: "The order covenant's coin being cancelled.", icon: "standing-order",
      valueSatoshis: "$(<orderSatoshis>)", token: null, unlockingScript: "cancelUnlockingBytecode" },
    subscriberAuthInput: { name: "Subscriber's own coin", description: "Any plain coin of the subscriber's address, signed with SIGHASH_ALL: proves the subscriber wants to cancel. Must be the last input.", icon: "subscriber",
      valueSatoshis: "$(<authSatoshis>)", token: null, unlockingScript: "subscriberUnlockingBytecode" },
  },
  outputs: {
    orderFunding: { name: "Standing order", description: "The funded order.", icon: "standing-order", lockingScript: "standingOrderContract", valueSatoshis: "$(<fundSatoshis>)", token: null },
    merchantPayment: { name: "Merchant payment", description: "One period's payment.", icon: "merchant", lockingScript: "merchantLockingScript", valueSatoshis: "$(<amountPerPeriod>)", token: null },
    orderChange: { name: "Order remainder", description: "What is left stays in the order for the next periods.", icon: "standing-order", lockingScript: "standingOrderContract",
      valueSatoshis: "$(remainingOrderSatoshis)", token: null, selectable: false, roles: ROLES },
    merchantLastPayment: { name: "Merchant final payment", description: "The order's remainder minus the fee.", icon: "merchant", lockingScript: "merchantLockingScript", valueSatoshis: "$(lastPaymentSatoshis)", token: null },
    subscriberRefund: { name: "Refund", description: "Everything left, back to the subscriber.", icon: "subscriber", lockingScript: "subscriberLockingScript", valueSatoshis: "$(refundSatoshis)", token: null },
  },
  lockingScripts: {
    standingOrderContract: { name: "Standing Order covenant", description: "P2SH32 of the compiled StandingOrder contract with this order's arguments.", icon: "standing-order",
      lockingType: "p2s", lockingBytecode: "standingOrderLockingBytecode", state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: ORDER_ROLES },
    merchantLockingScript: { name: "Merchant address", description: "P2PKH of the merchant.", icon: "merchant", lockingType: "p2s", lockingBytecode: "merchantLockingBytecode", state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: ROLES },
    subscriberLockingScript: { name: "Subscriber address", description: "P2PKH of the subscriber.", icon: "subscriber", lockingType: "p2s", lockingBytecode: "subscriberLockingBytecode", state: { variables: [], secrets: [] }, selectable: false, balance: NO_BALANCE, roles: ROLES },
  },
  scripts: {
    // Bytecode + args: the compiled contract and its constructor arguments are separate named scripts, and the redeem script
    // is the args followed by the bytecode (same bytes the solidcash SDK produces, so the address is unchanged).
    // Compiled contract bytecode: contracts/standing_order.scash, solidc 0.50.0 (standing_order.body.json); no argument inside.
    standingOrderContractBytecode: `0x${bodyHex}`,
    // Constructor arguments, last argument pushed first (as solidcash pushes them): merchant, subscriber, amount, period, fee, id.
    standingOrderConstructorArgs: "<orderId> <maxFee> <periodBlocks> <amountPerPeriod> <subscriberPkh> <merchantPkh>",
    standingOrderRedeemBytecode: "standingOrderConstructorArgs standingOrderContractBytecode",
    standingOrderLockingBytecode: "OP_HASH256 <$(<standingOrderRedeemBytecode> OP_HASH256)> OP_EQUAL",
    claimUnlockingBytecode: `<${CLAIM}> <standingOrderRedeemBytecode>`,
    cancelUnlockingBytecode: `<${CANCEL}> <standingOrderRedeemBytecode>`,
    merchantLockingBytecode: "OP_DUP OP_HASH160 <merchantPkh> OP_EQUALVERIFY OP_CHECKSIG",
    subscriberLockingBytecode: "OP_DUP OP_HASH160 <subscriberPkh> OP_EQUALVERIFY OP_CHECKSIG",
    subscriberUnlockingBytecode: "<subscriberKey.schnorr_signature.all_outputs> <subscriberKey.public_key>",
    remainingOrderSatoshis: "<orderSatoshis> <amountPerPeriod> OP_SUB <maxFee> OP_SUB",
    lastPaymentSatoshis: "<orderSatoshis> <maxFee> OP_SUB",
    refundSatoshis: "<orderSatoshis> <authSatoshis> OP_ADD <maxFee> OP_SUB",
  },
  variables: {
    merchantPkh: variable("Merchant", "HASH160 of the merchant's public key (20 bytes).", "bytes"),
    subscriberPkh: variable("Subscriber", "HASH160 of the subscriber's public key (20 bytes).", "bytes"),
    amountPerPeriod: variable("Amount per period", "Satoshis paid to the merchant each period.", "satoshis"),
    periodBlocks: variable("Period (blocks)", "Blocks between payments (relative timelock on the order coin).", "integer"),
    maxFee: variable("Max fee", "Most satoshis a payment or cancel may leave to miners.", "satoshis"),
    orderId: variable("Order id", "8 random bytes: gives every order its own address.", "bytes"),
    orderSatoshis: variable("Order coin value", "Value of the order coin being spent.", "satoshis"),
    fundSatoshis: variable("Funding", "Satoshis locked when the order starts.", "satoshis"),
    authSatoshis: variable("Authorizing coin value", "Value of the subscriber's own coin that authorizes the cancel.", "satoshis"),
    subscriberKey: variable("Subscriber key", "Signs the authorizing coin of a cancel.", "private_key"),
  },
  icons: ["standing-order", "subscriber", "merchant", "service"].map((name) => ({ name, hash: "0000000000000000000000" })),
};
export default standingOrderTemplate;
