# Wallet Telemetry & Crash Reporting — Design

Date: 2026-08-20
Branch: `feat/wallet-telemetry` (to be cut off `origin/main` @ `d77bc51d`)
Status: awaiting approval

## Goal

See where people get stuck in Wallet without learning anything about their money
or activity.

For each important flow we learn four things and nothing more: did the person
start it, did they finish / cancel / error, how long did it take, and — when
relevant — a broad category of what went wrong. Plus scrubbed crash reports.
All of it behind an off-by-default **Help improve Wallet** setting.

The design principle everything else follows from: **forbidden data must be
unrepresentable, not merely un-sent.** Privacy guarantees expressed as types and
as a single egress choke point survive the addition of the thirtieth call site
by an engineer who never read this document. Guarantees expressed as review
discipline do not.

## Non-goals

- **Beta-feature flows.** Guardian and local proving, swaps (pending / partly
  filled / completed / cancelled), connected-app requests, and on/off-ramp
  handoff and return are a follow-on spec. They depend on flows that are still
  moving, and the swap result taxonomy deserves its own treatment.
- **The user-initiated diagnostic report.** "Send diagnostic report" on a
  recoverable error is a separate feature with a different payload, different
  consent semantics (per-press, not per-setting), and its own UI. Follow-on spec.
- **macOS (Tauri).** Extension + iOS + Android only in this release.
- **Any persistent identifier.** See "Identifier design" below. This is a
  decision, not a deferral.
- **Cross-session analysis.** Retention, MAU, and repeat-user funnels are out of
  reach by construction and are not a future extension of this design.

## Decisions locked with the requester

1. **Destination:** third-party SaaS with an EU-hosted data-processing
   agreement. Not self-hosted, not a US-default vendor.
2. **Identifier design:** ephemeral per-flow ID only. No persistent per-install
   identifier, rotating or otherwise. This is what removes the
   Product/Privacy/Security review gate named in the requirements.
3. **Scope:** core pipeline + stable flows + crash reporting + anti-leak tests +
   disclosures. Beta flows and the diagnostic report are follow-ons.
4. **Platforms:** Chrome/Firefox extension, iOS, Android.
5. **Approach:** first-party emitter, vendors as dumb sinks. Aptabase (EU) for
   product events, Sentry (EU) for crashes.
6. **The existing `src/lib/analytics/` scaffold is deleted** as part of this
   work, not extended.
7. **Web SDK:** full observability interface — core emission API plus
   `@miden-sdk/telemetry-sentry` and `@miden-sdk/telemetry-otel` binding
   packages — all in this scope. The wallet ships after the SDK release.
8. **High-fidelity SDK channel:** exists, but behind a distinct opt-in API
   enabled explicitly at client construction, off by default and absent from the
   observation type when off.

## Starting state (what is already here, and why it can't be built on)

An audit of the current tree found four things that shape the work:

**A dead telemetry scaffold.** `src/lib/analytics/` contains nine hooks
(`useAnalytics`, `useFormAnalytics`, `usePageRouterAnalytics`,
`useAnalyticsSettings`, `performance-analytics`, and supporting state), wired
into `Link.tsx`, `ToggleSwitch.tsx`, `FormSubmitButton.tsx`,
`FormSecondaryButton.tsx`, `CopyButton.tsx`, `OpenInExplorerChip.tsx`,
`Welcome.tsx`, `Unlock.tsx`, `LanguageSettings.tsx`, and
`GeneratingTransaction.tsx`. Nothing ships today: the three backend handlers in
`src/lib/miden/back/main.ts` (lines 214–222) are commented out and there is no
`Analytics` module for them to call.

It cannot be built on, because it is shaped for exactly what the requirements
forbid. Its event categories are `ButtonPress`, `Toggle`, `FormChange`,
`FormSubmit`, `PageOpened`, `PageClosed`; `usePageRouterAnalytics` attaches
`tokenAddress` and `tokenId` to page-visit events; and its payload type is
`properties?: object`, an unbounded bag. Keeping it as "hooks we choose not to
call" would leave loaded guns in the tree and make the anti-leak claim
unstatable.

