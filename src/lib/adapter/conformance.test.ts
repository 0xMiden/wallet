/**
 * Runs the adapter's conformance suite against this wallet's real providers.
 *
 * `createAccount` shipped on the published `MidenWallet` interface in adapter
 * 0.13.2 and no provider here implements it. It stayed that way for six months
 * because both sides of the contract were green: the adapter's tests inject a
 * `vi.fn()` bag as `window.midenWallet`, and this repo mocks the adapter package
 * wholesale. Each side asserted against a shape it invented, so nothing ever
 * compared the real interface to the real providers.
 *
 * This is that comparison. The suite is authored in the adapter — where the
 * interface lives — and imported here, where the implementations live, so
 * neither side can quietly agree with itself.
 *
 * ## Why it may skip
 *
 * `@miden-sdk/miden-wallet-adapter-miden` only gained `conformance` after the
 * packages moved into `0xMiden/web-sdk`. Until a release ships that, the import
 * fails and this suite skips loudly rather than failing the build. It starts
 * running by itself on the next adapter bump — nothing to remember.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs';
import { JSDOM } from 'jsdom';
import path from 'path';

type Case = { name: string; run: () => void | Promise<void> };
type ConformanceModule = {
  CONFORMANCE_BUILD: { real: boolean; methodCount: number };
  MIDEN_WALLET_METHODS: readonly string[];
  getSurfaceCases: (provider: Record<string, unknown>) => Case[];
  runConformance: (cases: Case[]) => Promise<{ passed: string[]; failed: { name: string; error: string }[] }>;
};

const loadConformance = (): ConformanceModule | null => {
  try {
    const mod = require('@miden-sdk/miden-wallet-adapter-miden');
    return typeof mod?.getSurfaceCases === 'function' ? mod : null;
  } catch {
    return null;
  }
};

const conformance = loadConformance();

/**
 * Methods a provider is known not to implement.
 *
 * These are asserted exactly, not tolerated: adding a gap fails the test, and
 * so does *closing* one without removing it here. Both are things someone
 * should notice — the second is the whole point, since a silently-fixed gap
 * that nobody records is how the list rots back into being wrong.
 */
const KNOWN_GAPS: Record<string, string[]> = {
  'mobile (dApp browser injection script)': ['createAccount'],
  'desktop (Tauri injection script)': ['requestGuardianInfo', 'createAccount']
};

/**
 * Evaluates an injected provider script and returns the `window.midenWallet`
 * it installs.
 *
 * A FRESH JSDOM per call is load-bearing. The mobile script installs
 * `midenWallet` as a non-writable property, so reusing one window silently
 * re-measures the previous provider — which reports the Tauri provider as
 * having methods it does not have.
 *
 * Only the surface half of the suite is used on these: they are plain scripts
 * injected into a page with no wallet behind the bridge, so a round-trip would
 * fail for reasons that say nothing about conformance.
 */
const evaluateProvider = (source: string): Record<string, unknown> | null => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only'
  });
  const win = dom.window as unknown as Record<string, unknown>;
  // The scripts talk to their host over message handlers that do not exist
  // here. Stub enough for the IIFE to reach its `window.midenWallet =` line.
  win.webkit = { messageHandlers: { cordova_iab: { postMessage: () => {} } } };
  win.mobileApp = { postMessage: () => {} };
  win.__TAURI__ = { invoke: () => Promise.resolve() };
  try {
    (dom.window as unknown as { eval: (s: string) => void }).eval(source);
  } catch {
    // A provider that throws before installing itself yields null, which the
    // tests report as a failure rather than swallowing.
  }
  return (win.midenWallet as Record<string, unknown>) ?? null;
};

const describeIfAvailable = conformance ? describe : describe.skip;

if (!conformance) {
  // eslint-disable-next-line no-console
  console.warn(
    '[conformance] @miden-sdk/miden-wallet-adapter-miden has no conformance export yet; ' +
      'this suite skips until a release ships one. Bump the adapter to activate it.'
  );
}

describeIfAvailable('MidenWallet conformance', () => {
  it('imported the real suite, not a mock', () => {
    // This repo mocks the adapter in a dozen files. If a moduleNameMapper or a
    // setup-level mock ever caught this import, the suite would become a green
    // no-op — the identical failure mode it exists to prevent, one layer up.
    expect(conformance!.CONFORMANCE_BUILD.real).toBe(true);
    expect(conformance!.CONFORMANCE_BUILD.methodCount).toBe(conformance!.MIDEN_WALLET_METHODS.length);
  });

  it('the extension provider implements every method', async () => {
    const { MidenWindowObject } = require('lib/adapter/midenWindowObject') as {
      MidenWindowObject: new () => Record<string, unknown>;
    };
    const { failed } = await conformance!.runConformance(conformance!.getSurfaceCases(new MidenWindowObject()));
    expect(failed.map(f => f.name)).toEqual([]);
  });

  describe.each([
    [
      'mobile (dApp browser injection script)',
      () =>
        (
          require('lib/dapp-browser/injection-script') as {
            INJECTION_SCRIPT: string;
          }
        ).INJECTION_SCRIPT
    ],
    [
      'desktop (Tauri injection script)',
      () => fs.readFileSync(path.resolve(__dirname, '../../../src-tauri/scripts/dapp-injection.js'), 'utf8')
    ]
  ])('%s', (name, readSource) => {
    it('is missing exactly its known gaps, no more and no fewer', async () => {
      const provider = evaluateProvider(readSource());
      expect(provider).not.toBeNull();

      const { failed } = await conformance!.runConformance(conformance!.getSurfaceCases(provider!));

      const missing = failed.map(f => f.name.replace(/^implements |\(\)$/g, '')).sort();
      const expected = KNOWN_GAPS[name] ?? [];
      expect(missing).toEqual([...expected].sort());
    });
  });
});
