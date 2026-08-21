# Telemetry — store data-collection declarations

Bread ships an optional, off-by-default **Share usage data** setting. Four
storefronts each want that declared in their own vocabulary, and none of them
uses the same words for it. This file holds the answers for all four so they
stay consistent with each other and with the code.

Dev-only doc: excluded from the published site in `docs/_config.yml`.

**The three sources of truth, in this order:**

1. `src/lib/telemetry/types.ts` and `WIRE_KEYS` in
   `src/lib/telemetry/serialize.ts` — the exhaustive list of what can be sent,
   plus `src/lib/telemetry/aptabase.ts`, which maps that list onto Aptabase's
   envelope and is the only place a field can cross into a vendor format.
2. `docs/privacy/index.md` — the public policy, at
   `https://0xmiden.github.io/wallet/privacy/`. This is the URL submitted to
   every store.
3. This file — the per-store form answers derived from the two above.

If they ever disagree, the code is right and the other two are wrong.

## What is actually collected

Only while the setting is on. Product events carry exactly eight fields and no
free-form text:

| Field | Values |
|---|---|
| `phase` | `started`, `ended` |
| `flow` | One of 11: `open`, `unlock`, `create`, `import`, `recover`, `return`, `fund`, `receive_share`, `send`, `note_handle`, `activity_view` |
| `flowId` | Ephemeral per-flow random id, in memory only, never persisted or reused |
| `result` | `completed`, `cancelled`, `errored` (`ended` only) |
| `errorKind` | `network`, `rpc`, `proving`, `validation`, `storage`, `auth`, `timeout`, `unknown` (`ended` only, when it failed) |
| `durationMs` | Rounded integer milliseconds (`ended` only) |
| `appVersion` | e.g. `1.15.21` |
| `platform` | `extension`, `ios`, `android` |

### How those eight fields reach Aptabase

`buildEnvelope` in `src/lib/telemetry/aptabase.ts` maps them onto Aptabase's
envelope, each field exactly once, by name — never by spreading, because
Aptabase's `props` is an open object and the type system stops helping there:

| Envelope field | Holds |
|---|---|
| `eventName` | `<flow>_<phase>`, e.g. `send_started`. 22 possible names, both halves closed unions |
| `sessionId` | `flowId`. **Not** an Aptabase session — see below |
| `props` | `result`, `errorKind`, `durationMs` |
| `systemProps.osName` | `platform` |
| `systemProps.appVersion` | `appVersion` |
| `systemProps.isDebug` | `NODE_ENV !== 'production'` |
| `systemProps.sdkVersion` | The constant `bread-wallet-aptabase@1.0.0` |
| `timestamp` | ISO 8601 send time |

Two departures from how Aptabase's own SDKs fill this in, both deliberate:

- **`sessionId` is one flow, not one session.** Their SDKs reuse a session id
  across events with a four-hour timeout, which would link every flow one
  person performs into a single trail. Ours is the per-flow id, so an Aptabase
  "session" means exactly one activity. It also could not work otherwise —
  `guarantees.test.ts` asserts the telemetry module cannot reach a persistence
  API at all, so there is nowhere to keep a longer-lived id.
- **`systemProps.osVersion`, `locale` and `deviceModel` are never sent.** All
  three are fingerprinting vectors, none is required, and Aptabase's own
  custom-SDK example omits most of them. `egress-boundary.test.ts` fails if any
  of the three appears anywhere in an outgoing envelope, and
  `guarantees.test.ts` fails if the telemetry module reaches an API that could
  compute one.

One event per request (`/api/v0/event`, never the 25-event `/api/v0/events`
batch): an MV3 service worker has no guaranteed lifetime, so a batch buffer is
a buffer that gets killed. `credentials: 'omit'`, as Aptabase's own web SDK
sends, so no cookie can ride along.

Crash reports carry a scrubbed error type, a scrubbed message, scrubbed stack
frames, the `cause` chain, the app version, and a per-report random id. A report
containing anything that reads as recovery-phrase material is discarded whole.

No persistent user, device, or install identifier exists anywhere in either.

## Before any of these forms are submitted

The vendor-side configuration is not in this repo, and every claim below
depends on it. **Verify, do not assume** — a policy claiming 90 days against a
vendor defaulting to longer is worse than making no claim at all.

