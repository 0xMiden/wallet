# PR1615 corrected fixture candidate CI request

Run the 7 focused Jest files and both isolated post-fix sensitivity arms on the exact candidate below. C002 remains uncommitted until the normal run is green and both sensitivity results match their predictions. This request authorizes no live funding, chain write, browser or device run.

## Pin and apply once

Use the separate temporary CI transport with Node22 and the existing lockfile/cache setup. Reuse the accepted BigInt-safe results processor without changing the source tests or assertions.

- Original source commit: `072b3b805ab5f32e4f274790157d4ddd29b52c84`.
- Original source tree: `fcb29490602873b20fd85f983e4827e23c887ace`.
- Full patch: `candidate.patch`, SHA256 `62382a6c5d9cacfae1e41df5b0f0160a137f0bf947ab7cafbc5971d982a07146`, 45,440 bytes.
- Expected candidate tree after application: `b00e491e4459a5e7d71b0856e9481d65cabeedb2`.
- Current worktree head containing C001 only: `e247ca8b6185ff00678e9408bc0143c4df4879a7`.

Apply the full patch once to the original source. It already contains both checkpoint tests, including committed C001. Do not also apply the earlier test-checkpoint.patch, and do not apply this full patch on top of C001. Confirm all 19 current file hashes against candidate.json and record the transport commit, source, applied patch and candidate tree with every arm. A transport commit is not the final PR head.

## Normal corrected candidate

Run with no coverage and at most 2 workers:

```sh
yarn jest --runTestsByPath \
  src/lib/usdcx/use-burn-minimum.test.ts \
  playwright/e2e/helpers/usdcx-config.test.ts \
  playwright/e2e/helpers/arc-usdcx.test.ts \
  playwright/e2e/helpers/bridge.test.ts \
  playwright/e2e/helpers/usdcx-run.test.ts \
  playwright/e2e/helpers/usdcx-l2-deposit.test.ts \
  scripts/e2e-real.test.ts \
  --maxWorkers=2 --coverage=false
```

Prediction: all 7 suites and all their tests pass. In particular all 4 live-destination consumer cases pass, the existing grant-floor parity checks execute against 6 USDCx, the current funding boundary passes at 6 USDCx and fails as expected at 5.999999, and direct payout rows retain the unchanged fees. Record the observed count rather than inferring an unrun total. Any import/setup/serialization error or unexpected assertion is a stop before accepting the candidate.

Run appropriate named-file formatting/lint and TypeScript checks in CI, including the changed harness surfaces. Do not widen a lint baseline or change any gate. Local TypeScript and the named script/hook formatting preflights passed; the focused local Jest command was refused with status75 and was not bypassed.

## Isolated sensitivity A: shared live default

On a disposable CI copy of the exact candidate only:

1. In `playwright/e2e/helpers/usdcx-constants.ts`, replace `export const BURN_UNITS = USDCX_MIN_BURN;` with `export const BURN_UNITS = 1_000_000n;`.
2. In the `ETHEREUM_SEPOLIA_PAYOUT` reads object, add `burnUnits: 5_000_000n` in this arm only. Keep its other properties unchanged. This isolates the shared default while allowing the module to import.
3. Run only `playwright/e2e/helpers/usdcx-config.test.ts` with Jest, maxWorkers2 and no coverage.

Prediction: 10 tests total, 7 pass and exactly 3 fail. The failing names end in Arc Testnet, Base Sepolia and Arbitrum Sepolia. Each fails the actual consumer assertion at `usdcx-config.test.ts:21`, expecting undefined and receiving `{amount:'5'}`. Sepolia's consumer case passes at 5 USDCx.

Restoring default1 without holding Sepolia5 throws during module import because Sepolia's 1.5 USDC fee allowance takes 1 USDCx whole. That is not consumer proof and must not be credited as these 3 failures. Stop if the isolated arm fails to import or reaches a different assertion.

## Isolated sensitivity B: obsolete Sepolia override

Independently begin from the unmutated exact candidate, retaining `BURN_UNITS = USDCX_MIN_BURN` at 5 USDCx. Add only `burnUnits: 2_000_000n` to the `ETHEREUM_SEPOLIA_PAYOUT` reads object, preserving its other properties. Run the same config test alone.

Prediction: 10 tests total, 9 pass and exactly 1 fails. Only the name ending in Sepolia fails at line21, expecting undefined and receiving `{amount:'5'}`. Arc Testnet, Base Sepolia and Arbitrum Sepolia consumer cases pass. The module must import successfully.

## Evidence and restoration

Preserve each independent arm's exact mutation patch, before/mutated/restored file hashes, exit status, structured assertions and terminal output. No local source mutation is requested. Restore and verify candidate file hashes after each arm. Finish with a clean candidate positive control and include its green result. Preserve prior accepted checkpoint evidence and the failed first transport attempt.

The earlier accepted CI run is 39300055230, job 118222577910, transport `586dbc201aa2567befb249df8fb5103bd40a4a59`. It proves the original 4 consumer reds plus normal and mutated hook behavior; it does not replace this corrected-candidate proof.

## Later merge gates

This is a correction checkpoint only. Final source/base alignment and fresh review remain separate. The actual final PR head still needs the configured full unit, lint, i18n, unchanged 95% branches/functions/lines/statements coverage gate, applicable PR E2E and compile/build checks. Inspect all build output for errors and verify expected build artifacts. Applicable immediate-floor, later-minimum and fallback states need fresh screenshots in both themes. No visual verification, live payout measurement, publication or merge approval is claimed by this checkpoint.
