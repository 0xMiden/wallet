/* eslint-disable import/first */
/**
 * Tests for the dapp-browser barrel (`index.ts`).
 *
 * `index.ts` carries no logic of its own — it is a pure public-API
 * surface that re-exports the package's building blocks from their
 * source modules. These tests pin that surface: every value export must
 * be present AND be the exact same reference as the underlying source
 * module's export (so a barrel typo re-pointing one name at another
 * can't slip through). Exercising a representative call through the
 * barrel additionally proves the wiring is live, not just name-equal.
 *
 * The barrel transitively pulls in `@capacitor/preferences`,
 * `@capacitor/filesystem`, and `lib/miden/back/actions`, so those native
 * boundaries are mocked exactly the way the sibling suites mock them.
 * jest.mock is hoisted above the imports at runtime; the `import/first`
 * rule doesn't know that, hence the disable above.
 */

const mockProcessDApp = jest.fn(async () => ({ ok: true }));
jest.mock('lib/miden/back/actions', () => ({
  processDApp: (...args: unknown[]) => mockProcessDApp(...args)
}));

const prefStore: Record<string, string> = {};
jest.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: jest.fn(async ({ key }: { key: string }) => ({ value: prefStore[key] ?? null })),
    set: jest.fn(async ({ key, value }: { key: string; value: string }) => {
      prefStore[key] = value;
    }),
    remove: jest.fn(async ({ key }: { key: string }) => {
      delete prefStore[key];
    })
  }
}));

const fsStore: Record<string, { data: string }> = {};
jest.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    mkdir: jest.fn(async () => undefined),
    writeFile: jest.fn(async ({ path, data }: { path: string; data: string }) => {
      fsStore[path] = { data };
    }),
    readFile: jest.fn(async ({ path }: { path: string }) => {
      const entry = fsStore[path];
      if (!entry) throw new Error('ENOENT');
      return { data: entry.data };
    }),
    deleteFile: jest.fn(async ({ path }: { path: string }) => {
      delete fsStore[path];
    }),
    rmdir: jest.fn(async () => undefined)
  }
}));

import * as barrel from './index';
import * as categoryData from './category-data';
import * as dappSession from './dapp-session';
import * as faviconCache from './favicon-cache';
import * as featuredDapps from './featured-dapps';
import * as injectionScript from './injection-script';
import * as messageHandler from './message-handler';
import * as recentDapps from './recent-dapps';
import * as sessionPersistence from './session-persistence';
import * as snapshotPersistence from './snapshot-persistence';
import * as useDappConfirmationMod from './use-dapp-confirmation';
import * as webviewRect from './webview-rect';

