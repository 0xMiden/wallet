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
- **Cross-session analysis is impossible by construction**, not by omission.
  There is no identifier to join on, so retention, MAU, and repeat-user funnels
  cannot be computed from this data and are not a future extension of it.

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

Two things about the dashboard will mislead you if nobody says them out loud.

**Every "session" is one flow, and its duration is always 0s.** Aptabase groups
events by `sessionId`, and `sessionId` carries our `flowId` — a fresh random
value per flow, chosen precisely so that two things a user did cannot be joined
together. So a session is never a visit, a "session duration" is the gap between
the events of one flow (frequently 0ms, since `started` and `ended` can be
milliseconds apart), and the user count is a count of flows rather than people.
None of that is a bug and none of it is fixable without giving up the
unlinkability that is the point of the design. Read `props.durationMs` on the
`_ended` event for how long something actually took, and treat event counts as
counts of activities, not of users.

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

### Filter the funnel by duration before reading it

Route-gating the home-carousel screens (see below) means every visit to a home
pane opens and closes a flow — including a pane the user only passed through.
Swiping from Send to Earn transits `/receive`, and each swipe release navigates,
so that transit emits a matched `receive_share` pair. Tapping through the tab bar
out of curiosity emits a cancelled `send` at `select_recipient`, a cancelled
`receive_share`, and a cancelled `swap` at `swap_amounts`.

These are honest, balanced pairs, not leaks — but they are shallow, and left
unfiltered they dominate the first bucket of exactly the funnel `step` exists to
produce. They are also separable, because every `ended` event carries `durationMs`: a
transit is a few hundred milliseconds, a real visit is seconds. **So exclude
short flows before reading drop-off** — on duration, and not on `result`.

`result` is the wrong filter because `receive_share` completes as soon as the
address is on screen, which is immediately: the address is resolved before the
route is even reachable. So a swipe transit through `/receive` and a deliberate
visit both arrive `completed` with a duration near zero, and that flow's
`cancelled` branch is close to unreachable in practice. Duration is the only
thing that separates them.

This is deliberately left to the reader rather than enforced by a dwell timer in
the client. A timer would have to drop the `started` event too, which throws the
information away irrecoverably and bakes one guess at the threshold into shipped
builds; a duration filter is tunable afterwards, and keeps the shallow visits
available for anyone who wants to count them.

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

- **Leaving while a transaction is being proved reports it cancelled.** Proving
  takes seconds. If the user swipes away or backs out of review during it, the
  route gate settles the flow as cancelled at `step: submitting`, and the later
  success no-ops against an already-settled handle. The transaction still goes
  through. So completions are undercounted in this bucket specifically.
- **Backing out of review and returning counts as two flows.** The review screen
  settles on exit and the amount screen begins a fresh flow on the way back, so
  one journey that hesitated arrives as a cancelled flow at `step: review`
  followed by a second flow. True for send and for earn.

### What a completed swap looks like

Four events, in two flows, if the user opened the app to do it:

| Event | props |
|---|---|
| `open_started` | — |
| `open_ended` | `result: completed`, `durationMs` |
| `swap_started` | — |
| `swap_ended` | `result: completed`, `durationMs`, `step: submitting` |

The `open` pair is there because the app shell mounted; the swap pair is there
because the user went to `/swap` and submitted.

It is emphatically *not* a `send_*` pair. Swap had no instrumentation of its own
at first, and the events that showed up during a swap came from unrelated screens
the user happened to pass through — a genuinely misleading result, since an
unmatched `send_started` reads as an abandoned payment.

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

So screens in the home group gate on `pathname`, which is the carousel's own
source of truth for which page is showing, rather than on mount — see
`SendManager`, `SwapManager` and `Receive`. Two consequences worth knowing:

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
