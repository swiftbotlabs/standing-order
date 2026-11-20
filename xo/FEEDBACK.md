# XO feedback from porting Standing Order

We ported Standing Order to XO on 19 Nov, during BLAZE. Standing Order is our SolidCash subscription covenant: you lock coins once, the merchant can take one fixed amount per period, and you can cancel and get the rest back. We left the contract alone, wrote an XO template around it, and ran fund, claim and a last claim through invitations on chipnet. Versions: @xo-cash/engine 0.1.1-next.18029697917, @xo-cash/state 0.0.6, @xo-cash/templates 0.0.12, @xo-cash/utils 0.0.11, Node 22.

Overall it was a good experience. What helped most: starting from the faucet template, since our coin behaves the same way (it waits, pays out, keeps the rest), which gave us the roles almost for free, including a "service" role anyone can take to trigger a payment that is due. And the debug tool: we pasted the claim txid into Inspect and stepped through all 157 steps with the op cost next to them, and learned more than from our own tests.

What cost us time, with how to hit it again:

- "Template not found". Build the template object, write it with `JSON.stringify(T)`, import that file in the debug tool, then Join Invitation with one of our chipnet invitations. The import works but under a different template id, and Join fails with "Template not found": the bigints were dropped. Exporting with `serializeTemplate` fixed it at once (our check script now prints MATCH). A line in the docs, or a warning on import, would have saved us an hour.
- Three "network mismatch" errors. Open the debug tool with a mainnet account and load a chipnet invitation. You get three errors and no hint that the account is the problem. Switching the account to chipnet fixed it.
- The keyless claim. Fund an order with one engine, then start a second engine with a fresh database and the same template, and build the claim against the order's coin. The engine won't take that coin as an input until it tracks the order's locking script, and the tracking lives in its own state. So an outside party who only wants to trigger a due payment can't. We worked around it by naming the order output by its locking bytecode in the fund action, so the roles track the script. A plain "watch this script hash" call would be better.
- SQLite. Create the engine with IndexedDB storage in Node (we used fake-indexeddb): just importing `@xo-cash/state` still pulls in the native SQLite modules. We map them to a stub in our Node scripts.
- Bytecode from another compiler. SolidCash gives you bytecode, not CashAssembly, so at first we put the contract body in as a hex literal after the argument pushes. On 20 Nov General Protocols told us bytecode plus constructor args reads better, and that CashScript "snippets" (CashScript/cashscript#256) are the longer-term answer. We switched the same day: same order addresses, and fund, claim and last claim re-ran through invitations on chipnet.

The same lessons carried straight over to Standing Order Plus (split payee, pause, resume, cancel), which is the template we entered for Build with XO.

Three things we'd ask for: the "watch this script hash" call, a check that compiles every action of a template once and lists unresolved variables, and one worked example of follow-up actions (our claim-then-lastClaim chain took some trial and error).

We'd use XO again for covenants with clear roles. Handing someone an invitation to read and sign is a much easier story than handing them a script.
