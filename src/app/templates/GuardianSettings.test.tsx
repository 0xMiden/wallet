import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import GuardianSettings from './GuardianSettings';

// ---------------------------------------------------------------------------
// Mocks.
//
// GuardianSettings composes a lot of native/store-backed surface. We isolate
// the component under test by stubbing every collaborator so the only real code
// exercised (and measured) is GuardianSettings.tsx itself:
//   - `ChooseGuardianScreen` is captured so tests can drive `onSubmit` directly
//     and assert the `submitLabel` the component computes.
//   - `GuardianReplaceHotKey` (a sibling with its own native deps) is a stub.
//   - `lib/miden/activity` / `lib/miden/front` / store are jest.fn()s the tests
//     script per-case.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Capture the latest props ChooseGuardianScreen receives so tests can invoke
// its `onSubmit` (the sole driver of GuardianSettings' submit flow) and read the
// computed `submitLabel`.
const mockHolder: { chooseProps: any } = { chooseProps: null };
jest.mock('screens/onboarding/common/ChooseGuardian', () => ({
  ChooseGuardianScreen: (props: any) => {
    mockHolder.chooseProps = props;
    // Only the computed submit label is rendered as text. The endpoint value is
    // read off the captured props (below) instead of rendered, so it can't
    // collide with the component's own "current endpoint" paragraph.
    return (
      <div data-testid="choose-guardian">
        <span data-testid="submit-label">{props.submitLabel}</span>
      </div>
    );
  }
}));

// Sibling with native deps of its own — stub it, and surface the `onClose` it
// receives so we can confirm the prop is threaded through.
jest.mock('app/templates/GuardianReplaceHotKey', () => ({
  __esModule: true,
  default: ({ onClose }: { onClose?: () => void }) => (
    <button data-testid="replace-hot-key" onClick={() => onClose?.()}>
      replace-hot-key
    </button>
  )
}));

const mockInitiate = jest.fn();
const mockRequestSWProcessing = jest.fn();
const mockWaitForCompletion = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateSwitchGuardianTransaction: (...a: unknown[]) => mockInitiate(...a),
  requestSWTransactionProcessing: (...a: unknown[]) => mockRequestSWProcessing(...a),
  waitForTransactionCompletion: (...a: unknown[]) => mockWaitForCompletion(...a)
}));

const mockFetchFromStorage = jest.fn();
const mockOnStorageChanged = jest.fn();
// The last storage-change callback registered by the hook, so tests can fire it.
let mockStorageCb: ((next: string | null | undefined) => void) | null = null;
const mockUnsubscribe = jest.fn();
jest.mock('lib/miden/front', () => ({
  fetchFromStorage: (...a: unknown[]) => mockFetchFromStorage(...a),
  onStorageChanged: (key: string, cb: (next: string | null | undefined) => void) => {
    mockStorageCb = cb;
    return mockOnStorageChanged(key, cb);
  }
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { __provider: true } }));

jest.mock('lib/miden-chain/constants', () => ({ DEFAULT_GUARDIAN_ENDPOINT: 'https://default.guardian' }));

jest.mock('lib/settings/constants', () => ({ GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting' }));

const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({ isExtension: () => mockIsExtension() }));

const mockIsDelegateProofEnabled = jest.fn();
const mockSanitize = jest.fn();
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => mockIsDelegateProofEnabled(),
  sanitizeGuardianUrl: (v: string) => mockSanitize(v)
}));

// Store that satisfies both the hook-selector call form and `.getState()`.
const mockState: any = {
  currentAccount: { publicKey: 'pk_1', guardianEndpoint: 'https://guardian.one' },
  openTransactionModal: jest.fn()
};
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign((selector?: (s: any) => unknown) => (selector ? selector(mockState) : mockState), {
    getState: () => mockState
  })
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const CURRENT = 'https://guardian.one';
const NEW = 'https://guardian.two';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

// Drive the captured ChooseGuardianScreen.onSubmit (the only entry into
// GuardianSettings' submit logic).
const submit = async (guardianEndpoint: string, guardianId = 'g1') => {
  await act(async () => {
    mockHolder.chooseProps.onSubmit({ guardianId, guardianEndpoint });
  });
  await flush();
};

const label = () => screen.getByTestId('submit-label').textContent;

