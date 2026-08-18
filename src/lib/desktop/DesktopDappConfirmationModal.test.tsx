/* eslint-disable import/first */
/**
 * Tests for `DesktopDappConfirmationModal` — the desktop dApp approval prompt.
 *
 * SECURITY REGRESSION. The prompt used to be a JS string handed to
 * `show_dapp_confirmation_overlay` → `dapp_window.eval(...)`, i.e. injected into the
 * REQUESTING PAGE's main world. Its DOM, its `#miden-btn-approve` listener and its
 * standing-private-data checkbox were all page-owned, so a `MutationObserver` in the
 * dApp could tick the box and fire a synthetic click the instant the overlay
 * appeared — granting standing private-data access and executing sends with no user
 * interaction beyond having the page open. The verdict then came back over a
 * navigation to a fixed host that any page could perform itself, with no proof it
 * came from the wallet.
 *
 * These tests pin the replacement: the request drives `dappConfirmationStore`, the
 * shared `<DappConfirmationModal>` (the one mobile renders) is mounted in the
 * WALLET's own React tree, and the verdict comes from a click on that tree. The real
 * modal is rendered, not a stub, so "the approval control exists in the wallet
 * document" is what is actually asserted.
 */

import React from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { act, fireEvent, render, screen } from '@testing-library/react';

import {
  dappConfirmationStore,
  DAppConfirmationRequest,
  DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';

import DesktopDappConfirmationModal, {
  DesktopDappConfirmationModal as NamedDesktopDappConfirmationModal
} from './DesktopDappConfirmationModal';

// ── ./dapp-browser — Tauri command bindings ────────────────────────
// Only `focusMainWindow` may remain. The mock deliberately exposes NOTHING else, so
// re-introducing an overlay-eval call would fail with "is not a function" instead of
// silently passing.
const mockFocusMainWindow: jest.Mock = jest.fn(() => Promise.resolve());
jest.mock('./dapp-browser', () => ({
  focusMainWindow: () => mockFocusMainWindow()
}));

// ── @demox-labs/miden-wallet-adapter-base — real enum values ───────
// The package is untransformed ESM, so jest substitutes the repo-level manual mock,
// whose `AllowedPrivateData` is `{}` and whose `PrivateDataPermission` has neither
// member. Every scope assertion would then compare `undefined` with `undefined` and
// pass regardless of behaviour; these values mirror the real enums.
jest.mock('@demox-labs/miden-wallet-adapter-base', () => ({
  PrivateDataPermission: { UponRequest: 'UPON_REQUEST', Auto: 'AUTO' },
  AllowedPrivateData: { None: 0, Assets: 1, Notes: 2, Storage: 4, All: 65535 }
}));

// ── lib/platform — control the desktop guard ───────────────────────
const mockIsDesktop: jest.Mock = jest.fn(() => true);
jest.mock('lib/platform', () => ({
  isDesktop: () => mockIsDesktop(),
  isMobile: () => false
}));

// ── lib/store — selector-based wallet store stub ───────────────────
let mockCurrentAccount: { publicKey: string } | null = null;
let mockAccounts: Array<{ publicKey: string }> = [];
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) =>
    selector({ currentAccount: mockCurrentAccount, accounts: mockAccounts })
}));

// ── shared-modal environment (mirrors DappConfirmationModal.test.tsx) ──
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k })
}));

jest.mock('lib/animation', () => ({
  useSprings: () => ({ overlay: {}, modal: {}, sheetPresent: {}, reduceMotion: false })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn()
}));

jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: () => undefined
}));

jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const passthrough = ReactActual.forwardRef(
    ({ children, ...rest }: { children?: React.ReactNode }, ref: React.Ref<HTMLDivElement>) =>
      ReactActual.createElement('div', { ref, ...rest }, children)
  );
  return { motion: new Proxy({}, { get: () => passthrough }) };
});

jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {}
}));

const FULL_KEY = 'mtst1apsnkg6x57mhxyrq09aavyq08yu5dy4p_qr7qqq9wr6w';

function buildRequest(overrides: Partial<DAppConfirmationRequest> = {}): DAppConfirmationRequest {
  return {
    id: 'req-1',
    type: 'connect',
    origin: 'https://faucet.testnet.miden.io',
    appMeta: { name: 'Miden Faucet' },
    network: 'testnet',
    networkRpc: 'https://rpc.testnet.miden.io',
    privateDataPermission: PrivateDataPermission.UponRequest,
    allowedPrivateData: AllowedPrivateData.None,
    existingPermission: false,
    ...overrides
  } as DAppConfirmationRequest;
}

