# Corrected minimum fixture candidate proof

This branch-only transport applies the frozen full candidate patch once to source `072b3b805ab5f32e4f274790157d4ddd29b52c84`. The original checkpoint bundle and accepted transport `586dbc201aa2567befb249df8fb5103bd40a4a59` remain preserved.

- Bootstrap requires the original commit/tree, exact patch hash and size, exact candidate tree, all 19 candidate file hashes, protected source hashes and transport hashes.
- Normal and restored positive-control runs require every test in the same seven focused suites to pass. Counts are observed from Jest, with no pending tests or runtime errors accepted.
- The shared-default mutant holds Sepolia at five USDCx and requires exactly three real consumer failures. The separate Sepolia mutant retains the five-USDCx shared default and requires exactly one real consumer failure.
- Each sensitivity arm requires all ten config tests, exact failed names, the line21 assertion and its expected undefined/received amount5 result. Import, setup, serialization or unrelated failures reject the proof.
- Each arm preserves its mutation patch, before/mutated/restored hashes, complete structured assertions and terminal output. Source restores in `finally`, followed by a full seven-suite positive control.
- No coverage, browser, RPC, funding, device or chain operation runs. Runner, cache and lockfile install remain unchanged. Final-head CI, independent review, screenshots and merge gates remain separate.
