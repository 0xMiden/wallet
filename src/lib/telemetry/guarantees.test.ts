import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { getStorageProvider } from 'lib/platform/storage-adapter';
import { DEFAULT_TELEMETRY, TELEMETRY_STORAGE_KEY } from 'lib/settings/constants';

import { resolveTelemetryContext } from './context';
import { captureCrash, initCrashReporting, stopCrashReporting } from './crash';
import { WIRE_KEYS } from './serialize';
import { sendEvent } from './sink';

/**
 * The standing guarantees.
 *
 * Every other test in this module asserts that the code behaves. These assert
 * that the *product promises* stay true as the tree changes — so the change
 * that breaks one fails the build instead of shipping. They read the
 * repository itself: `package.json`, `yarn.lock`, the iOS and Android
 * projects, the HTML entry documents, and the import graph of `src`.
 *
 * The promises, and where each one is asserted:
 *
 * - No cross-app or cross-site tracking, ever — `no App Tracking Transparency,
 *   and no advertising identifier`, plus the third-party-origin assertion in
 *   `no stray egress`.
 * - No advertising identifier and no ATT prompt — `no App Tracking
 *   Transparency, and no advertising identifier`.
 * - Nothing sold or shared with data brokers — `no analytics, tracking, or
 *   advertising SDK`, at all three dependency levels.
 * - No persistent user identifier — `no persistent identifier`.
 * - Off by default and opt-in — `telemetry is off until the user turns it on`.
 * - One product-event egress point and one crash egress point — `no stray
 *   egress`, alongside `egress-boundary.test.ts`.
 *
 * Two rules this file holds itself to:
 *
 * 1. **It must not restate `egress-boundary.test.ts`.** That file asserts what
 *    leaves at the two boundaries, over the real wire, and which *files* may
 *    import `sendEvent` and `@sentry/*`. This file asserts things that live
 *    outside a running payload: native project config, the dependency tree at
 *    three separate levels, the service-worker import graph, and the shape of
 *    the fresh-install default. Two guards for one property that drift apart
 *    are worse than one guard.
 *
 * 2. **A guard that reads nothing must fail, not pass.** Every absence
 *    assertion below is trivially satisfiable by scanning an empty file list,
 *    so `the guard reads the tree it claims to read` puts a floor under each
 *    scan and a positive control on each extractor. Without those, a renamed
 *    directory turns this whole file green and silent.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Reading the tree.
// ---------------------------------------------------------------------------

/** Build output and tool caches. Everything else under a scanned root is read. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.gradle',
  '.idea',
  'DerivedData',
  'Pods',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'xcuserdata'
]);

interface ScannedFile {
  /** Repo-relative and forward-slashed, so a failure message is copy-pasteable. */
  path: string;
  text: string;
  lines: readonly string[];
}

function readScanned(absolute: string): ScannedFile {
  const text = readFileSync(absolute, 'utf8');
  return { path: relative(REPO_ROOT, absolute).split(sep).join('/'), text, lines: text.split('\n') };
}

/**
 * Every file under `root` with one of `extensions`.
 *
 * Throws rather than returning `[]` when the root is gone: a scan over a
 * directory that is not there satisfies every absence assertion in this file
 * without reading a byte, which is the exact way a guard rots into decoration.
 */
function scan(root: string, extensions: readonly string[]): ScannedFile[] {
  const absolute = resolve(REPO_ROOT, root);
  if (!existsSync(absolute)) {
    throw new Error(
      `guarantees.test.ts scans "${root}", which no longer exists. Point the guard at the new path — do not delete it.`
    );
  }
  if (statSync(absolute).isFile()) return [readScanned(absolute)];

  const collected: ScannedFile[] = [];
  const pending = [absolute];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (extensions.some(extension => entry.name.endsWith(extension))) collected.push(readScanned(child));
    }
  }
  return collected;
}

/** Anywhere outside TypeScript that a tracking declaration can live. */
const NATIVE_EXTENSIONS = [
  '.entitlements',
  '.gradle',
  '.h',
  '.java',
  '.json',
  '.kt',
  '.m',
  '.pbxproj',
  '.plist',
  '.pro',
  '.properties',
  '.swift',
  '.xcconfig',
  '.xcprivacy',
  '.xml'
];

const WEB_EXTENSIONS = ['.js', '.ts', '.tsx'];

const isTestFile = (file: ScannedFile): boolean => /\.(test|spec)\.(ts|tsx|js)$/.test(file.path);

/**
 * This file names every forbidden token as a string literal, so scanning it
 * reports the guard itself as the violation. Excluded by exact path rather
 * than by a pattern: rename the file and the exclusion stops applying, which
 * fails loudly instead of quietly widening into "test files are exempt".
 */
const GUARD_FILE = 'src/lib/telemetry/guarantees.test.ts';

let cachedSrc: ScannedFile[] | undefined;
/** Every file in `src`, tests included — a forbidden SDK is forbidden in a test too. */
function srcFiles(): ScannedFile[] {
  cachedSrc ??= scan('src', WEB_EXTENSIONS).filter(file => file.path !== GUARD_FILE);
  return cachedSrc;
}

/** Only what ships. Test files legitimately name env vars and endpoints. */
const shippedFiles = (): ScannedFile[] => srcFiles().filter(file => !isTestFile(file));

const telemetryFiles = (): ScannedFile[] => shippedFiles().filter(file => file.path.startsWith('src/lib/telemetry/'));

let cachedTrackingSurface: ScannedFile[] | undefined;
/** The native projects, the Capacitor config, and the whole web source. */
function trackingSurface(): ScannedFile[] {
  cachedTrackingSurface ??= [
    ...scan('ios', NATIVE_EXTENSIONS),
    ...scan('android', NATIVE_EXTENSIONS),
    ...scan('capacitor.config.ts', WEB_EXTENSIONS),
    ...srcFiles()
  ];
  return cachedTrackingSurface;
}

let cachedHtml: ScannedFile[] | undefined;
/** The entry documents the extension, the mobile WebView and the desktop shell load. */
function htmlDocuments(): ScannedFile[] {
  cachedHtml ??= [
    ...readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
      .map(entry => readScanned(join(REPO_ROOT, entry.name))),
    ...scan('public', ['.html'])
  ];
  return cachedHtml;
}

