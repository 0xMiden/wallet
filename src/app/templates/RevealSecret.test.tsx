import React from 'react';

import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import RevealSecret from './RevealSecret';

// Keep the REAL AccountBanner so we exercise the integration between
// RevealSecret and AccountBanner — the bug was RevealSecret rendering
// AccountBanner without an `account` prop, which AccountBanner then
// dereferenced (`account!.name`) and crashed on for regular accounts.

const mockAccount = { name: 'My Test Account', publicKey: 'mtst1qtestaddress0000' };

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/atoms/Alert', () => () => null);
jest.mock('app/atoms/FormField', () => React.forwardRef(() => null));

jest.mock('components/Button', () => ({
  Button: ({ onClick, title, disabled }: { onClick: () => void; title: string; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>
      {title}
    </button>
  ),
  ButtonVariant: { Primary: 'Primary', Secondary: 'Secondary' }
}));

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: { Wallet: 'Wallet' }
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { hasHardwareProtector: jest.fn().mockResolvedValue(false) }
}));

const mockSetSecret = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockAccount,
  useSecretState: () => [null, mockSetSecret],
  useMidenContext: () => ({
    revealMnemonic: jest.fn(),
    revealPrivateKey: jest.fn(),
    revealHotKey: jest.fn(),
    revealGuardianKeys: jest.fn()
  })
}));

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: jest.fn(),
  withWasmClientLock: jest.fn((cb: () => unknown) => cb())
}));

jest.mock('lib/miden/sdk/resolve-public-key-commitments', () => ({
  resolvePublicKeyCommitments: jest.fn(() => [])
}));

jest.mock('lib/mobile/useHideNavbarWhileOpen', () => ({
  useHideNavbarWhileOpen: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isMobile: () => false
}));

jest.mock('lib/ui/useCopyToClipboard', () => ({
  __esModule: true,
  default: () => ({ fieldRef: { current: null } })
}));

describe('RevealSecret - account banner', () => {
  let testRoot: ReturnType<typeof createRoot> | null = null;
  let testContainer: HTMLDivElement | null = null;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  afterEach(async () => {
    if (testRoot) {
      await act(async () => {
        testRoot!.unmount();
      });
      testRoot = null;
    }
    if (testContainer) {
      testContainer.remove();
      testContainer = null;
    }
  });

  // Regression: a regular (non-Guardian) account reaches reveal='private-key',
  // which is the only branch that renders <AccountBanner>. Before the fix the
  // banner was rendered without an `account` prop and threw
  // "Cannot read properties of undefined (reading 'name')" on mount.
  it('renders the current account in the private-key reveal banner without crashing', async () => {
    testContainer = document.createElement('div');
    testRoot = createRoot(testContainer);

    await act(async () => {
      testRoot!.render(<RevealSecret reveal="private-key" />);
    });
    // Flush the Vault.hasHardwareProtector() promise so the banner mounts.
    await act(async () => {
      await Promise.resolve();
    });

    expect(testContainer.textContent).toContain('My Test Account');
  });
});
