# Telemetry — known limitations

What the telemetry pipeline does **not** guarantee. Two kinds of thing are in
here and they want different readers:

- **Redaction limits** — where the crash-report scrubber could be defeated.
  Read before assuming a crash report cannot contain a secret.
- **Measurement bias** — where the data systematically misrepresents reality.
  Read before drawing a conclusion from a dashboard.

Dev-only doc: excluded from the published site in `docs/_config.yml`.

None of these is a known leak or a known wrong number. They are the honest edges
of a system that works, written down so nobody has to rediscover them.

## Why some of this is public and some is not

The public policy (`docs/privacy/index.md`) carries the two redaction limits, at
the level of consequence rather than mechanism: it says the scrubber is a filter
and not a guarantee, and names the two shapes that could get past it. A user
deciding whether to turn the setting on is making a risk judgement, and
"scrubbing is best-effort" is load-bearing for that judgement. Withholding it
while advertising the scrubbing would be the overclaim.

What stays here is the mechanism — thresholds, regexes, the specific split that
evades — because it changes nothing for a user and reads as an evasion guide.

The measurement bias is **not** in the public policy, deliberately. It discloses
nothing about what is collected about a user; it is a caveat about what *we* may
conclude. Putting it in a privacy policy would pad a document people already
struggle to read with something that cannot inform their decision. It belongs
here, where the people reading the dashboards are.

## Redaction limits

Both live in `src/lib/telemetry/redact.ts`. Product events are unaffected —
`TelemetryWirePayload` has no free-text field, so there is nothing to scrub.
These apply only to crash reports.

### A recovery phrase split across many fields

`containsSeedMaterialDeep` scans **each string separately** and drops the whole
report on a run of `BIP39_RUN_THRESHOLD` (4) consecutive wordlist words. A real
phrase is 12 or 24 words, clearing the bar by 3x, and a 6+6 split across two
fields is still caught twice over. What is not caught is 12 words spread two at a
time across six separate fields: no single string reaches four.

**Why the threshold is 4 and not 1.** Measured against the 937 real strings in
`public/_locales/en/en.json`: 98.2% peak at a run of three or fewer, and the
1.8% reaching four are seed-phrase help copy that *should* drop. A threshold of 1
was rejected outright — 63% of the wallet's own UI strings contain at least one
wordlist word, because "about", "account", "amount", "note", "key" and "input"
are all BIP-39 entries. At 1 the scrubber would drop nearly every report and
protect nothing.

**Why strings are not concatenated before scanning.** The obvious fix — join
every string in the report and scan the result — manufactures runs across
boundaries that were never adjacent, so unrelated legitimate reports start
getting dropped. It trades a contrived evasion for a real loss of diagnostics.
Rejected on those grounds.

A second rule covers the realistic single-word case: a mnemonic-context word
(`seed`, `phrase`, `recovery`, …) plus any wordlist hit drops the message, with
the context words excluded from counting as the hit themselves, so "seed phrase
input is empty" survives.

### A context-free credential

`redactText` recognises secrets by shape or by the name they are stored under.
A bare `hunter2correcthorsebatterystaple` as the entire text of an error message
— no key naming it, no `password=` in front, no URL around it — matches nothing,
raw or base64'd, because by pattern alone it is indistinguishable from a request
id. Truncating anything that *looks* like a token would eat request ids, event
ids and hashes, which is most of what makes a crash report diagnosable.

What does cover it: `SENSITIVE_KEY_PARTS` (the value goes whatever it looks
like, which is the `password: hunter2` case) and `ASSIGNMENT_PATTERN`. Named, or
embedded in a URL, every value in the test corpus is destroyed in every
encoding.

Nothing in `src` currently throws an error whose message is a bare credential,
and `egress-boundary.test.ts` drives the real wire on error paths to keep that
true. This is the residual risk if some future code did.

### What is solid

