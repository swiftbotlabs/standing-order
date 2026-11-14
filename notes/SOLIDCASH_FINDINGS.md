# SolidCash findings (for upstream PRs, SolidCash bounty)

1. examples/*.scash declare `pragma solidcash ^0.14.0`; published @solidcash/solidc 0.50.0 rejects them: "solidc version 0.50.0 does not satisfy version constraint ^0.14.0". Every example fails to compile as shipped. Fix: bump the pragmas (or loosen the check for 0.x).
2. The vitest matchers `toFailRequire` / `toFailRequireWith` are async (`Promise<void>`, dist/test/TestExtensions.d.ts), but
   examples/testing-suite/test/transfer_with_timeout.test.ts calls `expect(tx).not.toFailRequire();` without `await` inside a
   non-async `it`. An unawaited matcher can let a test pass without asserting. Proven on our suite: planting a wrong expectation
   only turns red once the call is awaited (2 planted failures -> 2 red; restored -> 8/8 green). Fix: `it(..., async () => { await expect(tx)... })`,
   and/or make the matcher throw synchronously when not awaited (Vitest's `expect.poll`-style warning).
3. `toFail()` does not exist (Chai error "Invalid Chai property: toFail"); a timelock (CSV) failure is reported by `toFailRequire`.
   Worth a docs line: which matcher covers non-`require` script failures (OP_CHECKSEQUENCEVERIFY).
4. Token category byte order: `tx.inputs[i].tokenCategory` compares against the category in the opposite byte order to the
   SDK's `token.category` hex (randomToken / utxo.token). Passing `hexToBin(utxo.token.category)` as a `bytes32` constructor
   argument makes every honest claim fail `require` (and every negative test pass for the wrong reason). Works with
   `hexToBin(category).reverse()`. Fix: document it next to tokenCategory, or accept the display order in the SDK and reverse
   when encoding constructor args. Our suite caught it only because the happy-path tests are awaited and positive.
5. `solidhat --init` writes `solidcash.config.ts`, but `solidhat compile` on Node 22 fails: "Unknown file extension \".ts\" for
   .../solidcash.config.ts" (and `--experimental-strip-types` -> "Node.js is not compiled with TypeScript support" on distro
   builds). Renaming to `solidcash.config.mjs` works. Fix: init writes .mjs/.js unless the project has a TS loader, or the CLI
   loads the config through a bundled loader (jiti/tsx).
6. The init config sets `compiler: { evmCompat: true }`. Then `solidhat compile` and plain `solidc` produce DIFFERENT bytecode for
   the same source (so a different contract address). Easy to fund one address and test another. With evmCompat false both
   match byte for byte. Fix: document what evmCompat changes, warn when artifacts from both paths coexist, or record the flag
   in the artifact.
7. MAJOR: WalletConnect/WizardConnect wallets cannot sign multi-function SolidCash contracts. For an OP_INVOKE-dispatched
   function the SDK signs over the FUNCTION BODY (Contract.js ~L604: "OP_CHECKSIG inside an OP_INVOKE'd function uses the
   function body as coveredBytecode"), but walletconnect-utils.js getWcContractInfo() puts the FULL redeem script in
   sourceOutputs[i].contract.redeemScript, which BCH WC2 wallets (e.g. @bch-wc2/privkey-connector signing.js L33) use as
   coveredBytecode. Result: every external signature fails NULLFAIL. Repro (scripts/diag_sign.mjs, 2026 VM): SDK signature
   verify OK; wallet signature "failed a signature verification with a non-null signature (NULLFAIL)". Setting
   contract.redeemScript = artifact.functionBodies[selector] -> wallet signature verify OK. Proven live on chipnet:
   cancel signed by a WizardConnect wallet, tx 0cd7464af4f629a5488193efb194c083919c559dbe190174970bb40ae686e4a7
   (before the fix the same flow was rejected: mandatory-script-verify-flag-failed, NULLFAIL).
   Fix: getWcContractInfo() passes the function body for dispatched functions (or adds a coveredBytecode field and
   documents it for wallets).
8. @solidcash/solidcash imports `@noble/curves/secp256k1` (dist/ecrecover/*.js, dist/framed/composer/recovery.js) but does not
   declare @noble/curves in its dependencies. It works only if a 1.x copy happens to be hoisted. Next to any package that
   brings @noble/curves 2.x (e.g. nostr-tools via @wizardconnect/core) a Vite build fails: "Missing \"./secp256k1\" specifier
   in \"@noble/curves\" package". Fix: declare "@noble/curves": "^1.9" (or move to the 2.x `secp256k1.js` path).

### 7, follow-up (15 Nov): what a real wallet does
Paytaca (Android, WizardConnect) ignores `contract.redeemScript` when the unlocking bytecode is present: it takes the last
push of the unlocking bytecode (the full redeem script) as covered bytecode and requires its hash to match the P2SH32
locking bytecode. So no request shape lets it sign inside an `OP_INVOKE`d function; the result is NULLFAIL on broadcast
("Signature must be zero for failed CHECK(MULTI)SIG operation"). Until wallets and the SDK agree on the covered bytecode
for dispatched functions, one pattern is to keep signatures out of the contract: authorize with a sibling input from
the signer's own P2PKH address (our `cancel()`), which every wallet signs correctly. It is only safe if the contract also
reads that input's sighash byte (ALL or ALL|UTXOS only) and fixes the outputs; otherwise a SINGLE/NONE/ANYONECANPAY
signature the signer made elsewhere can be replayed (see `test/replay.test.ts`).
Also: Paytaca decodes `transaction` only as a hex string; the object form fails with "Error reading Uint32LE".
