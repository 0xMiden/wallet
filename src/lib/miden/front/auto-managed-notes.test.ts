import { renderHook } from '@testing-library/react';

import { excludeAutoManagedNotes, selectAutoConsumeBatch, useManuallyClaimableNotes } from './auto-managed-notes';
import type { ConsumableNote, SwapOrderNoteMetadata } from '../types';

type NoteFixture = Pick<
  ConsumableNote,
  'id' | 'faucetId' | 'amount' | 'isBeingClaimed' | 'swapOrder' | 'fromCache' | 'standardPayment'
>;

let mockFaucetId: string | null = 'faucet-native';
let mockAutoConsume = true;
let mockBaseFee: number | null = null;
let mockFloorFee: number | null | undefined;
let mockClaimableNotes: NoteFixture[] | undefined;
let mockIsFallback = false;

let mockLegacyFeeIdentity: string | undefined;
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockLegacyFeeIdentity ?? mockFaucetId
}));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => mockFaucetId }));

jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee,
  // The claim floor follows the raw fee, an unknown one read as fee-free: these cases predate the floor refusing it.
  useClaimFloorBaseFee: () => (mockFloorFee === undefined ? (mockBaseFee ?? 0) : mockFloorFee)
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
  standardPayment: true,
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
// Another trader's public PSWAP order on a pair tag the account still tracks (#2118).
const nativeForeignOrder = note('foreign-order', 'faucet-native', '1000000', { standardPayment: false });
const nativeUnflagged = note('unflagged', 'faucet-native', '1000000', { standardPayment: undefined });

beforeEach(() => {
  jest.clearAllMocks();
  mockFaucetId = 'faucet-native';
  mockAutoConsume = true;
  mockBaseFee = null;
  mockFloorFee = undefined;
  mockClaimableNotes = [native, other, nativeManualSwap];
  mockIsFallback = false;
});

describe('selectAutoConsumeBatch', () => {
  it('takes the native notes that are neither swap-managed nor already being claimed', () => {
    expect(selectAutoConsumeBatch([native, other, nativeManualSwap, nativeInFlight], 'faucet-native', FEE)).toEqual([
      native
    ]);
  });

  it("takes only standard payments, never another trader's PSWAP order or an unflagged note (#2118)", () => {
    expect(selectAutoConsumeBatch([native, nativeForeignOrder, nativeUnflagged], 'faucet-native', FEE)).toEqual([
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

  it('claims nothing while the fee is unknown, and says so once', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      // A known fee first, so the shared latch starts clear whatever ran before.
      selectAutoConsumeBatch([native], 'faucet-native', FEE);
      expect(selectAutoConsumeBatch([native], 'faucet-native', null)).toEqual([]);
      expect(debug).toHaveBeenCalledWith('[claim-floor] claim skipped, fee unknown', 'auto-consume');
    } finally {
      debug.mockRestore();
    }
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

  it('keeps a native note that is not a standard payment, since no auto-consumer claims it', () => {
    expect(excludeAutoManagedNotes([native, nativeForeignOrder], 'faucet-native', true, FEE)).toEqual([
      nativeForeignOrder
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

  it('judges a list with any live entry as the auto-consumers do, leaving cached entries out of the total', () => {
    expect(excludeAutoManagedNotes([nativeCached, nativeDust], 'faucet-native', true, FEE)).toEqual([
      nativeCached,
      nativeDust
    ]);
  });

  it('lists every native note to claim by hand while the fee is unknown', () => {
    expect(excludeAutoManagedNotes([native, nativeDust], 'faucet-native', true, null)).toEqual([native, nativeDust]);
  });

  it('with auto-consume off keeps every note except a native note a consume already covers', () => {
    const otherInFlight = note('other-in-flight', 'faucet-other', '1000000', { isBeingClaimed: true });
    expect(
      excludeAutoManagedNotes([native, other, nativeInFlight, otherInFlight], 'faucet-native', false, FEE)
    ).toEqual([native, other, otherInFlight]);
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

  it('useManuallyClaimableNotes judges with the claim floor fee', () => {
    // A chain proven fee-free: the floor reads 0 and the auto-consumers take the dust, which the raw fee would list.
    mockBaseFee = 10000;
    mockFloorFee = 0;
    mockClaimableNotes = [nativeDust, other];
    const { result } = renderHook(() => useManuallyClaimableNotes('pk-1'));
    expect(result.current.data).toEqual([other]);
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

beforeEach(() => {
  mockLegacyFeeIdentity = undefined;
});

it('fee identity: leaves legacy display notes manual while hiding actual native auto-managed notes', () => {
  mockLegacyFeeIdentity = 'faucet-other';
  mockBaseFee = 7;
  const { result } = renderHook(() => useManuallyClaimableNotes('account'));
  expect(result.current.data).toEqual([other, nativeManualSwap]);
});