Worth stating alongside the gaps, so the gaps are read in proportion:

- Detection runs against **every decoded view** of a string — base64, base64url,
  percent-encoding, fully percent-encoded text, and JSON `\n` / `\uXXXX`
  escapes. Encoding a phrase does not smuggle it out.
- Value patterns are **deliberately unanchored**. `\b` is trivially evaded:
  `Error` + an address concatenates into `Errormtst1aq…` with no boundary
  between `r` and `m`. Matching mid-token over-redacts slightly and cannot be
  sidestepped by gluing a secret onto a word.
- Scrubbing happens **twice** — as Sentry's `beforeSend`, and independently in
  `captureCrash`, which rebuilds the error from redacted parts. A hook is a wire
  that can come loose.
- The stack **header line is discarded outright** rather than scrubbed, because
  it repeats `error.message` verbatim and would leak whatever the patterns
  cannot see.
- Integrations are an **allowlist** (`CRASH_INTEGRATION_ALLOWLIST`), not a
  denylist. `Breadcrumbs` (console output, every fetch URL, DOM clicks),
  `HttpContext` (URL, referrer, user agent), `CultureContext` and
  `BrowserSession` never run. A denylist would have silently admitted
  `ConversationId` — a persistent identifier — when Sentry v10 added it.

## Measurement bias

### An error followed by a successful retry is recorded as an error only

A failed attempt settles its flow as `errored` and clears the handle. If the
user immediately retries and succeeds, that success opens **no new flow** and
emits no `completed`. The retry is invisible.

**So the data overstates how often people get stuck** and understates eventual
success. A flow with a 20% `errored` rate does not mean 20% of users failed to
get through — some unknown share of them succeeded on the next try and the data
cannot see it. Read `errored` as "hit an error at least once", never as "did not
succeed".

Reopening a flow on retry was rejected: detecting a retry is fiddly and would
complicate the settle logic that the idempotency guard in
`src/lib/telemetry/report-flow.ts` depends on, and a mis-settled flow corrupts
the abandonment signal — which is the thing the two-event design exists to
produce. `unlock` is exempt from all of this, because it is scoped per attempt
rather than per session.

### A transaction the node took but the client could not apply reports as a success

`ApplyTransactionAfterSubmitFailed` means the node accepted the transaction and
the local WASM client then failed to record it. The pipeline marks the row
`Completed` on purpose — the funds moved, the next sync reconciles the note
states, and retrying would hit the node's nullifier check and produce a
misleading "already consumed" error. There are four such branches:
`src/lib/miden/transaction/index.ts:1556` for non-guardian rows, the value-moving
and canonicalization-race branches of the guardian catch, and
`reconcileStructuralApplyFailure`, which completes a replace-hot-key or
switch-guardian after the same failure.

Because the row is `Completed`, the settled event says `result: completed`, which
in "did the user's money move" terms is true and in "did the client work" terms
is false. **So the failure rate here is a floor, not a total.** A client-side
apply defect can grow without bound and will not appear in it, which is the exact
shape of thing that goes unnoticed for a release or two.

Fixing it properly means a distinct `step` on that success, so the outcome can be
counted separately without being called a failure. That was left out of the first
pass deliberately: it needs a telemetry-only hint threaded through
`updateTransactionStatus`, which is a core write path, and a value that must not
reach the stored row. Worth doing, worth doing on its own.

### Other boundaries worth knowing before reading a number

Each of these is a deliberate choice, and each makes a naive reading wrong:

- **Abandonment is inferred, not reported.** A `started` with no matching
  `ended` is the abandonment signal, computed on the receiving side. A dropped
  network request or a browser killed mid-send therefore looks identical to a
  user walking away.
- **`open` fires only where `PageRouter` renders.** dApp confirmation windows
  render `ConfirmPage` and produce no `open` at all, so `open` counts are app
  launches, not window opens.
