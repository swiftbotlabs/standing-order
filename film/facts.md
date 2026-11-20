# Standing Order film: every on-screen claim and its source

Product world = real screenshots of the live dapp https://standing-order.swiftbotlab.workers.dev/ on chipnet (test coins), captured
headless with Playwright by /data/blaze/film/capture.cjs (log + element boxes in capture2/). The wallet in the capture is our headless
WizardConnect test wallet (/data/blaze/wizard-wallet/wallet.mjs), so the phone-style sign request in scene 2 is a drawn card that shows the
dapp's real request text; it is labelled "test wallet · chipnet". Scene 1 (card on file, ledger) is an illustration and says so.

| Claim on screen / in voice | Source |
|---|---|
| Plan "Studio membership", 10,000 sats every block, 1,000 to a co-creator, 3 periods, 39,000 sats prepaid incl. claim fees | dapp pay page text (capture), pay link in capture/log.txt |
| Sign request text "Start a standing order: 10,000 sats every 1 block(s) for "Studio membership"" | capture/wallet.log SIGN REQUEST line (the dapp's userPrompt) |
| Claim tx 5331c3fc…: input 39,000; outputs merchant 10,000, co-creator 1,000, back into the order 26,000; fee 2,000 | txs.json (decoded from chipnet via Electrum), relayer journal 14:53:12Z "order bfccfe4b chipnet: CLAIMED 5331c3fc…" (first capture run) |
| Claim tx in block 332597 | capture/30-order-final.png history list |
| "relayer: claim before the period → rejected: non-BIP68-final (code 64)" at 14:48:09Z | `journalctl --user -u standing-order-relayer` 2026-11-15 14:48:09Z, order bfccfe4b (same order, 5 min before the claim landed) |
| Pause moves the coins to a contract nobody can collect from | contracts/paused_order.scash has only resume() (back to this order) and cancel() (to the subscriber); paused tx de8564d5 output 15,000 to bchtest:pwlw2f… (txs.json) |
| Resume / Add a period / Cancel txids 93897069 / 48caa653 / 8b4cc5f0 | capture/log.txt RESUMED / TOPUP / CANCELLED lines; txs.json |
| "77 tests", solidhat green | local agent 1115-1450-blaze-v2-deploy.result.md: `npx solidhat test` 5 files, 77/77 passed |
| Replay attacks tested | test/replay.test.ts (7 cases, VM-verified, red against the old contract) |
| Two independent security reviews | STATUS.md 11-14 12:05Z review (replay HIGH fixed) and 11-15 14:5xZ v2 review (/data/blaze/REVIEW_V2.md, 4 fixes) |
| Contract lines in scene 8 | contracts/standing_order_plus.scash lines 62-64, 47, 125-127 (verbatim; "..." marks omitted lines) |
| Scene 3 numbers (30,000 → three payments of 10,000) | schematic, no split, round numbers; matches the contract rule (one period's amount per period) |
| "Built during BCH BLAZE 2026" | build window 14-22 Nov; v2 contracts and this film were made on 15 Nov |

Second capture run (capture2/) repeats the same flow on the final site (banner with the 14-Nov links, fixed form, new wording); its txids
replace the ones above where they differ (see capture2/log.txt).

Sound: narration (Kokoro af_heart draft; final ElevenLabs Bella, eleven_v4, owner's account), music "Fire Place" by HoliznaCC0 (CC0, FMA),
effects CC0 from Freesound (UI click by Ranner 488534, wooden button by Troube 686544, Stamp by kermite607 362623). See CREDITS.md.

## Final capture (capture2/, used in the film), 2026-11-15
- Subscribe da20c2b3dfdbcfa78a966d4082a4d111dd037431b0bb7aee0a5ed0ee051221f9 (39,000 to bchtest:pvd0j7…, block 332605)
- Relayer claim 3544cee941616ffeb2f4561a71bb6b0e7fe82d559e37c2f7b53cb9d8a76e9660 (block 332616): merchant 10,000, co-creator 1,000, back into the order 26,000, fee 2,000 (txs2.json). Run by scripts/relayer.mjs (the relayer code, keyless) at 15:13:12Z.
- Network refusals of the same claim before it was final: relayer timer 15:03:08Z and 15:08:09Z "non-BIP68-final (code 64)" (journalctl). The film quotes 15:03:08Z.
- Pause ad673916c516ac78acc50714daa367797c4ed53917d980611d0b3c2bea6f3785 (15,000 to the paused covenant bchtest:pwvrq4…), resume 71b6dd476e27148c12395542b9aca409b23b7045cf372f3091568c8616e70703, add a period 967272b023e5fe8cc24f1a716d9db38edf48062d73533611f3de761c42327968, cancel 77bc1d3ceae410015a48238f302f74efcb00decb264b5dbe17c824a966ded5d1 (148,112 back to the subscriber wallet).

## Paytaca still (added 2026-11-16)
The phone in scene 2 now shows a real Paytaca v0.27.3 sign request (Samsung, chipnet). It comes from a separate run of the same pay link,
2026-11-16 08:1xZ: subscribe 2319c5cb..., pause 6d60c534..., cancel 590d4f74... (queue/exec/1115-1450 result). The status bar is cropped,
and the screen is labelled "Paytaca, a real BCH wallet · chipnet". The tap on Approve is drawn as a ring.
