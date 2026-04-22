# Private notes silently dropped by the transport layer

**TL;DR.** Under concurrent upload load, the note-transport server's `fetch_notes` pagination can advance a client's cursor past notes that were inserted during the multi-tag scan, making those notes permanently invisible to the recipient. The sender's wallet still marks the transaction `Completed` (the tx commit on-chain succeeded; the transport `send_note` RPC returned 200), the sender's vault is decremented, but the receiver has no way to learn about the note.

Empirically this fires at 15–30 % of private sends in a worst-case-throughput stress run on testnet. No public notes were lost in the captured runs.

**Status of the analysis.** The root-cause reasoning is inferential — we identified a code path in the transport server + client that can produce exactly the observed failure pattern, and the other plausible paths are inconsistent with the forensic data. We have not directly inspected the transport server's DB to prove the lost envelopes are present server-side (which would confirm the race is the *sole* cause). See "Open questions" at the end.

---

## RESOLUTION (2026-04-22)

**Two independent bugs in the transport server were the cause.** Both fixed on `~/miden/miden-note-transport` branch `wiktor-monotonic-seq-cursor`.

### Bug 1: `:memory:` pool-per-connection isolation (primary, silently dropped writes)

SQLite `:memory:` databases are isolated per-connection — two connections pointing at `:memory:` see two *different* databases. The deadpool pool used `max_size=16`, so writes and reads landed on 16 isolated in-memory DBs, and a single `fetch_notes` saw only the fraction of notes that happened to land on its connection.

Forensic confirmation: against a live transport with 46 `store_note` calls, `stats` reported 25 total notes. The other 21 were stored on sibling connections and completely invisible to everything querying via a different pooled connection.

Fix: `crates/node/src/database/sqlite/mod.rs` clamps pool size to 1 when the URL is `:memory:` or `file::memory:` (commit `d23af60`). File-backed URLs keep `max_size=16`.

Why previous runs appeared to show a fetch-pagination bug even after the seq-cursor fix: the "9 % remaining loss after seq fix" observation was the pool-isolation bug, not a pagination race. Any loss-rate number captured before `d23af60` landed is contaminated by both bugs.

### Bug 2: `fetch_notes` timestamp cursor + multi-tag per-tag loop race (secondary, correctness-critical for file-backed DBs)

The original cursor was `created_at` (microsecond timestamp). Two writes can share a microsecond on macOS under load, and a multi-tag fetch ran per-tag queries sequentially — a concurrent INSERT between tag A and tag B could get a timestamp that was below the `rcursor` returned for tag A.

Fix split over three commits:
- `a5680e2` — add an `AUTOINCREMENT` `seq` column, use it as the pagination cursor in `fetch_notes` (pull path). Closes the timestamp-collision half.
- `3623865` — apply the same `seq` cursor to `streaming.rs` (push path), add a compound `(tag, seq)` index, add an ordering regression test.
- `9df51b9` — single-snapshot `tag IN (…)` query in `fetch_notes_by_tags`, replaces the per-tag loop in the gRPC handler. Closes the per-tag interleave half.

### Empirical verification

40-op 100 % private stress runs on testnet with `STRESS_DELAY_MIN_MS=0 STRESS_DELAY_MAX_MS=0 STRESS_IDLE_EVERY=0 STRESS_CLAIM_AFTER_SEND_PROB=0`, transport running locally via `MIDEN_NOTE_TRANSPORT_URL` override:

| run | fix set | delta | conservationHeld |
|---|---|---|---|
| perf-run9  | seq cursor only (pool-isolation bug still present) | −116 TST | false |
| perf-run10 | + pool-size=1 | 0 TST | **true** |
| perf-run12 | + pool-size=1 (reproducibility) | 0 TST | **true** |
| perf-run13 | + pool-size=1 (third confirmation) | pending | pending |
| perf-run14 | + pool-size=1 + multi-tag single-query | pending | pending |

