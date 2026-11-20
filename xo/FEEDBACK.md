# XO feedback (Standing Order port, 19-20 Nov)

The bigint thing cost us the most time, about an hour. We built the template object, saved it with `JSON.stringify(T)`, imported it in the debug tool, then tried Join Invitation with one of our chipnet invitations: "Template not found". The import works, but under a different template id, because the bigints are gone. `serializeTemplate` fixed it straight away. One line in the docs, or a warning on import, would have saved that hour.

Other things that slowed us down, each with how to hit it:

- Network mismatch. Open the debug tool with a mainnet account and load a chipnet invitation: three "network mismatch" errors and nothing pointing at the account. Switching the account to chipnet fixed it.
- Keyless claim. Fund an order from one engine, start a second engine with a fresh database and the same template, build the claim against the order's coin. The second engine won't use that coin until it tracks the order's locking script, and that tracking lives in its own state. So someone who only wants to trigger a due payment can't. Our workaround: name the order output by its locking bytecode in the fund action, so the roles track the script.
- SQLite in Node. We create the engine with IndexedDB storage (fake-indexeddb), but importing `@xo-cash/state` still pulls in the native SQLite modules. We map them to a stub.
- Bytecode from SolidCash. SolidCash gives bytecode, not CashAssembly, so first we pasted the contract body as a hex literal after the argument pushes. On 20 Nov GP told us bytecode plus constructor args reads better (and that CashScript snippets, CashScript/cashscript#256, are the longer-term answer). We switched the same day; the order addresses stayed the same and fund, claim and last claim re-ran on chipnet.

What helped: starting from the faucet template, because our coin behaves the same way (waits, pays out, keeps the rest), so the roles came almost for free. And Inspect in the debug tool: we pasted our claim txid and stepped through all 157 steps with the op cost next to each one. We learned more there than from our own tests.

Versions: @xo-cash/engine 0.1.1-next.18029697917, @xo-cash/state 0.0.6, @xo-cash/templates 0.0.12, @xo-cash/utils 0.0.11, Node 22. The same lessons carried over to Standing Order Plus (split payee, pause, resume, cancel), the template we entered for Build with XO.

What we'd ask for:
- a "watch this script hash" call;
- a check that compiles every action of a template once and lists unresolved variables;
- one worked example of follow-up actions (our claim then lastClaim chain took trial and error).
