# Building with XO: our notes

We ported Standing Order to XO during BLAZE. Standing Order is a SolidCash covenant for subscriptions: the subscriber locks coins once, the merchant can pull one fixed amount per period, and the subscriber can cancel and take the rest back. We kept the contract exactly as it was and wrote an XO template around it, then ran fund, claim and a final claim through invitations on chipnet.

Short version: we liked it, and most of our time went into a few rough edges rather than the contract.

What we liked. We copied the shape of the faucet template, since our coin behaves the same way (it waits, pays out, keeps the rest). That gave us roles almost for free: subscriber, merchant, and a "service" role that anybody can take to trigger a payment that is due. After that, making and signing invitations through the engine was pretty painless. The debug tool was the highlight for us. Pasting the claim txid into Inspect and stepping through it (157 steps, op cost on the side) showed what the covenant was doing better than our own test output.

Things that tripped us up:

The template id. We first saved the template with plain `JSON.stringify` to load it into the debug tool. It loaded, but under a different id than the one in our invitations, so Join Invitation kept saying "Template not found". It took us a while to see that the bigints had been dropped on the way out. `serializeTemplate` fixed it straight away. It would help if the docs said loudly that this is the way to export, or if the import warned you.

Mainnet vs chipnet in the debug tool. Our first account in the tool was a mainnet one, and our chipnet invitations came up with three "network mismatch" errors. Easy once you know, but a hint pointing at the account would have been nice.

The keyless role. The whole point of our claim is that anyone can run it. But the engine would only take the order's coin as an input once it was tracking that script, and that tracking sits in the engine's own state. So a fresh engine can't claim an order it didn't see being funded, which is exactly the situation of a third party who triggers payments. We got around it by having the roles track the order script. A plain "watch this script hash" call would be much better.

SQLite. `@xo-cash/state` pulls in its native SQLite modules even when you pick IndexedDB storage. We stubbed them out for our Node scripts. Loading them only when SQLite is actually chosen would avoid that.

Bytecode from another compiler. SolidCash hands you bytecode, not CashAssembly, so we put the contract body into the template as a hex literal after the argument pushes. It works, but we honestly don't know if that is how you want it done. We asked in the General Protocols group. A documented "bytecode plus constructor args" option would make ports like this one a lot easier.

What we'd add: the watch call above, a linter that compiles every action of a template once and tells you which variables are unresolved, and one worked example of follow-up actions. Ours (claim, then lastClaim when too little is left for another period) took some trial and error.

Overall we'd use XO again for covenants with clear roles. Giving someone an invitation to look at and sign is a much easier story than handing them a script.
