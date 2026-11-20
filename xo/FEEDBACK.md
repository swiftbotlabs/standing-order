# XO feedback from porting Standing Order

We ported Standing Order to XO on 19 Nov, during BLAZE. Standing Order is our SolidCash subscription covenant: you lock coins once, the merchant can take one fixed amount per period, and you can cancel and get the rest back. We left the contract alone and wrote an XO template around it, then ran fund, claim and a last claim through invitations on chipnet.

Overall it was a good experience. Most of the time went into a handful of rough edges, not into the contract.

What helped: we started from the faucet template because our coin behaves the same way (it waits, pays out, keeps the rest). That gave us the roles almost for free, including a "service" role anyone can take to trigger a payment that is due. Signing invitations through the engine just worked after that. The debug tool was the best part. We pasted the claim txid into Inspect and stepped through all 157 steps with the op cost next to them, and it showed us more than our own tests did.

What cost us time:

- "Template not found". We saved the template with plain `JSON.stringify` so we could load it in the debug tool. It loaded, but with a different id from the one in our invitations, so Join Invitation kept failing with "Template not found". The bigints had been dropped on the way out. `serializeTemplate` fixed it at once. One line in the docs saying "export with serializeTemplate", or a warning on import, would have saved us an hour.
- Three "network mismatch" errors. Our first account in the debug tool was a mainnet one and the invitations were chipnet. Obvious afterwards, but a hint pointing at the account would help.
- The keyless claim. The point of our claim is that anyone can run it, but the engine only accepted the order's coin as an input once it was tracking that script, and the tracking lives in the engine's own state. So a fresh engine can't claim an order it didn't see funded, which is exactly the case of an outside party triggering payments. We worked around it by having the roles track the order script. A plain "watch this script hash" call would be better.
- SQLite. `@xo-cash/state` loads its native SQLite modules even when you choose IndexedDB. We stubbed them out in our Node scripts.
- Bytecode from another compiler. SolidCash gives you bytecode, not CashAssembly, so at first we put the contract body in as a hex literal after the argument pushes. We weren't sure that was right, so we asked in the General Protocols group.

On 20 Nov General Protocols answered: bytecode plus constructor args reads better than a hex literal, and CashScript "snippets" (CashScript/cashscript#256) are the longer-term answer. We changed the Standing Order template the same day (the contract bytecode and its constructor args are now two named scripts, same order addresses) and re-ran fund, claim and last claim through invitations, plus fund, claim and cancel from the template, on chipnet.

If we could ask for three things: the "watch this script hash" call, a check that compiles every action of a template once and lists unresolved variables, and one worked example of follow-up actions. Our claim-then-lastClaim chain took some trial and error.

We'd use XO again for covenants with clear roles. Handing someone an invitation to read and sign is a much easier story than handing them a script.