**A persistent identifier already on disk.** `use-analytics-state.hook.ts`
seeds `localStorage['analytics']` with `{ enabled: undefined, userId: nanoid() }`.
Existing installs are therefore already carrying a dormant long-lived
identifier that nothing owns and nothing uses. Deleting the scaffold must delete
that key.

**A second, broken egress path.** `src/shared/logger.ts` has a
`sendLogToServer` stub behind a consent check that reads
`if (analytics && !analyticsJson.enabled === true) return;` — which parses as
`(!enabled) === true`, i.e. it returns early when consent *is* granted and
proceeds when it is not. Its `censorKeys` scrubber matches `APrivateKey` and
`AViewKey`, Aleo formats inherited from an upstream codebase, which correspond
to nothing in Miden. Harmless only because the transport is an empty method.
This design replaces that path rather than sitting beside it.

**A dead CDP dependency.** `@segment/analytics-node` is in `package.json`
(line 155) with zero imports anywhere in `src/`, `packages/`, `utility/`, or
`scripts/`. Segment's purpose is fanning events to downstream vendors — the
data-broker shape the requirements name. It is removed here so a privacy audit
of the dependency tree comes back clean.

**Clean ATT baseline.** `AppTrackingTransparency`,
`NSUserTrackingUsageDescription`, `ATTrackingManager`, `IDFA`, and
`advertisingIdentifier` appear nowhere in `ios/`, `android/`, or `src/`. The
requirement is to keep it that way, which is a test, not a change.

## Architecture

### The trust boundary

Everything lives in a new `src/lib/telemetry/`. Exactly one module is permitted
to perform telemetry network egress: a sink that runs in the background service
worker. No frontend code calls `fetch` for telemetry, ever.

A flow calls a reporting function → an intercom message crosses to the
background → the background handler checks consent, builds the payload, and
sends. This follows the "Adding a Wallet Action" path in `AGENTS.md`: message
type in `src/lib/shared/types.ts`, handler in `src/lib/miden/back/actions.ts`,
registered in `src/lib/miden/back/main.ts`, and — because new intercom message
types need it — `src/lib/intercom/mobile-adapter.ts` updated too.

Three reasons the gate lives in the background rather than at the call sites:

1. Consent is checked in one place. That is the difference between an auditable
   guarantee and a review discipline.
2. The service worker outlives the popup, so a flow result is not lost when the
   user dismisses the window mid-send.
3. Settings already mirror into the background (`BG_SETTINGS_MIRRORED_KEY`,
   `isDelegateProofEnabledAsync` in `src/lib/settings/`), so reading consent
   there follows an existing pattern.

### The wire type

The payload type has exactly the permitted fields, and every field is narrow:

| Field | Type | Source |
|---|---|---|
| `flow` | closed union of flow-name literals | caller |
| `phase` | `'started' \| 'ended'` | caller |
| `flowId` | ephemeral opaque string | background |
| `result` | `'completed' \| 'cancelled' \| 'errored'` (absent on `started`) | caller |
| `errorKind` | closed union of broad categories (optional) | caller |
| `durationMs` | `number` (absent on `started`) | background |
| `appVersion` | `string` | background, from `package.json` version |
| `platform` | `'extension' \| 'ios' \| 'android'` | background, from `lib/platform` |

There is no free-form `string` field, no `object` field, and no index signature
anywhere in the type. `appVersion` and `platform` are derived in the background
and cannot be passed in. The serializer builds a fresh object literal field by
field and never spreads.

This is the load-bearing decision. An address, an amount, a note ID, or an
`error.message` has nowhere to go: it fails `yarn ts` before any test runs.

### Flow lifecycle: two events, not one

Each flow emits `flow_started` when it begins and `flow_ended` with its result
and duration.

Emitting a single event at the terminal state is the obvious simplification and
it is wrong here. If a user gets stuck and force-quits, or the popup is
dismissed mid-send, no terminal event ever fires — so the single-event design
silently discards exactly the population this project exists to find. With two
events, a `started` with no matching `ended` *is* the abandonment signal, and it
is already durable by the time the popup dies.

Abandonment is therefore a fourth outcome alongside completed, cancelled, and
errored, computed vendor-side rather than reported by the client.

### Identifier design

The ephemeral flow ID exists solely to join those two events. It is generated
when a flow starts, held in memory in the background keyed by flow, and dropped
when the flow ends or when a TTL expires so an abandoned flow cannot pin memory
indefinitely. It never touches disk, is never reused, and is never sent with
anything other than that pair.

