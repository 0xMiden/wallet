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