interface Hit {
  file: string;
  line: number;
}

/** Line-by-line, so a failure names the line. Patterns must not carry the `g` flag. */
function matches(files: readonly ScannedFile[], pattern: RegExp): Hit[] {
  const found: Hit[] = [];
  for (const file of files) {
    file.lines.forEach((line, index) => {
      if (pattern.test(line)) found.push({ file: file.path, line: index + 1 });
    });
  }
  return found;
}

const at = (hit: Hit): string => `${hit.file}:${hit.line}`;

// ---------------------------------------------------------------------------
// Reading imports.
// ---------------------------------------------------------------------------

/**
 * The clause between `import`/`export` and `from` may not contain a quote, a
 * semicolon, a paren or an `=`. That is what stops the match running out of an
 * import statement and into an unrelated `t('…')` call further down the file —
 * the failure mode of the obvious `[\s\S]*?` version, which happily reports
 * `'this receipt was already settled'` as a package name.
 */
const FROM_CLAUSE = /(?:^|[\n;])[ \t]*(?:import|export)[ \t]+([^'";()=]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])[ \t]*import[ \t]*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;
const REQUIRE_CALL = /\brequire[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g;

interface Specifier {
  value: string;
  /** `import type … from` is erased by TypeScript and pulls in no runtime module. */
  typeOnly: boolean;
}

function specifiersOf(text: string): Specifier[] {
  const found: Specifier[] = [];
  for (const match of text.matchAll(FROM_CLAUSE)) {
    const clause = match[1];
    const value = match[2];
    if (clause === undefined || value === undefined) continue;
    found.push({ value, typeOnly: /^type\s/.test(clause) });
  }
  for (const pattern of [SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) found.push({ value, typeOnly: false });
    }
  }
  return found;
}

/** `baseUrl: "src"` in tsconfig.json makes each of these a bare-looking internal import. */
const ALIAS_ROOTS = ['app', 'components', 'lib', 'screens', 'shared', 'utils', 'workers'];

const isInternal = (specifier: string): boolean =>
  specifier.startsWith('.') || ALIAS_ROOTS.some(root => specifier === root || specifier.startsWith(`${root}/`));

/** `@scope/name/deep/path` → `@scope/name`; `name/deep/path` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

let cachedImports: Map<string, Set<string>> | undefined;
/** Every npm package `src` imports, mapped to the files importing it. */
function importedPackages(): Map<string, Set<string>> {
  if (cachedImports === undefined) {
    const imported = new Map<string, Set<string>>();
    for (const file of srcFiles()) {
      for (const specifier of specifiersOf(file.text)) {
        if (isInternal(specifier.value)) continue;
        const name = packageOf(specifier.value);
        const importers = imported.get(name) ?? new Set<string>();
        importers.add(file.path);
        imported.set(name, importers);
      }
    }
    cachedImports = imported;
  }
  return cachedImports;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  resolutions?: Record<string, string>;
}

function manifest(): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('package.json is not a JSON object');
  return parsed;
}

/** Every package name the manifest names, including through a `resolutions` override. */
function declaredPackages(): string[] {
  const { dependencies, devDependencies, optionalDependencies, peerDependencies, resolutions } = manifest();
  const named = [
    ...Object.keys(dependencies ?? {}),
    ...Object.keys(devDependencies ?? {}),
    ...Object.keys(optionalDependencies ?? {}),
    ...Object.keys(peerDependencies ?? {}),
    // `"**/lodash": "^4.18.0"` pins a transitive package by name.
    ...Object.keys(resolutions ?? {}).map(key => key.replace(/^\*\*\//, ''))
  ];
  return [...new Set(named)].sort();
}

let cachedLockfile: Set<string> | undefined;
/** Every package in `yarn.lock`, at any depth — declared and transitive alike. */
function lockfilePackages(): Set<string> {
  if (cachedLockfile === undefined) {
    const names = new Set<string>();
    for (const line of readFileSync(resolve(REPO_ROOT, 'yarn.lock'), 'utf8').split('\n')) {
      // A yarn v1 entry header starts at column zero and ends in a colon;
      // everything else in the file is indented or a comment.
      if (line.length === 0 || /^[\s#]/.test(line) || !line.endsWith(':')) continue;
      for (const descriptor of line.slice(0, -1).split(',')) {
        const cleaned = descriptor.trim().replace(/^"/, '').replace(/"$/, '');
        // `name@range`, where a scoped name carries a leading `@` of its own.
        const separator = cleaned.lastIndexOf('@');
        if (separator > 0) names.add(cleaned.slice(0, separator));
      }
    }
    cachedLockfile = names;
  }
  return cachedLockfile;
}

// ---------------------------------------------------------------------------

describe('the guard reads the tree it claims to read', () => {
  // Each floor is far below the real count and far above zero, so it survives
  // ordinary growth and fails the moment a scan silently stops finding files.
  it.each([
    ['the iOS and Android projects plus the web source', (): number => trackingSurface().length, 500],
    ['the wallet source tree', (): number => srcFiles().length, 500],
    ['the shipped (non-test) source', (): number => shippedFiles().length, 300],
    ['the telemetry module', (): number => telemetryFiles().length, 8],
    ['the HTML entry documents', (): number => htmlDocuments().length, 8],
    ['the lockfile', (): number => lockfilePackages().size, 500],
    ['the manifest', (): number => declaredPackages().length, 100],
    ['the import graph of src', (): number => importedPackages().size, 40]
  ])('reads %s', (_what, count, floor) => {
    expect(count()).toBeGreaterThanOrEqual(floor);
  });

  it('matches a string it knows is present, so a broken scanner cannot read as a clean tree', () => {
    // If this stops finding the Face ID prompt, every "token is absent"
    // assertion below has stopped meaning anything.
    expect(matches(trackingSurface(), /NSFaceIDUsageDescription/).map(hit => hit.file)).toEqual([
      'ios/App/App/Info.plist'
    ]);
  });

  it('extracts package names it knows are present, so a broken parser cannot read as a clean tree', () => {
    expect(declaredPackages()).toContain('@sentry/browser');
    expect(lockfilePackages().has('@sentry/browser')).toBe(true);
    expect([...(importedPackages().get('@sentry/browser') ?? [])]).toEqual(['src/lib/telemetry/crash.ts']);
  });
});

// ---------------------------------------------------------------------------
// Promise: no cross-app tracking, no advertising identifier, no ATT prompt.
// ---------------------------------------------------------------------------

interface ForbiddenToken {
  label: string;
  pattern: RegExp;
  why: string;
}

/**
 * A distinctive name, matched case-insensitively anywhere it appears. Each is
 * long enough that an accidental match is not a thing that happens — unlike a
 * bare `ATT` or `analytics`, which hit `attempt`, `attribute` and every
 * sentence in the CHANGELOG.
 */
const named = (token: string): RegExp => new RegExp(token.replace(/\./g, '\\.'), 'i');

/**
 * An acronym as a word *inside* an identifier.
 *
 * `\b` is not enough here: it treats `_` as a word character, so `\bIDFA\b`
 * reads straight past `IDFA_FALLBACK_KEY` — which is how a real one would be
 * spelled. Requiring a non-alphanumeric neighbour instead catches
 * `IDFA_KEY`, `ad-idfa-value` and `'idfa'`, while still refusing to fire
 * inside a contiguous base64, hex or pbxproj run, where every neighbour is
 * alphanumeric. That last part is what keeps a four-letter pattern from
 * becoming the guard that matched `AI` inside `regain`, `pairing` and `again`.
 */
const acronym = (token: string): RegExp => new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, 'i');

const ADVERTISING_TOKENS: readonly ForbiddenToken[] = [
  {
    label: 'NSUserTrackingUsageDescription',
    pattern: named('NSUserTrackingUsageDescription'),
    why: 'the Info.plist key whose mere presence is what makes iOS show the App Tracking Transparency prompt'
  },
  {
    label: 'AppTrackingTransparency',
    pattern: named('AppTrackingTransparency'),
    why: 'the iOS framework that exists only to request permission to track across apps'
  },
  { label: 'ATTrackingManager', pattern: named('ATTrackingManager'), why: 'the API that raises the ATT prompt' },
  {
    label: 'ASIdentifierManager',
    pattern: named('ASIdentifierManager'),
    why: 'the iOS class that vends the advertising identifier'
  },
  {
    label: 'advertisingIdentifier',
    pattern: named('advertisingIdentifier'),
    why: 'the IDFA itself — a cross-app identifier the wallet has promised never to read'
  },
  {
    label: 'identifierForVendor',
    pattern: named('identifierForVendor'),
    why: 'the IDFV — install-scoped, but still a durable identifier the wallet has no reason to hold'
  },
  {
    label: 'AdvertisingIdClient',
    pattern: named('AdvertisingIdClient'),
    why: 'the Google Play Services class that vends the Android advertising id'
  },
  {
    label: 'getAdvertisingIdInfo',
    pattern: named('getAdvertisingIdInfo'),
    why: 'the call that reads the Android advertising id'
  },
  {
    label: 'the AD_ID permission',
    pattern: named('com.google.android.gms.permission.AD_ID'),
    why: 'the manifest permission an app must hold to read the Android advertising id'
  },
  { label: 'AD_ID', pattern: acronym('AD_ID'), why: 'the Android advertising id, however it is spelled' },
  { label: 'play-services-ads', pattern: named('play-services-ads'), why: 'the Google Mobile Ads SDK' },
  {
    label: 'play-services-measurement',
    pattern: named('play-services-measurement'),
    why: 'the Firebase Analytics native artifact, which collects the advertising id on Android'
  },
  {
    label: 'firebase-analytics',
    pattern: named('firebase-analytics'),
    why: 'Firebase Analytics, which mints an app-instance id and reports it continuously'
  },
  { label: 'IDFA', pattern: acronym('IDFA'), why: 'the iOS advertising identifier' },
  { label: 'IDFV', pattern: acronym('IDFV'), why: 'the iOS vendor identifier' },
  { label: 'GAID', pattern: acronym('GAID'), why: 'the Google advertising id' },
  { label: 'AAID', pattern: acronym('AAID'), why: 'the Android advertising id' }
];

/** `<key>NAME</key>` — enough structure to enumerate what an Info.plist declares. */
const PLIST_KEY = /<key>([A-Za-z0-9_]+)<\/key>/g;

const IOS_PLIST = 'ios/App/App/Info.plist';
const IOS_PRIVACY_MANIFEST = 'ios/App/App/PrivacyInfo.xcprivacy';
const ANDROID_MANIFEST = 'android/app/src/main/AndroidManifest.xml';

const fileText = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

const captured = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap(match => (match[1] === undefined ? [] : [match[1]]));

describe('no App Tracking Transparency, and no advertising identifier', () => {
  it.each(ADVERTISING_TOKENS)('never references $label, anywhere in the repo', ({ label, pattern, why }) => {
    expect(
      matches(trackingSurface(), pattern).map(
        hit =>
          `${at(hit)} references ${label} — ${why}. Bread promises no cross-app tracking, no ATT prompt, and no advertising identifier, ever.`
      )
    ).toEqual([]);
  });

  it('declares no tracking in the iOS privacy manifest', () => {
    // `PrivacyInfo.xcprivacy` is the machine-readable form of these promises —
    // the file Apple reads and the App Store surfaces. Shipping telemetry
    // without noticing this file is how "we do not track" survives in the
    // marketing copy and quietly stops being true in the binary.
    const declaration = fileText(IOS_PRIVACY_MANIFEST);
    const violations: string[] = [];

    const tracking = /<key>NSPrivacyTracking<\/key>\s*<(true|false)\/>/.exec(declaration);
    if (tracking === null) {
      violations.push(`${IOS_PRIVACY_MANIFEST} no longer declares NSPrivacyTracking at all.`);
    } else if (tracking[1] !== 'false') {
      violations.push(
        `${IOS_PRIVACY_MANIFEST} sets NSPrivacyTracking to true, which is a declaration to Apple that the app tracks users across apps and websites.`
      );
    }

    const domains = /<key>NSPrivacyTrackingDomains<\/key>\s*(<array\s*\/>|<array>[\s\S]*?<\/array>)/.exec(declaration);
    if (domains === null) {
      violations.push(`${IOS_PRIVACY_MANIFEST} no longer declares NSPrivacyTrackingDomains at all.`);
    } else {
      for (const domain of captured(domains[1] ?? '', /<string>([^<]+)<\/string>/g)) {
        violations.push(`${IOS_PRIVACY_MANIFEST} lists ${domain} as a tracking domain. There are to be none.`);
      }
    }

    // Deliberately not asserting that NSPrivacyCollectedDataTypes is empty —
    // declaring crash and product-interaction data there is honest and may
    // become necessary. What may never appear is a collected type flagged as
    // used for tracking.
    for (const flag of captured(declaration, /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<(true|false)\/>/g)) {
      if (flag === 'true') {
        violations.push(
          `${IOS_PRIVACY_MANIFEST} flags a collected data type as used for tracking. Nothing the wallet collects may ever be.`
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('asks for no permission prompt on iOS beyond Face ID and the camera', () => {
    // Structural rather than textual: this sees a tracking key added under a
    // spelling the token list above has never heard of.
    const declared = captured(fileText(IOS_PLIST), PLIST_KEY).filter(key => key.endsWith('UsageDescription'));
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared
        .filter(key => key !== 'NSFaceIDUsageDescription' && key !== 'NSCameraUsageDescription')
        .map(
          key =>
            `${IOS_PLIST} declares ${key}. Every NS*UsageDescription is a permission prompt shown to the user; adding one is a privacy decision, and NSUserTrackingUsageDescription in particular is the ATT prompt the wallet promises never to show.`
        )
    ).toEqual([]);
  });

  it('asks for no Android permission beyond internet access and vibration', () => {
    const requested = captured(fileText(ANDROID_MANIFEST), /<uses-permission[^>]*android:name="([^"]+)"/g);
    expect(requested.length).toBeGreaterThan(0);
    expect(
      requested
        .filter(name => name !== 'android.permission.INTERNET' && name !== 'android.permission.VIBRATE')
        .map(
          name =>
            `${ANDROID_MANIFEST} requests ${name}. Widen this list only after confirming the permission is not a tracking permission — com.google.android.gms.permission.AD_ID, QUERY_ALL_PACKAGES, READ_PHONE_STATE and the location permissions all are.`
        )
    ).toEqual([]);
  });

  it('probes for no installed app beyond the wallets it deep-links to', () => {
    // An app-inventory query is a fingerprint. These lists exist so "Open in
    // MetaMask" can be hidden when MetaMask is absent; nothing may report them,
    // and nothing may grow them into a survey of what else is on the device.
    const deepLinkTargets = [
      'cbwallet',
      'com.ledger.live',
      'com.okinc.okex.gp',
      'com.uniswap.mobile',
      'com.wallet.crypto.trustapp',
      'io.metamask',
      'io.safe.global',
      'io.zerion.android',
      'ledgerlive',
      'me.rainbow',
      'metamask',
      'okx',
      'org.toshi',
      'rainbow',
      'safe',
      'trust',
      'uniswap',
      'zerion'
    ];

    const probed = [
      ...captured(fileText(ANDROID_MANIFEST), /<package android:name="([^"]+)"/g),
      ...captured(fileText(IOS_PLIST), /<key>LSApplicationQueriesSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g).flatMap(
        block => captured(block, /<string>([^<]+)<\/string>/g)
      )
    ];

    expect(probed.length).toBeGreaterThan(0);
    expect(
      probed
        .filter(target => !deepLinkTargets.includes(target))
        .map(
          target =>
            `the native config probes for "${target}". Checking which apps are installed is a fingerprinting surface; add a target here only when a deep link needs it, and never report what the probe finds.`
        )
    ).toEqual([]);
  });

  it('never opens the SDK high-fidelity observation channel', () => {
    // `observeSensitive` is the Miden SDK's opt-in channel for detailed
    // observation. The assertion is that the name is absent, not that it is
    // set to false: a flag that exists is a flag that gets flipped.
    expect(
      matches(srcFiles(), /\bobserveSensitive\b/).map(
        hit => `${at(hit)} names observeSensitive — the SDK's high-fidelity channel, which the wallet never opens.`
      )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Promise: nothing sold or shared with data brokers.
// ---------------------------------------------------------------------------

interface ForbiddenPackage {
  pattern: RegExp;
  why: string;
}

/**
 * Matched against an extracted package name, never against raw file text.
 * That distinction is the whole design: a `rg analytics` guard fires on the
 * word "analytics" in a comment, in this file's own strings, and in the
 * CHANGELOG, so it gets deleted. A name-level match fires only on a real
 * dependency edge.
 */
const FORBIDDEN_PACKAGES: readonly ForbiddenPackage[] = [
  {
    pattern: /^@segment\//,
    why: 'Segment — a customer-data platform whose product is forwarding user data onward to other vendors. `@segment/analytics-node` was deleted along with the analytics scaffold and must never return'
  },
  { pattern: /^(@amplitude\/|amplitude-js$)/, why: 'Amplitude product analytics' },
  { pattern: /^(@mixpanel\/|mixpanel$|mixpanel-browser$)/, why: 'Mixpanel product analytics' },
  { pattern: /^(@posthog\/|posthog-js$|posthog-node$)/, why: 'PostHog product analytics' },
  { pattern: /^(@rudderstack\/|rudder-sdk-js$)/, why: 'RudderStack customer-data platform' },
  { pattern: /^@snowplow\//, why: 'Snowplow behavioural event tracking' },
  { pattern: /^(@heap\/|heap-api$)/, why: 'Heap autocapture analytics' },
  {
    pattern: /^(@fullstory\/|@hotjar\/|logrocket$|logrocket-react$|@microsoft\/clarity$|clarity-js$)/,
    why: 'session replay — it records the screen, and for a wallet the screen holds addresses, balances and recovery phrases'
  },
  {
    pattern: /^@sentry\/(feedback|replay|replay-canvas)$/,
    why: 'Sentry session replay and user feedback — they record the DOM and prompt the user for a name and an email. All three sit in yarn.lock as transitive dependencies of @sentry/browser and tree-shake away because nothing imports them; this assertion is what keeps that true'
  },
  {
    pattern: /^(@datadog\/|@bugsnag\/|@newrelic\/|newrelic$|@elastic\/apm-rum$)/,
    why: 'a second crash or RUM egress point — the wallet has exactly one, and it scrubs before it sends'
  },
  {
    pattern:
      /^(react-ga$|react-ga4$|@vercel\/analytics$|@next\/third-parties$|ga-gtag$|matomo-tracker$|plausible-tracker$|@june-so\/)/,
    why: 'page analytics'
  },
  {
    pattern:
      /^(firebase$|@firebase\/|@react-native-firebase\/|@capacitor-firebase\/|@capacitor-community\/firebase-analytics$)/,
    why: 'Firebase — its analytics module mints an app-instance id and, on Android, reads the advertising id'
  },
  {
    pattern:
      /^(@braze\/|@customerio\/|@intercom\/|@appsflyer\/|appsflyer-sdk$|react-native-appsflyer$|branch-sdk$|react-native-branch$|@adjustcom\/|react-native-adjust$)/,
    why: 'marketing attribution and messaging — resolving one person across apps and devices is the entire product'
  },
  {
    pattern:
      /^(expo-tracking-transparency$|react-native-tracking-transparency$|capacitor-plugin-app-tracking-transparency$|@capacitor-community\/app-tracking-transparency$|@capawesome\/capacitor-app-tracking-transparency$|react-native-idfa$|react-native-advertising-id$)/,
    why: 'an App Tracking Transparency or advertising-id plugin — installing one is how the ATT prompt reaches a Capacitor app in the first place'
  },
  {
    pattern: /^@miden-sdk\/telemetry-/,
    why: 'a vendor telemetry binding for the Miden SDK. The wallet owns its egress point and its scrubber; a binding package would add a second egress point outside that boundary'
  }
];

const forbidding = (name: string): ForbiddenPackage | undefined =>
  FORBIDDEN_PACKAGES.find(forbidden => forbidden.pattern.test(name));

/**
 * The Sentry packages `yarn.lock` resolves, all of them, reviewed.
 *
 * Three — feedback, replay, replay-canvas — are on the forbidden list above
 * and are nonetheless in the tree, because `@sentry/browser` depends on them.
 * That is the distinction this file has to get right: a package can be
 * *resolved* without being *declared* and without being *imported*, and only
 * the last of the three decides what a user runs. Nothing imports these, so
 * the bundler drops them and no replay code reaches the artifact.
 *
 * So they are exempt from the lockfile assertion and forbidden at both levels
 * that matter, and this list is pinned below so a Sentry upgrade that resolves
 * a seventh package fails and gets read before it is accepted.
 */
const REVIEWED_TRANSITIVE_SENTRY: readonly string[] = [
  '@sentry/browser',
  '@sentry/browser-utils',
  '@sentry/conventions',
  '@sentry/core',
  '@sentry/feedback',
  '@sentry/replay',
  '@sentry/replay-canvas'
];

describe('no analytics, tracking, or advertising SDK', () => {
  it('is declared in package.json — dependencies, devDependencies, or a resolutions override', () => {
    expect(
      declaredPackages().flatMap(name => {
        const forbidden = forbidding(name);
        return forbidden === undefined ? [] : [`package.json declares ${name} — ${forbidden.why}.`];
      })
    ).toEqual([]);
  });

  it('is imported anywhere in src, which is the level that decides what ships', () => {
    expect(
      [...importedPackages()].flatMap(([name, importers]) => {
        const forbidden = forbidding(name);
        return forbidden === undefined
          ? []
          : [`${[...importers].sort().join(', ')} imports ${name} — ${forbidden.why}.`];
      })
    ).toEqual([]);
  });

  it("is resolved in yarn.lock, so none can arrive as somebody else's transitive dependency", () => {
    // Except the reviewed Sentry set, which is resolved, unimported, and
    // tree-shaken — see REVIEWED_TRANSITIVE_SENTRY.
    expect(
      [...lockfilePackages()]
        .sort()
        .filter(name => !REVIEWED_TRANSITIVE_SENTRY.includes(name))
        .flatMap(name => {
          const forbidden = forbidding(name);
          return forbidden === undefined
            ? []
            : [
                `yarn.lock resolves ${name} — ${forbidden.why}. Nothing imports it yet, which is the only reason it does not ship; one import would be enough.`
              ];
        })
    ).toEqual([]);
  });
});

/**
 * The dependency promise has to be made at three levels, because a package can
 * be present at one and absent at the others, and only one of the three
 * decides what a user actually runs:
 *
 * - **Declared** — named in `package.json`. `@sentry/browser`, and only that.
 * - **In the lockfile** — resolved at any depth. `@sentry/browser` drags six
 *   more packages in, among them `@sentry/replay`, `@sentry/replay-canvas` and
 *   `@sentry/feedback`, which record the DOM and prompt for a name and email.
 * - **Imported** — referenced by a module in `src`. This is the level that
 *   ships: nothing imports those three, so the bundler drops them, and the
 *   built artifact contains no replay code at all.
 *
 * The pin below is deliberate, not incidental. A Sentry upgrade that adds a
 * seventh transitive package fails here and gets read before it is accepted,
 * which is the only point at which anybody would notice.
 */
describe('the Sentry dependency, at each of the three levels it exists at', () => {
  it('declares exactly one Sentry package', () => {
    expect(declaredPackages().filter(name => name.startsWith('@sentry/'))).toEqual(['@sentry/browser']);
  });

  it('carries a reviewed set of Sentry packages in the lockfile, none of which may grow silently', () => {
    expect([...lockfilePackages()].filter(name => name.startsWith('@sentry/')).sort()).toEqual(
      [...REVIEWED_TRANSITIVE_SENTRY].sort()
    );
  });

  it('imports only @sentry/browser, so the replay and feedback packages stay unreferenced and tree-shaken', () => {
    // Which *file* may import Sentry is asserted in `egress-boundary.test.ts`.
    // This asserts which *package* may be imported — the other axis, and the
    // one that decides whether replay code reaches the bundle.
    expect([...importedPackages().keys()].filter(name => name.startsWith('@sentry/')).sort()).toEqual([
      '@sentry/browser'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Promise: no persistent user identifier.
// ---------------------------------------------------------------------------

interface Api {
  label: string;
  pattern: RegExp;
}

const PERSISTENCE_APIS: readonly Api[] = [
  { label: 'localStorage', pattern: /\blocalStorage\s*\./ },
  { label: 'sessionStorage', pattern: /\bsessionStorage\s*\./ },
  { label: 'chrome.storage', pattern: /\bchrome\s*\.\s*storage\b/ },
  { label: 'browser.storage', pattern: /\bbrowser\s*\.\s*storage\b/ },
  { label: 'getStorageProvider', pattern: /\bgetStorageProvider\b/ },
  { label: 'Capacitor Preferences', pattern: /\bPreferences\s*\./ },
  { label: 'indexedDB', pattern: /\bindexedDB\b/ },
  { label: 'Dexie', pattern: /\bDexie\b/ },
  { label: 'document.cookie', pattern: /\bdocument\s*\.\s*cookie\b/ }
];

/** The one persistence call the telemetry module may make, and the only one it needs. */
const PERMITTED_PERSISTENCE = { file: 'src/lib/telemetry/legacy-cleanup.ts', label: 'localStorage' };

/**
 * Packages that exist to mint an identifier.
 *
 * Detected as imports rather than as call sites, because `nanoid()` also
 * appears in the sentence in `legacy-cleanup.ts` explaining what the deleted
 * scaffold used to do — a comment matching a code pattern is exactly how a
 * guard earns a reputation for crying wolf.
 */
const IDENTIFIER_PACKAGES = [
  '@paralleldrive/cuid2',
  'crypto-random-string',
  'cuid',
  'nanoid',
  'short-uuid',
  'shortid',
  'ulid',
  'uuid'
];

/** And the two that need no import. */
const IDENTIFIER_CALLS: readonly Api[] = [
  { label: 'crypto.randomUUID()', pattern: /\brandomUUID\s*\(/ },
  { label: 'crypto.getRandomValues()', pattern: /\bgetRandomValues\s*\(/ }
];

/** The one module allowed to mint one, and the id it mints dies with the flow. */
const FLOW_ID_MINTER = 'src/lib/telemetry/report-flow.ts';

/**
 * Words that make a field durable identity rather than a measurement. Matched
 * against the camelCase words of a key, so `flowId` reads as `flow` + `id` and
 * passes — the flow id is minted per flow, held in memory, and thrown away.
 */
const DURABLE_IDENTITY_WORDS: ReadonlySet<string> = new Set([
  'aaid',
  'account',
  'address',
  'advertiser',
  'advertising',
  'anonymous',
  'client',
  'cookie',
  'device',
  'distinct',
  'email',
  'fingerprint',
  'gaid',
  'idfa',
  'idfv',
  'install',
  'installation',
  'person',
  'profile',
  'session',
  'subscriber',
  'uid',
  'user',
  'username',
  'uuid',
  'visitor'
]);

const wordsOf = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 0);

describe('no persistent identifier', () => {
  it('writes nothing durable from the telemetry module, beyond deleting the legacy key', () => {
    // The strongest form of "there is no persistent telemetry identifier" is
    // that the module cannot persist anything at all. The single exception is
    // `legacy-cleanup.ts`, which only ever *removes* the `analytics` key the
    // deleted scaffold left behind on existing installs.
    expect(
      PERSISTENCE_APIS.flatMap(({ label, pattern }) =>
        matches(telemetryFiles(), pattern)
          .filter(hit => !(hit.file === PERMITTED_PERSISTENCE.file && label === PERMITTED_PERSISTENCE.label))
          .map(
            hit =>
              `${at(hit)} reaches ${label} from inside the telemetry module. Telemetry identifiers are ephemeral and per-flow; anything written to storage outlives the flow and becomes the durable id the wallet promises not to hold.`
          )
      )
    ).toEqual([]);
  });

  it('mints an identifier in exactly one telemetry module, and only the ephemeral per-flow id', () => {
    const minting = new Set([
      ...telemetryFiles()
        .filter(file => specifiersOf(file.text).some(spec => IDENTIFIER_PACKAGES.includes(packageOf(spec.value))))
        .map(file => file.path),
      ...IDENTIFIER_CALLS.flatMap(({ pattern }) => matches(telemetryFiles(), pattern).map(hit => hit.file))
    ]);

    // Positive control first: without it, deleting `report-flow`'s import of
    // nanoid would empty the set and satisfy the real assertion below.
    expect([...minting]).toContain(FLOW_ID_MINTER);
    minting.delete(FLOW_ID_MINTER);

    expect(
      [...minting]
        .sort()
        .map(
          file =>
            `${file} mints an identifier. Only ${FLOW_ID_MINTER} may, and the id it mints exists to pair one flow's started and ended events, lives in a closure, and is never persisted or reused.`
        )
    ).toEqual([]);
  });

  it('has no wire field that could name a person, a device, or an install', () => {
    // `egress-boundary.test.ts` pins WIRE_KEYS to the keys actually observed on
    // the wire, which stays green if a `userId` is added to both at once. This
    // reads the meaning of the names instead.
    expect(
      WIRE_KEYS.flatMap(key => {
        const identity = wordsOf(key).filter(word => DURABLE_IDENTITY_WORDS.has(word));
        return identity.length === 0
          ? []
          : [
              `the wire payload carries "${key}", whose name (${identity.join(', ')}) reads as durable identity. Telemetry events are joined per flow and never per person.`
            ];
      })
    ).toEqual([]);
  });

  it('has not resurrected the deleted analytics scaffold', () => {
    // It seeded `localStorage['analytics']` with a nanoid() userId that lived
    // for the life of the install. The code is gone; this is what keeps it gone.
    expect(
      ['src/lib/analytics', 'src/lib/analytics.ts', 'src/lib/analytics.tsx']
        .filter(path => existsSync(resolve(REPO_ROOT, path)))
        .map(
          path =>
            `${path} is back. The analytics scaffold minted a persistent per-install userId; that is why it was deleted.`
        )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Promise: the background service worker loads telemetry by deep path only.
// ---------------------------------------------------------------------------

const BACKGROUND_ENTRY = 'src/background-entry.ts';
const TELEMETRY_BARREL = 'src/lib/telemetry/index.ts';
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.js', '.json'];

const repoPath = (absolute: string): string => relative(REPO_ROOT, absolute).split(sep).join('/');

/** Resolve a specifier the way the bundler does: relative paths and `baseUrl: src` aliases. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(resolve(REPO_ROOT, fromFile)), specifier);
  else if (ALIAS_ROOTS.some(root => specifier === root || specifier.startsWith(`${root}/`)))
    base = resolve(REPO_ROOT, 'src', specifier);
  else return null;

  for (const extension of RESOLVED_EXTENSIONS) {
    if (existsSync(`${base}${extension}`)) return repoPath(`${base}${extension}`);
  }
  for (const extension of RESOLVED_EXTENSIONS) {
    const barrel = resolve(base, `index${extension}`);
    if (existsSync(barrel)) return repoPath(barrel);
  }
  if (existsSync(base) && statSync(base).isFile()) return repoPath(base);
  return null;
}

interface BackgroundGraph {
  modules: ReadonlySet<string>;
  /** Module → a module that imports it, so a failure names the route in rather than just the file. */
  importedBy: ReadonlyMap<string, string>;
}

let cachedGraph: BackgroundGraph | undefined;
/** Everything the MV3 service worker pulls in, following runtime imports only. */
function backgroundGraph(): BackgroundGraph {
  if (cachedGraph === undefined) {
    const modules = new Set<string>();
    const importedBy = new Map<string, string>();
    const pending = [BACKGROUND_ENTRY];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || modules.has(current)) continue;
      modules.add(current);
      if (!/\.(ts|tsx|js)$/.test(current)) continue;

      for (const specifier of specifiersOf(readFileSync(resolve(REPO_ROOT, current), 'utf8'))) {
        if (specifier.typeOnly) continue;
        const resolved = resolveSpecifier(specifier.value, current);
        if (resolved === null) continue;
        if (!importedBy.has(resolved)) importedBy.set(resolved, current);
        if (!modules.has(resolved)) pending.push(resolved);
      }
    }
    cachedGraph = { modules, importedBy };
  }
  return cachedGraph;
}

describe('the background service worker never imports the telemetry barrel', () => {
  it('walks a graph that reaches the background telemetry code, so the assertions below are not vacuous', () => {
    const { modules } = backgroundGraph();
    expect(modules.size).toBeGreaterThan(100);
    expect(modules.has('src/lib/miden/back/actions.ts')).toBe(true);
    expect(modules.has('src/lib/telemetry/sink.ts')).toBe(true);
  });

  it('imports `lib/telemetry` from nowhere in the graph', () => {
    // There is no lint rule for this and there never has been — the convention
    // has held because two people remembered it. `lib/telemetry/index.ts`
    // re-exports `report-flow`, which imports `lib/miden/front`, which is a
    // React tree. Background code uses `lib/telemetry/sink` and
    // `lib/telemetry/context` instead.
    const importer = backgroundGraph().importedBy.get(TELEMETRY_BARREL);
    expect(
      importer === undefined
        ? []
        : [
            `${importer} imports the \`lib/telemetry\` barrel. The service worker must import the deep modules it needs — \`lib/telemetry/sink\`, \`lib/telemetry/context\` — because the barrel re-exports \`report-flow\`, which drags React, constate and zustand into the worker bundle.`
          ]
    ).toEqual([]);
  });

  it('reaches only the telemetry modules a worker can load, and no more', () => {
    // Widen this list only on purpose. `crash.ts`, `redact.ts` and
    // `report-flow.ts` are frontend code: the worker has no window, and
    // `report-flow` is the module the barrel pulls React in through.
    expect([...backgroundGraph().modules].filter(module => module.startsWith('src/lib/telemetry/')).sort()).toEqual([
      'src/lib/telemetry/context.ts',
      'src/lib/telemetry/serialize.ts',
      'src/lib/telemetry/sink.ts',
      'src/lib/telemetry/types.ts'
    ]);
  });
});

// ---------------------------------------------------------------------------
// Promise: no stray egress. Complements, and does not restate,
// `egress-boundary.test.ts`, which asserts the same property over a live wire.
// ---------------------------------------------------------------------------

const SINK = 'src/lib/telemetry/sink.ts';

const EGRESS_APIS: readonly Api[] = [
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
  { label: 'navigator.sendBeacon()', pattern: /\bsendBeacon\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'EventSource', pattern: /\bEventSource\b/ },
  { label: 'new Image()', pattern: /\bnew Image\s*\(/ },
  { label: 'axios', pattern: /\baxios\b/ }
];

/**
 * Third-party origins the shipped HTML documents may reach, each with the
 * reason it is tolerated.
 *
 * Deliberately empty: the entry documents reach no third party at all.
 *
 * They used to. `fonts.googleapis.com` and `fonts.gstatic.com` were listed
 * here, because six of the eight documents carried Google Fonts `<link>` tags
 * that disclosed the user's IP address and User-Agent to Google on every
 * launch, before the consent prompt had asked anything. That set no cookie and
 * carried no identifier, so it was not the cross-site *tracking* the wallet
 * promises against — but a wallet that promises "no tracking across other apps
 * or sites" and then phones a third party to draw its own headings is not
 * worth arguing about. Inter and Nunito are served from the bundle now (see the
 * `@font-face` block in `src/main.css`), so the exception is gone and the
 * assertion below forbids what it used to permit.
 *
 * Adding an entry back is a decision to ship a third-party fetch, and the
 * reason string is where it gets justified to whoever reads this next.
 */
const ALLOWED_THIRD_PARTY_ORIGINS: ReadonlyMap<string, string> = new Map<string, string>();

const DOCUMENT_URL = /(?:src|href)\s*=\s*"([^"]+)"/g;

const isThirdParty = (url: string): boolean => /^(https?:)?\/\//.test(url);

describe('no stray egress', () => {
  it('makes every network call in the telemetry module from the sink', () => {
    expect(
      EGRESS_APIS.flatMap(({ label, pattern }) =>
        matches(telemetryFiles(), pattern)
          .filter(hit => !(hit.file === SINK && label === 'fetch()'))
          .map(
            hit =>
              `${at(hit)} reaches the network with ${label}. The telemetry module has exactly one egress point, ${SINK}, because that is what makes the consent gate a single auditable check instead of a discipline applied at every call site.`
          )
      )
    ).toEqual([]);
  });

  it('holds exactly one fetch call in the sink, so a second endpoint cannot hide beside the first', () => {
    // A one-element array asserts the count and the location at once.
    expect(matches(telemetryFiles(), /\bfetch\s*\(/).map(hit => hit.file)).toEqual([SINK]);
  });

  it.each([
    ['TELEMETRY_INGEST_URL', SINK],
    ['SENTRY_DSN', 'src/lib/telemetry/crash.ts']
  ])('reads %s in exactly one shipped file', (variable, owner) => {
    const readers = [
      ...new Set(matches(shippedFiles(), new RegExp(`\\bprocess\\.env\\.${variable}\\b`)).map(hit => hit.file))
    ];
    expect(readers).toEqual([owner]);
  });

  it('uses no fire-and-forget beacon anywhere in the wallet', () => {
    // `navigator.sendBeacon` survives page unload and returns nothing to await,
    // so a call to it is invisible to every test that asserts on a response.
    // Nothing in this wallet has ever needed one.
    expect(
      matches(shippedFiles(), /\bsendBeacon\b/).map(
        hit => `${at(hit)} calls sendBeacon — an unobservable egress path that no assertion in this repo can see.`
      )
    ).toEqual([]);
  });

  it('loads no unreviewed third-party resource in any HTML entry document', () => {
    const referenced = htmlDocuments().flatMap(document =>
      captured(document.text, DOCUMENT_URL).map(url => ({ document: document.path, url }))
    );

    // Every document references a local script, and most a local icon too, so
    // a count in single digits means the extractor has stopped extracting and
    // the assertion below is passing over unread files. The real count is 28
    // across 15 documents — it was 52 while the Google Fonts tags were in, and
    // dropping them is what ate the headroom. Raise the floor if that count
    // grows; do not lower it to fit a scan that has started missing files.
    expect(referenced.length).toBeGreaterThan(20);

    expect(
      referenced
        .filter(reference => isThirdParty(reference.url))
        .map(reference => ({
          ...reference,
          origin: new URL(reference.url.startsWith('//') ? `https:${reference.url}` : reference.url).origin
        }))
        .filter(reference => !ALLOWED_THIRD_PARTY_ORIGINS.has(reference.origin))
        .map(
          reference =>
            `${reference.document} loads ${reference.url}, reaching ${reference.origin}. A third-party tag in an entry document reaches out on every launch, which is cross-site tracking whatever the tag claims to do. Serve the asset locally — see the \`@font-face\` block in \`src/main.css\` for how Inter and Nunito were brought in-bundle — or add the origin to ALLOWED_THIRD_PARTY_ORIGINS with the reason it is tolerable.`
        )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Promise: telemetry is off by default and opt-in.
// ---------------------------------------------------------------------------

const INGEST_URL = 'https://ingest.telemetry.invalid/v1/events';
const SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';

const requests: string[] = [];

/**
 * Installed once and never reswapped: Sentry caches the fetch implementation it
 * resolves, so replacing the stub per test would leave the crash transport
 * writing into an array nobody reads — and an "it sent nothing" assertion over
 * an empty array passes for the wrong reason.
 */
const fetchStub = (input: unknown): Promise<{ status: number; headers: Headers }> => {
  requests.push(String(input));
  return Promise.resolve({ status: 200, headers: new Headers() });
};

let originalFetch: PropertyDescriptor | undefined;

beforeAll(() => {
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', { value: fetchStub, writable: true, configurable: true });
});

afterAll(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch');
  else Object.defineProperty(globalThis, 'fetch', originalFetch);
});

/** Drain the fire-and-forget reporting chain and Sentry's transport buffer. */
async function flushEgress(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

describe('telemetry is off until the user turns it on', () => {
  beforeEach(async () => {
    requests.length = 0;
    process.env.TELEMETRY_INGEST_URL = INGEST_URL;
    process.env.SENTRY_DSN = SENTRY_DSN;
    localStorage.removeItem(TELEMETRY_STORAGE_KEY);
    // The background mirror holds no boolean, which is the state of a wallet
    // that has never been asked: `readMirroredSetting` falls back to
    // DEFAULT_TELEMETRY for an absent key and a non-boolean one alike.
    await getStorageProvider().set({ [TELEMETRY_STORAGE_KEY]: undefined });
  });

  afterEach(async () => {
    stopCrashReporting();
    await flushEgress();
  });

  it('defaults to off', () => {
    expect(DEFAULT_TELEMETRY).toBe(false);
  });

  it('sends nothing at either egress point on a fresh install', async () => {
    // Nothing is mocked here. `egress-boundary.test.ts` substitutes the consent
    // gate to drive both sides of it; this runs the real settings module
    // against empty storage, which is the state a wallet is actually in the
    // first time it opens. Flipping DEFAULT_TELEMETRY to true fails here even
    // if every mocked consent test still passes.
    initCrashReporting();
    captureCrash(new Error('rpc endpoint returned status'));
    await sendEvent({ phase: 'started', flow: 'open', flowId: 'fresh-install' }, resolveTelemetryContext());
    await flushEgress();

    expect(requests).toEqual([]);
  });

  it('sends at both once consent is stored, so the silence above is the gate and not a broken driver', async () => {
    // Written straight to the store the background reads rather than through
    // `setTelemetrySetting`, whose mirror write is fire-and-forget: the point
    // here is the gate, not the timing of the mirror.
    await getStorageProvider().set({ [TELEMETRY_STORAGE_KEY]: true });

    initCrashReporting();
    captureCrash(new Error('rpc endpoint returned status'));
    await sendEvent({ phase: 'started', flow: 'open', flowId: 'opted-in' }, resolveTelemetryContext());
    await flushEgress();

    expect(requests).toContain(INGEST_URL);
    expect(requests.filter(url => url.includes('sentry.io')).length).toBeGreaterThan(0);
  });
});
