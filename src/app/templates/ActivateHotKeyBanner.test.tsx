import React from 'react';

import { act, render, screen } from '@testing-library/react';

import ActivateHotKeyBanner, { ActivateHotKeyBanner as NamedActivateHotKeyBanner } from './ActivateHotKeyBanner';

// ---------------------------------------------------------------------------
// Mocks.
//
// ActivateHotKeyBanner is a thin controller that renders through the shared
// `PromptCard` and, on tap, drives a cold-signed hot-key rotation across a
// chain of native/store-backed collaborators. We stub every collaborator so
// the only real code exercised (and measured) is ActivateHotKeyBanner.tsx.
//
//   - `components/ui`'s PromptCard is captured so tests can read the computed
//     props (title/body/variant/className) and invoke its `onClick` — the sole
//     entry into the rotation flow — directly.
//   - `lib/miden/front`'s `useAccount`, the activity helpers, the guardian-sync
//     provider, platform/settings predicates, haptics, and the store are all
//     jest.fn()s the tests script per-case.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Capture the latest props PromptCard receives so tests can invoke its
// `onClick` (the only driver of the rotation flow) and read the rendered
// title/body plus the forwarded `variant`/`className`.
const pcHolder: { props: any } = { props: null };
jest.mock('components/ui', () => ({
  __esModule: true,
  PromptCard: (props: any) => {
    pcHolder.props = props;
    return (
      <div
        data-testid="prompt-card"
        data-variant={props.variant}
        data-classname={props.className ?? ''}
        role={props.onClick ? 'button' : undefined}
        onClick={props.onClick}
      >
        <span data-testid="pc-title">{props.title}</span>
        <span data-testid="pc-body">{props.body}</span>
      </div>
    );
  }
}));

const mockInitiate = jest.fn();
const mockRequestSWProcessing = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...a: unknown[]) => mockInitiate(...a),
  requestSWTransactionProcessing: (...a: unknown[]) => mockRequestSWProcessing(...a)
}));

const mockUseAccount = jest.fn();
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount()
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { __provider: true } }));

const mockHapticLight = jest.fn();
jest.mock('lib/mobile/haptics', () => ({ hapticLight: (...a: unknown[]) => mockHapticLight(...a) }));

const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({ isExtension: () => mockIsExtension() }));

const mockIsDelegateProofEnabled = jest.fn();
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => mockIsDelegateProofEnabled()
}));

// Store exposes `.getState()` returning the object whose `openTransactionModal`
// the success path fires.
const mockOpenTransactionModal = jest.fn();
const mockState: any = { openTransactionModal: mockOpenTransactionModal };
jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => mockState }
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

// Drive the captured PromptCard.onClick (the only entry into the rotation
// flow), awaiting the async handler and letting React flush effects.
const click = async () => {
  await act(async () => {
    await pcHolder.props.onClick();
  });
  await flush();
};

const title = () => screen.getByTestId('pc-title').textContent;
const body = () => screen.getByTestId('pc-body').textContent;