/** Push a request into the REAL store and expose its eventual resolution. */
function pushRequest(request: DAppConfirmationRequest): { get: () => DAppConfirmationResult | undefined } {
  let resolved: DAppConfirmationResult | undefined;
  act(() => {
    void dappConfirmationStore.requestConfirmation(request).then(result => {
      resolved = result;
    });
  });
  return { get: () => resolved };
}

/** Flush pending microtasks inside act. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDesktop.mockReturnValue(true);
  mockCurrentAccount = { publicKey: FULL_KEY };
  mockAccounts = [];
});

afterEach(async () => {
  // The store is a module singleton — never leave a request pending for the next test.
  act(() => {
    dappConfirmationStore.resolveConfirmation(undefined, { confirmed: false });
  });
  await flush();
});

describe('DesktopDappConfirmationModal', () => {
  it('renders nothing while no confirmation is pending', () => {
    const { container } = render(<DesktopDappConfirmationModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is exported both as default and by name (App.tsx lazy-imports the named one)', () => {
    expect(NamedDesktopDappConfirmationModal).toBe(DesktopDappConfirmationModal);
  });

  it('stays inert off desktop, so mobile keeps its own provider-rendered modal', async () => {
    mockIsDesktop.mockReturnValue(false);
    const { container } = render(<DesktopDappConfirmationModal />);
    pushRequest(buildRequest());
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
  });

  it('renders the approval in the WALLET window and resolves from a click there', async () => {
    render(<DesktopDappConfirmationModal />);
    const result = pushRequest(buildRequest());
    await flush();

    // The prompt is in this document — the wallet's own React tree — not in a
    // string handed to the dApp webview to evaluate.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Miden Faucet')).toBeInTheDocument();
    expect(screen.getByText('https://faucet.testnet.miden.io')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    });
    await flush();

    expect(result.get()).toMatchObject({ confirmed: true, accountPublicKey: FULL_KEY });
    // And the prompt is gone once answered.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves a denial from the wallet-side Deny button', async () => {
    render(<DesktopDappConfirmationModal />);
    const result = pushRequest(buildRequest());
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'deny' }));
    });
    await flush();

    expect(result.get()).toEqual({ confirmed: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('raises the wallet window once per request, since it sits behind the dApp window', async () => {
    render(<DesktopDappConfirmationModal />);
    pushRequest(buildRequest());
    await flush();

    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);

    // An unrelated store notification must not re-raise the window.
    act(() => {
      dappConfirmationStore.resolveConfirmation('some-other-session', { confirmed: false });
    });
    await flush();
    expect(mockFocusMainWindow).toHaveBeenCalledTimes(1);
  });

  it('still prompts when raising the window fails', async () => {
    mockFocusMainWindow.mockRejectedValueOnce(new Error('no window'));
    render(<DesktopDappConfirmationModal />);
    const result = pushRequest(buildRequest());
    await flush();

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    });
    await flush();
    expect(result.get()).toMatchObject({ confirmed: true });
  });

  it('falls back to the first account when none is current', async () => {
    mockCurrentAccount = null;
    mockAccounts = [{ publicKey: FULL_KEY }];
    render(<DesktopDappConfirmationModal />);
    const result = pushRequest(buildRequest());
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    });
    await flush();
    expect(result.get()).toMatchObject({ accountPublicKey: FULL_KEY });
  });

  it('cannot approve a connect with no account at all', async () => {
    mockCurrentAccount = null;
    mockAccounts = [];
    render(<DesktopDappConfirmationModal />);
    pushRequest(buildRequest());
    await flush();

    expect(screen.getByRole('button', { name: 'approve' })).toBeDisabled();
  });

  it('unsubscribes from the store on unmount', async () => {
    const { unmount } = render(<DesktopDappConfirmationModal />);
    unmount();

    pushRequest(buildRequest());
    await flush();
    // No focus call means the subscription is really gone (the component is
    // unmounted, so there is no tree left to assert against).
    expect(mockFocusMainWindow).not.toHaveBeenCalled();
  });
});
