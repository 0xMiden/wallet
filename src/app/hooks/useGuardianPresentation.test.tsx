import '../../../test/jest-mocks';

import React from 'react';

import { act, render } from '@testing-library/react';

import type { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { useGuardianPresentation } from './useGuardianPresentation';

const account = {
  publicKey: 'pk1',
  name: 'Account 1',
  isPublic: true,
  type: WalletType.Guardian,
  hdIndex: 0,
  hotPublicKey: 'hot1',
  guardianSyncStatus: 'in-sync'
} as WalletAccount;

describe('useGuardianPresentation', () => {
  let renders = 0;
  const Probe = () => {
    renders += 1;
    useGuardianPresentation();
    return null;
  };

  beforeEach(() => {
    renders = 0;
    useWalletStore.setState({ currentAccount: account });
  });

  it('re-renders for a guardian field and not for an unrelated account update', () => {
    render(<Probe />);
    const mounted = renders;

    act(() => useWalletStore.setState({ currentAccount: { ...account, name: 'Renamed' } }));
    expect(renders).toBe(mounted);

    act(() => useWalletStore.setState({ currentAccount: { ...account, guardianSyncStatus: 'resolving' } }));
    expect(renders).toBe(mounted + 1);
  });
});
