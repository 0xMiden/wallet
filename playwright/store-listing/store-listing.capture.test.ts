import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isGuardianKeyCommitment } from 'lib/miden/guardian/key-commitment';

import {
  capturePlan,
  exploreCatalogRoute,
  installCaptureShim,
  installHardwareSecurityShim,
  guardianPubkeyRoute,
  guardianPubkeyStubCommitment,
  parkCapturePointer,
  settleCaptureMotion,
  validateCapturePlan
} from './store-listing.capture';

type ManifestAsset = {
  kind: string;
  raw: string;
};

type SceneManifest = {
  platforms: Record<string, ManifestAsset[]>;
};

const repositoryRoot = path.resolve(__dirname, '../..');
const scenes = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'store-listing/scenes.json'), 'utf8')
) as SceneManifest;

const expectedRuntime = {
  appStore: {
    platformFlag: 'ios',
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    raw: { width: 1320, height: 2868 }
  },
  playStore: {
    platformFlag: 'android',
    viewport: { width: 360, height: 640 },
    deviceScaleFactor: 3,
    raw: { width: 1080, height: 1920 }
  },
  chromeWebStore: {
    platformFlag: 'chrome',
    viewport: { width: 400, height: 600 },
    deviceScaleFactor: 1,
    raw: { width: 400, height: 600 }
  }
} as const;

