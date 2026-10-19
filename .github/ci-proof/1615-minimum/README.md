# Archived minimum checkpoint proof

This temporary branch proves only the two-test checkpoint on source `072b3b805ab5f32e4f274790157d4ddd29b52c84`. It does not approve PR1615's current head or correct the live fixtures.

- Push only `ci/1615-minimum-proof` to run the branch-specific workflow. There is no dispatch trigger or PR.
- The transport remains outside a separate exact-source checkout. Node22 installs the archived lockfile with Yarn's existing default cache location; no cache settings change.
- Bootstrap checks source commit/tree, baseline source/test/dependency hashes, transport hashes, decoded patch hash and the two patched test hashes.
- Normal checkpoint: 13 tests, 9 passes, exactly four minimum-consumer failures receiving `{"amount":"5"}`.
- Hook control: 3 passes. Each independent cleanup mutant: 2 passes and the stale-read failure at the final assertion, expected `8000000n`, received `9000000n`.
- Every mutant is derived once from verified normal source in CI and restored in `finally`, with source hashes checked after each arm. No mutant source is committed or uploaded.
- Each arm preserves Jest JSON and logs. `summary.json` labels actual red arms explicitly; the job succeeds only when all predicted outcomes match exactly.
- No coverage, browser, RPC, funding, device or chain operation runs. Dependency install can run archived package lifecycle scripts, as in the existing dependency setup.

Expected assertion locations: fixture line21 and hook line49. Any collection error, different test name, failure location, value, status or test count rejects this proof. Review and session notification must precede publication of this transport.