- **`return` is mobile-only.** `useForegroundRefresh` is the only foreground
  signal and hard-returns off mobile. On the extension a popup reopen *is* a
  fresh mount, so it is already an `open`. Compare `return` across platforms
  only by way of `platform`, which is on every event.
- **`activity_view` completes on the history list's first settled load.**
  Reading a list emits nothing later; inventing a completion event (a row tap,
  say) would report every ordinary visit as abandoned.
- **`receive_share` completes once the address renders**, and deliberately does
  not wait for a copy or a share — holding a QR code up to be scanned is an
  ordinary successful receive that fires neither.
- **`note_handle` is per claim attempt**, not per visit. Browsing pending notes
  is not handling one.
- **`durationMs` has no bounds check.** `Math.round` passes a negative, `NaN`,
  or `Infinity` straight through. Durations come from `performance.now()`, which
  is monotonic, so this is not expected to bite — but nothing stops it.
- **A run's span can exceed the 30-minute idle bound, by one flow.** The bound
  governs which flows *join* a run: after 30 minutes of silence the next flow to
  start gets a new id. A flow already open when that silence elapses still ends
  under the id it started with, because the alternative is a `started` and an
  `ended` that no longer pair, and pairing has to win. So a send opened at 09:00
  and dismissed at 09:41 puts all of its events under one id across a 35-minute
  gap. It cannot chain — no new flow joins that run — but the span of a single
  run is bounded by the lifetime of one straddling flow, not by the clock.
- **Cross-run analysis is impossible by construction**, not by omission. The
  only identifiers are the per-flow id and the per-run id, both minted in memory
  and both gone when the app closes, so nothing joins one launch to the next.
  Retention, MAU and repeat-user funnels cannot be computed from this data and
  are not a future extension of it. Within a single run the flows are joinable —
  that is what `runId` is for — and that is the whole of the linkability.

## Withdrawing consent is not instantaneous

Turning the setting off drops the queue and tears down the crash client
immediately, and no flow that *starts* afterwards is ever reported. What is not
ordered is a flow that was **already open** at the moment consent was withdrawn:
the event is built in the page when the flow ends, and gated in the background,
which reads consent from a mirrored storage write. Nothing sequences that write
against an unrelated unmount elsewhere in the app, so a flow ending inside the
propagation window can still send its `flow_ended`.

Found by `playwright/telemetry/telemetry-egress.spec.ts`, which observed a
`send` flow arriving with `result: cancelled` seconds after the toggle went off.
The window is small and what escapes is one flow-shaped event — a name, a
`cancelled` result, a duration — carrying nothing about the user or the money.
It is recorded rather than fixed because closing it properly means routing
withdrawal through the same channel the events take, so that ordering is
guaranteed instead of likely; the settings handler awaits its own write, which
covers everything that handler goes on to do and no more.

## What a local sink can and cannot prove

`playwright/telemetry/telemetry-egress.spec.ts` runs the shipped extension
against a local HTTP server standing in for Aptabase. It is the only test that
sees a real request leave a real service worker, and it covers the half of the
boundary that is ours: silence before consent, the envelope's exact contents,
and — against a real wallet holding a real seed, password and address — that
none of those bytes reach the wire in any encoding.

Two things it deliberately does not prove:

- **That Aptabase accepts the envelope.** Self-hosting Aptabase needs Postgres
  *and* ClickHouse plus an authenticated session to mint an app key, off an
  image tagged `:main`. `assertAptabaseContract` encodes the vendor's documented
  contract instead, so if they change it this suite stays green while production
  events start being rejected.
- **That `host_permissions` covers the production endpoints.** The manifest
  lists `http://localhost/*`, which is why the sink is reachable, but neither
  `eu.aptabase.com` nor Sentry's ingest host. Production egress therefore rests
  on both vendors serving permissive CORS to an extension origin. That works
  today and is load-bearing; a vendor tightening CORS would break telemetry in
  a way no test here would catch.

