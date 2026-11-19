// libauth compiler for the Plus template's scripts (offline tests). The subscriber's authorizing coin is a plain P2PKH input here,
// signed with a test key, as an XO wallet would add it.
import { walletTemplateToCompilerBch } from "@bitauth/libauth";
import T from "../standing-order-plus.template.mjs";
export const template = T;
const scripts = Object.fromEntries(Object.entries(T.scripts).map(([k, v]) => [k, { script: v }]));
scripts.authLockingBytecode = { script: "OP_DUP OP_HASH160 <$(<authKey.public_key> OP_HASH160)> OP_EQUALVERIFY OP_CHECKSIG", lockingType: "standard" };
scripts.authUnlockingBytecode = { script: "<authKey.schnorr_signature.all_outputs> <authKey.public_key>", unlocks: "authLockingBytecode" };
const variables = Object.fromEntries(Object.keys(T.variables).map((k) => [k, { type: "AddressData" }]));
variables.authKey = { type: "Key" };
export const compiler = walletTemplateToCompilerBch({ $schema: T.$schema, name: T.name, supported: T.supported, version: 0, scripts, entities: { all: { variables } } });
export function compile(scriptId, data) {
  const r = compiler.generateBytecode({ scriptId, data });
  if (!r.success) throw new Error(scriptId + ": " + JSON.stringify(r.errors).slice(0, 300));
  return r.bytecode;
}
