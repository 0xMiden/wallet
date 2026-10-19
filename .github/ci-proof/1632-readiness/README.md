# Readiness sensitivity CI request

Status: private proposal only. No wallet source edit, commit, push, test or mutation execution has occurred. The three scheduled code panels and schema4 plan gate validated; current-head CI and post-fix verification remain pending. Umbrella1632 stays open.

Checkpoint source: `811686e46ebf8c60cec9d020b68e342dfb3904c0`. Checkout that exact reviewed commit for this proof job. The portable bundle supplies the proposed test versions without committing a production mutant.

| CI arm | Test bytes | Production bytes | Expected Jest result |
| --- | --- | --- | --- |
| old-normal | fetch.test.old.ts | fetch.production.normal.ts | exit0, exactly the named test passes |
| old-mutant | fetch.test.old.ts | fetch.production.mutant.ts | exit0, exactly the named test passes, establishing vacuity |
| new-normal | fetch.test.f001.ts | fetch.production.normal.ts | exit0, exactly the named test passes |
| new-mutant | fetch.test.f001.ts | fetch.production.mutant.ts | exit1, exactly the named test fails at the constructor assertion |
| combined-normal | fetch.test.proposed.ts | fetch.production.normal.ts | full named fetch test file passes |

Exact focused name: `metadata/fetch uncached chain failures waits for SDK readiness before parsing and requesting a proof`.

Pinned new-mutant failure: `src/lib/miden/metadata/fetch.test.ts:680` at `expect(mockRpcClient).not.toHaveBeenCalled()`, reporting `Expected number of calls: 0` and `Received number of calls: 1`. The separate readiness-rejection test is excluded from every focused mutant arm, because its independent failure would not prove this vacuity.

Run only in GitHub Actions with Node22 and the reviewed checkout dependencies installed through the existing pinned-lockfile setup. Extract this bundle outside the checkout, then invoke:

```sh
node "$RUNNER_TEMP/wallet1632-readiness/matrix.mjs" "$GITHUB_WORKSPACE"
```

`matrix.mjs` refuses local execution, validates the exact source commit and every bundled file hash, runs separate Jest processes with2workers and no coverage, records JSON/log output for every arm, validates the exact selected test/assertion failure, and restores the original CI checkout bytes in finally. The proof runner exits0 only after the expected failing mutant and every passing arm validate. The raw new-mutant Jest exit1 and failure remain in results/new-mutant.json and its log. A runtime/collection error, wrong selected case, timeout, different assertion or unexpected pass fails the proof runner.

Upload the complete results directory, request.json and exact bundle checksum. This request does not alter workflows or runner profiles. Root owns routing, artifact transfer and any notification to other sessions if shared CI changes are needed.

Patch sequence for the eventual feature checkpoint, only after routing authorization:

1. f001-readiness.patch adds a gate-entry signal to the existing positive readiness test and asserts RPC construction stays blocked.
2. f002-description.patch applies after it and replaces the identical two-row description matrix with its existing empty-description case. The full words and both omission assertions remain identical. Missing-slot and all strict codec matrices remain.

`test-fixes.patch` is the combined alternative. The normal production file is byte-identical to the reviewed source. `temporary-production-mutant.patch` is for the ephemeral proof checkout only and must never be committed to the feature branch.

The test-only mutation applicability ruling is explicitly confirmed: restoring either changed test hunk against correct production restores a weak/redundant passing test. Do not invent a production baseline failure or a source/count mirror assertion. The four-arm sensitivity result proves F001; the retained omission assertions and full fetch test file preserve F002 coverage.

After the approved patch is actually applied, current-head CI must run the full wallet gates with unchanged95percent thresholds. A fresh four-bundle verification panel over the material test changes remains required. No done state, final report or PR review publication is claimed by this request.
