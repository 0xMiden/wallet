import { renderHook } from '@testing-library/react';

import { excludeAutoManagedNotes, isAutoManagedNote, useManuallyClaimableNotes } from './auto-managed-notes';
import type { SwapOrderNoteMetadata } from '../types';

let mockFaucetId: string | null = 'faucet-native';
let mockAutoConsume = true;
let mockClaimableNotes: Array<{ id: string; faucetId: string; swapOrder?: SwapOrderNoteMetadata }> | undefined;
const mockMutate = jest.fn();

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockFaucetId
}));

jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockAutoConsume
}));

jest.mock('./claimable-notes', () => ({
  useClaimableNotes: (publicAddress: string, enabled: boolean) => {
    mockUseClaimableNotes(publicAddress, enabled);
    return { data: mockClaimableNotes, mutate: mockMutate };
  }
}));
const mockUseClaimableNotes = jest.fn();

const native = { id: 'native', faucetId: 'faucet-native' };
const other = { id: 'other', faucetId: 'faucet-other' };
const manualSwapOrder: SwapOrderNoteMetadata = {
  orderId: 'order-1',
  depth: 0,
  role: 'payback',
  lineageState: 'filled',
  expiresAt: 0,
  autoConsume: false
};
const nativeManualSwap = { id: 'swap', faucetId: 'faucet-native', swapOrder: manualSwapOrder };

beforeEach(() => {
  jest.clearAllMocks();
  mockFaucetId = 'faucet-native';
  mockAutoConsume = true;
  mockClaimableNotes = [native, other, nativeManualSwap];
});

describe('isAutoManagedNote', () => {
  it('is true only for a native, non-swap note while auto-consume is on', () => {
    expect(isAutoManagedNote(native, 'faucet-native', true)).toBe(true);
    expect(isAutoManagedNote(other, 'faucet-native', true)).toBe(false);
    expect(isAutoManagedNote(nativeManualSwap, 'faucet-native', true)).toBe(false);
  });

  it('is false when auto-consume is off or the native faucet is unknown', () => {
    expect(isAutoManagedNote(native, 'faucet-native', false)).toBe(false);
    expect(isAutoManagedNote(native, null, true)).toBe(false);
  });
});

describe('excludeAutoManagedNotes', () => {
  it('keeps undefined so callers retain their not-loaded branch', () => {
    expect(excludeAutoManagedNotes(undefined, 'faucet-native', true)).toBeUndefined();
  });

  it('drops only the auto-managed notes', () => {
    expect(excludeAutoManagedNotes([native, other, nativeManualSwap], 'faucet-native', true)).toEqual([
      other,
      nativeManualSwap
    ]);
  });

  it('returns every note when auto-consume is off', () => {
    expect(excludeAutoManagedNotes([native, other], 'faucet-native', false)).toEqual([native, other]);
  });
});

describe('useManuallyClaimableNotes', () => {
  it('forwards the address and enabled flag to useClaimableNotes', () => {
    renderHook(() => useManuallyClaimableNotes('pk-1', false));
    expect(mockUseClaimableNotes).toHaveBeenCalledWith('pk-1', false);
  });

  it('filters auto-managed notes out of the data and passes mutate through', () => {
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([other, nativeManualSwap]);
    expect(result.current.mutate).toBe(mockMutate);
  });

  it('returns the full list when auto-consume is off', () => {
    mockAutoConsume = false;
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([native, other, nativeManualSwap]);
  });

  it('returns undefined while notes are not loaded', () => {
    mockClaimableNotes = undefined;
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toBeUndefined();
  });
});
