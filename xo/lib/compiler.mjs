// libauth compiler for the XO template's scripts (shared by test.mjs and demo.mjs). The XO template stores scripts as strings;
// libauth wants { script } objects and needs to know which locking script a signing unlock covers.
import { walletTemplateToCompilerBch } from "@bitauth/libauth";
import T from "../standing-order.template.mjs";
export const template = T;
export const libauthTemplate = {
  $schema: T.$schema, name: T.name, supported: T.supported, version: 0,
  scripts: Object.fromEntries(Object.entries(T.scripts).map(([k, v]) => [k,
    k === "subscriberUnlockingBytecode" ? { script: v, unlocks: "subscriberLockingBytecode" }
      : k === "subscriberLockingBytecode" ? { script: v, lockingType: "standard" } : { script: v }])),
  entities: { all: { variables: Object.fromEntries(Object.entries(T.variables).map(([k, v]) => [k, { type: v.type === "private_key" ? "Key" : "AddressData" }])) } },
};
export const compiler = walletTemplateToCompilerBch(libauthTemplate);
export function compile(scriptId, data) {
  const r = compiler.generateBytecode({ scriptId, data });
  if (!r.success) throw new Error(scriptId + ": " + JSON.stringify(r.errors).slice(0, 300));
  return r.bytecode;
}
