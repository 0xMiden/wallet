import { renderHook } from '@testing-library/react';

import { excludeAutoManagedNotes, selectAutoConsumeBatch, useManuallyClaimableNotes } from './auto-managed-notes';
import type { ConsumableNote, SwapOrderNoteMetadata } from '../types';

type NoteFixture = Pick<ConsumableNote, 'id' | 'faucetId' | 'amount' | 'isBeingClaimed' | 'swapOrder' | 'fromCache'>;

let mockFaucetId: string | null = 'faucet-native';
let mockAutoConsume = true;
let mockBaseFee: number | null = null;
let mockClaimableNotes: NoteFixture[] | undefined;
let mockIsFallback = false;

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockFaucetId
}));

jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee
}));

jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockAutoConsume
}));

jest.mock('./claimable-notes', () => ({
  useClaimableNotes: (publicAddress: string, enabled: boolean) => {
    mockUseClaimableNotes(publicAddress, enabled);
    return { data: mockClaimableNotes, isFallback: mockIsFallback };
  }
}));
const mockUseClaimableNotes = jest.fn();

// With a base fee of 10 a claim has to be worth more than 300 (CLAIM_COST_FEE_MULTIPLE).
const FEE = 10;
const note = (id: string, faucetId: string, amount: string, extra: Partial<NoteFixture> = {}): NoteFixture => ({
  id,
  faucetId,
  amount,
  isBeingClaimed: false,
  ...extra
});
const manualSwapOrder: SwapOrderNoteMetadata = {
  orderId: 'order-1',
  depth: 0,
  role: 'payback',
  lineageState: 'filled',
  expiresAt: 0,
  autoConsume: false
};
const native = note('native', 'faucet-native', '1000000');
const other = note('other', 'faucet-other', '1000000');
const nativeManualSwap = note('swap', 'faucet-native', '1000000', { swapOrder: manualSwapOrder });
const nativeDust = note('dust', 'faucet-native', '1');
const nativeInFlight = note('in-flight', 'faucet-native', '1000000', { isBeingClaimed: true });
const nativeCached = note('cached', 'faucet-native', '1000000', { fromCache: true });
const otherCached = note('other-cached', 'faucet-other', '1000000', { fromCache: true });

beforeEach(() => {
  jest.clearAllMocks();
  mockFaucetId = 'faucet-native';
  mockAutoConsume = true;
  mockBaseFee = null;
  mockClaimableNotes = [native, other, nativeManualSwap];
  mockIsFallback = false;
});

describe('selectAutoConsumeBatch', () => {
  it('takes the native notes that are neither swap-managed nor already being claimed', () => {
    expect(selectAutoConsumeBatch([native, other, nativeManualSwap, nativeInFlight], 'faucet-native', FEE)).toEqual([
      native
    ]);
  });

  it('judges the batch total, so notes worth too little alone still go together', () => {
    const halves = [note('a', 'faucet-native', '200'), note('b', 'faucet-native', '200')];
    expect(selectAutoConsumeBatch(halves, 'faucet-native', FEE)).toEqual(halves);
  });

  it('claims nothing when the batch is worth no more than its fee', () => {
    expect(selectAutoConsumeBatch([nativeDust], 'faucet-native', FEE)).toEqual([]);
  });

  it('does not count an in-flight note toward the batch total', () => {
    expect(selectAutoConsumeBatch([nativeInFlight, nativeDust], 'faucet-native', FEE)).toEqual([]);
  });

  it('never takes an entry only the cached list has shown, nor counts its value', () => {
    expect(selectAutoConsumeBatch([nativeCached, native], 'faucet-native', FEE)).toEqual([native]);
    expect(selectAutoConsumeBatch([nativeCached, nativeDust], 'faucet-native', FEE)).toEqual([]);
  });

  it('fails open on an unknown fee', () => {
    expect(selectAutoConsumeBatch([nativeDust], 'faucet-native', null)).toEqual([nativeDust]);
  });

  it('claims nothing while the native faucet is unknown', () => {
    expect(selectAutoConsumeBatch([native], null, null)).toEqual([]);
  });
});

describe('excludeAutoManagedNotes', () => {
  it('keeps undefined so callers retain their not-loaded branch', () => {
    expect(excludeAutoManagedNotes(undefined, 'faucet-native', true, FEE)).toBeUndefined();
  });

  it('drops only the batch the auto-consumers claim', () => {
    expect(excludeAutoManagedNotes([native, other, nativeManualSwap], 'faucet-native', true, FEE)).toEqual([
      other,
      nativeManualSwap
    ]);
  });

  it('keeps a native note worth too little to auto-claim', () => {
    expect(excludeAutoManagedNotes([nativeDust, other], 'faucet-native', true, FEE)).toEqual([nativeDust, other]);
  });

  it('drops a native note a consume already covers, even beside a batch too small to claim', () => {
    expect(excludeAutoManagedNotes([nativeInFlight, nativeDust], 'faucet-native', true, FEE)).toEqual([nativeDust]);
  });

  it('judges a cache-first list as if a live read had confirmed it', () => {
    expect(excludeAutoManagedNotes([nativeCached, otherCached], 'faucet-native', true, FEE)).toEqual([otherCached]);
  });

  it('returns every note when auto-consume is off', () => {
    expect(excludeAutoManagedNotes([native, other, nativeInFlight], 'faucet-native', false, FEE)).toEqual([
      native,
      other,
      nativeInFlight
    ]);
  });
});

describe('useManuallyClaimableNotes', () => {
  it('forwards the address and enabled flag to useClaimableNotes', () => {
    renderHook(() => useManuallyClaimableNotes('pk-1', false));
    expect(mockUseClaimableNotes).toHaveBeenCalledWith('pk-1', false);
  });

  it('filters auto-managed notes out of the data', () => {
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([other, nativeManualSwap]);
    expect(result.current.isFallback).toBe(false);
  });

  it('reports whether the list is still the persisted fallback', () => {
    mockIsFallback = true;
    mockClaimableNotes = [nativeCached, otherCached];
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.isFallback).toBe(true);
    expect(result.current.data).toEqual([otherCached]);
  });

  it('judges the native batch against the chain fee', () => {
    mockBaseFee = FEE;
    mockClaimableNotes = [nativeDust, other];
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([nativeDust, other]);
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