## How to read this data in Aptabase

**A session is one run of the app.** Aptabase groups events by `sessionId`, and
`sessionId` carries our `runId` — minted in memory when the app starts, thrown
away when it stops, rotated after 30 minutes of inactivity, and written nowhere.
So a session is a visit: it has a real duration, it holds the flows the person
performed in order, and reading one tells you what somebody did. Two edges keep
"a session is one run" from being exact — a flow left open across the idle
window carries its own pair past the rotation, and a backwards clock step
rotates deliberately — so a long-tail session may hold one trailing event, and
one run may occasionally appear as two. Both are noted under the boundaries
above.

`props.flowId` is what pairs a `started` with its `ended` inside that session.
Group by it when you want flows; group by `sessionId` when you want visits.

This was not the original design, and the history is worth knowing because the
first version looked more private and was useless. `sessionId` used to carry
`flowId`, so every Aptabase session held exactly one flow and lasted 0s. The
first build on a real device reported, for a session in which the user performed
one swap, two 0s "sessions" containing a `send_started` and a `receive_share`
pair — none of which the user did, and no mention of the swap. Even with the
event bugs fixed, that grouping could never have described a visit.

What the change costs, stated plainly: within one run, the flows a person
performed are linkable to each other. What it does not cost is anything durable
— no id survives a reload, none identifies a device, a person or an install, and
nothing links two runs. `guarantees.test.ts` asserts the telemetry module cannot
reach a persistence API at all, so there is nowhere for a longer-lived id to
hide even by accident.

**"Users" in the dashboard still is not people.** Aptabase infers a user count
from session activity, and our sessions are app runs — so one person who opens
the wallet three times is three. Treat it as a count of visits.

**A flow with no `_ended` event is the abandonment signal.** Nothing reports "the
user gave up"; a `started` with no matching `ended` is what that looks like, and
it is also what a crash, a force-quit, or the extension popup being dismissed
mid-flow looks like. Those are not distinguishable, by construction — see
Measurement bias.

**`step` is the funnel.** The distribution of `props.step` across `_ended` events
with `result: cancelled` is where people give up, which is the question this
telemetry exists to answer. A `send_ended` with `result: cancelled, step:
select_amount` is someone who could not get through the amount field; the same
event with `step: review` is someone who got all the way to the last screen and
chose not to sign. Those need completely different fixes, and before `step`
existed both arrived as an identical bare `send_started`.

### A pane the user swiped past reports nothing

The home carousel commits a route on every swipe release, so reaching Swap from
Overview is four navigations and crosses Send, Receive and Earn on the way. Each
crossing used to open and close a flow: a swipe from Send to Earn emitted a
matched `receive_share` pair, and tapping through the tab bar out of curiosity
emitted a cancelled `send` at `select_recipient` and a cancelled `swap` at
`swap_amounts`.

Those pairs were honest — matched, balanced, with real durations — and they
described nothing anybody did. Left in, they dominate the first bucket of exactly
the funnel `step` exists to produce.

So the three carousel screens gate on *dwell* rather than on the route being
current: `useRouteDwell` requires the route to hold still for 600ms before the
flow begins. A crossing is under that; the shortest deliberate visit is well over
it. Nothing is emitted for a pane the finger merely passed over.

An earlier version of this document told the reader to filter short flows by
`durationMs` instead. That was the wrong place for it. It makes correct numbers
depend on remembering a caveat, and leaves the raw event stream wrong for anyone
who reads it directly — which is how "we have telemetry" becomes "the telemetry
says people abandon Send constantly". It was also insufficient for
`receive_share` in particular, which completes as soon as the address is on
screen: a transit and a real visit both arrive `completed` within milliseconds,
so `result` could not separate them and duration was the only discriminator left.

The cost of the gate is that a genuine visit shorter than 600ms reports nothing.
That is the right direction to err: a missed visit costs one event, a spurious
one costs the credibility of the whole funnel.