Unit tests: 7/7 pass on branch tip, including a new `test_concurrent_store_fetch_sees_all_rows` that spawns 40 concurrent writers (>old `max_size=16`) and asserts all rows are visible.

### Harness robustness

Added transient-RPC retry loop (5 attempts, exp backoff, covers HTTP 5xx / `grpc request failed` / `grpc-status header missing` / `connection reset` / `timed out` / `Temporary failure`) to `miden-cli.ts::createFaucet` and `::sync`, matching the pattern already in `::mint`. Testnet flakes during harness setup no longer fail the whole run (observed in perf-run11 which failed setup unrelated to the fix). See miden-wallet commit `a3f408211`.

---

## Empirical evidence

Two instrumented 100-op runs on testnet with the worst-case-throughput configuration (`STRESS_DELAY_MIN_MS=0 STRESS_DELAY_MAX_MS=0 STRESS_IDLE_EVERY=0 STRESS_CLAIM_AFTER_SEND_PROB=0`):

| run | delta | lost private notes |
|---|---|---|
| perf-run3 | −59 TST | 12 |
| perf-run4 | −72 TST | 12 (8 A→B + 4 B→A) |

An earlier 100-op run on the same config (pre-IDB-dump instrumentation) showed the same −59 delta as perf-run3. Across the captured runs: **100 % of lost value = private notes that never arrived at the receiver. No public notes lost.**

> **Caveat on sample size.** n=2 fully-forensic runs. The 15–30 % loss rate is a point estimate, not a confidence interval. The "only private notes" claim is empirically consistent across captured runs but isn't formally proven; a future run could in principle surface a public-note loss via a different path.

Breakdown from perf-run4 (cross-referencing `MidenClientDB_mtst.outputNotes` on the sender against `MidenClientDB_mtst.inputNotes` on the receiver):

| | A→B | B→A |
|---|---|---|
| total sends | 58 | 55 |
| private sends | 25 | 26 |
| public sends | 33 | 29 |
| public lost | 0 | 0 |
| **private lost** | **8 (40 TST)** | **4 (32 TST)** |

Sender-side state for the lost notes:
- `outputNote.stateDiscriminant = 3` (vs `4` for every delivered note)
- `TridentMain.transactions.status = 2` (`Completed`) — same as the delivered ones
- The wallet has no way to tell, from its own local state, that the note never reached the receiver

Receiver-side state: no `inputNote` record at all.

Network telemetry for the same run:
- 1,540 transport RPCs total across both wallets (mix of `send_note` uploads and `fetch_notes` polls), all returned HTTP 200 at the client-observed layer
- 220 prover RPCs, all HTTP 200
- 0 `executeTransaction` errors in the captured timeline on either wallet
- Wallet A's `miden-connectivity-issues` flag was set once, but the flag path (`withProverFallback` → local-prover fallback) does not account for the loss pattern — A's 8 missed sends can't all coincide with prover fallbacks, and the flag is a separate symptom.

**Asymmetry between wallets.** A lost 8/25 private sends (32 %); B lost 4/26 (15 %). Two plausible explanations:
- Small-sample variance. With n_lost_A=8 and n_lost_B=4 the gap isn't statistically meaningful on its own.
- A's local-prover fallback path fired at least once (connectivity flag). The fallback retry takes a different timing profile through `withProverFallback`, potentially widening the upload-vs-fetch race window for A's subsequent sends. Would need more runs to separate these.

## Root cause: transport `fetch_notes` pagination race

Three interacting behaviours in the transport server + client combine into a silent drop.

### (1) Per-tag queries run sequentially against a moving DB state

`~/miden/miden-note-transport/crates/node/src/node/grpc/mod.rs:161-200`

```rust
let mut rcursor = cursor;
let mut proto_notes = vec![];
for tag in tags {
    let stored_notes = self.database.fetch_notes(tag.into(), cursor).await?;
    for stored_note in &stored_notes {
        rcursor = rcursor.max(ts_cursor);
    }
    proto_notes.extend(stored_notes.into_iter().map(TransportNote::from));
}
Ok(tonic::Response::new(FetchNotesResponse { notes: proto_notes, cursor: rcursor }))
```

