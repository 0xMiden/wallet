import * as fs from 'fs';
import * as path from 'path';

import { assertAptabaseContract, startAptabaseSink, type AptabaseSink, type SinkRequest } from './aptabase-sink';
import { APTABASE_APP_KEY, APTABASE_HOST, SINK_PORT } from './config';
import { HANDOFF_SELECTOR, PASSWORD, SEED_WORDS, importWalletToConsentPrompt } from './onboarding';
import { encodingVariantsOf } from '../../src/lib/telemetry/egress-guard';
import { expect, test } from '../fixtures/extension';

/**
 * What the wallet actually puts on the wire when a user opts in to telemetry.
 *
 * This exists because every other telemetry test is blind to the one thing that
 * matters most. The jest egress test asserts against a MOCKED transport with
 * synthetic fixtures, so it proves the serializer is well behaved and nothing
 * about the shipped service worker; and every e2e suite builds with no Aptabase
 * key, which makes telemetry inert by construction and means none of them has
 * ever seen a single real request leave.
 *
 * Why this cannot live in an existing suite. The key and the host are baked in
 * at BUILD time by vite's `define`, so a suite that exercises egress needs a
 * differently-configured build and cannot share another job's artifact. And
 * `dismissTelemetryConsent` exists precisely because accepting consent arms real
 * egress for the life of the profile — accepting is only safe in a build whose
 * endpoint is a local sink and whose `SENTRY_DSN` is empty, which is what the
 * telemetry job configures and no other job does.
 *
 * Runs on merge to main rather than per-PR: it needs its own build of the
 * extension, and the risk it guards against is a slow one — nobody lands a
 * change to the serializer without the jest tests noticing.
 */

test.describe.configure({ mode: 'serial' });

/** Quiet window for "nothing was sent". Generous: an absence is worth waiting on. */
const SILENCE_WINDOW_MS = 3_000;

let sink: AptabaseSink;

test.beforeAll(async () => {
  assertBuildIsTelemetryConfigured();
  // A fixed port, not an ephemeral one: the extension was built with this host
  // compiled into it, so the sink has to come up where the build already
  // expects. A collision is loud (`EADDRINUSE`) rather than a silent miss.
  sink = await startAptabaseSink(SINK_PORT);
});

/**
 * Prove the artifact under test was built with telemetry pointed at the sink.
 *
 * Without this the first test is VACUOUS in the most dangerous way: "the wallet
 * sent nothing before consent" is exactly what an unconfigured build does, so a
 * job that forgot the env would report the strongest guarantee in this file as
 * passing. Reading the key back out of the bundle is also the only check that
 * the build and this spec agree — they hold the constants separately, and a
 * mismatch would otherwise surface as a mysteriously silent wallet.
 *
 * Also asserts `SENTRY_DSN` did NOT get baked in. This is the one suite that
 * accepts consent, which arms the crash reporter; an empty DSN is what keeps
 * that from shipping a report off the runner.
 */
function assertBuildIsTelemetryConfigured(): void {
  const dist = process.env.EXTENSION_DIST ?? path.join(__dirname, '../../dist/chrome_unpacked');
  const haystack = readJsFiles(dist);
  if (haystack.length === 0) throw new Error(`No built extension JS found under ${dist}`);

  const joined = haystack.join('\n');
  if (!joined.includes(APTABASE_APP_KEY)) {
    throw new Error(
      `The extension at ${dist} was not built with APTABASE_APP_KEY=${APTABASE_APP_KEY}. ` +
        `Telemetry is inert in this build, which would make the pre-consent silence assertion vacuous. ` +
        `Build with \`yarn build:chrome:telemetry\`.`
    );
  }
  if (!joined.includes(APTABASE_HOST)) {
    throw new Error(`The extension at ${dist} was not built with APTABASE_HOST=${APTABASE_HOST}.`);
  }
  // Any Sentry DSN is a live ingestion endpoint; matching the scheme rather than
  // a specific host so a non-sentry.io self-hosted relay cannot slip through.
  const dsn = /https:\/\/[0-9a-f]{16,}@[\w.-]+\/\d+/.exec(joined);
  if (dsn) {
    throw new Error(
      `The extension at ${dist} was built with a Sentry DSN (${dsn[0]}). This suite accepts telemetry ` +
        `consent, which arms the crash reporter, so it must only ever run against a build with SENTRY_DSN unset.`
    );
  }
}

function readJsFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

test.afterAll(async () => {
  await sink?.close();
});

test.describe('Telemetry egress', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Extension-only');

  test('sends nothing at all until consent is given', async ({ extensionContext, extensionId }) => {
    const before = sink.requests.length;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });

    // Everything up to and including the moment the prompt is on screen: app
    // boot, the `open` flow, a whole onboarding. This is the window the wallet
    // must be silent in, and the one a "fire the event, check consent later"
    // regression would break. It is also the shape of the Google-Fonts bug this
    // feature already had once — egress before anyone agreed to any.
    await importWalletToConsentPrompt(page);

    await page.locator('[data-testid="help-improve-wallet-decline"]').click();
    await expect(page.locator(HANDOFF_SELECTOR)).toBeVisible({ timeout: 30_000 });

    await sink.settle(SILENCE_WINDOW_MS);
    expect(describeRequests(sink.requests.slice(before))).toEqual([]);
  });

  test('opts in, sends well-formed events, and leaks nothing from a real wallet', async ({
    extensionContext,
    extensionId
  }) => {
    const before = sink.requests.length;
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/fullpage.html`, { waitUntil: 'domcontentloaded' });

    await importWalletToConsentPrompt(page);
    await page.locator('[data-testid="help-improve-wallet-accept"]').click();
    await expect(page.locator(HANDOFF_SELECTOR)).toBeVisible({ timeout: 30_000 });

    await test.step('accepting does not retroactively send the onboarding it just finished', async () => {
      // The `import` flow ENDED before the prompt was shown, and the gate is
      // checked when an event is sent, so it was dropped rather than queued.
      // Worth pinning: it means opting in never backfills, and a reader
      // wondering why the obvious event is missing gets an answer here rather
      // than concluding telemetry is broken.
      await sink.settle(SILENCE_WINDOW_MS);
      expect(describeRequests(sink.requests.slice(before))).toEqual([]);
    });

    await test.step('a flow started after consent does reach the endpoint', async () => {
      // The point of the whole suite: proof that the SHIPPED service worker
      // POSTs, not merely that a mocked transport was called. A reload remounts
      // the app shell, which is one `open` flow — started and ended, so two
      // events, both entirely after consent.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#root > *', { timeout: 30_000 });
      await sink.waitForRequests(before + 2);
    });

    const received = () => sink.requests.slice(before);

    await test.step('every request satisfies the Aptabase contract', () => {
      for (const request of received()) assertAptabaseContract(request, APTABASE_APP_KEY);
    });

    await test.step('every envelope carries only allowlisted fields', () => {
      for (const request of received()) assertEnvelopeShape(request);
    });

    await test.step('no secret this wallet holds appears in any byte sent', async () => {
      // Stronger than the jest egress test, which scans synthetic fixtures.
      // These are the real values this profile is holding right now.
      const sentinels = [
        SEED_WORDS.join(' '),
        // Individually too: a leak that emits one word at a time is still a
        // leak, and a whole-phrase check would not see it.
        ...SEED_WORDS,
        PASSWORD
      ];
      // The seed and the password above are unconditional and are the values
      // that matter; the address is added when the UI will give it up. Kept
      // best-effort ON PURPOSE, so a change to the receive screen's markup
      // cannot fail a leak test over a selector — and it cannot quietly empty
      // the scan either, because the list is already non-empty without it.
      const address = await readAccountAddress(page, extensionId);
      if (address) sentinels.push(address);

      assertNoSentinels(received(), sentinels);
    });

    await test.step('withdrawing consent stops egress', async () => {
      // Clicked through rather than deep-linked. `#/settings/general-settings`
      // renders the settings INDEX, not the tab — so a deep link looks like it
      // worked while leaving the toggle unmounted, and the test would fail on a
      // missing element rather than on anything about telemetry.
      await page.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`, {
        waitUntil: 'domcontentloaded'
      });
      await page.locator('[data-testid="Settings/GeneralButton"]').click();

      const toggle = page.locator('[data-testid="General Settings/TelemetryToggle"]');
      await toggle.waitFor({ state: 'visible', timeout: 30_000 });
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();

      // Drain the propagation window before marking, rather than asserting from
      // the click. A flow that was ALREADY OPEN when consent was withdrawn can
      // still report its cancellation: the event is built in the page when the
      // flow ends and gated in the background, which reads consent from a
      // mirrored write that is not ordered against an unrelated unmount. This
      // suite found that (a `send` flow, cancelled seconds later, arriving with
      // `result: cancelled`) and it is a real if narrow limitation — recorded in
      // `docs/telemetry-limitations.md`. What must hold, and is what is asserted
      // below, is that once withdrawal has landed nothing further is sent.
      await sink.settle(SILENCE_WINDOW_MS);
      const afterPropagation = sink.requests.length;

      // A full reload is one `open` flow, start to end — the same activity that
      // produced two events while consent was on. Silence here is the gate, and
      // could not be an accident of there being nothing to report.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#root > *', { timeout: 30_000 });
      await page.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`, {
        waitUntil: 'domcontentloaded'
      });

      await sink.settle(SILENCE_WINDOW_MS);
      expect(describeRequests(sink.requests.slice(afterPropagation))).toEqual([]);
    });
  });
});

