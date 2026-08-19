import React from 'react';

import { act, render } from '@testing-library/react';

import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';

import { GuardianRecoveryProvider } from './GuardianRecoveryProvider';

jest.mock('lib/miden/front', () => ({
  useMidenContext: jest.fn()
}));

jest.mock('lib/store', () => ({
  useWalletStore: jest.fn()
}));

const mockUseMidenContext = jest.mocked(useMidenContext);
const mockUseWalletStore = jest.mocked(useWalletStore);
const startGuardianRecovery = jest.fn<Promise<boolean>, [string]>();

function setAccounts(accounts: unknown[]): void {
  mockUseWalletStore.mockImplementation(selector => selector({ accounts }));
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
      { publicKey: 'not-recovered' },
      { publicKey: 'rotation-required', guardianNoteRecoveryPending: true, requiresHotKeyRotation: true }
    ]);

    const { container } = render(<GuardianRecoveryProvider />);

    expect(container).toBeEmptyDOMElement();
    expect(startGuardianRecovery).not.toHaveBeenCalled();
  });

  it('starts eligible recoveries immediately and retries them while pending', () => {
    setAccounts([
      { publicKey: 'account-a', guardianNoteRecoveryPending: true, requiresHotKeyRotation: false },
      { publicKey: 'account-b', guardianNoteRecoveryPending: true }
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
    setAccounts([{ publicKey: 'account-a', guardianNoteRecoveryPending: true }]);

    render(<GuardianRecoveryProvider />);
    await act(async () => Promise.resolve());

    expect(warn).toHaveBeenCalledWith(
      '[GuardianRecovery] Failed to request recovery start for account-a:',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});