Consequence, stated plainly because it must be disclosed and cannot be walked
back later: there is no per-user deletion, because there is nothing that
identifies a user. See "Retention and deletion".

Durations use `performance.now()`, not `Date.now()`, so a wall-clock adjustment
mid-flow cannot produce a negative or wildly inflated timing.

### Instrumented flows

Getting started: `open`, `unlock`, `create`, `import`, `recover`, `return`.
Everyday use: `fund`, `receive_share`, `send`, `note_handle`, `activity_view`.

`errorKind` is a closed union of `network`, `rpc`, `proving`, `validation`,
`storage`, `auth`, `timeout`, `unknown`, produced by mapping a caught error to a
category. `error.message` is never a candidate, because no field could hold it.

### Instrumentation points

The codebase has two flow shapes, and both offer a single choke point, so no
screen needs to know telemetry exists:

- **Onboarding** is a step machine: `OnboardingStep` / `OnboardingAction`
  dispatched through one `onAction` host (`src/screens/onboarding/navigator.tsx`).
  Instrument the host that handles the actions.
- **Send and other managed flows** wrap themselves in `NavigatorProvider`
  (`SendManager` in `src/screens/send-flow/SendManager.tsx`, exported as
  `SendFlow`). Instrument the manager; mount and terminal transitions are the
  natural begin and end.

## Consent

Follows the existing settings pattern rather than the scaffold's:

- A new key in `src/lib/settings/constants.ts` beside
  `DELEGATE_PROOF_STORAGE_KEY` and `HAPTIC_FEEDBACK_STORAGE_KEY`.
- `isTelemetryEnabled` / `setTelemetrySetting` / `isTelemetryEnabledAsync`
  helpers in `src/lib/settings/helpers.ts`, mirrored to the background the way
  the delegate-proof and auto-consume settings already are.
- **Tri-state:** never asked / off / on, defaulting to off. A fresh install is
  not treated as a refusal, and "off until the user turns it on" holds.
- **First launch:** an optional, skippable step in the onboarding step machine.
  Not a blocking modal.
- **Permanent control:** a `SettingToggle` row in
  `src/app/templates/GeneralSettings.tsx`, next to haptic feedback and delegated
  proving.
- **i18n:** new flat keys in `public/_locales/en/en.json`; CI blocks raw strings
  (`yarn lint:i18n`).
- This is a Wallet setting. It is not Apple's App Tracking Transparency prompt,
  and no ATT prompt is added.

Turning it off stops sends **and drops the queue**. There is deliberately no
"hold events while off and flush if they later opt in" behavior — that would
make the off switch a lie.

Migration: deleting the scaffold deletes `localStorage['analytics']`, removing
the dormant `nanoid` identifier from existing installs.

## Crash reporting

Sentry, EU region, using the documented shared-environment recipe:

- A hand-constructed `BrowserClient` and `Scope`. **Never `Sentry.init()`** — in
  an extension it pollutes global state shared with host pages.
- **Granular named imports only.** A namespace import of `@sentry/browser` has
  gotten an extension rejected from the Chrome Web Store under MV3's remote-code
  rule; granular imports resolved it. This is a build requirement, not a style
  preference.
- Default integrations that touch global state are filtered out:
  `BrowserApiErrors`, `Breadcrumbs`, `GlobalHandlers`.
- No tracing or performance integrations.

Two of those exclusions are doing privacy work, not just avoiding global-state
pollution. Dropping `Breadcrumbs` removes automatic capture of console output,
fetch URLs, and DOM click targets — all on the never-send list. Dropping tracing
removes automatic `fetch` and history instrumentation, which would capture full
URLs. The extension-safety recipe and the privacy requirements happen to want
the same configuration.

The cost: dropping `GlobalHandlers` means no automatic `window.onerror` or
`unhandledrejection` capture, so those are wired explicitly and call
`captureException` directly. For a wallet, explicit is preferable anyway.

### The message problem

An exception message is free text written by whoever threw it, which in this
codebase plausibly includes an address, an amount, or — worst case — a seed word,
from something like an "invalid mnemonic word" validation error. Messages are
therefore never sent verbatim.