beforeEach(() => {
  jest.clearAllMocks();
  pcHolder.props = null;
  mockState.openTransactionModal = mockOpenTransactionModal;
  mockUseAccount.mockReturnValue({ publicKey: 'pk_1' });
  mockIsExtension.mockReturnValue(false);
  mockIsDelegateProofEnabled.mockReturnValue(false);
  mockInitiate.mockResolvedValue('tx-1');
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
describe('ActivateHotKeyBanner — rendering', () => {
  it('renders a warning PromptCard with the banner title/body and an onClick handler', () => {
    render(<ActivateHotKeyBanner />);

    expect(title()).toBe('activateHotKeyBannerTitle');
    // No error yet → `error ?? t(...)` falls through to the body key.
    expect(body()).toBe('activateHotKeyBannerBody');

    const card = screen.getByTestId('prompt-card');
    expect(card).toHaveAttribute('data-variant', 'warning');
    // className is optional and undefined here → forwarded as undefined.
    expect(card).toHaveAttribute('data-classname', '');
    expect(typeof pcHolder.props.onClick).toBe('function');
  });

  it('forwards the className prop through to the PromptCard', () => {
    render(<ActivateHotKeyBanner className="my-custom-class" />);

    expect(screen.getByTestId('prompt-card')).toHaveAttribute('data-classname', 'my-custom-class');
  });

  it('exposes the same component as the default and named export', () => {
    expect(ActivateHotKeyBanner).toBe(NamedActivateHotKeyBanner);
  });
});

// ---------------------------------------------------------------------------
// Rotation flow — success, delegate flag, extension SW processing.
// ---------------------------------------------------------------------------
describe('ActivateHotKeyBanner — rotation success', () => {
  it('fires haptics, initiates the rotation and opens the tx modal (non-extension build)', async () => {
    render(<ActivateHotKeyBanner />);

    await click();

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    // Cold-signed rotation: publicKey, delegate flag (false), provider.
    expect(mockInitiate).toHaveBeenCalledTimes(1);
    expect(mockInitiate).toHaveBeenCalledWith('pk_1', false, { __provider: true });
    expect(mockOpenTransactionModal).toHaveBeenCalledTimes(1);
    // Non-extension build skips the service-worker processing nudge.
    expect(mockRequestSWProcessing).not.toHaveBeenCalled();

    // Success path never sets an error → body stays on the copy key.
    expect(body()).toBe('activateHotKeyBannerBody');
  });

  it('passes the delegate-proof flag through when enabled', async () => {
    mockIsDelegateProofEnabled.mockReturnValue(true);
    render(<ActivateHotKeyBanner />);

    await click();

    expect(mockInitiate).toHaveBeenCalledWith('pk_1', true, { __provider: true });
  });

  it('requests service-worker processing on extension builds', async () => {
    mockIsExtension.mockReturnValue(true);
    render(<ActivateHotKeyBanner />);

    await click();

    expect(mockRequestSWProcessing).toHaveBeenCalledTimes(1);
    expect(mockOpenTransactionModal).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Rotation flow — errors and the in-flight guard.
// ---------------------------------------------------------------------------
describe('ActivateHotKeyBanner — errors and guards', () => {
  it('surfaces a thrown Error message in the card body', async () => {
    mockInitiate.mockRejectedValue(new Error('initiate exploded'));
    render(<ActivateHotKeyBanner />);

    await click();

    // catch → setError(e.message); body renders the error instead of the copy.
    expect(body()).toBe('initiate exploded');
    // Failure short-circuits before opening the modal / SW nudge.
    expect(mockOpenTransactionModal).not.toHaveBeenCalled();
    expect(mockRequestSWProcessing).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error rejection into the card body', async () => {
    mockInitiate.mockRejectedValue('plain string failure');
    render(<ActivateHotKeyBanner />);

    await click();

    // catch → setError(String(e)).
    expect(body()).toBe('plain string failure');
  });

  it('re-enables submission after a failure and clears the prior error on retry', async () => {
    // First tap fails (Error branch), which also resets `submitting` to false.
    mockInitiate.mockRejectedValueOnce(new Error('first boom'));
    render(<ActivateHotKeyBanner />);

    await click();
    expect(body()).toBe('first boom');

    // Second tap is allowed (submitting was cleared): setError(null) wipes the
    // stale message and the now-resolving initiate succeeds.
    await click();

    expect(mockInitiate).toHaveBeenCalledTimes(2);
    expect(mockOpenTransactionModal).toHaveBeenCalledTimes(1);
    expect(body()).toBe('activateHotKeyBannerBody');
  });

  it('ignores taps while a rotation is already in flight (submitting guard)', async () => {
    // A successful rotation leaves `submitting` latched true (never reset on the
    // happy path), so the recomputed onClick guards re-entry.
    render(<ActivateHotKeyBanner />);

    await click();
    expect(mockInitiate).toHaveBeenCalledTimes(1);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);

    // Second tap hits `if (submitting) return;` before any side effect.
    await click();

    expect(mockInitiate).toHaveBeenCalledTimes(1);
    expect(mockHapticLight).toHaveBeenCalledTimes(1);
    expect(mockOpenTransactionModal).toHaveBeenCalledTimes(1);
  });
});