Each per-tag query hits the database independently. Between one tag's query and the next, another client can commit a `send_note` that lands with `created_at` *less than* the eventual `rcursor`.

### (2) `fetch_notes` filter is strictly-greater-than

`~/miden/miden-note-transport/crates/node/src/database/sqlite/mod.rs:99-134`

```rust
notes
    .filter(tag.eq(tag_value))
    .filter(created_at.gt(cursor_i64))
    .order(created_at.asc())
```

`created_at` is microsecond-precision `i64`. A returned `rcursor` equal to the max `created_at` of the response means the next fetch will never see any note with `created_at <= rcursor`.

### (3) No recovery path: client stores ONE global cursor across all tags

`~/miden/miden-client/crates/rust-client/src/note_transport/mod.rs:86-163`, `~/miden/miden-client/crates/rust-client/src/store/mod.rs:447-476`

```rust
pub async fn fetch_private_notes(&mut self) -> Result<(), ClientError> {
    let note_tags = self.store.get_unique_note_tags().await?;
    let cursor = self.store.get_note_transport_cursor().await?;  // SINGLE global cursor
    self.fetch_transport_notes(cursor, note_tags).await?;
    Ok(())
}
```

This doesn't cause the drop, but it prevents self-healing after one occurs. The cursor is a single opaque `u64` shared across every tracked tag, so once a note's `created_at` is below the global cursor, no per-tag re-scan from an older cursor is possible.

### Timeline of a drop

1. Wallet B has `cursor = 100`, tracks tags `[T1, T2]`.
2. B calls `fetch_notes(tags=[T1, T2], cursor=100)`.
3. Server runs query for T1 at wall time `t0`, returns `[150, 300]`.
4. Between `t0` and `t1`, wallet A uploads a new note for T1. Server inserts with `created_at = Utc::now() = 220`.
5. Server runs query for T2 at wall time `t1`, returns `[200, 250]`.
6. Server computes `rcursor = max(150, 300, 200, 250) = 300`.
7. Response: 4 notes, `cursor = 300`. The note at `ts=220` for T1 — inserted after its tag's query had already returned — is in neither the response nor reachable from a future `cursor >= 300` query.
8. B's next call uses `cursor = 300`. Server filters `created_at > 300`. T1's `ts=220` is skipped forever.

The loss rate scales with:
- Concurrency of sends (more concurrent uploads ⇒ more chances of an insert falling in the per-tag-query window)
- Number of tags being tracked (more per-tag queries ⇒ larger total window)

**How far the test config is from real user behaviour.** The stress config deliberately maximises both factors: both wallets upload with zero inter-op delay, both wallets poll on the default 3 s `triggerSync` cadence, and the 50 %-of-the-time claim-after-send step that would create natural spacing is disabled (`STRESS_CLAIM_AFTER_SEND_PROB=0`). This is a worst-case-throughput probe — real users send at a fraction of this rate and rarely run two wallets in lock-step. **The 15–30 % loss rate is not the rate a typical user should expect**, but because the underlying race is a deterministic data-ordering bug rather than a rate-limiter overload, any two users sending at roughly the same wall-clock instant can hit it. The test just makes it reproducible.

## Recommended fixes, ranked

