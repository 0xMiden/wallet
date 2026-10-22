import { useAppKitAccount } from '@reown/appkit/react';
import type { UseAppKitAccountReturn } from '@reown/appkit-controllers';
import { act, renderHook } from '@testing-library/react';

import {
  __resetStartupReconnectForTest,
  boundStartupReconnect,
  STARTUP_RECONNECT_BOUND_MS,
  type StartupReconnectDeps
} from './startup-reconnect';
import { useEvmWalletConnection } from './useEvmWalletConnection';

jest.mock('./useNativeReown', () => ({
  useNativeReown: () => ({ available: false, connecting: false, state: { address: undefined, connected: false } })
}));

const connecting: UseAppKitAccountReturn = {
  allAccounts: [],
  caipAddress: undefined,
  address: undefined,
  isConnected: false,
  status: 'connecting'
};

function deps(): StartupReconnectDeps & { settle: (status: string) => void } {
  const listeners = new Set<(status: string) => void>();
  return {
    storedStatus: () => 'connected',
    subscribeStatus: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeModalOpen: () => () => {},
    forgetSession: jest.fn(),
    disconnect: jest.fn(async () => {}),
    settle: status => listeners.forEach(listener => listener(status))
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetStartupReconnectForTest();
  jest.mocked(useAppKitAccount).mockReturnValue(connecting);
});

afterEach(() => {
  jest.useRealTimers();
});

it('reads a startup restore as connecting until its bound, then as disconnected, then as AppKit says again', () => {
  const bound = deps();
  boundStartupReconnect(bound);
  const { result } = renderHook(() => useEvmWalletConnection());
  expect(result.current.status).toBe('connecting');

  act(() => {
    jest.advanceTimersByTime(STARTUP_RECONNECT_BOUND_MS);
  });
  expect(result.current.status).toBe('disconnected');
  expect(result.current.connected).toBe(false);

  // The user paired afresh: AppKit's own `connecting` shows again.
  act(() => {
    bound.settle('disconnected');
  });
  expect(result.current.status).toBe('connecting');
});
