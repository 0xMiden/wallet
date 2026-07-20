import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import GuardianReplaceHotKey from './GuardianReplaceHotKey';

// ---------------------------------------------------------------------------
// Mocks.
//
// GuardianReplaceHotKey drives a cold-signed hot-key rotation through a chain
// of native/store-backed collaborators. We isolate the component under test by
// stubbing every collaborator so the only real code exercised (and measured) is
// GuardianReplaceHotKey.tsx itself:
//   - `FormSubmitButton` is captured so tests can invoke its `onClick`
//     (the sole entry into the rotation flow) regardless of the `disabled`
//     state the component computes, and read the `loading` / `children` props.
//   - `lib/miden/activity` / guardian-sync provider / platform / settings /
//     store are jest.fn()s the tests script per-case.
// ---------------------------------------------------------------------------

// i18n: identity translator so assertions can match on the raw keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// Capture the latest props FormSubmitButton receives so tests can invoke its
// `onClick` (the only driver of the rotation flow) and read the computed label
// (`children`), `loading`, and `disabled`. The stub always forwards the click,
// so the `!currentAccount` guard is reachable even though the real button would
// be disabled in that state.
const fsbHolder: { props: any } = { props: null };
jest.mock('app/atoms/FormSubmitButton', () => ({
  __esModule: true,
  default: (props: any) => {
    fsbHolder.props = props;
    return (
      <button data-testid="submit" disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </button>
    );
  }
}));

const mockInitiate = jest.fn();
const mockRequestSWProcessing = jest.fn();
const mockWaitForCompletion = jest.fn();
jest.mock('lib/miden/activity', () => ({
  initiateReplaceHotKeyTransaction: (...a: unknown[]) => mockInitiate(...a),
  requestSWTransactionProcessing: (...a: unknown[]) => mockRequestSWProcessing(...a),
  waitForTransactionCompletion: (...a: unknown[]) => mockWaitForCompletion(...a)
}));

jest.mock('lib/miden/front/guardian-sync', () => ({ zustandProvider: { __provider: true } }));

const mockIsExtension = jest.fn();
jest.mock('lib/platform', () => ({ isExtension: () => mockIsExtension() }));

const mockIsDelegateProofEnabled = jest.fn();
jest.mock('lib/settings/helpers', () => ({
  isDelegateProofEnabled: () => mockIsDelegateProofEnabled()
}));

// Store that satisfies both the hook-selector call form and `.getState()`.
const mockState: any = {
  currentAccount: { publicKey: 'pk_1' },
  openTransactionModal: jest.fn()
};
jest.mock('lib/store', () => ({
  useWalletStore: Object.assign(
    (selector?: (s: any) => unknown) => (selector ? selector(mockState) : mockState),
    { getState: () => mockState }
  )
}));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
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

// Drive the captured FormSubmitButton.onClick (the only entry into the rotation
// flow), awaiting the async handler and letting React flush effects.
const click = async () => {
  await act(async () => {
    await fsbHolder.props.onClick();
  });
  await flush();
};

// The button's rendered label (its children).
const label = () => screen.getByTestId('submit').textContent;

