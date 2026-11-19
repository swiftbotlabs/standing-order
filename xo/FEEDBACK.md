# Feedback on building with XO

We moved Standing Order (a SolidCash covenant for recurring payments) onto XO during BLAZE. The contract itself did not change. The work was writing an XO template around it and then getting the engine to fund, claim and close an order through invitations on chipnet. Notes from that, in the order we hit things.

**What worked well.** The faucet template was the right thing to copy. Same shape as ours (a coin that waits some blocks, pays out, keeps the rest), so roles and actions mapped over quickly, including a "service" role anyone can take to trigger a due payment. Once the engine had the template, creating, signing and executing invitations just worked, and `serializeInvitation` gives you a file you can hand to someone else. The debug tool is the best part. Pasting a txid into Inspect and stepping through all 157 steps of our claim, with the op cost next to it, told us more than our own tests did.

**Where we lost time.**

1. Template identifiers. We exported our template with plain `JSON.stringify` so the debug tool could import it. It imported fine but got a different id (9066f726… instead of bd50bcd1…), because the bigints were dropped, and then Join Invitation said "Template not found". Nothing pointed at the cause. `serializeTemplate` fixes it. Suggestion: say in the docs that this is the only safe way to export, and have the import show a warning when a template has lost bigint fields.

2. Network of the account in the debug tool. Our first tool account was on mainnet, and opening a chipnet invitation gave three "Extended public key network mismatch" errors. A hint like "this invitation is for chipnet" would help.

3. A role with no key. The claim is meant to be run by anyone. The engine only accepted the order's coin as an input once it tracked that locking script, and the tracking lives in engine state. So a fresh engine cannot claim an order it did not see funded, and that is exactly the case for a third party who triggers payments. We worked around it by having the subscriber and trigger roles track the order script. A documented way to tell the engine "watch this script hash" would be cleaner.

4. Native SQLite at load time. `@xo-cash/state` loads the native SQLite modules even when you choose IndexedDB storage. We did not want native modules in a Node script that only uses IndexedDB, so we stub them (`lib/no-native.mjs`). Loading them lazily, only when SQLite storage is picked, would remove the need.

5. Contracts compiled elsewhere. SolidCash gives bytecode, not CashAssembly source, so we put the contract body in the template as a hex literal after the argument pushes. It works, but we are not sure it is the intended pattern. A documented "bytecode plus constructor arguments" form would make ports like ours much easier. We asked about this in the General Protocols group.

**Missing that we would use.** A watch-only "track this covenant" call (point 3), a template linter that compiles every action once against a sample and reports which variables are unresolved, and a short page on follow-up actions with a worked example.

Overall: once it clicked, XO was a good fit for a covenant with clear roles, and the invitation flow is a nicer story for users than "here is a script, sign this". Most of our hours went into the identifier and state issues above, not the contract.