The event keeps the error class name and the stack. The message passes through a
redactor first:

1. **BIP-39 wordlist check.** The wordlist is already bundled and threaded
   through onboarding as `wordslist`. If a candidate message contains any
   wordlist entry, the message is dropped entirely and only the class name and
   stack are kept. Cheap, exhaustive, and testable against the single worst leak.
2. **Pattern redaction** for Miden address forms, long hex runs, and digit
   sequences.
3. **`beforeSend` rebuilds the event from an allowlist**, the same way the
   analytics serializer does — a second line of defense, not the primary one.

IP address storage is disabled on the Sentry project. A retained IP is a
linkable identifier wearing a different hat, and would quietly undo the
ephemeral-only decision.

### Surfaces

Only the background worker and the wallet's own UI get a client. Content
scripts do not: they run in the page world, and nothing in the requirements
needs errors from there.

### Replacing `logger.ts`

`src/shared/logger.ts`'s server path is removed and routed through the telemetry
module. Leaving a second egress path — with an inverted consent check and an
Aleo-format scrubber — beside a carefully gated one would defeat the purpose of
having a single choke point.

## Web SDK observability

### Why it belongs in the SDK

Any consumer of `@miden-sdk/miden-sdk` faces the same opaque box the wallet
does. `src/lib/miden/sdk/prove-telemetry.ts` exists — with a comment explaining
it is there to find out why proving occasionally exceeds 20 seconds, whether the
delegated remote prover stalled, and whether it fell back to local — precisely
because prove path, fallback, and remote duration are SDK-internal and not
observable from outside. That file had to build a bounded ring and a
`chrome.storage.local` mirror to approximate facts the SDK already knows. Every
other consumer will hand-roll the same shim.

The SDK is also further along this road than it looks. It already has three
ad-hoc observation surfaces — `onStateChanged(callback: (event: any) => void)`,
per-call `onProgress?: (status: WaitStatus) => void`, and the callback-injection
idiom of `GetKeyCallback` / `InsertKeyCallback` / `SignCallback` /
`CallbackProver`. This is consolidation and typing of something half-built, not
a new concept. `onStateChanged` accepting `any` is exactly what a designed
interface replaces.

Designing the whole interface now rather than shipping a single
`setObserver(fn)` avoids a one-way door: ship the narrow version and the next
person who wants richer observability either breaks consumers or carries two
APIs forever.

### The line: core emits, never transports

`@sentry/*` must not appear in `@miden-sdk/miden-sdk`'s dependencies, and not as
an optional peer either. The core exposes hooks with zero telemetry
dependencies and no network capability. Vendor bindings live in separate opt-in
packages following the OpenTelemetry instrumentation pattern:

- `@miden-sdk/telemetry-sentry`
- `@miden-sdk/telemetry-otel`

each with the vendor as a `peerDependency`.

That split is not architectural purity — it is what makes the wallet's claim
testable. The wallet must assert nothing *can* leave, not that nothing is
configured to leave. With bindings in separate packages, the wallet installs the
core only and CI asserts no binding package appears anywhere in its dependency
tree. If the core could carry a Sentry transport, that assertion does not exist.

This is also why OpenTelemetry appears here but not in the wallet. As the
wallet's transport it is wrong: heavy for eight fields, and its trace and parent
IDs are precisely the cross-operation linkability the identifier decision
rejected. As one of several bindings it is the most valuable item on the list,
because dApp and infra teams already speak OTLP and span semantics fit
operation-with-duration exactly.

### Observation shape and the fidelity problem

The wallet and a dApp want opposite fidelity. A dApp developer debugging their
own app wants the account ID, the note ID, and the verbatim error text in their
Sentry — it is their app and their user, and stripped observations are useless
to them. The wallet must never send any of it.

Resolution: an observation carries safe fields always — operation name from a
closed union, outcome, duration, and SDK-internal facts like prove path and
fallback. The high-fidelity part is **a distinct opt-in API, enabled explicitly
at client construction, off by default**, and the corresponding field is
*optional in the type and genuinely absent* when disabled — not empty. Bindings
must handle its absence, which is honest, since absence is the default.

One callback registration with an optional field, not two channels; the type
then tells the truth about what a consumer gets.

