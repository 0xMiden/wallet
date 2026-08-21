/**
 * Deliberate-violation harness for the standing guarantees.
 *
 * Breaks one product promise at a time — plants an ATT key in `Info.plist`,
 * adds an analytics SDK to `package.json`, imports the telemetry barrel from
 * the service worker, flips the consent default — runs
 * `guarantees.test.ts` against it, and reports whether the guard caught it.
 * A guard that cannot fail manufactures confidence.
 *
 * Nothing is left on disk: every edited file is restored from an in-memory
 * copy, and every created file is deleted, before the next mutation runs.
 *
 * Usage: node scripts/telemetry-guarantee-mutations.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GUARD_TEST = 'src/lib/telemetry/guarantees.test.ts';

const PLIST = 'ios/App/App/Info.plist';
const PRIVACY = 'ios/App/App/PrivacyInfo.xcprivacy';
const APP_DELEGATE = 'ios/App/App/AppDelegate.swift';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const GRADLE = 'android/app/build.gradle';
const STRINGS = 'android/app/src/main/res/values/strings.xml';
const PACKAGE_JSON = 'package.json';
const LOCKFILE = 'yarn.lock';
const POPUP = 'popup.html';
const MOBILE = 'mobile.html';

const SINK = 'src/lib/telemetry/sink.ts';
const CRASH = 'src/lib/telemetry/crash.ts';
const CONTEXT = 'src/lib/telemetry/context.ts';
const SERIALIZE = 'src/lib/telemetry/serialize.ts';
const REPORT_FLOW = 'src/lib/telemetry/report-flow.ts';
const LEGACY = 'src/lib/telemetry/legacy-cleanup.ts';
const APTABASE = 'src/lib/telemetry/aptabase.ts';
const CONSTANTS = 'src/lib/settings/constants.ts';
const HELPERS = 'src/lib/settings/helpers.ts';
const ACTIONS = 'src/lib/miden/back/actions.ts';
const BACK_MAIN = 'src/lib/miden/back/main.ts';
const ERROR_BOUNDARY = 'src/app/ErrorBoundary.tsx';
const INDEX_TEST = 'src/lib/telemetry/index.test.ts';

const LEGACY_ANCHOR = `const LEGACY_ANALYTICS_KEY = 'analytics';`;
const WIRE_KEYS_ANCHOR = `export const WIRE_KEYS: readonly string[] = [
  'phase',`;
const withWireKey = key => ({
  file: SERIALIZE,
  find: WIRE_KEYS_ANCHOR,
  replace: `export const WIRE_KEYS: readonly string[] = [
  '${key}',
  'phase',`
});

/** Each entry: one broken promise, and the guard meant to notice. */
const MUTATIONS = [
  // -------------------------------------------------------------------------
  // No ATT prompt, no advertising identifier, no cross-app probing.
  // -------------------------------------------------------------------------
  {
    name: 'the ATT prompt string added to Info.plist',
    guards: 'never references NSUserTrackingUsageDescription / iOS permission prompts',
    edits: [
      {
        file: PLIST,
        find: `<key>NSFaceIDUsageDescription</key>`,
        replace: `<key>NSUserTrackingUsageDescription</key>
	<string>Bread uses your activity to improve the app.</string>
	<key>NSFaceIDUsageDescription</key>`
      }
    ]
  },
  {
    name: 'the AppTrackingTransparency framework imported in AppDelegate',
    guards: 'never references AppTrackingTransparency',
    edits: [{ file: APP_DELEGATE, find: `import Capacitor`, replace: `import AppTrackingTransparency\nimport Capacitor` }]
  },
  {
    name: 'ATTrackingManager asked for tracking authorization',
    guards: 'never references ATTrackingManager',
    edits: [
      {
        file: APP_DELEGATE,
        find: `        // Override point for customization after application launch.`,
        replace: `        ATTrackingManager.requestTrackingAuthorization { _ in }
        // Override point for customization after application launch.`
      }
    ]
  },
  {
    name: 'the IDFA read through ASIdentifierManager',
    guards: 'never references ASIdentifierManager / advertisingIdentifier',
    edits: [
      {
        file: APP_DELEGATE,
        find: `    var window: UIWindow?`,
        replace: `    let adId = ASIdentifierManager.shared().advertisingIdentifier
    var window: UIWindow?`
      }
    ]
  },
  {
    name: 'the AD_ID permission requested on Android',
    guards: 'never references the AD_ID permission / Android permissions',
    edits: [
      {
        file: MANIFEST,
        find: `    <uses-permission android:name="android.permission.VIBRATE" />`,
        replace: `    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="com.google.android.gms.permission.AD_ID" />`
      }
    ]
  },
  {
    name: 'the Google advertising-id library added to build.gradle',
    guards: 'never references play-services-ads',
    edits: [
      {
        file: GRADLE,
        find: `apply plugin: 'kotlin-android'`,
        replace: `apply plugin: 'kotlin-android'
dependencies { implementation 'com.google.android.gms:play-services-ads-identifier:18.0.1' }`
      }
    ]
  },
  {
    name: 'Firebase Analytics added to build.gradle',
    guards: 'never references firebase-analytics',
    edits: [
      {
        file: GRADLE,
        find: `apply plugin: 'kotlin-android'`,
        replace: `apply plugin: 'kotlin-android'
dependencies { implementation 'com.google.firebase:firebase-analytics:22.1.0' }`
      }
    ]
  },
  {
    name: 'AdvertisingIdClient wired in as manifest metadata',
    guards: 'never references AdvertisingIdClient',
    edits: [
      {
        file: MANIFEST,
        find: `        <provider`,
        replace: `        <meta-data android:name="com.google.android.gms.ads.AdvertisingIdClient" android:value="true" />

        <provider`
      }
    ]
  },
  {
    name: 'the IDFA acronym appearing in wallet source, inside an identifier and lowercased',
    guards: 'never references IDFA',
    edits: [{ file: LEGACY, find: LEGACY_ANCHOR, replace: `const IDFA_FALLBACK_KEY = 'idfa';\n${LEGACY_ANCHOR}` }]
  },
  {
    name: 'the AAID acronym hyphenated into a config key',
    guards: 'never references AAID',
    edits: [{ file: LEGACY, find: LEGACY_ANCHOR, replace: `const KEYS = ['device-aaid-cache'];\nvoid KEYS;\n${LEGACY_ANCHOR}` }]
  },
  {
    name: 'the GAID acronym appearing in an Android string resource',
    guards: 'never references GAID',
    edits: [
      {
        file: STRINGS,
        find: `<resources>`,
        replace: `<resources>\n    <string name="ad_id_label">GAID</string>`
      }
    ]
  },
  {
    name: 'the iOS privacy manifest flipped to declare tracking',
    guards: 'declares no tracking in the iOS privacy manifest',
    edits: [{ file: PRIVACY, find: `<key>NSPrivacyTracking</key>\n\t<false/>`, replace: `<key>NSPrivacyTracking</key>\n\t<true/>` }]
  },
  {
    name: 'a tracking domain declared in the iOS privacy manifest',
    guards: 'declares no tracking in the iOS privacy manifest',
    edits: [
      {
        file: PRIVACY,
        find: `<key>NSPrivacyTrackingDomains</key>\n\t<array/>`,
        replace: `<key>NSPrivacyTrackingDomains</key>\n\t<array><string>t.example-adtech.com</string></array>`
      }
    ]
  },
  {
    name: 'a collected data type flagged as used for tracking',
    guards: 'declares no tracking in the iOS privacy manifest',
    // The anchor used to be the empty `<array/>`, which stopped existing the
    // moment the manifest actually declared the two types the feature collects.
    // Flip a declared entry's tracking flag instead, which is both the realistic
    // mistake and an anchor that survives adding a third type.
    edits: [
      {
        file: PRIVACY,
        find: `			<string>NSPrivacyCollectedDataTypeProductInteraction</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<false/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>`,
        replace: `			<string>NSPrivacyCollectedDataTypeProductInteraction</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<false/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<true/>`
      }
    ]
  },
  {
    name: 'a permission prompt the token list has never heard of (location)',
    guards: 'iOS permission prompts',
    edits: [
      {
        file: PLIST,
        find: `<key>NSFaceIDUsageDescription</key>`,
        replace: `<key>NSLocationWhenInUseUsageDescription</key>
	<string>Bread uses your location to show nearby offers.</string>
	<key>NSFaceIDUsageDescription</key>`
      }
    ]
  },
  {
    name: 'a location permission the token list has never heard of (Android)',
    guards: 'Android permissions',
    edits: [
      {
        file: MANIFEST,
        find: `    <uses-permission android:name="android.permission.VIBRATE" />`,
        replace: `    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />`
      }
    ]
  },
  {
    name: 'the Android app-inventory probe widened past the wallets it deep-links to',
    guards: 'probes for no installed app beyond the wallets it deep-links to',
    edits: [
      {
        file: MANIFEST,
        find: `        <package android:name="org.toshi" />`,
        replace: `        <package android:name="org.toshi" />
        <package android:name="com.instagram.android" />`
      }
    ]
  },
  {
    name: 'the iOS app-inventory probe widened past the wallets it deep-links to',
    guards: 'probes for no installed app beyond the wallets it deep-links to',
    edits: [
      {
        file: PLIST,
        find: `		<string>cbwallet</string>`,
        replace: `		<string>cbwallet</string>\n\t\t<string>instagram</string>`
      }
    ]
  },
  {
    name: 'the SDK high-fidelity channel named, even set to false',
    guards: 'never opens the SDK high-fidelity observation channel',
    edits: [
      { file: LEGACY, find: LEGACY_ANCHOR, replace: `const SDK_OPTIONS = { observeSensitive: false };\n${LEGACY_ANCHOR}` }
    ]
  },

  // -------------------------------------------------------------------------
  // Nothing sold or shared with data brokers.
  // -------------------------------------------------------------------------
  {
    name: 'Segment declared as a dependency again',
    guards: 'no analytics SDK is declared',
    edits: [
      {
        file: PACKAGE_JSON,
        find: `    "@sentry/browser": "^10.70.0",`,
        replace: `    "@segment/analytics-node": "^2.2.1",\n    "@sentry/browser": "^10.70.0",`
      }
    ]
  },
  {
    name: 'Amplitude declared as a devDependency',
    guards: 'no analytics SDK is declared',
    edits: [
      { file: PACKAGE_JSON, find: `  "devDependencies": {`, replace: `  "devDependencies": {\n    "@amplitude/analytics-browser": "^2.11.0",` }
    ]
  },
  {
    name: 'a vendor telemetry binding declared',
    guards: 'no analytics SDK is declared',
    edits: [
      {
        file: PACKAGE_JSON,
        find: `    "@sentry/browser": "^10.70.0",`,
        replace: `    "@miden-sdk/telemetry-sentry": "^0.1.0",\n    "@sentry/browser": "^10.70.0",`
      }
    ]
  },
  {
    name: 'Mixpanel smuggled in through a resolutions override',
    guards: 'no analytics SDK is declared',
    edits: [{ file: PACKAGE_JSON, find: `  "resolutions": {`, replace: `  "resolutions": {\n    "**/mixpanel-browser": "2.55.0",` }]
  },
  {
    name: 'the Sentry dependency removed entirely (anti-vacuity: the pin is not one-directional)',
    guards: 'declares exactly one Sentry package',
    edits: [{ file: PACKAGE_JSON, find: `    "@sentry/browser": "^10.70.0",\n`, replace: `` }]
  },
  {
    name: 'Sentry session replay imported',
    guards: 'no analytics SDK is imported / imports only @sentry/browser',
    edits: [
      {
        file: REPORT_FLOW,
        find: `import { nanoid } from 'nanoid';`,
        replace: `import { replayIntegration } from '@sentry/replay';\nimport { nanoid } from 'nanoid';\nvoid replayIntegration;`
      }
    ]
  },
  {
    name: 'PostHog imported by a page',
    guards: 'no analytics SDK is imported',
    edits: [
      {
        file: ERROR_BOUNDARY,
        find: `import { captureCrash } from 'lib/telemetry/crash';`,
        replace: `import posthog from 'posthog-js';\n\nimport { captureCrash } from 'lib/telemetry/crash';\nvoid posthog;`
      }
    ]
  },
  {
    name: 'FullStory imported by a test file (tests are scanned too)',
    guards: 'no analytics SDK is imported',
    edits: [
      {
        file: INDEX_TEST,
        find: `import { clearLegacyAnalyticsStorage } from './legacy-cleanup';`,
        replace: `import * as FullStory from '@fullstory/browser';\n\nimport { clearLegacyAnalyticsStorage } from './legacy-cleanup';\nvoid FullStory;`
      }
    ]
  },
  {
    name: 'Datadog RUM pulled in through a dynamic import',
    guards: 'no analytics SDK is imported (dynamic form)',
    edits: [
      {
        file: ERROR_BOUNDARY,
        find: `import { captureCrash } from 'lib/telemetry/crash';`,
        replace: `import { captureCrash } from 'lib/telemetry/crash';\nvoid import('@datadog/browser-rum');`
      }
    ]
  },
  {
    name: 'LogRocket pulled in through require()',
    guards: 'no analytics SDK is imported (require form)',
    edits: [
      {
        file: ERROR_BOUNDARY,
        find: `import { captureCrash } from 'lib/telemetry/crash';`,
        replace: `import { captureCrash } from 'lib/telemetry/crash';\nvoid require('logrocket');`
      }
    ]
  },
  {
    name: 'Segment arriving in the lockfile as a transitive dependency',
    guards: 'no analytics SDK is resolved in yarn.lock',
    edits: [
      {
        file: LOCKFILE,
        find: `"@sentry/browser@^10.70.0":`,
        replace: `"@segment/analytics-node@^2.2.1":\n  version "2.2.1"\n\n"@sentry/browser@^10.70.0":`
      }
    ]
  },
  {
    name: 'Amplitude arriving in the lockfile as a transitive dependency',
    guards: 'no analytics SDK is resolved in yarn.lock',
    edits: [
      {
        file: LOCKFILE,
        find: `"@sentry/browser@^10.70.0":`,
        replace: `"@amplitude/analytics-core@^2.5.0":\n  version "2.5.0"\n\n"@sentry/browser@^10.70.0":`
      }
    ]
  },
  {
    name: 'an eighth Sentry package resolved by an upgrade',
    guards: 'the reviewed transitive Sentry set',
    edits: [
      {
        file: LOCKFILE,
        find: `"@sentry/browser@^10.70.0":`,
        replace: `"@sentry/opentelemetry@10.70.0":\n  version "10.70.0"\n\n"@sentry/browser@^10.70.0":`
      }
    ]
  },

  // -------------------------------------------------------------------------
  // No persistent identifier.
  // -------------------------------------------------------------------------
  {
    name: 'the sink writing a value to localStorage',
    guards: 'the telemetry module writes nothing durable',
    edits: [
      {
        file: SINK,
        find: `export function dropQueue(): void {`,
        replace: `export function rememberInstall(id: string): void {\n  localStorage.setItem('telemetry_install_id', id);\n}\n\nexport function dropQueue(): void {`
      }
    ]
  },
  {
    name: 'the context module writing to chrome.storage',
    guards: 'the telemetry module writes nothing durable',
    edits: [
      {
        file: CONTEXT,
        find: `function resolvePlatform(): TelemetryPlatform {`,
        replace: `void chrome.storage.local.set({ telemetry_client_id: 'stable' });\n\nfunction resolvePlatform(): TelemetryPlatform {`
      }
    ]
  },
  {
    name: 'the sink reaching the cross-platform KV store',
    guards: 'the telemetry module writes nothing durable',
    edits: [
      {
        file: SINK,
        find: `export function dropQueue(): void {`,
        replace: `export function rememberInstall(id: string): void {\n  void getStorageProvider().set({ telemetry_install_id: id });\n}\n\nexport function dropQueue(): void {`
      }
    ]
  },
  {
    name: 'a cookie written from the crash reporter',
    guards: 'the telemetry module writes nothing durable',
    edits: [
      {
        file: CRASH,
        find: `export function captureCrash(error: unknown): void {`,
        replace: `export function tagSession(id: string): void {\n  document.cookie = \`telemetry_session=\${id}\`;\n}\n\nexport function captureCrash(error: unknown): void {`
      }
    ]
  },
  {
    name: 'a second telemetry module minting an identifier',
    guards: 'mints an identifier in exactly one telemetry module',
    edits: [
      {
        file: CRASH,
        find: `import wordlist from 'bip39/src/wordlists/english.json';`,
        replace: `import wordlist from 'bip39/src/wordlists/english.json';\nimport { nanoid } from 'nanoid';\n\nexport const CRASH_SESSION = nanoid();`
      }
    ]
  },
  {
    name: 'an identifier minted from crypto.randomUUID instead of a package',
    guards: 'mints an identifier in exactly one telemetry module',
    edits: [
      {
        file: CONTEXT,
        find: `function resolvePlatform(): TelemetryPlatform {`,
        replace: `export const CLIENT_ID = crypto.randomUUID();\n\nfunction resolvePlatform(): TelemetryPlatform {`
      }
    ]
  },
  {
    name: 'the flow-id minter removed (anti-vacuity: the positive control)',
    guards: 'mints an identifier in exactly one telemetry module',
    edits: [{ file: REPORT_FLOW, find: `import { nanoid } from 'nanoid';\n`, replace: `` }]
  },
  { name: 'a userId field added to the wire payload', guards: 'no wire field naming a person', edits: [withWireKey('userId')] },
  {
    name: 'a deviceId field added to the wire payload',
    guards: 'no wire field naming a device',
    edits: [withWireKey('deviceId')]
  },
  {
    name: 'an anonymousId field added to the wire payload',
    guards: 'no wire field naming a person',
    edits: [withWireKey('anonymousId')]
  },
  {
    name: 'the deleted analytics scaffold recreated',
    guards: 'has not resurrected the deleted analytics scaffold',
    edits: [
      {
        file: 'src/lib/analytics/index.ts',
        create: `import { nanoid } from 'nanoid';

const KEY = 'analytics';

export function getUserId(): string {
  const stored = localStorage.getItem(KEY);
  if (stored !== null) return stored;
  const minted = nanoid();
  localStorage.setItem(KEY, minted);
  return minted;
}
`
      }
    ]
  },

  // -------------------------------------------------------------------------
  // The service worker loads telemetry by deep path only.
  // -------------------------------------------------------------------------
  {
    name: 'the barrel imported for side effects by a background module',
    guards: 'imports lib/telemetry from nowhere in the graph',
    edits: [{ file: ACTIONS, find: `import { sendEvent } from 'lib/telemetry/sink';`, replace: `import 'lib/telemetry';\nimport { sendEvent } from 'lib/telemetry/sink';` }]
  },
  {
    name: 'the background switched from the deep sink path to the barrel',
    guards: 'imports lib/telemetry from nowhere in the graph',
    edits: [
      {
        file: ACTIONS,
        find: `import { sendEvent } from 'lib/telemetry/sink';`,
        replace: `import { beginFlow } from 'lib/telemetry';\nimport { sendEvent } from 'lib/telemetry/sink';\nvoid beginFlow;`
      }
    ]
  },
  {
    name: 'the barrel imported from deeper in the worker graph',
    guards: 'imports lib/telemetry from nowhere in the graph',
    edits: [
      {
        file: BACK_MAIN,
        find: `import { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';`,
        replace: `import { classifyError } from 'lib/telemetry';\nimport { WalletMessageType, WalletRequest, WalletResponse } from 'lib/shared/types';\nvoid classifyError;`
      }
    ]
  },
  {
    name: 'the crash reporter pulled into the service worker by deep path',
    guards: 'reaches only the telemetry modules a worker can load',
    edits: [
      {
        file: ACTIONS,
        find: `import { sendEvent } from 'lib/telemetry/sink';`,
        replace: `import { captureCrash } from 'lib/telemetry/crash';\nimport { sendEvent } from 'lib/telemetry/sink';\nvoid captureCrash;`
      }
    ]
  },
  {
    name: 'the worker stopping short of the sink (anti-vacuity: the graph walk)',
    guards: 'walks a graph that reaches the background telemetry code',
    edits: [
      {
        file: ACTIONS,
        find: `import { sendEvent } from 'lib/telemetry/sink';`,
        replace: `const sendEvent = async (..._args: unknown[]): Promise<void> => undefined;`
      }
    ]
  },
  {
    name: 'the barrel imported TYPE-ONLY by a background module',
    guards: 'imports lib/telemetry from nowhere in the graph',
    // TypeScript erases a type-only import outright: no `require`, no module in
    // the worker bundle, no React. The guard walks runtime edges and is right
    // to ignore this one.
    equivalent: 'a type-only import pulls in no runtime module',
    edits: [
      {
        file: ACTIONS,
        find: `import { sendEvent } from 'lib/telemetry/sink';`,
        replace: `import type { FlowHandle } from 'lib/telemetry';\nimport { sendEvent } from 'lib/telemetry/sink';\nexport type { FlowHandle };`
      }
    ]
  },

  // -------------------------------------------------------------------------
  // Off by default, opt-in.
  // -------------------------------------------------------------------------
  {
    name: 'the default flipped on',
    guards: 'defaults to off / sends nothing on a fresh install',
    edits: [{ file: CONSTANTS, find: `export const DEFAULT_TELEMETRY = false;`, replace: `export const DEFAULT_TELEMETRY = true;` }]
  },
  {
    name: 'the background read-miss failing OPEN while the constant stays false',
    guards: 'sends nothing at either egress point on a fresh install',
    // The constant assertion cannot see this one. Only running the real
    // settings module against empty storage can.
    edits: [
      {
        file: HELPERS,
        find: `  if (!(await readMirroredSetting(TELEMETRY_STORAGE_KEY, DEFAULT_TELEMETRY))) return false;`,
        replace: `  if (!(await readMirroredSetting(TELEMETRY_STORAGE_KEY, true))) return false;`
      }
    ]
  },
  {
    name: 'the consent gate removed from sendEvent',
    guards: 'sends nothing at either egress point on a fresh install',
    edits: [{ file: SINK, find: `    if (!(await isTelemetryEnabledAsync())) return;`, replace: `    await isTelemetryEnabledAsync();` }]
  },
  {
    name: 'the consent gate removed from captureCrash',
    guards: 'sends nothing at either egress point on a fresh install',
    edits: [
      { file: CRASH, find: `      if (!(await isTelemetryEnabledAsync())) return;`, replace: `      await isTelemetryEnabledAsync();` }
    ]
  },
  {
    name: 'both egress points silenced (anti-vacuity: the silence must be the gate)',
    guards: 'sends at both once consent is stored',
    edits: [
      { file: SINK, find: `    await transport(payload);`, replace: `    void transport;` },
      { file: CRASH, find: `      target.captureException(reportable);`, replace: `      void target;\n      void reportable;` }
    ]
  },

  // -------------------------------------------------------------------------
  // No stray egress.
  // -------------------------------------------------------------------------
  {
    name: 'a fetch added to the context module',
    guards: 'every network call in the telemetry module comes from the sink',
    edits: [
      {
        file: CONTEXT,
        find: `function resolvePlatform(): TelemetryPlatform {`,
        // Never called, so only the static guard can notice it — a fetch at
        // module scope would take the suite down on import and score a kill
        // that proves nothing about the guard.
        replace: `function ping(): void {\n  void fetch('https://example.com/collect');\n}\nvoid ping;\n\nfunction resolvePlatform(): TelemetryPlatform {`
      }
    ]
  },
  {
    name: 'a second endpoint mirrored from inside the sink itself',
    guards: 'exactly one fetch call in the sink',
    edits: [
      {
        file: SINK,
        find: `  await fetch(endpoint.url, {`,
        replace: `  await fetch('https://mirror.example.com/collect', { method: 'POST', body: JSON.stringify(payload) });\n  await fetch(endpoint.url, {`
      }
    ]
  },
  {
    name: 'a sendBeacon added to the flow reporter',
    guards: 'every network call comes from the sink / no fire-and-forget beacon',
    edits: [
      {
        file: REPORT_FLOW,
        find: `function report(event: TelemetryEvent): void {`,
        replace: `function report(event: TelemetryEvent): void {\n  navigator.sendBeacon('https://example.com/collect', JSON.stringify(event));`
      }
    ]
  },
  {
    name: 'a sendBeacon added outside the telemetry module entirely',
    guards: 'no fire-and-forget beacon anywhere in the wallet',
    edits: [
      {
        file: ERROR_BOUNDARY,
        find: `import { captureCrash } from 'lib/telemetry/crash';`,
        replace: `import { captureCrash } from 'lib/telemetry/crash';\nvoid navigator.sendBeacon('https://example.com/collect');`
      }
    ]
  },
  {
    name: 'a WebSocket opened from the crash reporter',
    guards: 'every network call in the telemetry module comes from the sink',
    edits: [
      {
        file: CRASH,
        find: `export function captureCrash(error: unknown): void {`,
        replace: `export const liveChannel = new WebSocket('wss://example.com/crashes');\n\nexport function captureCrash(error: unknown): void {`
      }
    ]
  },
  {
    name: 'axios imported into the sink',
    guards: 'every network call in the telemetry module comes from the sink',
    edits: [
      {
        file: SINK,
        find: `import { isTelemetryEnabledAsync } from 'lib/settings/helpers';`,
        replace: `import axios from 'axios';\n\nimport { isTelemetryEnabledAsync } from 'lib/settings/helpers';\nvoid axios;`
      }
    ]
  },
  {
    name: 'the Aptabase app key read from a second shipped file',
    guards: 'reads APTABASE_APP_KEY in exactly one shipped file',
    edits: [
      { file: LEGACY, find: LEGACY_ANCHOR, replace: `const KEY = process.env.APTABASE_APP_KEY;\nvoid KEY;\n${LEGACY_ANCHOR}` }
    ]
  },
  {
    name: 'the Aptabase host read from a second shipped file',
    guards: 'reads APTABASE_HOST in exactly one shipped file',
    edits: [
      { file: LEGACY, find: LEGACY_ANCHOR, replace: `const HOST = process.env.APTABASE_HOST;\nvoid HOST;\n${LEGACY_ANCHOR}` }
    ]
  },
  {
    name: 'a durable identity field added to the Aptabase envelope',
    guards: 'no Aptabase envelope field that could name a person, a device, or an install',
    edits: [
      {
        file: APTABASE,
        find: `export const APTABASE_SYSTEM_PROP_KEYS: readonly string[] = ['isDebug', 'osName', 'appVersion', 'sdkVersion'];`,
        replace: `export const APTABASE_SYSTEM_PROP_KEYS: readonly string[] = ['isDebug', 'osName', 'appVersion', 'sdkVersion', 'deviceId'];`
      }
    ]
  },
  {
    name: 'the fingerprint-capable telemetry module reaching for a locale',
    guards: 'cannot compute an operating-system version, a locale, or a device model',
    edits: [
      {
        file: APTABASE,
        find: `      osName: payload.platform,`,
        replace: `      osName: payload.platform,\n      locale: navigator.language,`
      }
    ]
  },
  {
    name: 'the Sentry DSN read from a second shipped file',
    guards: 'reads SENTRY_DSN in exactly one shipped file',
    edits: [{ file: LEGACY, find: LEGACY_ANCHOR, replace: `const DSN = process.env.SENTRY_DSN;\nvoid DSN;\n${LEGACY_ANCHOR}` }]
  },
  {
    name: 'a Google Tag Manager script added to the popup document',
    guards: 'no unreviewed third-party resource in an HTML entry document',
    edits: [
      {
        file: POPUP,
        find: `    <script type="module" src="/src/popup.tsx"></script>`,
        replace: `    <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXX"></script>
    <script type="module" src="/src/popup.tsx"></script>`
      }
    ]
  },
  {
    name: 'a tracking pixel added to the mobile document',
    guards: 'no unreviewed third-party resource in an HTML entry document',
    edits: [
      {
        file: MOBILE,
        find: `    <script type="module" src="/src/mobile-app.tsx"></script>`,
        replace: `    <img src="https://px.example-adtech.com/p.gif" width="1" height="1" />
    <script type="module" src="/src/mobile-app.tsx"></script>`
      }
    ]
  },

  // -------------------------------------------------------------------------
  // The guard's own defences against reading nothing.
  // -------------------------------------------------------------------------
  {
    name: 'the source scan narrowed to a leaf directory (self-sabotage)',
    guards: 'reads the tree it claims to read',
    edits: [
      {
        file: GUARD_TEST,
        find: `cachedSrc ??= scan('src', WEB_EXTENSIONS)`,
        replace: `cachedSrc ??= scan('src/lib/telemetry', WEB_EXTENSIONS)`
      }
    ]
  },
  {
    name: 'the import parser broken so it matches nothing (self-sabotage)',
    guards: 'extracts package names it knows are present',
    edits: [{ file: GUARD_TEST, find: `const FROM_CLAUSE = /(?:`, replace: `const FROM_CLAUSE = /$^/g;\nconst UNUSED_CLAUSE = /(?:` }]
  }
];