| fix | repo / files | effort | quality |
|---|---|---|---|
| **Cursor based on a monotonic row ID (autoincrement) assigned at INSERT-commit time**, not on `created_at`. | `~/miden/miden-note-transport/crates/node/src/database/sqlite/{schema.rs, mod.rs, migrations/}`, `~/miden/miden-note-transport/crates/node/src/node/grpc/mod.rs` | medium (schema + migration + filter change) | Eliminates the race. INSERT order = read order regardless of clock. |
| Rewrite per-tag loop as a single `tag IN (…)` query read in one consistent DB snapshot. | `~/miden/miden-note-transport/crates/node/src/node/grpc/mod.rs:161-200` + `crates/node/src/database/sqlite/mod.rs` | low | Closes the multi-query race window. Still vulnerable if `created_at` ordering breaks (e.g. clock skew on server restart). |
| `created_at.gt` → `created_at.ge` on the server + de-dupe on the client by note ID. | `~/miden/miden-note-transport/crates/node/src/database/sqlite/mod.rs:116` | low | Prevents skipping identical-timestamp collisions; by itself does NOT fix inserts landing within a multi-tag query window. |
| Per-tag cursors in the client. | `~/miden/miden-client/crates/rust-client/src/note_transport/mod.rs:114-163`, `~/miden/miden-client/crates/rust-client/src/store/mod.rs:447-476` | medium | Complementary defence-in-depth: lets a stale tag recover independently, also helps when a new tag is added with pre-existing server-side notes. Does not obviate the server fix. |

**Option 1 is the durable fix.** It subsumes options 2 and 3 (both are addressing symptoms of the same underlying non-monotonic cursor). Option 4 is *complementary*: it helps recovery in scenarios unrelated to this race (e.g. a newly-tracked tag whose history pre-dates the current cursor), and is worth doing regardless.

### Minimum viable change for option 1

