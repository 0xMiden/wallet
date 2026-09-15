# In-wallet update notification - Design

**Issue:** #821
**Decision:** Use each platform's authoritative update channel for availability, and a Miden-owned manifest only for presentation metadata.

## Goal

Tell a user that a newer build is actually available to that installation, explain the update briefly, and hand off to the platform's normal update action. A remote manifest must never make an unavailable build appear installable or control an arbitrary navigation target.

## Product contract

- Render one non-blocking update card after an initialized wallet reaches its normal app surface. Do not cover onboarding, recovery, or the hot-key rotation gate.
- Show `Update available`, the available version, a bounded plain-text summary, and exact platform action copy.
- Keep showing the card until the user updates or explicitly dismisses that version. A dismissal is scoped to `(platform, availableVersion)`, so a later version appears again.
- `normal`, `important`, and `critical` change the card's visual emphasis only. Remote metadata never blocks wallet use, bypasses dismissal, or triggers installation automatically.
- If the presentation manifest is absent, stale, or invalid but the platform reports a real update, show safe generic copy and the locally defined platform action.
- Development, sideloaded, unpacked, and unsupported builds return `unknown` and show nothing unless an explicit E2E test double is enabled.

## Availability sources

One `UpdateAvailabilityAdapter` normalizes `{ status, currentVersion, availableVersion, action }`. `status` is `available`, `none`, or `unknown`; network/API failure is `unknown`, not `none`.

| Runtime | Authoritative signal | User action |
| --- | --- | --- |
| Chrome extension | `runtime.onUpdateAvailable`; when the manifest names a newer Chrome version, one deduplicated `runtime.requestUpdateCheck()` asks Chrome to confirm it. Chrome documents this as appropriate when a backend already knows the client is outdated. | `runtime.reload()` only after Chrome has reported the downloaded update as available. |
| Android | A small Capacitor plugin wraps Google Play Core `AppUpdateManager.appUpdateInfo`, including the available version code and allowed update mode. | Start the Play flexible update flow; complete and restart only through Play Core. Fall back to the compiled Play Store listing when Play Core says an update exists but cannot start the flow. |
| iOS | A small Capacitor plugin reads the installed version and queries Apple's App Store product metadata for `com.miden.bread`; a strictly greater App Store version is authoritative. There is no general StoreKit API that reports an App Store update for the current app. | Open the compiled App Store product URL. The manifest cannot replace it. |
| Tauri desktop | Tauri's signed updater `check()` result. Enabling this path includes updater artifacts, configured HTTPS endpoint(s), signature verification, and capability permissions. | `downloadAndInstall()` followed by a platform relaunch prompt. |
| Firefox, Safari extension, plain web | No implemented authoritative signal in this issue. | No card. Add a platform adapter only when its distribution channel is defined. |

The Chrome listener lives in the service worker so it survives popup lifetimes. It stores only the normalized result in extension local storage and notifies open wallet surfaces. Mobile and desktop adapters run on app foreground with a session-level single-flight and a six-hour successful-check cache. A manual foreground after an `unknown` result may retry after exponential backoff.

## Miden-owned release manifest

Check in `updates/manifest.json` as an append-only, schema-versioned catalog and fetch its raw `main` URL over HTTPS. CI validates it, and the release workflow requires a matching entry before publishing a release. The catalog keeps recent releases so staged stores can expose different versions at the same time.

Each release entry contains:

```json
{
  "version": "1.17.0",
  "summary": "Short plain-text fixes and improvements summary.",
  "urgency": "normal",
  "platforms": {
    "chrome": { "version": "1.17.0" },
    "android": { "version": "1.17.0", "versionCode": 11700001 },
    "ios": { "version": "1.17.0" },
    "desktop": { "version": "1.17.0" }
  }
}
```

The client accepts only schema-known fields, valid SemVer, a known urgency enum, bounded plain text, and exact platform/version matches. It renders text as text, never HTML. URLs, commands, action labels, and update modes remain compiled into the app. Invalid entries are ignored independently so one bad release cannot suppress older valid metadata.

## State and UI

- New `src/lib/update/` modules own schema validation, semantic comparison, platform adapters, caching, and dismissal persistence.
- `UpdateNotificationProvider` mounts beside the existing global notice providers. It waits for the normal initialized app surface, resolves availability, joins exact-version metadata, and renders `UpdateNotificationCard`.
- Persistence uses the existing cross-platform storage adapter under versioned keys. It stores no device identifier and sends no wallet/account data.
- The card is keyboard and screen-reader reachable, has an explicit dismiss control, reports install progress where the native API provides it, and surfaces a retryable local error if the user-initiated update action fails.
- Copy is added through i18n; the remote summary remains authored English release text for this first version and is labeled as release notes rather than silently machine-translated.

## Security and failure behavior

- Availability is platform-authoritative. The manifest supplies only summary and emphasis.
- A manifest compromise cannot select a URL, execute markup, force an update, or block wallet access.
- Tauri updates remain signature-verified by the updater plugin; signature verification cannot be disabled.
- Checks never delay wallet boot. Timeouts and malformed responses fail closed to no card unless an authoritative adapter already reported an update, in which case generic copy is used.
- The update action is always a user gesture. No background auto-install or forced restart.

## Verification

- Unit tests for SemVer comparison, schema validation, exact platform/build matching, dismissal scoping, stale metadata, `unknown` handling, and single-flight/cache behavior.
- Adapter contract tests for Chrome events/check throttling, Android Play states, iOS App Store responses, and Tauri signed-updater states.
- React tests for initialized-surface gating, generic fallback, emphasis, dismiss, retry, progress, and a later version reappearing.
- Native Android and iOS tests for bridge response mapping and store-opening fallbacks.
- E2E test doubles inject deterministic availability without contacting public stores, then verify the rendered card and action dispatch on extension, Android, iOS, and desktop builds.
- Fresh screenshots at supported widths and mobile safe-area/orientation states are required before claiming the UI complete.
- Run the repository's typecheck, lint, full Jest coverage gate, all affected native builds, and verify expected build artifacts before Review Council.

## Rollout

1. Land manifest schema, validator, adapter contract, storage, and generic card behind `MIDEN_UPDATE_NOTIFICATIONS`.
2. Add Chrome and mobile adapters, then Tauri's signed updater configuration and release artifacts.
3. Add the first real manifest entry only after every target has a published version to match.
4. Enable the flag after release-pipeline and store-sandbox verification. Unknown/unsupported platforms remain silent.

## References

- Chrome extension update lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle
- Google Play in-app updates: https://developer.android.com/guide/playcore/in-app-updates/kotlin-java
- Tauri updater: https://v2.tauri.app/plugin/updater/