- [ ] Aptabase project created **in the EU region**, retention set to **90 days**. The region is fixed when the project is created and is encoded in the key — an `A-US-*` key sends to the United States and makes the policy's "European Union (Germany)" row false.
- [ ] Sentry (EU) project created, retention set to **90 days**
- [ ] Sentry: **IP address storage disabled** (`Settings → Security & Privacy → Prevent Storing of IP Addresses`)
- [ ] Sentry: data scrubbing left **on**; it is defence in depth behind our own scrubber, not a replacement for it
- [ ] Both: raw event export **off**, third-party forwarding **off**
- [ ] Both: signed DPA on file naming the EU hosting region
- [ ] `APTABASE_APP_KEY` and `SENTRY_DSN` set in the release build environment. Both are empty by default, so an unconfigured build sends nothing regardless of the setting. The key comes from Aptabase's dashboard under Settings → Instructions.
- [ ] `APTABASE_HOST` left **unset** for a release build. The host is derived from the key's region (`A-EU-*` → `https://eu.aptabase.com`), and setting it overrides that. It exists only for a self-hosted (`A-SH-*`) or development (`A-DEV-*`) key, which carry no region to derive from and send nothing at all without it.
- [ ] Confirm the key actually begins `A-EU-`. A malformed or missing key disables sending silently and without an error, which is the right behaviour for a best-effort path and the wrong thing to discover after a release.

## Chrome Web Store

Developer Dashboard → the item → **Privacy practices**.

**Single purpose.** Unchanged: a non-custodial wallet for the Miden blockchain.

**Data usage — check exactly one box:**

| Chrome category | Declare | Why |
|---|---|---|
| Personally identifiable information | **No** | No name, address, email, age, or ID number exists in either payload. |
| Health information | **No** | — |
| Financial and payment information | **No** | No addresses, balances, amounts, or transaction contents are sent. Field names carrying them are scrubbed from crash reports. |
| Authentication information | **No** | Note for whoever fills this in: `errorKind` has a value called `auth`. It is a category label meaning "an authentication step failed" — not a credential, not a password, not a PIN. |
| Personal communications | **No** | — |
| Location | **No** | See the note below; this one deserves a considered answer rather than a reflex. |
| Web history | **No** | No URL, no page, no referrer. The Sentry integrations that would have captured them (`HttpContext`, `Breadcrumbs`) are excluded — see `CRASH_INTEGRATION_ALLOWLIST` in `src/lib/telemetry/crash.ts`. |
| **User activity** | **Yes** | This is the one to check. Flow name, outcome, and duration are in-product interaction records. |
| Website content | **No** | The extension sends nothing from any page it runs on. |

**On Location.** Chrome's category reads "region, IP address, GPS coordinates",
and the ingest endpoints do see the request's IP address, as any server does for
any request. We declare **No**, because the extension neither reads nor
transmits location data — no location permission, no location API, no IP field
in either payload — and the processors are configured not to store the IP. If
that reasoning is ever revisited, revisit it here rather than silently flipping
the box, and keep the public policy's IP paragraph in step with the answer.

**Certifications — all three can be signed:**

- *I do not sell or transfer user data to third parties, outside of the approved
  use cases.* Aptabase and Sentry are processors acting on our instructions
  under a DPA, which is the approved service-provider case. Nothing goes to a
  data broker or an ad network.
- *I do not use or transfer user data for purposes unrelated to my item's single
  purpose.* The only purpose is finding where the wallet breaks.
- *I do not use or transfer user data to determine creditworthiness or for
  lending purposes.*

**Privacy policy URL:** required, because we now declare a category. Use the
policy URL above.

## Firefox AMO

Unlike the other three, Firefox's declaration is **machine-readable and lives in
the repo** — AMO rejects a submission without it. It is already in place, in the
Firefox block of both `public/manifest.v2.json` (the file `yarn build:firefox`
ships) and `public/manifest.json`:

```json
"data_collection_permissions": {
  "required": ["none"],
  "optional": ["technicalAndInteraction"]
}
```

This is an exact fit for the design, which is why it is a two-line declaration:

- `required: ["none"]` — nothing is collected for the extension to function. A
  user who never opts in transmits nothing, which is the default state.
- `optional: ["technicalAndInteraction"]` — Mozilla's category for technical and
  interaction telemetry, covering both our product events and our crash
  reports. Mozilla only permits this category as optional, never required, which
  matches an off-by-default setting exactly.

Nothing else is declared: no `personallyIdentifyingInfo`, no
`financialAndPaymentInfo`, no `locationInfo`, no `browsingActivity`, no
`websiteContent`.

**Two things to know when submitting.**

*The browser-level answer is honoured, not just declared.* Firefox shows its own
checkbox for `technicalAndInteraction` in the install prompt, and the user can
toggle it afterwards in `about:addons` → Permissions and data. That is a second
consent sitting beside **Share usage data**, and two consents that can disagree
would be a defect, so `isTelemetryEnabledAsync` in `src/lib/settings/helpers.ts`
ANDs them: nothing is sent unless both say yes. A user who declines at the
Firefox prompt is not collected from however the in-app toggle is set.