Why opt-in rather than always-populated-and-ignored: an always-populated
sensitive section puts account IDs and raw error text in memory at every
observation point for every consumer, and reduces the wallet's guarantee to a
statement about *consumption* ("our binding does not destructure that field")
that must be re-audited whenever a field is added. Opt-in makes it a statement
about *configuration* — the channel is never enabled, so the data is never
assembled. For the wallet that is one construction site to check, enforceable as
a CI assertion that the option name appears nowhere in wallet source. It also
keeps error formatting and ID serialization off the proving and sync hot paths,
which matters given the 20-second prove problem that motivated
`prove-telemetry.ts`.

The SDK emits a one-time console warning when the channel is enabled. Nearly
free, and it makes accidental production enablement loud rather than silent.

Contracts the core observer must honor: synchronous, no network capability, no
identifiers in safe fields, wrapped so it can never throw into the caller, and a
no-op when nothing is subscribed.

Once the SDK reports prove path, fallback, and remote duration natively,
`prove-telemetry.ts` becomes a consumer of the sink rather than a shim that
infers them.

### Release ordering

The wallet is gated on an SDK release:

1. Web SDK PR lands the core emission interface and both binding packages.
2. SDK version is published.
3. Wallet bumps the pin, and `resolve.dedupe` for `@miden-sdk/miden-sdk` and
   `dexie` is re-verified after the bump — per the duplicate-dexie gotcha in
   `AGENTS.md`, two inlined dexies trip dexie's global guard and the service
   worker fails to register while mobile and desktop crash. Verify by parsing a
   built chunk's `.js.map` for `DEXIE_VERSION`; a plain `grep -r` over
   `node_modules` misses it. Wipe `dist/chrome_unpacked` before re-verifying.
4. The wallet PR carries the verbatim marker `Web SDK PR: #N` on its own line —
   prose mentions do not trigger the linked-PR CI pipeline. Local parity via
   `scripts/dev-with-web-sdk-pr.sh`.

## Proving forbidden data cannot leave

The requirement is that tests stop forbidden data from being sent. The way to
satisfy it is to test the **boundary**, not the call sites. A suite asserting
"the send flow reports the right fields" covers only the call sites someone
remembered, and says nothing about the thirtieth one added six months from now.

### The centerpiece: adversarial egress test

Seed a wallet with known poison values — a real generated mnemonic, an account
address, a balance, an amount, a note ID. Drive every instrumented flow
including failure and cancellation paths. Spy on the transport. Assert that no
outbound body contains any poison value as a substring. New call sites are
covered automatically because the assertion lives at the exit.

Two details decide whether this test is real or theater:

1. **Encoding variants.** Check lowercase, uppercase, hex, base64, URI-encoded,
   and JSON-escaped forms. A naive substring check on a base64-encoded address
   passes while leaking.
2. **Raw bodies, not parsed ones.** Sentry sends newline-delimited envelopes
   rather than a single JSON object. A test that does `JSON.parse(body)` stops
   checking the part carrying the stack.

Lives in Playwright, using the `MIDEN_E2E_TEST` harness
(`window.__TEST_STORE__` / `window.__TEST_INTERCOM__`).

### Supporting assertions

- **Serializer unit test:** output keys are exactly the allowlist, for every
  event variant.
- **BIP-39 wordlist test:** a crash message containing any wordlist entry
  results in an event with no message field.
- **Host allowlist:** telemetry can only ever contact the two expected
  endpoints; a vendor upgrade cannot quietly add a third.
- **Dependency-tree assertions:** no `@miden-sdk/telemetry-*` package in the
  wallet's tree; the SDK's sensitive-channel option name appears nowhere in
  wallet source; `@segment/analytics-node` is gone.
- **Consent gate, all three states.** The key case is that a fresh install,
  where consent is neither granted nor refused, sends nothing at all. Plus:
  toggling off mid-flight drops the queue.
- **ATT absence:** `AppTrackingTransparency`,
  `NSUserTrackingUsageDescription`, `ATTrackingManager`, `IDFA`, and
  `advertisingIdentifier` appear nowhere in `ios/` or `android/`, including
  `Info.plist`.
- **Type-level:** `yarn ts` is the enforcement for the wire type. Covered by
  strict mode plus the no-`any`/no-`as` rule in `AGENTS.md`.