### Approvals on the extension

`dapp_connect` and `dapp_tx` are reported from two disjoint places, because the
platforms do not share a path: mobile and desktop go through the confirmation
store, while the extension uses an intercom and a popup window that never
touches it and reports from `ConfirmPage` instead. A change to one is not a
change to the other.

Two consequences specific to the extension's popup:

- **An auto-approved reconnect reports nothing at all.** A `connect` from an
  already-permitted dApp is granted during render without asking, so there is no
  approval to measure and no flow is begun. Approval counts therefore exclude
  reconnects by design.
- **Auto-lock mid-prompt splits one approval into two flows.** The confirm page
  swaps in the unlock screen when the wallet locks, which unmounts the prompt
  (cancelling its flow) and remounts it on unlock (beginning another). One
  prompt, two flows, the first spuriously cancelled.

### Two known biases in the `submitting` bucket

- **A flow reaching `submitting` says the transaction was accepted, not that it
  landed.** The flow settles when the row is enqueued, which is before anything
  is proved or submitted. So `send_ended` with `result: completed` means the user
  finished asking; whether the money moved is a separate event,
  `tx_send_settled`, and the two are not joined. See "operations" below.
- **Backing out of review and returning counts as two flows.** The review screen
  settles on exit and the amount screen begins a fresh flow on the way back, so
  one journey that hesitated arrives as a cancelled flow at `step: review`
  followed by a second flow. True for send and for earn.

### Operations: what the wallet did, as opposed to what the user did

A flow ends when the user is done asking. What happens next — proving,
submission, the node accepting or refusing it — happens with no screen open, and
before this existed it was reported nowhere at all. A remote prover outage that
failed every transaction for everyone would have produced no product event
(there was no flow open to fail) and no crash report (the pipeline catches its
own errors and renders failure UX rather than letting one reach a global
handler).

These arrive as a single `<operation>_settled` event, with `result` and usually a
`durationMs`, plus a `step` naming where a failure happened.

| Event | What it means |
|---|---|
| `tx_send_settled`, `tx_swap_settled`, `tx_receive_settled`, `tx_earn_settled`, `tx_bridge_settled`, `tx_guardian_settled`, `tx_dapp_settled` | One transaction reached a terminal state. On `result: errored`, read `step` as below. |
| `tx_earn_settled`, `tx_bridge_settled` (again) | These two each cover two lifecycles. An earn deposit and a bridged send are ordinary rows that settle through `updateTransactionStatus`; an earn *withdrawal* and an inbound *bridge* are `Completed` in the database from birth and carry their real outcome in `extraInputs.phase`, so they report from their own phase writers instead. Both halves land under the same event name and are not distinguishable from the props. |
| `tx_other_settled` | A row whose type this build has never heard of, written by a newer version. Should be zero; a non-zero count means a downgrade happened. |
| `prove_settled` | One prove attempt. `step: prove_delegate` or `prove_local` for a normal one; `step: prove_fallback` means the delegated prover failed and the local one finished the job — the transaction succeeded and the user waited twice. |
| `service_prover_settled`, `service_node_settled`, `service_network_settled` | A dependency went down (`result: errored`) or came back (`result: completed`, with `durationMs` as the outage length). |

**Reading `step` on a failed transaction, which is not as direct as it looks.**
Only a guardian transaction whose leaf ran inline stamps an explicit `proving`.
Everything else — every ordinary send, and every guardian transaction on the
default build, where the leaf runs in the offscreen document and reports no
stages back — is stamped `sending` once when the pipeline picks it up, and runs
execute, prove *and* submit under it.