describe('store listing capture plan', () => {
  it('parks the browser pointer away from product controls before capture', async () => {
    const move = jest.fn().mockResolvedValue(undefined);

    await parkCapturePointer({ mouse: { move } });

    expect(move).toHaveBeenCalledWith(0, 0);
  });

  it('waits past the longest product transition before capture', async () => {
    const waitForTimeout = jest.fn().mockResolvedValue(undefined);

    await settleCaptureMotion({ waitForTimeout });

    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('stabilizes guardian probes with and without the signature-scheme query', () => {
    expect(guardianPubkeyRoute.test('https://guardian.example/pubkey')).toBe(true);
    expect(guardianPubkeyRoute.test('https://guardian.example/pubkey?scheme=ecdsa')).toBe(true);
    expect(guardianPubkeyRoute.test('https://guardian.example/accounts')).toBe(false);
  });

  it('stubs the operators with a key the Guardian picker accepts', () => {
    expect(isGuardianKeyCommitment(guardianPubkeyStubCommitment)).toBe(true);
  });

  it('pins the dApp browser scenes to the bundled catalog and waits for its rows', () => {
    const scenes = capturePlan.filter(entry => entry.sceneId.endsWith('-dapp-browser'));
    expect(scenes.map(entry => [entry.sceneId, entry.ready.testId])).toEqual([
      ['ios-dapp-browser', 'dapp-grid-card'],
      ['android-dapp-browser', 'dapp-grid-card']
    ]);
    const published = 'https://raw.githubusercontent.com/0xMiden/wallet-explore/main';
    expect(exploreCatalogRoute.test(`${published}/testnet.json`)).toBe(true);
    expect(exploreCatalogRoute.test(`${published}/icons/faucet.png`)).toBe(true);
    expect(exploreCatalogRoute.test('https://raw.githubusercontent.com/0xMiden/token-list/main/testnet.json')).toBe(
      false
    );
  });

  // The create flow lists the operators only in Choose your Guardian's provider sheet.
  it('captures every guardian scene once the provider sheet is open', () => {
    const scenes = capturePlan.filter(entry => entry.sceneId === 'guardian');
    expect(scenes.map(entry => [entry.platform, entry.ready.testId])).toEqual([
      ['appStore', 'meet-guardian-provider-sheet'],
      ['playStore', 'meet-guardian-provider-sheet'],
      ['chromeWebStore', 'meet-guardian-provider-sheet']
    ]);
  });

  it('waits for the final wallet balance state before dependent captures', () => {
    const walletEntries = capturePlan.filter(
      item => item.sceneId === 'wallet-keys' || item.sceneId === 'chrome-side-panel'
    );

    expect(walletEntries).not.toHaveLength(0);
    expect(walletEntries.every(item => item.ready.text === '+0.00 (0.00%)')).toBe(true);
  });

  it('covers every unique non-icon raw product capture in the scene manifest', () => {
    const manifestPaths = new Set(
      Object.values(scenes.platforms)
        .flat()
        .filter(asset => asset.kind !== 'icon')
        .map(asset => asset.raw)
    );
    const plannedPaths = capturePlan.map(entry => entry.outputPath);

    expect(new Set(plannedPaths)).toEqual(manifestPaths);
    expect(plannedPaths).toHaveLength(manifestPaths.size);
  });

  it.each(Object.entries(expectedRuntime))(
    '%s captures the actual platform branch at the exact raw dimensions',
    (platform, expected) => {
      const entries = capturePlan.filter(entry => entry.platform === platform);
      // The exact count, derived the same way the sibling test above derives manifestPaths: one
      // capture per unique non-icon raw. It is NOT `scenes.platforms[platform].length`, which
      // counts GENERATED assets - playStore's feature graphic reuses an existing raw and its icon
      // renders an SVG, so neither has a capture of its own (6/7/7 here, 6/9/8 there).
      // A missing platform key yields an empty set, so the length assertion below fails loudly
      // rather than silently comparing against nothing.
      const manifestAssets = scenes.platforms[platform] ?? [];
      const expectedCaptures = new Set(manifestAssets.filter(asset => asset.kind !== 'icon').map(asset => asset.raw));
      expect(entries).toHaveLength(expectedCaptures.size);

      for (const entry of entries) {
        expect(entry.platformFlag).toBe(expected.platformFlag);
        expect(entry.viewport).toEqual(expected.viewport);
        expect(entry.deviceScaleFactor).toBe(expected.deviceScaleFactor);
        expect({
          width: entry.viewport.width * entry.deviceScaleFactor,
          height: entry.viewport.height * entry.deviceScaleFactor
        }).toEqual(expected.raw);
      }
    }
  );

  it('defines a deterministic fixture state and observable ready condition for every capture', () => {
    for (const entry of capturePlan) {
      expect(entry.fixtureState).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.ready.testId).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.ready.hiddenTestIds).toContain('alert');
      expect(entry.outputPath).toMatch(/^store-listing\/raw\/(app-store|play-store|chrome-web-store)\/.+\.png$/);
    }
  });

  it('keeps capture metadata free of credentials, key material, and personal fixture data', () => {
    const serialized = JSON.stringify(capturePlan);

    expect(serialized).not.toMatch(/mnemonic|seed phrase|private key|password|personal|mainnet/i);
    expect(serialized).toContain('testnet');
    expect(serialized).toContain('deterministic-fixture');
  });

  it('rejects duplicate outputs and incomplete ready conditions', () => {
    const duplicate = [...capturePlan, { ...capturePlan[0]! }];
    expect(() => validateCapturePlan(duplicate)).toThrow(/duplicate capture output/i);

    const missingReady = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, ready: { ...entry.ready, testId: '' } } : entry
    );
    expect(() => validateCapturePlan(missingReady)).toThrow(/ready test id/i);
  });

  it('rejects platform flags or dimensions that would resize another platform', () => {
    const wrongPlatform = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, platformFlag: 'android' as const } : entry
    );
    expect(() => validateCapturePlan(wrongPlatform)).toThrow(/platform flag/i);

    const wrongViewport = capturePlan.map((entry, index) =>
      index === 0 ? { ...entry, viewport: { ...entry.viewport, width: entry.viewport.width - 1 } } : entry
    );
    expect(() => validateCapturePlan(wrongViewport)).toThrow(/capture dimensions/i);
  });

  describe('capture shim fetch guard', () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

    afterEach(() => {
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
      else Reflect.deleteProperty(globalThis, 'fetch');
      Reflect.deleteProperty(globalThis, 'CapacitorCustomPlatform');
    });

    it('sends overlapping requests through the installed wrapper, not past it', async () => {
      // The guard exists so a wrapper re-entering globalThis.fetch reaches the real browser fetch
      // instead of looping. Held across the await it also caught merely CONCURRENT requests, which
      // is the normal case on a wallet screen: the second one silently skipped the wallet's
      // guardian CORS bypass, so request timing decided which code path a capture exercised.
      const browserCalls: string[] = [];
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: (input: unknown) => {
          browserCalls.push(String(input));
          return Promise.resolve('browser');
        }
      });

      installCaptureShim('ios');

      // A wrapper that never settles until we release it, exactly like an in-flight request.
      let release: (value: string) => void = () => {};
      const pending = new Promise<string>(resolve => {
        release = resolve;
      });
      const wrapperCalls: string[] = [];
      globalThis.fetch = ((input: unknown) => {
        wrapperCalls.push(String(input));
        return pending;
      }) as unknown as typeof globalThis.fetch;

      const first = globalThis.fetch('https://example.test/one');
      const second = globalThis.fetch('https://example.test/two');
      release('wrapped');
      await Promise.all([first, second]);

      expect(wrapperCalls).toEqual(['https://example.test/one', 'https://example.test/two']);
      expect(browserCalls).toEqual([]);
    });
  });

  describe('hardware security shim', () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const pluginFor = { ios: 'LocalBiometric', android: 'HardwareSecurity' } as const;

    beforeEach(() => {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: jest.fn() });
    });

    afterEach(() => {
      if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
      else Reflect.deleteProperty(globalThis, 'fetch');
      Reflect.deleteProperty(globalThis, 'Capacitor');
      Reflect.deleteProperty(globalThis, 'CapacitorCustomPlatform');
    });

    // The real Capacitor core and biometric module, loaded after the init scripts as the capture page's bundle is.
    function loadBiometric() {
      let loaded:
        | {
            biometric: typeof import('lib/biometric');
            plugins: typeof import('lib/biometric/localBiometricPlugin');
          }
        | undefined;
      jest.isolateModules(() => {
        loaded = {
          biometric: jest.requireActual<typeof import('lib/biometric')>('lib/biometric'),
          plugins: jest.requireActual<typeof import('lib/biometric/localBiometricPlugin')>(
            'lib/biometric/localBiometricPlugin'
          )
        };
        // lib/platform requires Capacitor on its first call. Made later, that require would reach the shared
        // registry and reuse the core an earlier case built for its own platform.
        jest.requireActual<typeof import('lib/platform')>('lib/platform').isMobile();
      });
      if (!loaded) throw new Error('the biometric module did not load');
      return loaded;
    }

    it.each(['ios', 'android'] as const)('makes the %s hardware probe pass', async platform => {
      installCaptureShim(platform);
      installHardwareSecurityShim(platform);

      await expect(loadBiometric().biometric.isHardwareSecurityAvailable()).resolves.toBe(true);
    });

    it.each(['ios', 'android'] as const)(
      'leaves the %s probe failing without it, as in the wallet contexts',
      async platform => {
        installCaptureShim(platform);

        await expect(loadBiometric().biometric.isHardwareSecurityAvailable()).resolves.toBe(false);
      }
    );

    it.each(['ios', 'android'] as const)('leaves every other %s plugin method unimplemented', async platform => {
      installCaptureShim(platform);
      installHardwareSecurityShim(platform);

      await expect(loadBiometric().plugins[pluginFor[platform]].hasHardwareKey()).rejects.toMatchObject({
        code: 'UNIMPLEMENTED'
      });
    });
  });
});