Unit and serializer work in Jest, co-located as `*.test.ts`. The new module
clears the 95% branch/function/line/statement coverage floor.

## Retention and deletion

Because there is no persistent identifier, there is **no per-user deletion**.
This cuts both ways and the spec states it rather than dressing it up: it is the
strongest possible privacy position, and it means a "delete my telemetry"
request genuinely cannot be honored, because there is no way to identify which
rows are anyone's. That must be disclosed accurately rather than papered over
with a deletion promise that cannot be kept.

- **Retention:** 90 days for both product events and crash reports — the
  shortest window that still supports release-over-release comparison across a
  few versions.
- Enforced in **vendor configuration**, not in a policy document, and **verified
  after setup** rather than assumed.
- Raw event export and any forwarding to a third party stay off. This is where
  "never sold or shared with data brokers" becomes a checked configuration fact
  plus a DPA term instead of an intention.
- IP address storage disabled on the Sentry project (see above).

## Disclosures

### Privacy policy

`docs/privacy/index.md` is served by GitHub Pages at
`https://0xmiden.github.io/wallet/privacy/` — the URL submitted to every store,
so it is the live document for all surfaces. It currently opens with "**None.**"
and states the app has "no analytics SDKs, no crash reporters, and no
advertising identifiers."

It needs a new section covering: the optional setting and that it is off by
default; where to turn it off; the exact list of fields sent; the explicit
never-send list; the two processors and their EU regions; the 90-day retention
window; and the honest note that deletion is impossible by design because
nothing identifies a user. `Last updated` changes with it.

### Three store surfaces

Not one — the extension is in scope.

- **Apple App Store.** Declare Diagnostics and Usage Data, mapped to App
  Functionality and Analytics, marked **not linked to identity** and **not used
  for tracking**. It must be declared even though collection is optional and off
  by default, because the questionnaire asks what the app *can* collect. No ATT
  prompt.
- **Google Play.** The pre-written Data Safety answers in `STORE_LISTING.md`
  need updating — line 213 currently declares "App info and performance — Crash
  logs / Diagnostics: None collected (no crash reporter)." The deletion question
  is answered consistently with the no-identifier design.
- **Chrome Web Store.** Its own data-use disclosure plus certification
  checkboxes about not selling data and not using it for unrelated purposes.
  Most likely to be forgotten, since it lives outside this repo.

### Marketing copy

`STORE_LISTING.md` line 47 reads "No tracking or analytics that compromise your
privacy." Arguably still defensible given this design, but it should be a
deliberate decision by whoever owns the claim rather than a sentence that
survives because nobody re-read it. Flag for Product.

## Done means

Traced from the requirements:

- [ ] A new user can turn **Help improve Wallet** on, or leave it off, and a
      fresh install with no choice made sends nothing.
- [ ] Turning it off stops future automatic data sharing and drops anything
      queued.
- [ ] Every listed stable flow reports only start / result / duration plus
      app version, platform, and a broad error kind.
- [ ] A crash produces a scrubbed report only when the setting is on.
- [ ] Tests prove forbidden wallet and user data cannot leave, at the transport
      boundary, across encoding variants.
- [ ] No ATT prompt exists, and the privacy policy plus all three store
      disclosures are updated and reviewed before release.
- [ ] `src/lib/analytics/` and its call sites are gone, the legacy
      `localStorage['analytics']` key is deleted on upgrade, `logger.ts`'s
      server path is removed, and `@segment/analytics-node` is dropped.
- [ ] Web SDK ships the core emission interface plus both binding packages, with
      the high-fidelity channel off by default and absent from the type when
      disabled.

## Open questions for review

1. **Vendor confirmation.** Aptabase (EU/Germany) is recommended over PostHog EU
   because it has no unique identifiers, no cookies, and no long-term user
   identification as an architectural constraint rather than a setting, and it
   states plainly that user-level analytics like MAU and retention are
   impossible on its data model — a vendor that structurally cannot do the thing
   we ruled out is a stronger position than one configured not to. Needs a
   commercial and DPA check before implementation.
2. **Retention window.** 90 days is a proposal, not a constraint. Product may
   want shorter.
3. **Marketing copy** at `STORE_LISTING.md:47` — Product decision.
