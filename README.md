# Standing Order

**Subscriptions that pay themselves, on Bitcoin Cash.** Live: https://standing-order.swiftbotlab.workers.dev/

A subscriber funds a standing order once. The merchant can take one period's amount per period, never more and never
early. The subscriber can cancel any time and the rest comes straight back. No custody: the funds sit in a covenant
that only enforces those rules. Plans can be priced in BCH or in a CashToken stablecoin such as PUSD.

Built for BCH BLAZE 2026 (Mainnet track, SolidCash bounty).

## How it works

| Step | Who | What happens on chain |
|---|---|---|
| Subscribe | subscriber (WizardConnect wallet) | funds a `StandingOrder` covenant with N periods (+ claim fees) |
| Claim | anyone (our relayer, the page, the merchant) | after `period` blocks, pays the merchant exactly one period; the change must return to the same covenant |
| Cancel | subscriber only | spends the covenant back to the subscriber with their signature |

The period check is a relative timelock (`this.age >= period`) on the covenant's own UTXO, so every claim restarts the
clock: at most one claim per period, enforced by consensus, not by our server.

## Contracts (SolidCash)
- `contracts/standing_order.scash` (BCH): `claim()` / `cancel(pk, sig)`, 125 bytes.
- `contracts/standing_order_token.scash` (fungible CashTokens, e.g. PUSD): same rules in tokens; the covenant keeps a small
  BCH pool for fees; the last claim pays the remaining tokens and BCH to the merchant, 154 bytes.

## Tests
```
npm install
npx --no-install solidhat test     # 18 mock-network tests (both contracts), all assertions awaited
```
Negative tests were proven with planted controls (flipping an expectation turns the suite red).

## Proven on chipnet
- Early claim refused by the network; claim after one confirmed block paid the merchant exactly 20,000 sats
  (026fb3adafab7578cf0ac187fcd96ce01337e1e465d8cb2facd77cbab6bf20d5); immediate re-claim refused; cancel refunded
  (6f5d17649dd984871aa63fd2b9ba46708e9ba28c2dc775e702d480e4cb654177).
- Token order: claim paid exactly 500 tokens (4da3b5215547088ea806469a9fa69c2d0aceb244b32358cb90aa7062a95b9d2f);
  re-claim refused; cancel refunded tokens + BCH (8a1071df1d547253957e60f2150ab6bf6472e27bce33415a1ff0e36e359dfd07).
- Over WizardConnect: subscribe signed by a wallet (cc9acc9d437df09b41f2e7382e48e607d96849c792d8266895458b13e80173b2) and
  cancel signed by the wallet (0cd7464af4f629a5488193efb194c083919c559dbe190174970bb40ae686e4a7).
- The relayer collected a browser-made order on its own (940720a945287eb9589c9cd6900ecded841871ef3e41753867af5048bca4e44f).

## Web app (`web/`)
Vite + TypeScript, no framework. Pay-link generator, WizardConnect connect (QR or open link), subscribe, order status,
collect, cancel, merchant view. `web/worker.js` serves the app and a small order registry; `scripts/relayer.mjs` claims
due periods (it holds no keys).

## SolidCash findings
`notes/SOLIDCASH_FINDINGS.md` lists what we hit while building, with repros. The most important: WalletConnect /
WizardConnect wallets could not sign functions of multi-function contracts, because signatures inside an `OP_INVOKE`d
function cover the function body while `getWcContractInfo()` passed the full redeem script. The app works around it
(`fixCoveredBytecode` in `web/src/chain.ts`); a fix is prepared for upstream.

## License
MIT
