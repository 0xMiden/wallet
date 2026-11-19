# Nightly-only Epoch solve-failure diagnostics

## Intent

Original attempt44034323631 failed after successful approve/deposit, but only the later provider-note-readiness failure fingerprint survived. The original solver/allocator exception is unavailable. Recovery is now independently complete: original principal returned, original lock disabled, canonical Epoch cancelled925269/official440792 and independently verified440817; original cap243414 spent/1756586 remaining. No new payer is authorized by this diagnostic change itself.

The product already logs a fixed `[EpochBridge] EVM→Miden solveIntent failed:` console site. The nightly currently does not retain that failure. Observe this existing site without changing product transactions, original acceptance predicates or error handling.

## Approaches and decision

- Selected under standing independent authority: a scoped nightly page-console observer, safe finite SDK error metadata and ephemeral process-keyed HMAC. No product behavior change.
- Request/response interception or SDK monkeypatching would alter more timing and trust boundaries; reject.
- Exporting original errors, logs, payloads, free-form names/codes/URLs or guessing a retry/timeout/RPC/amount/auth fix is prohibited.

## Exact behavior

- Only the first console event of type error with the exact existing public solve-failure prefix on the active reverse wallet page is eligible.
- Write only `{site, observedAt, errorSha256, kind, httpStatus?}` to `${checkpointPath}.return-solve-failure.json`, mode0600. Fixed site `evm-to-miden-solve`; errorSha256 is HMAC-SHA256 with a fresh unretained32-byte key, never a public unkeyed hash.
- Fixed kinds: api-error, transaction-error, compact-sdk-error, unknown. Read only own DATA descriptors for SDK name/status. Pinned SDK2.0.1 APIError uses `.status`, not `.statusCode`. Status is exported only for APIError and integer100-599; everything else is omitted. Never export arbitrary error code, message, stack, transaction hash, URL, SDK bytes or keys. Descriptor/getter/proxy errors become unknown.
- Persist the basic keyed record synchronously before asynchronous JSHandle metadata inspection. At most one safe metadata update; a closing page or failed inspection must not lose the basic record or replace the original error. Never await this diagnostic on the money path.
- Register immediately before the existing reverse UI try block; stop before existing counterparty.stop in finally. Stop/unavailable console registration/diagnostic I/O must not throw into the financial flow. Ignore later and unrelated events; never alter polling/transport/retries/timeouts/nonce/amount/auth/ACK/budget.
- Explicitly retain this single safe filename beside the existing readiness sidecar in public summaries. Do not broaden an artifact glob or export raw worker logs.

## Scope and tests

New small helper and focused Jest contracts; real non-funded Playwright smoke verifies actual ConsoleMessage/JSHandle serialization with a synthetic Error on about:blank. No wallet, account, RPC, signing secret or deposit in this smoke. Preserve mainnet trace/video/screenshots off.

Touch only nightly helper/caller, exact artifact allowlist and its existing workflow test, one browser smoke, CHANGELOG and repo design/plan. Keep current main675cc SDK0.18/Guardian0.19rc2/lockfiles and every original15/95 gate unchanged. Genuine functional assertion RED precedes implementation; type/import/setup failures are not RED. Use branch-only temporary proof workflow and omit it from the final PR.

Completion requires unit/real-browser proof, existing contract suites and discovery/types, internal whole-change review, all original15 current-head actual successes/95 coverage, authorized squash merge with tree/source binding, then current held/dual-readiness and remaining-cap checks before considering a new ordinary funded attempt. Original cause stays UNKNOWN until actual evidence identifies it. Legacy exclusion, no public NEAR rollout/new funds/accounts/Council/raw-private export remain.