beforeEach(() => {
  jest.clearAllMocks();
  mockStorageCb = null;
  mockHolder.chooseProps = null;
  mockState.currentAccount = { publicKey: 'pk_1', guardianEndpoint: CURRENT };
  mockState.openTransactionModal = jest.fn();
  mockIsExtension.mockReturnValue(false);
  mockIsDelegateProofEnabled.mockReturnValue(false);
  // Default: identity sanitizer, so currentEndpoint mirrors the store value.
  mockSanitize.mockImplementation((v: string) => v);
  mockFetchFromStorage.mockResolvedValue(undefined);
  mockOnStorageChanged.mockReturnValue(mockUnsubscribe);
  mockInitiate.mockResolvedValue('tx-1');
  mockWaitForCompletion.mockResolvedValue({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Rendering / current-endpoint display.
// ---------------------------------------------------------------------------
describe('GuardianSettings — rendering', () => {
  it('shows the per-account guardian endpoint and the default switch label', async () => {
    render(<GuardianSettings />);
    await flush();

    // Per-account endpoint wins → no legacy storage read.
    expect(mockFetchFromStorage).not.toHaveBeenCalled();
    expect(screen.getByText(CURRENT)).toBeInTheDocument();
    expect(label()).toBe('switchGuardian');
    // Props threaded into the ChooseGuardianScreen.
    expect(mockHolder.chooseProps.currentEndpoint).toBe(CURRENT);
    expect(mockHolder.chooseProps.hideHeader).toBe(true);
    expect(mockHolder.chooseProps.allowCustomEndpoint).toBe(true);
    expect(screen.getByTestId('replace-hot-key')).toBeInTheDocument();
  });

  it('falls back to the loading label when the resolved endpoint is empty', async () => {
    // Force the hook to return an empty string so `currentEndpoint || t('loading')`
    // takes the loading branch.
    mockSanitize.mockReturnValue('');
    render(<GuardianSettings />);
    await flush();

    // The endpoint paragraph renders the loading key.
    expect(screen.getAllByText('loading').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// useCurrentGuardianEndpoint — legacy fallback branch.
// ---------------------------------------------------------------------------
describe('GuardianSettings — legacy guardian endpoint fallback', () => {
  beforeEach(() => {
    // Account predates the per-account field → hook consults legacy storage.
    mockState.currentAccount = { publicKey: 'pk_1', guardianEndpoint: undefined };
  });

  it('reads a stored legacy endpoint and subscribes to storage changes', async () => {
    mockFetchFromStorage.mockResolvedValue('https://legacy.stored');
    render(<GuardianSettings />);
    await flush();

    expect(mockFetchFromStorage).toHaveBeenCalledWith('guardian_url_setting');
    expect(mockOnStorageChanged).toHaveBeenCalledWith('guardian_url_setting', expect.any(Function));
    expect(screen.getByText('https://legacy.stored')).toBeInTheDocument();
  });

  it('falls back to the default endpoint when nothing is stored', async () => {
    mockFetchFromStorage.mockResolvedValue(undefined); // stored ?? null -> null
    render(<GuardianSettings />);
    await flush();

    expect(screen.getByText('https://default.guardian')).toBeInTheDocument();
  });

  it('falls back to the default endpoint when the storage read rejects', async () => {
    mockFetchFromStorage.mockRejectedValue(new Error('storage boom'));
    render(<GuardianSettings />);
    await flush();

    expect(screen.getByText('https://default.guardian')).toBeInTheDocument();
  });

  it('reacts to storage-change events (set then clear)', async () => {
    mockFetchFromStorage.mockResolvedValue(undefined);
    render(<GuardianSettings />);
    await flush();
    expect(mockStorageCb).toBeTruthy();

    // A change event pushes a new endpoint.
    await act(async () => {
      mockStorageCb!('https://changed.endpoint');
    });
    expect(screen.getByText('https://changed.endpoint')).toBeInTheDocument();

    // Clearing (undefined -> null) reverts to the default.
    await act(async () => {
      mockStorageCb!(undefined);
    });
    expect(screen.getByText('https://default.guardian')).toBeInTheDocument();
  });

  it('unsubscribes from storage changes on unmount', async () => {
    const { unmount } = render(<GuardianSettings />);
    await flush();

    expect(mockUnsubscribe).not.toHaveBeenCalled();
    act(() => {
      unmount();
    });
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// handleSubmit — guards and the two-stage confirm flow.
// ---------------------------------------------------------------------------
describe('GuardianSettings — submit guards', () => {
  it('does nothing when there is no current account', async () => {
    mockState.currentAccount = null;
    render(<GuardianSettings />);
    await flush();

    await submit(NEW);

    expect(mockInitiate).not.toHaveBeenCalled();
    expect(label()).toBe('switchGuardian');
    // No confirmation text since submit was a no-op.
    expect(screen.queryByText('switchGuardianConfirmation')).not.toBeInTheDocument();
  });

  it('rejects an unchanged endpoint with an error and clears any pending state', async () => {
    render(<GuardianSettings />);
    await flush();

    // Enter confirming with a different endpoint first...
    await submit(NEW);
    expect(label()).toBe('confirmSwitchGuardian');

    // ...then submit the CURRENT endpoint: guarded as unchanged, pending reset.
    await submit(CURRENT);

    expect(mockInitiate).not.toHaveBeenCalled();
    expect(screen.getByText('guardianEndpointUnchanged')).toBeInTheDocument();
    expect(label()).toBe('switchGuardian'); // confirming cleared
  });

  it('requires a second confirming tap on the same endpoint before switching', async () => {
    render(<GuardianSettings />);
    await flush();

    // First tap: enters confirming, shows confirmation copy, no tx yet.
    await submit(NEW);
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(label()).toBe('confirmSwitchGuardian');
    expect(screen.getByText('switchGuardianConfirmation')).toBeInTheDocument();

    // Second tap on the SAME endpoint: fires the switch.
    await submit(NEW);
    await flush();
    expect(mockInitiate).toHaveBeenCalledTimes(1);
  });

  it('re-confirms (without switching) when a different endpoint is chosen while confirming', async () => {
    render(<GuardianSettings />);
    await flush();

    await submit(NEW); // pending = NEW
    expect(label()).toBe('confirmSwitchGuardian');

    // Different endpoint while confirming → pendingEndpoint !== guardianEndpoint,
    // so it re-arms confirmation instead of switching.
    const OTHER = 'https://guardian.three';
    await submit(OTHER);
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(label()).toBe('confirmSwitchGuardian');

    // Now a matching second tap on OTHER actually switches.
    await submit(OTHER);
    await flush();
    expect(mockInitiate).toHaveBeenCalledTimes(1);
    expect(mockInitiate).toHaveBeenCalledWith('pk_1', OTHER, false, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// runSwitch — success, extension SW processing, errors.
// ---------------------------------------------------------------------------
describe('GuardianSettings — runSwitch', () => {
  const confirmSwitch = async (endpoint = NEW) => {
    await submit(endpoint); // first tap → confirming
    await submit(endpoint); // second tap → runSwitch
    await flush();
  };

  it('completes a switch: opens the tx modal and shows the success message', async () => {
    mockIsDelegateProofEnabled.mockReturnValue(true);
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();

    expect(mockInitiate).toHaveBeenCalledWith('pk_1', NEW, true, { __provider: true });
    expect(mockState.openTransactionModal).toHaveBeenCalledTimes(1);
    // Non-extension build skips the service-worker processing nudge.
    expect(mockRequestSWProcessing).not.toHaveBeenCalled();
    expect(mockWaitForCompletion).toHaveBeenCalledWith('tx-1');
    expect(screen.getByText('guardianSwitched')).toBeInTheDocument();
    // Confirmation copy hidden once success shows.
    expect(screen.queryByText('switchGuardianConfirmation')).not.toBeInTheDocument();
    expect(label()).toBe('switchGuardian'); // pending cleared
  });

  it('requests service-worker processing on extension builds', async () => {
    mockIsExtension.mockReturnValue(true);
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();

    expect(mockRequestSWProcessing).toHaveBeenCalledTimes(1);
    expect(screen.getByText('guardianSwitched')).toBeInTheDocument();
  });

  it('shows the loading label while the switch is in flight', async () => {
    const gate = deferred<{ status: string }>();
    mockWaitForCompletion.mockReturnValue(gate.promise);
    render(<GuardianSettings />);
    await flush();

    await submit(NEW); // confirming
    // Second tap kicks off runSwitch; it parks on waitForTransactionCompletion.
    await submit(NEW);
    await flush();

    expect(label()).toBe('loading');
    expect(screen.queryByText('guardianSwitched')).not.toBeInTheDocument();

    // Resolve the in-flight tx → success.
    await act(async () => {
      gate.resolve({ status: 'ok' });
    });
    await flush();
    expect(screen.getByText('guardianSwitched')).toBeInTheDocument();
  });

  it('surfaces a chain error carried on the completion result', async () => {
    mockWaitForCompletion.mockResolvedValue({ errorMessage: 'chain rejected the switch' });
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();

    expect(screen.getByText('chain rejected the switch')).toBeInTheDocument();
    expect(screen.queryByText('guardianSwitched')).not.toBeInTheDocument();
  });

  it('surfaces a thrown Error message', async () => {
    mockInitiate.mockRejectedValue(new Error('initiate exploded'));
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();

    expect(screen.getByText('initiate exploded')).toBeInTheDocument();
    expect(screen.queryByText('guardianSwitched')).not.toBeInTheDocument();
  });

  it('stringifies a non-Error rejection', async () => {
    mockInitiate.mockRejectedValue('plain string failure');
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();

    expect(screen.getByText('plain string failure')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Success animation → onClose plumbing.
// ---------------------------------------------------------------------------
describe('GuardianSettings — onClose', () => {
  const confirmSwitch = async (endpoint = NEW) => {
    await submit(endpoint);
    await submit(endpoint);
    await flush();
  };

  it('invokes onClose when the success message finishes animating', async () => {
    const onClose = jest.fn();
    render(<GuardianSettings onClose={onClose} />);
    await flush();

    await confirmSwitch();
    const success = screen.getByText('guardianSwitched');

    act(() => {
      fireEvent.animationEnd(success);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not crash on the success animation end when onClose is omitted', async () => {
    render(<GuardianSettings />);
    await flush();

    await confirmSwitch();
    const success = screen.getByText('guardianSwitched');

    // `onClose?.()` — optional-chaining no-op, must not throw.
    expect(() =>
      act(() => {
        fireEvent.animationEnd(success);
      })
    ).not.toThrow();
  });
});