The check reads `permissions.getAll()` rather than
`permissions.contains({ data_collection: [...] })`, for one specific reason.
Telling *"this browser has no such concept"* apart from *"this browser said no"*
is the whole difficulty, and `contains()` cannot do it: Chrome rejects an unknown
`data_collection` key, so a thrown error would mean both "Chrome" and "something
broke", and treating a throw as a refusal would silently disable telemetry on
Chrome. `getAll()` distinguishes them by **the presence of the `data_collection`
key** in its response, which is the mechanism Mozilla documents for
feature-detecting this experience at runtime — absent key means the browser does
not implement it and our own setting decides; present key means its answer is
authoritative, and an empty array is a refusal rather than an absence. Everything
else — a throw, a rejected promise, a non-array value — fails closed. See
`src/lib/telemetry/browser-consent.test.ts` for the matrix.

*No `strict_min_version` was added.* Firefox below 140 does not render the
built-in consent UI, and Mozilla's transitional rule for those versions is that
the add-on must offer the user control over data collection immediately after
installation. Bread does: the consent prompt appears right after the wallet is
created or imported, and the toggle lives in Settings → General thereafter.

## Apple App Store

Two artifacts that App Review compares against each other. **They must agree.**

### App Privacy questionnaire (App Store Connect)

| Data type | Purpose | Linked to identity | Used for tracking |
|---|---|---|---|
| Diagnostics → **Crash Data** | App Functionality | **No** | **No** |
| Usage Data → **Product Interaction** | Analytics | **No** | **No** |

Declare nothing else. In particular: no Identifiers (no user id, device id, or
advertising identifier exists), no Financial Info, no Contact Info, no Location,
no Sensitive Info, no Advertising Data.

Answer **yes** to "collected but optional" where the form offers it. Apple's
questionnaire asks what the app *can* collect, so both rows must be declared
even though collection is off by default and requires opt-in.

**No App Tracking Transparency prompt.** `NSUserTrackingUsageDescription` is
absent, and a test asserts it stays absent — nothing is tracked, so there is
nothing to ask permission for.

*On `durationMs`.* It is declared under Product Interaction rather than
Diagnostics → Performance Data. Apple's Performance Data means launch time, hang
rate, and energy use; our duration is how long a user-facing flow took, which is
interaction timing. If Product would rather also declare Performance Data, that
is harmless — over-declaring costs nothing with Apple, under-declaring is what
gets an app rejected.

### `ios/App/App/PrivacyInfo.xcprivacy`

Already updated, and it mirrors the table above:

- `NSPrivacyCollectedDataTypeCrashData` → purpose `AppFunctionality`, `Linked` false, `Tracking` false
- `NSPrivacyCollectedDataTypeProductInteraction` → purpose `Analytics`, `Linked` false, `Tracking` false
- `NSPrivacyTracking` stays `false`, `NSPrivacyTrackingDomains` stays empty

`src/lib/telemetry/guarantees.test.ts` asserts the last line and asserts no
collected type may ever be flagged as used for tracking. It deliberately does
**not** assert that the collected-types list is empty, so honest additions are
allowed and dishonest ones are not.

## Google Play

The paste-ready Data Safety answers live in
[`STORE_LISTING.md`](../STORE_LISTING.md) under "Data Safety (Google Play)",
which is the existing mechanism — they are not duplicated here, so there is one
place to change them.

For orientation, the telemetry-relevant answers there are: **App activity → App
interactions** and **App info and performance → Crash logs / Diagnostics**, each
collected optionally, not shared, encrypted in transit, purpose Analytics and
App functionality; **Device or other IDs: not collected**.

**The data-deletion question.** Play asks whether users can request deletion of
their data. Answered honestly and consistently with the no-identifier design:
on-device wallet data can be deleted in-app, and the telemetry cannot be deleted
per user because nothing in it identifies a user. It expires on its own at 90
days. The account-deletion URL requirement does not apply — the app has no
accounts.

## Marketing copy — needs a Product decision

`STORE_LISTING.md` line 47 reads "No tracking or analytics that compromise your
privacy." It is flagged in place with a `<!-- REVIEW -->` comment rather than
silently rewritten. The claim is arguably still true — this is analytics that
does not compromise privacy, which is the distinction the sentence draws — but
that should be somebody's decision, not a sentence that survived because nobody
re-read it.

## One inconsistency worth fixing, in the consent copy

`helpImproveWalletDescription` in `public/_locales/en/en.json` describes the
product events well ("which parts of Wallet you use, where you get stuck, broad
error categories, the app version, and your platform") but never says **crash
reports**, which the same single setting also turns on. Nothing it says is
false, and "where you get stuck" is in the neighbourhood, but a user reading only
that string would not know they were consenting to stack traces being sent.

Not fixed here: changing that string means re-translating it across every locale
in `public/_locales/`, and the wording is Product's call. Raised so it is a
decision. The public policy is explicit about crash reports either way.