| `step` | What failed |
|---|---|
| `syncing` | Before anything was built. Usually the node. |
| `signing` | Talking to the guardian while building the transaction. |
| `executing` | Local execution, before proving. Usually a wallet bug or a bad request. |
| `proving` | The prover, unambiguously — but only guardian-inline transactions can say this. |
| `sending` | **Somewhere in execute → prove → submit, indistinguishable from the stage alone.** The commonest step on a failure by a wide margin. Cross it with `errorKind`: `proving` or `timeout` points at the prover, `rpc` or `network` at the node or the connection. |
| `submitting` | The hand-off to the network itself, and nothing after it. |
| `confirming` | Anything after the transaction is on chain: waiting for inclusion, the private-note transport relay, and the guardian's post-commit re-registration and sync. A failure here did not cost the user the transaction. |

Do not read `sending` as a submission failure. Folding it into `submitting` was
the first thing this reporting did and it was wrong: it filed every prover outage
on the wallet's commonest transaction type as a node problem, which is precisely
the conclusion the whole feature exists to make impossible.

Some things to know before reading them:

- **They carry no `flowId`,** so an operation cannot be joined to the flow that
  started it. Doing so would mean writing a telemetry identifier onto the
  transaction row, and that row is durable storage — it would turn an in-memory
  id into a persisted one. They share a `sessionId` only when the same realm
  reported both.
- **A background settlement often has a session of its own.** On the extension
  the transaction pipeline runs in the service worker, which holds its own run
  id; a transaction settling after the popup closed belongs to no visit, and is
  not made to look like one.
- **`prove_settled` with `result: completed` is not always good news.** Filter on
  `step: prove_fallback` — those all succeeded, and every one of them is a user
  who waited for a prover that was not answering.
- **`prove_settled` counts real proves only, not speculative ones.** The wallet
  pre-proves a send it expects you to confirm, and that attempt is deliberately
  left out. Its failures are routine — the amount changed, you went back a
  screen, the document was reaped — so folding them in would inflate the prove
  failure rate with aborts and destroy the only number that says whether proving
  works. The cost is that a prover degrading shows up here one step later than it
  could, when a real prove hits it. If the fallback rate is ever needed as an
  early warning, the speculative path needs its own operation rather than a share
  of this one.
- **A missing `durationMs` is deliberate, not a dropped field.** Two outcomes
  have no honest interval and so report none: a row reconciled from `Failed` to
  `Completed` when the user finally taps Retry, where the only interval available
  is how long they were away, and a row that never recorded a start time. Filter
  them out of a latency percentile rather than treating an absent duration as
  zero — which is exactly why it is absent rather than zero.
- **A `service_*` outage's `durationMs` is a bound, not a measurement, and on the
  extension it is loose.** Three reasons, none of them fixable without giving the
  connectivity tracker durable cross-realm state. Each realm — worker, offscreen
  document, page — holds its own in-memory copy, so an outage marked in one is
  cleared by that one or not at all. The offscreen document is torn down
  routinely rather than rarely (a stale send-form speculation closes it), which
  loses an open outage's `completed` and lets a single sustained outage re-report
  `errored` once per document lifetime. And `service_prover`'s clear fires on any
  successful prove including a purely local one, so its duration is closer to
  "time until the next prove of any kind worked" than "time the delegated prover
  was down". Read a rising count of `errored` as the outage signal and treat the
  duration as an upper bound on a single stretch, not a total.
- **A bridge can produce two events with opposite verdicts, in that order.** A
  bridged send reports `completed` when the note commits, because as far as the
  send pipeline is concerned it is done; if the allocator then rejects the intent,
  the row is demoted and reports `errored` with `step: submitting`. Both are true
  of the moment they were sent. When counting bridge failures, the later event
  wins.

### What a completed swap looks like

Four flow events, in two flows, under **one session** with a real duration, if
the user opened the app to do it — plus the operations the wallet then performed,
which may arrive under a different session:

