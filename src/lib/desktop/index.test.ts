/* eslint-disable import/first */
/**
 * Tests for the desktop barrel (`index.ts`).
 *
 * `index.ts` carries no logic of its own — it is a pure public-API
 * surface for the Tauri desktop integration that re-exports the
 * package's building blocks from their source modules. These tests pin
 * that surface: every value export must be present AND be the exact
 * same reference as the underlying source module's export (so a barrel
 * typo re-pointing one name at another, or a dropped export, can't slip
 * through). Exercising a representative call/render through the barrel
 * additionally proves the wiring is live, not just name-equal.
 *
 * The barrel transitively pulls in the Tauri native boundaries
 * (`@tauri-apps/api/core`, `@tauri-apps/api/event`), the i18n runtime,
 * the wallet store, and the dApp message handler's backend actions.
 * Those boundaries are mocked exactly the way the sibling suites mock
 * them so the barrel loads without a live desktop/native environment.
 * jest.mock is hoisted above the imports at runtime; the `import/first`
 * rule doesn't know that, hence the disable above.
 */

// --- Native / heavy boundary mocks (hoisted above the imports) ---------

// Tauri command bridge used by secure-storage + dapp-browser.
const mockInvoke = jest.fn<Promise<undefined>, unknown[]>(async () => undefined);
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args)
}));

// Tauri event bridge used by dapp-browser's listeners.
const mockListen = jest.fn<Promise<() => void>, unknown[]>(async () => () => {});
jest.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args)
}));

// i18n runtime pulled in by DesktopDappConfirmationModal.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Wallet store pulled in by DesktopDappConfirmationModal — the selector
// form `useWalletStore(s => s.x)` just needs to return undefined here.
jest.mock('lib/store', () => ({
  useWalletStore: jest.fn(() => undefined)
}));

// Backend action reached transitively via the dApp message handler that
// DesktopDappHandler imports; mocked the way the sibling barrel does.
jest.mock('lib/miden/back/actions', () => ({
  processDApp: jest.fn(async () => ({ ok: true }))
}));

import React from 'react';

import { render } from '@testing-library/react';

import * as dappBrowser from './dapp-browser';
import * as confirmationModal from './DesktopDappConfirmationModal';
import * as handler from './DesktopDappHandler';
import * as barrel from './index';
import * as secureStorage from './secure-storage';

// `import * as barrel` yields a namespace binding that ESLint's
// import/namespace rule refuses to index by a computed key (it can't
// statically prove a dynamic key exists on the namespace). This alias is
// the SAME object — every property is the identical reference — so the
// identity assertions below are unchanged; it only lets us look export
// names up dynamically without tripping the rule.
const barrelByName = barrel as unknown as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('desktop barrel — re-export identity', () => {
  // Each tuple: [name on the barrel, the source module's namespace, name
  // on the source module]. Identity equality proves the barrel points the
  // public name at the intended implementation, not merely at *something*
  // truthy of the same shape.
  const cases: Array<[keyof typeof barrel, Record<string, unknown>, string]> = [
    // secure-storage
    ['isHardwareSecurityAvailable', secureStorage, 'isHardwareSecurityAvailable'],
    ['hasHardwareKey', secureStorage, 'hasHardwareKey'],
    ['generateHardwareKey', secureStorage, 'generateHardwareKey'],
    ['encryptWithHardwareKey', secureStorage, 'encryptWithHardwareKey'],
    ['decryptWithHardwareKey', secureStorage, 'decryptWithHardwareKey'],
    ['deleteHardwareKey', secureStorage, 'deleteHardwareKey'],
    // dapp-browser
    ['openDappWindow', dappBrowser, 'openDappWindow'],
    ['closeDappWindow', dappBrowser, 'closeDappWindow'],
    ['dappNavigate', dappBrowser, 'dappNavigate'],
    ['dappGetUrl', dappBrowser, 'dappGetUrl'],
    ['onDappWalletRequest', dappBrowser, 'onDappWalletRequest'],
    ['onDappWindowClose', dappBrowser, 'onDappWindowClose'],
    ['sendDappWalletResponse', dappBrowser, 'sendDappWalletResponse'],
    // DesktopDappHandler
    ['DesktopDappHandler', handler, 'DesktopDappHandler'],
    ['useDesktopDappHandler', handler, 'useDesktopDappHandler'],
    // DesktopDappConfirmationModal
    ['DesktopDappConfirmationModal', confirmationModal, 'DesktopDappConfirmationModal']
  ];

  it.each(cases)('re-exports %s from its source module by identity', (barrelName, sourceMod, sourceName) => {
    expect(barrelByName[barrelName]).toBeDefined();
    expect(barrelByName[barrelName]).toBe(sourceMod[sourceName]);
  });

  it('exposes exactly the expected set of value exports (no extras, no gaps)', () => {
    const expected = cases.map(([name]) => name).sort();
    // Only runtime value exports survive to the namespace object; the
    // `export type { DappWalletRequest, DappWalletRequestEvent }` line is
    // erased by the compiler and never appears here.
    const actual = Object.keys(barrel).sort();
    expect(actual).toEqual(expected);
  });

  it('does NOT leak the type-only re-exports as runtime values', () => {
    expect(Object.keys(barrel)).not.toContain('DappWalletRequest');
    expect(Object.keys(barrel)).not.toContain('DappWalletRequestEvent');
  });
});

describe('desktop barrel — export shapes', () => {
  it('re-exports every secure-storage + dapp-browser helper as a function', () => {
    const fns: Array<keyof typeof barrel> = [
      'isHardwareSecurityAvailable',
      'hasHardwareKey',
      'generateHardwareKey',
      'encryptWithHardwareKey',
      'decryptWithHardwareKey',
      'deleteHardwareKey',
      'openDappWindow',
      'closeDappWindow',
      'dappNavigate',
      'dappGetUrl',
      'onDappWalletRequest',
      'onDappWindowClose',
      'sendDappWalletResponse',
      'useDesktopDappHandler'
    ];
    for (const name of fns) {
      expect(typeof barrelByName[name]).toBe('function');
    }
  });

  it('re-exports the two React components as functions', () => {
    expect(typeof barrel.DesktopDappHandler).toBe('function');
    expect(typeof barrel.DesktopDappConfirmationModal).toBe('function');
  });
});

describe('desktop barrel — live wiring smoke checks', () => {
  it('drives a re-exported dapp-browser command through the barrel to the Tauri bridge', async () => {
    await barrel.openDappWindow('https://miden.xyz');
    expect(mockInvoke).toHaveBeenCalledWith('open_dapp_window', { url: 'https://miden.xyz' });
  });

  it('re-exported secure-storage helper reaches the Tauri bridge is guarded off-desktop', async () => {
    // isHardwareSecurityAvailable short-circuits to false when not running
    // in a Tauri (desktop) context — jsdom has no `__TAURI__` on window —
    // so it resolves false without ever touching the mocked invoke bridge.
    await expect(barrel.isHardwareSecurityAvailable()).resolves.toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('renders the re-exported DesktopDappHandler to null without throwing', () => {
    const { container } = render(React.createElement(barrel.DesktopDappHandler));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the re-exported DesktopDappConfirmationModal to null without throwing', () => {
    const { container } = render(React.createElement(barrel.DesktopDappConfirmationModal));
    expect(container).toBeEmptyDOMElement();
  });
});