describe('dapp-browser barrel — re-export identity', () => {
  // Each tuple: [name on the barrel, the source module's namespace, name
  // on the source module]. Identity equality proves the barrel points the
  // public name at the intended implementation, not merely at *something*
  // truthy of the same shape.
  const cases: Array<[keyof typeof barrel, Record<string, unknown>, string]> = [
    // injection-script
    ['INJECTION_SCRIPT', injectionScript, 'INJECTION_SCRIPT'],
    // message-handler
    ['handleWebViewMessage', messageHandler, 'handleWebViewMessage'],
    // dapp-session
    ['createDappSession', dappSession, 'createDappSession'],
    ['parseOrigin', dappSession, 'parseOrigin'],
    ['getDappHostname', dappSession, 'getDappHostname'],
    ['getDappDisplayName', dappSession, 'getDappDisplayName'],
    // favicon-cache
    ['buildFaviconUrl', faviconCache, 'buildFaviconUrl'],
    ['getFaviconUrl', faviconCache, 'getFaviconUrl'],
    ['getFallbackColor', faviconCache, 'getFallbackColor'],
    ['getFallbackLetter', faviconCache, 'getFallbackLetter'],
    // webview-rect
    ['rectFromDOMRect', webviewRect, 'rectFromDOMRect'],
    ['rectsEqual', webviewRect, 'rectsEqual'],
    // use-dapp-confirmation
    ['useDappConfirmation', useDappConfirmationMod, 'useDappConfirmation'],
    // featured-dapps
    ['FEATURED_DAPPS', featuredDapps, 'FEATURED_DAPPS'],
    ['CAROUSEL_DAPPS', featuredDapps, 'CAROUSEL_DAPPS'],
    ['EXPLORE_GRID_DAPPS', featuredDapps, 'EXPLORE_GRID_DAPPS'],
    // category-data
    ['CATEGORIES', categoryData, 'CATEGORIES'],
    // recent-dapps
    ['getRecentDapps', recentDapps, 'getRecentDapps'],
    ['recordRecentDapp', recentDapps, 'recordRecentDapp'],
    ['forgetRecentDapp', recentDapps, 'forgetRecentDapp'],
    // session-persistence
    ['loadPersistedSessions', sessionPersistence, 'loadPersistedSessions'],
    ['savePersistedSessions', sessionPersistence, 'savePersistedSessions'],
    ['upsertPersistedSession', sessionPersistence, 'upsertPersistedSession'],
    ['removePersistedSession', sessionPersistence, 'removePersistedSession'],
    ['clearAllPersistedSessions', sessionPersistence, 'clearAllPersistedSessions'],
    ['toPersisted', sessionPersistence, 'toPersisted'],
    ['fromPersisted', sessionPersistence, 'fromPersisted'],
    // snapshot-persistence
    ['writeSnapshotToDisk', snapshotPersistence, 'writeSnapshotToDisk'],
    ['readSnapshotFromDisk', snapshotPersistence, 'readSnapshotFromDisk'],
    ['removeSnapshotFromDisk', snapshotPersistence, 'removeSnapshotFromDisk'],
    ['clearAllSnapshotsFromDisk', snapshotPersistence, 'clearAllSnapshotsFromDisk']
  ];

  it.each(cases)('re-exports %s from its source module by identity', (barrelName, sourceMod, sourceName) => {
    expect(barrel[barrelName]).toBeDefined();
    expect(barrel[barrelName]).toBe(sourceMod[sourceName]);
  });

  it('exposes exactly the expected set of value exports (no extras, no gaps)', () => {
    const expected = cases.map(([name]) => name).sort();
    // Only runtime value exports survive to the namespace object; `export
    // type { ... }` lines are erased by the compiler and never appear here.
    const actual = Object.keys(barrel).sort();
    expect(actual).toEqual(expected);
  });
});

describe('dapp-browser barrel — live wiring smoke checks', () => {
  it('function exports are callable functions', () => {
    const fns: Array<keyof typeof barrel> = [
      'handleWebViewMessage',
      'createDappSession',
      'parseOrigin',
      'getDappHostname',
      'getDappDisplayName',
      'buildFaviconUrl',
      'getFaviconUrl',
      'getFallbackColor',
      'getFallbackLetter',
      'rectFromDOMRect',
      'rectsEqual',
      'useDappConfirmation',
      'getRecentDapps',
      'recordRecentDapp',
      'forgetRecentDapp',
      'loadPersistedSessions',
      'savePersistedSessions',
      'upsertPersistedSession',
      'removePersistedSession',
      'clearAllPersistedSessions',
      'toPersisted',
      'fromPersisted',
      'writeSnapshotToDisk',
      'readSnapshotFromDisk',
      'removeSnapshotFromDisk',
      'clearAllSnapshotsFromDisk'
    ];
    for (const name of fns) {
      expect(typeof barrel[name]).toBe('function');
    }
  });

  it('drives a pure re-exported function through the barrel', () => {
    // parseOrigin is side-effect-free — a good witness that the barrel
    // hands back a working implementation rather than a stale binding.
    expect(barrel.parseOrigin('https://miden.xyz/swap?x=1')).toBe('https://miden.xyz');
    expect(barrel.getDappHostname('https://www.uniswap.org')).toBe('uniswap.org');
  });

  it('constant exports carry real data', () => {
    expect(typeof barrel.INJECTION_SCRIPT).toBe('string');
    expect(barrel.INJECTION_SCRIPT.length).toBeGreaterThan(0);
    expect(Array.isArray(barrel.FEATURED_DAPPS)).toBe(true);
    expect(barrel.FEATURED_DAPPS.length).toBeGreaterThan(0);
    expect(Array.isArray(barrel.CAROUSEL_DAPPS)).toBe(true);
    expect(Array.isArray(barrel.EXPLORE_GRID_DAPPS)).toBe(true);
    expect(Array.isArray(barrel.CATEGORIES)).toBe(true);
    expect(barrel.CATEGORIES.length).toBeGreaterThan(0);
  });
});