/**
 * The wallet's own address as the UI shows it, or `null` if it is not on offer.
 *
 * Returns the address only when it looks like one. A short or empty string
 * added to the sentinel list would match everything and turn the leak scan into
 * noise, or match nothing and quietly weaken it.
 */
async function readAccountAddress(page: import('@playwright/test').Page, extensionId: string): Promise<string | null> {
  try {
    await page.goto(`chrome-extension://${extensionId}/fullpage.html#/receive`, { waitUntil: 'domcontentloaded' });
    const text = await page
      .getByTestId('receive-page')
      .locator('[data-testid="account-address"], code')
      .first()
      .innerText({ timeout: 10_000 });
    const trimmed = text.trim();
    return trimmed.length >= 8 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Renderable form of what arrived, so a failure names the payload. */
function describeRequests(requests: readonly SinkRequest[]): string[] {
  return requests.map(request => `${request.method} ${request.path} ${request.body}`);
}

/**
 * The envelope may contain these keys and no others.
 *
 * An allowlist rather than a denylist of known-bad fields: the failure mode
 * being guarded against is a NEW field appearing, which no denylist can
 * anticipate. Mirrors `buildEnvelope` in `src/lib/telemetry/aptabase.ts`.
 */
const ENVELOPE_KEYS = ['timestamp', 'sessionId', 'eventName', 'systemProps', 'props'];
const SYSTEM_PROPS_KEYS = ['isDebug', 'osName', 'appVersion', 'sdkVersion'];
const PROPS_KEYS = ['result', 'errorKind', 'durationMs'];

function assertEnvelopeShape(request: SinkRequest): void {
  const envelope = JSON.parse(request.body) as Record<string, unknown>;

  expect(Object.keys(envelope).sort()).toEqual([...ENVELOPE_KEYS].sort());
  expect(Object.keys(envelope.systemProps as object).sort()).toEqual([...SYSTEM_PROPS_KEYS].sort());
  for (const key of Object.keys(envelope.props as object)) {
    expect(PROPS_KEYS).toContain(key);
  }

  // Both halves come from closed literal unions in `types.ts`, so anything
  // outside this shape means a free-form string reached the event name.
  expect(String(envelope.eventName)).toMatch(/^[a-z_]+_(started|ended)$/);
  // The session id is an ephemeral per-flow nanoid. Asserting its shape is what
  // keeps a persistent or device-derived identifier from being introduced here
  // without a test noticing.
  expect(String(envelope.sessionId)).toMatch(/^[A-Za-z0-9_-]{21}$/);
}

function assertNoSentinels(requests: readonly SinkRequest[], sentinels: readonly string[]): void {
  const haystacks = requests.flatMap(request => [
    request.body,
    request.path,
    ...Object.values(request.headers).map(value => (Array.isArray(value) ? value.join(',') : String(value ?? '')))
  ]);

  const leaks: string[] = [];
  for (const sentinel of sentinels) {
    for (const variant of encodingVariantsOf(sentinel)) {
      const hit = haystacks.find(haystack => haystack.includes(variant));
      if (hit !== undefined) {
        leaks.push(`${JSON.stringify(sentinel)} (as ${JSON.stringify(variant)}) appears in: ${hit}`);
      }
    }
  }
  expect(leaks).toEqual([]);
}