beforeEach(() => {
  jest.clearAllMocks();
  fsbHolder.props = null;
  mockState.currentAccount = { publicKey: 'pk_1' };
  mockState.openTransactionModal = jest.fn();
  mockIsExtension.mockReturnValue(false);
  mockIsDelegateProofEnabled.mockReturnValue(false);
  mockInitiate.mockResolvedValue('tx-1');
  mockWaitForCompletion.mockResolvedValue({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
describe('GuardianReplaceHotKey — rendering', () => {
  it('renders the title, description and the idle button label', () => {
    render(<GuardianReplaceHotKey />);

    // Title (<p>) and idle button label both use the same key.
    expect(screen.getAllByText('replaceHotKey').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('replaceHotKeyDescription')).toBeInTheDocument();
    expect(label()).toBe('replaceHotKey');

    // Not confirming yet: no confirmation copy, button enabled, not loading.
    expect(screen.queryByText('replaceHotKeyConfirmation')).not.toBeInTheDocument();
    expect(fsbHolder.props.disabled).toBe(false);
    expect(fsbHolder.props.loading).toBe(false);
    // No error / success surfaces initially.
    expect(screen.queryByText('hotKeyRotated')).not.toBeInTheDocument();
  });

  it('disables the button when there is no current account', () => {
    mockState.currentAccount = null;
    render(<GuardianReplaceHotKey />);

    expect(fsbHolder.props.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guards and the two-stage confirm flow.
// ---------------------------------------------------------------------------
describe('GuardianReplaceHotKey — guards', () => {
  it('does nothing when there is no current account', async () => {
    mockState.currentAccount = null;
    render(<GuardianReplaceHotKey />);

    await click();

    // Guard returns early: no confirming transition, no transaction.
    expect(mockInitiate).not.toHaveBeenCalled();
    expect(label()).toBe('replaceHotKey');
    expect(screen.queryByText('replaceHotKeyConfirmation')).not.toBeInTheDocument();
  });

  it('first tap arms confirmation without initiating a transaction', async () => {
    render(<GuardianReplaceHotKey />);

    await click();

    expect(mockInitiate).not.toHaveBeenCalled();
    expect(label()).toBe('confirmReplaceHotKey');
    expect(screen.getByText('replaceHotKeyConfirmation')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Rotation flow — success, extension SW processing, in-flight, errors.
// ---------------------------------------------------------------------------
describe('GuardianReplaceHotKey — rotation', () => {
  const confirmRotate = async () => {
    await click(); // first tap → confirming
    await click(); // second tap → rotation
  };

  it('completes a rotation: opens the tx modal and shows the success message', async () => {
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    // Cold-signed rotation: publicKey, delegate flag (false), provider.
    expect(mockInitiate).toHaveBeenCalledTimes(1);
    expect(mockInitiate).toHaveBeenCalledWith('pk_1', false, { __provider: true });
    expect(mockState.openTransactionModal).toHaveBeenCalledTimes(1);
    // Non-extension build skips the service-worker processing nudge.
    expect(mockRequestSWProcessing).not.toHaveBeenCalled();
    expect(mockWaitForCompletion).toHaveBeenCalledWith('tx-1');

    expect(screen.getByText('hotKeyRotated')).toBeInTheDocument();
    // confirming cleared on success → confirmation copy hidden, label reset.
    expect(screen.queryByText('replaceHotKeyConfirmation')).not.toBeInTheDocument();
    expect(label()).toBe('replaceHotKey');
    expect(fsbHolder.props.loading).toBe(false);
  });

  it('passes the delegate-proof flag through when enabled', async () => {
    mockIsDelegateProofEnabled.mockReturnValue(true);
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    expect(mockInitiate).toHaveBeenCalledWith('pk_1', true, { __provider: true });
  });

  it('requests service-worker processing on extension builds', async () => {
    mockIsExtension.mockReturnValue(true);
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    expect(mockRequestSWProcessing).toHaveBeenCalledTimes(1);
    expect(screen.getByText('hotKeyRotated')).toBeInTheDocument();
  });

  it('marks the button loading while the rotation is in flight', async () => {
    const gate = deferred<{ status: string }>();
    mockWaitForCompletion.mockReturnValue(gate.promise);
    render(<GuardianReplaceHotKey />);

    await click(); // confirming
    // Second tap kicks off the rotation, which parks on the unresolved
    // waitForTransactionCompletion. Fire it without awaiting the full handler
    // (that promise only settles once we open the gate below).
    await act(async () => {
      void fsbHolder.props.onClick();
      // Let the synchronous setSubmitting(true) + the initiate/openModal
      // microtasks run so the handler reaches (and stalls on) the gate.
      await Promise.resolve();
    });
    await flush();

    expect(fsbHolder.props.loading).toBe(true);
    expect(screen.queryByText('hotKeyRotated')).not.toBeInTheDocument();

    // Resolve the in-flight tx → success, loading cleared.
    await act(async () => {
      gate.resolve({ status: 'ok' });
    });
    await flush();

    expect(screen.getByText('hotKeyRotated')).toBeInTheDocument();
    expect(fsbHolder.props.loading).toBe(false);
  });

  it('surfaces a chain error carried on the completion result and stays confirming', async () => {
    mockWaitForCompletion.mockResolvedValue({ errorMessage: 'chain rejected the rotation' });
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    expect(screen.getByText('chain rejected the rotation')).toBeInTheDocument();
    expect(screen.queryByText('hotKeyRotated')).not.toBeInTheDocument();
    // errorMessage branch returns before clearing confirming.
    expect(label()).toBe('confirmReplaceHotKey');
    expect(fsbHolder.props.loading).toBe(false);
  });

  it('surfaces a thrown Error message', async () => {
    mockInitiate.mockRejectedValue(new Error('initiate exploded'));
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    expect(screen.getByText('initiate exploded')).toBeInTheDocument();
    expect(screen.queryByText('hotKeyRotated')).not.toBeInTheDocument();
  });

  it('stringifies a non-Error rejection', async () => {
    mockInitiate.mockRejectedValue('plain string failure');
    render(<GuardianReplaceHotKey />);

    await confirmRotate();

    expect(screen.getByText('plain string failure')).toBeInTheDocument();
  });

  it('clears a prior error when a fresh rotation is submitted', async () => {
    // First rotation fails with a chain error (leaves component confirming).
    mockWaitForCompletion.mockResolvedValueOnce({ errorMessage: 'first boom' });
    render(<GuardianReplaceHotKey />);

    await confirmRotate();
    expect(screen.getByText('first boom')).toBeInTheDocument();

    // Still confirming → a single tap re-runs the rotation, which resets error
    // (setError(null)) and this time succeeds.
    await click();

    expect(screen.queryByText('first boom')).not.toBeInTheDocument();
    expect(screen.getByText('hotKeyRotated')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Success animation → onClose plumbing.
// ---------------------------------------------------------------------------
describe('GuardianReplaceHotKey — onClose', () => {
  const confirmRotate = async () => {
    await click();
    await click();
  };

  it('invokes onClose when the success message finishes animating', async () => {
    const onClose = jest.fn();
    render(<GuardianReplaceHotKey onClose={onClose} />);

    await confirmRotate();
    const success = screen.getByText('hotKeyRotated');

    act(() => {
      fireEvent.animationEnd(success);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not crash on the success animation end when onClose is omitted', async () => {
    render(<GuardianReplaceHotKey />);

    await confirmRotate();
    const success = screen.getByText('hotKeyRotated');

    // `onClose?.()` — optional-chaining no-op, must not throw.
    expect(() =>
      act(() => {
        fireEvent.animationEnd(success);
      })
    ).not.toThrow();
  });
});
