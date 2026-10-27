# Disposable normal wallet worker proof

Use accepted factory source `099982aecac255b6b3e7e0449c3c16cc9fdd982c` and exact SDK `fd52477d7c7d5d475dc14987ebbd7a36dbb703da`. Keep the original eight fixture files unchanged. The new disposable fixture owns only `playwright/proofs/storage-wallet-worker-matrix/`.

The 20-case matrix covers ST/MT and module/classic actual normal wallet construction, public reader use, late commit abort and intentional-abort control, plus strict/default timing for each WASM mode. All cases run once with retries zero. The two builds retain one physical SDK, the original 42 assets, genuine WASM, native IndexedDB and the supported raw MockChain export/import bootstrap. Every non-asset request is blocked. Only generated ephemeral fixture data exists in browser memory.

Source facts:

- Wallet `MidenClientInterface.createWithStoragePermission` at 714 honors explicit normal `useWorker:true`; mock construction remains excluded from worker claims.
- SDK `index.js` 392-415 has the module/classic selector. Its real wrapper is exported as `WasmWebClient` at 49-51, explicitly for integration tests; changing its existing static `workerMode` selects the real native worker, without replacing a class.
- SDK `index.js` 1107-1127 initializes native main WASM and awaits actual worker readiness before returning. The worker path initializes its own WASM and, for supported MT, its own pool.
- The existing public reader path and `settings.set` use the actual main-WASM fallback. They must not be called worker-forwarded transaction coverage. No live RPC, execution, proof or submission is added to manufacture such coverage.
- SDK `storage-policy.js` 145-166 distinguishes instance `tx.abort()` from an unexpected native abort. A disposable native request-success listener can call the captured native abort for a real late commit failure, while the normal instance abort supplies its paired healthy control. SDK callback results and wallet health remain unmodified.
- `settings.set` routes through `inner.setSetting` and native `db.settings.put`; fixed 1024-byte values, two warmups and 16 measured writes give comparable bounded strict/default samples. Each case has an isolated context/store, no prior connection durability conflict. This is an SDK-option measurement, not a production SLA or proof of physical persistence.

First deliverable is a frozen fixture and CI runner. No runtime result is claimed before root dispatches and inspects saved CI output. Keep safe phase/boolean/count/timing receipts, exact source/package/asset bindings and unchanged-input checks. Never attach raw dumps, account/note bodies, fixture entropy, error messages, screenshots or traces.

Run browser cases with one worker to avoid concurrent measurement noise. No native platform is spoofed; actual hardwareConcurrency is recorded. Main-WASM storage failures are distinguished from worker-forwarded financial operations.