// ---------------------------------------------------------------------------

function apply(edit, restorers) {
  const path = resolve(ROOT, edit.file);

  if (edit.create !== undefined) {
    if (existsSync(path)) throw new Error(`${edit.file} already exists; the mutation would not create it`);
    const directory = dirname(path);
    const directoryExisted = existsSync(directory);
    if (!directoryExisted) mkdirSync(directory, { recursive: true });
    writeFileSync(path, edit.create);
    restorers.push(() => {
      rmSync(path, { force: true });
      if (!directoryExisted) rmSync(directory, { recursive: true, force: true });
    });
    return;
  }

  const original = readFileSync(path, 'utf8');
  restorers.push(() => writeFileSync(path, original));
  if (!original.includes(edit.find)) throw new Error(`anchor not found in ${edit.file}:\n${edit.find}`);
  writeFileSync(path, original.replace(edit.find, edit.replace));
}

function runGuard() {
  try {
    execFileSync('node', ['node_modules/.bin/jest', GUARD_TEST], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    return { failed: false, output: '' };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const failingTests = output => [
  ...new Set([...output.matchAll(/●\s+(.+?)\s+›\s+(.+)/g)].map(match => `${match[1]} › ${match[2]}`.trim()))
];

// A red baseline reports every mutation as killed, which is the one way this
// harness could claim a perfect score while proving nothing.
const baseline = runGuard();
if (baseline.failed) {
  console.error('BASELINE IS RED — every mutation below would report as killed for the wrong reason.');
  console.error(baseline.output);
  process.exit(1);
}
console.log('baseline: green\n');

let killed = 0;
let survived = 0;
let equivalent = 0;
let broken = 0;

for (const [index, mutation] of MUTATIONS.entries()) {
  const restorers = [];
  const label = `${String(index + 1).padStart(2, '0')}. ${mutation.name}`;
  let result;
  try {
    for (const edit of mutation.edits) apply(edit, restorers);
    result = runGuard();
  } catch (error) {
    broken++;
    console.log(`BROKEN  ${label}\n        ${error.message.split('\n')[0]}`);
    continue;
  } finally {
    for (const restore of restorers.reverse()) restore();
  }

  if (result.failed) {
    killed++;
    console.log(`KILLED  ${label}\n        tripped: ${failingTests(result.output).join('; ')}`);
  } else if (mutation.equivalent) {
    equivalent++;
    console.log(`EQUIVALENT ${label}\n        ${mutation.equivalent}`);
  } else {
    survived++;
    console.log(`SURVIVED ${label}\n        guard that should have caught it: ${mutation.guards}`);
  }
}

console.log(
  `\n${killed} killed, ${equivalent} equivalent, ${survived} survived, ${broken} broken anchors, ${MUTATIONS.length} total`
);

// A leftover mutation would silently poison every later run.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(line => line.length > 0 && !line.includes('scripts/telemetry-guarantee-mutations.mjs') && !line.includes(GUARD_TEST));
if (dirty.length > 0) {
  console.error(`\nTREE NOT RESTORED:\n${dirty.join('\n')}`);
  process.exit(1);
}

process.exit(survived === 0 && broken === 0 ? 0 : 1);
