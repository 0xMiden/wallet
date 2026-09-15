import React from 'react';

import { act, render } from '@testing-library/react';

import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { GuardianRecoveryProvider } from './GuardianRecoveryProvider';

jest.mock('lib/miden/front', () => ({
  useMidenContext: jest.fn()
}));

jest.mock('lib/store', () => ({
  useWalletStore: jest.fn()
}));

const mockUseMidenContext: jest.Mock = jest.requireMock('lib/miden/front').useMidenContext;
const mockUseWalletStore: jest.Mock = jest.requireMock('lib/store').useWalletStore;
const startGuardianRecovery = jest.fn<Promise<boolean>, [string]>();

function account(publicKey: string, overrides: Partial<WalletAccount> = {}): WalletAccount {
  return {
    publicKey,
    name: publicKey,
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: 0,
    authScheme: 'ecdsa',
    ...overrides
  };
}

function setAccounts(accounts: WalletAccount[]): void {
  mockUseWalletStore.mockImplementation((selector: (state: { accounts: WalletAccount[] }) => unknown) =>
    selector({ accounts })
  );
}

describe('GuardianRecoveryProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    startGuardianRecovery.mockResolvedValue(true);
    mockUseMidenContext.mockReturnValue({ startGuardianRecovery });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing when no account is eligible', () => {
    setAccounts([
      account('not-recovered'),
      account('rotation-required', { guardianNoteRecoveryPending: true, requiresHotKeyRotation: true })
    ]);

    const { container } = render(<GuardianRecoveryProvider />);

    expect(container).toBeEmptyDOMElement();
    expect(startGuardianRecovery).not.toHaveBeenCalled();
  });

  it('starts eligible recoveries immediately and retries them while pending', () => {
    setAccounts([
      account('account-a', { guardianNoteRecoveryPending: true, requiresHotKeyRotation: false }),
      account('account-b', { guardianNoteRecoveryPending: true })
    ]);

    render(<GuardianRecoveryProvider />);
    expect(startGuardianRecovery).toHaveBeenCalledWith('account-a');
    expect(startGuardianRecovery).toHaveBeenCalledWith('account-b');

    act(() => jest.advanceTimersByTime(5_000));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(4);
  });

  it('backs off to a slow heartbeat while the backend keeps refusing', () => {
    startGuardianRecovery.mockResolvedValue(false);
    setAccounts([account('account-a', { guardianNoteRecoveryPending: true })]);

    render(<GuardianRecoveryProvider />);
    expect(startGuardianRecovery).toHaveBeenCalledTimes(1);

    // 5s, then 10s, 20s, 40s, then capped at 60s.
    act(() => jest.advanceTimersByTime(5_000));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(9_999));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(1));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(3);

    act(() => jest.advanceTimersByTime(20_000 + 40_000));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(5);

    // Ceiling: an hour of refusals costs 60 offers, not 720.
    act(() => jest.advanceTimersByTime(600_000));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(15);
  });

  it('stops offering once unmounted', () => {
    startGuardianRecovery.mockResolvedValue(false);
    setAccounts([account('account-a', { guardianNoteRecoveryPending: true })]);

    const { unmount } = render(<GuardianRecoveryProvider />);
    expect(startGuardianRecovery).toHaveBeenCalledTimes(1);

    unmount();
    act(() => jest.advanceTimersByTime(600_000));
    expect(startGuardianRecovery).toHaveBeenCalledTimes(1);
  });

  it('logs a rejected start request without breaking the retry worker', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    startGuardianRecovery.mockRejectedValue(new Error('not ready'));
    setAccounts([account('account-a', { guardianNoteRecoveryPending: true })]);

    render(<GuardianRecoveryProvider />);
    await act(async () => Promise.resolve());

    expect(warn).toHaveBeenCalledWith(
      '[GuardianRecovery] Failed to request recovery start for account-a:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