| Event | props |
|---|---|
| `open_started` | `flowId: A` |
| `open_ended` | `flowId: A`, `result: completed`, `durationMs` |
| `swap_started` | `flowId: B` |
| `swap_ended` | `flowId: B`, `result: completed`, `durationMs`, `step: submitting` |
| `prove_settled` | `result: completed`, `step: prove_delegate`, `durationMs` |
| `tx_swap_settled` | `result: completed`, `durationMs` |

The `open` pair is there because the app shell mounted; the swap pair is there
because the user went to `/swap` and submitted. Both share one `sessionId`,
which is what makes this readable as a visit rather than as four loose rows.
It is emphatically *not* a `send_*` pair. Swap had no instrumentation of its own
at first, and the events that showed up during a swap came from unrelated screens
the user happened to pass through — a genuinely misleading result, since an
unmatched `send_started` reads as an abandoned payment.

### Handled failures do not become crash reports, and the worker has none

Two separate decisions that look like one gap.

**Handled failures stay on the product channel deliberately.** Everything above
is a failure the wallet caught, classified and rendered. Sending those to Sentry
as well would buy a free-text message and a stack in exchange for turning a
routine, expected outcome — a prover being briefly unreachable — into crash
volume, and for widening the surface a scrubber has to hold from "unexpected
errors" to "every error". The closed-union `errorKind` plus `step` is what these
failures are worth; if one of them ever needs a stack to diagnose, it is not
being handled properly and that is the thing to fix.

**Unhandled errors in the service worker are reported nowhere.** This one is a
real gap, not a decision. `initCrashReporting` is called from React contexts
only, so its `error` and `unhandledrejection` listeners never exist in the
worker — where the transaction pipeline, sync and every background timer
actually run. An unhandled rejection there is invisible on both channels. Fixing
it is not a matter of calling the same function: the worker has no `window`, so
registration has to target `self`, and it has to re-run on every wake because
module state does not survive a teardown — and the worker's import graph is
guarded by a test precisely to keep it small, which a Sentry client is not. Until
that is done, read a healthy crash dashboard as "the UI is not throwing", which
is a much narrower claim than it appears.


## Instrumenting a new flow: mount is not intent

`TabLayout` renders Overview, Send, Receive, Earn and Swap as a single
five-page carousel and mounts **all of them at once**, keeping them mounted for
the whole session. So on any screen in that group:

- a flow begun in a mount effect begins on every app launch, for a screen the
  user has not looked at;
- it is never settled by leaving, because swiping to another page does not
  unmount anything;
- and a flow that completes on render — `receive_share` completes when the
  address appears — completes on every launch too.

That is not hypothetical. The first build to reach a real device reported, for a
session in which the user performed exactly one swap: a `send_started` with no
end, and a complete `receive_share` pair. Neither corresponded to anything the
user did. The swap itself, which had no instrumentation yet, reported nothing.
Every event was an artifact of the carousel.

So screens in the home group gate on `pathname` — the carousel's own source of
truth for which page is showing — rather than on mount, and then on that route
holding still for 600ms rather than merely being current, because every swipe
release navigates and a crossing is not a visit. See `SendManager`,
`SwapManager`, `Receive` and `useRouteDwell`. Two consequences worth knowing:

- **A step effect must depend on the route gate as well as the step.** The flow
  now begins after the screen mounted, so a step reported on mount lands in no
  flow and the event arrives stepless. This was caught by the egress E2E, not by
  a unit test.
- **`instrumentation-coverage.test.ts` cannot catch this class of bug.** It
  proves a flow is begun somewhere, not that the place it is begun means what
  the flow's name claims. Only a real build against the sink showed it.

## Coupling to be aware of

`src/lib/telemetry/guarantees.test.ts` reads the repository as text — the native
projects, `package.json`, `yarn.lock`, the HTML entry documents, and the import
graph of `src`. Moving `src/background-entry.ts` or renaming a telemetry module
breaks it. That is intentional: the failure message names which promise broke and
where, and a guard that silently stops reading is worse than one that fails
loudly. Point it at the new path; do not delete it.
