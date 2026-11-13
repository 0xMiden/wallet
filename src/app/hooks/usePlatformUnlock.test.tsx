import React from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { getPlatformUnlockSupport } from 'lib/platform-auth/capabilities';
import type { PlatformUnlockCommand, PlatformUnlockResult } from 'lib/platform-auth/types';
import { signalUnknownPlatformCredential } from 'lib/platform-auth/webauthn';

import { usePlatformUnlock } from './usePlatformUnlock';

let mockExtension = true;
let pending: string[];
const mockSend = jest.fn(async (command: PlatformUnlockCommand): Promise<PlatformUnlockResult> => {
  switch (command.action) {
    case 'state':
      return { action: 'state', state: { available: true, hasPassword: true, credential: null } };
    case 'pending-signals':
      return { action: 'pending-signals', credentialIds: [...pending] };
    case 'signal-complete':
      pending = pending.filter(id => id !== command.credentialId);
      return { action: 'signal-complete' };
    default:
      throw new Error('Unexpected command');
  }
});
jest.mock('lib/miden/front', () => ({ useMidenContext: () => ({ platformUnlock: mockSend }) }));
jest.mock('lib/platform', () => ({ isExtension: () => mockExtension }));
jest.mock('lib/platform-auth/capabilities', () => ({ getPlatformUnlockSupport: jest.fn() }));
jest.mock('lib/platform-auth/webauthn', () => ({ signalUnknownPlatformCredential: jest.fn() }));
const mockSupport = jest.mocked(getPlatformUnlockSupport);
const mockSignal = jest.mocked(signalUnknownPlatformCredential);
const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

beforeEach(() => {
  jest.clearAllMocks();
  mockExtension = true;
  pending = [];
  mockSupport.mockResolvedValue(true);
  mockSignal.mockResolvedValue();
});

it('exposes only worker metadata after the eligible browser evidence resolves', async () => {
  const { result } = renderHook(() => usePlatformUnlock(), { wrapper });
  await waitFor(() => expect(result.current.state.available).toBe(true));
  expect(result.current.state).toEqual({ available: true, hasPassword: true, credential: null });
});

it('does not use extension transport on native targets', async () => {
  mockExtension = false;
  const { result } = renderHook(() => usePlatformUnlock(), { wrapper });
  await act(async () => undefined);
  expect(result.current.state.available).toBe(false);
  expect(mockSupport).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});

it('fails closed before worker requests on old or unsupported browser/OS evidence', async () => {
  mockSupport.mockResolvedValue(false);
  const { result } = renderHook(() => usePlatformUnlock(), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.state.available).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});

it('retains failed provider cleanup for a later refresh while acknowledging successes', async () => {
  pending = ['AQIDBA', 'BQYHCA'];
  mockSignal.mockImplementation(async id => {
    if (id === 'AQIDBA') throw new Error('Provider unavailable');
  });
  const { result } = renderHook(() => usePlatformUnlock(), { wrapper });
  await waitFor(() => expect(pending).toEqual(['AQIDBA']));
  expect(result.current.state.available).toBe(true);
  mockSignal.mockResolvedValue();
  await act(async () => {
    await result.current.refresh();
  });
  await waitFor(() => expect(pending).toEqual([]));
});