- Add an `id INTEGER PRIMARY KEY AUTOINCREMENT` column (if the current `id` column is `Binary` — verify against `schema.rs`). SQLite's implicit `rowid` is risky because `VACUUM` can re-number rows; an explicit `AUTOINCREMENT` is safer.
- Swap `filter(created_at.gt(cursor_i64))` → `filter(id.gt(cursor_i64))`, `order(created_at.asc())` → `order(id.asc())`.
- Server's `rcursor` becomes `max(returned notes' id)`.
- Add a migration that backfills the new column for existing rows in ascending `created_at` order.

### Forward-compat: migration is not free

The wire-level `cursor` is a `u64`, and the server redefining what that `u64` *means* (timestamp micros → row ID) breaks old clients. A microsecond timestamp is ~1.7 × 10¹⁵ today; row IDs will be in the low millions at most. An old client sending `cursor = 1776813612000000` to a new server hits `id > 1776813612000000` → empty result → never advances cursor → **stuck forever**.

Two migration paths worth considering:

1. **Versioned wire protocol.** Add a `cursor_v2` field in the gRPC request and response. New clients set `cursor_v2`; server responds in kind. Old clients continue to receive the old cursor semantics for a transitional period (server keeps the `created_at` query path alive behind a flag).
2. **Magnitude-heuristic dispatch on the server.** If `cursor > 10^12` treat it as a legacy timestamp, else a row ID. Fragile — edge cases around cursor = 0 and server clock skew — but zero-client-change.

An initial "just reinterpret the u64 as a row ID" option was considered and rejected: old clients' stale timestamp cursors would be strictly greater than any row ID, so the server would return empty forever and the client would never advance.

Recommended: **option 1 (versioned wire)**. It's the cleanest and avoids any fragility around mixed-version deploys.

## Red herrings investigated

### Tag-table undercount (not the cause)

During investigation, the SDK's `tags` table on wallet A was missing records for **22 of 58** output notes. Private notes in particular had only 3 of 25 with tag records; 22 were un-indexed from the sender's own bookkeeping view.

Initial hypothesis was that this undercount caused the drops. After cross-tabulating `noteType × hasTag × received`, the data showed: private-note loss rates are **the same whether or not the sender has a tag record** (~32 % A untracked vs ~33 % A tracked; ~15 % B untracked vs ~17 % B tracked). The tag undercount is an *independent* anomaly worth filing separately — it suggests the SDK's `get_transaction_store_update` in `~/miden/miden-client/crates/rust-client/src/transaction/mod.rs:401-436` may not be registering tags for all output notes via its `updated_output_notes()` iterator — but it is not the driver of the lost-notes bug.

### `miden-connectivity-issues` flag (symptom, not cause)

The banner fires on the local-prover fallback path (`withProverFallback` in `miden-client-interface.ts:262`). Wallet A's flag was set in both runs, B's was not. A did lose more notes than B (32 % vs 15 %), but A's 8 missed sends can't all coincide with the specific moments the flag fired. Treat the flag as a correlated symptom (both are downstream of concurrent-op pressure), not a causal explanation.

## Related wallet-side issue (not the stress-test loss)

`~/miden/miden-wallet/src/lib/miden/activity/transactions.ts:57-114` (`completeCustomTransaction`)

This sibling of `completeSendTransaction` is used by the `'execute'` transaction type (not `'send'`, which the stress test exercises). It swallows `sendPrivateNote` errors via `console.error` and marks the transaction `Completed` regardless of whether the transport upload threw. `completeSendTransaction` at line 307 handles the same scenario correctly — it marks `Failed` on transport error. Aligning `completeCustomTransaction` is worth doing even though it's not the root cause of the dropped-notes bug.

## Verification plan

1. Apply option 1 in `~/miden/miden-note-transport` and deploy to the testnet instance (`transport.miden.io`).
2. Re-run the stress harness from `~/miden/miden-wallet` with the same throughput-mode config:
   ```
   STRESS_NUM_NOTES=100 \
   STRESS_DELAY_MIN_MS=0 STRESS_DELAY_MAX_MS=0 \
   STRESS_IDLE_EVERY=0 STRESS_CLAIM_AFTER_SEND_PROB=0 \
   E2E_NETWORK=testnet yarn test:e2e:stress:run-only
   ```
3. Expected: `stress-summary.json` → `conservationHeld: true, balanceDelta: 0`.
4. If conservation still fails, `test-results/run-*/indexeddb-final.json` + the per-op divergence trajectory will pinpoint where the remaining loss starts, and the same cross-reference (`A.outputNotes` vs `B.inputNotes`) will show whether the lost items are still private-only.
5. For faster iteration: run against a local note-transport node (`E2E_NETWORK=localhost`) so you can toggle the fix without redeploying testnet.

## Open questions / not yet verified

1. **Is the race definitely the sole cause?** We haven't inspected the transport server's `notes` table directly to confirm that all lost envelopes are actually stored server-side. If they are, the fetch-side race is proven as the sole mechanism. If not, there's an additional silent failure in the `send_note` write path (e.g. a transaction rollback under contention that returns 200 anyway). A post-fix rerun that still shows any loss would point to this.
2. **Why A > B?** The A=32 % vs B=15 % private-loss split could be small-sample noise (n=8 vs n=4) or a real asymmetry driven by A's local-prover fallback. Resolving this requires more runs — or simpler, an A/B run where the connectivity flag is forcibly prevented.
3. **Is there a public-note analogue?** Public notes delivered via chain sync use a different fetch path (sync height + nullifier/tag scan over committed blocks) that is not subject to this race. 0 public losses across both runs matches that; but a formal argument would require a fuller review of the sync-state path.
4. **Adversarial amplification?** A malicious sender or a misbehaving transport shard could in principle *deliberately* trigger the race (e.g. upload a note at `created_at` just below a known victim's cursor). No active exploitation path identified, but the fix should close the class regardless.

## Artifacts

Run artifacts preserved in:
- `test-results.perfrun3-*/run-2026-04-21T21-38-18-483Z/`
- `test-results/run-2026-04-21T23-04-21-780Z/` (perf-run4)

Each has:
- `stress-summary.json` — conservation status + driver stats
- `stress-operations.csv` — per-op primary + secondary status/amount
- `indexeddb-final.json` — per-wallet full IDB dump (SDK's transactions, outputNotes, inputNotes, tags)
- `chrome-storage-final.json` — per-wallet storage (includes `miden-connectivity-issues` flag)
- `timeline.ndjson` — full firehose (stress_op, balance_check, network_request with source: service_worker, browser_console)
- `tx-queue-timeseries.csv` — pending-tx queue state over time
