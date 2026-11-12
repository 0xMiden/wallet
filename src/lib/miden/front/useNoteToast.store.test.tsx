import '../../../../test/jest-mocks';

import { renderHook } from '@testing-library/react';

import { useWalletStore } from 'lib/store';

import { useNoteToastMonitor } from './useNoteToast';

// The monitor against the real store, so "never toasts" is read from the store's own toast flag rather than from
// the arguments of a mocked action. The actual native fee ID differs from the shared legacy display mock.
const NATIVE = 'actual-native';

type NoteFixture = { id: string; faucetId: string; amount: string; isBeingClaimed: boolean; standardPayment: boolean };

let mockNotes: NoteFixture[] | undefined = [];
let mockBaseFee: number | null = null;
let mockFloorFee: number | null | undefined;
let mockAutoConsume = true;

jest.mock('lib/intercom/client', () => ({
  createIntercomClient: jest.fn(() => ({ request: jest.fn(), subscribe: jest.fn(() => () => {}) })),
  IntercomClient: jest.fn()
}));

jest.mock('lib/miden/metadata', () => ({
  fetchTokenMetadata: jest.fn(),
  MIDEN_METADATA: { name: 'Miden', symbol: 'MIDEN', decimals: 8 }
}));

jest.mock('./claimable-notes', () => ({
  useClaimableNotes: () => ({ data: mockNotes, isFallback: false })
}));

jest.mock('app/hooks/useNativeFeeFaucetId', () => ({
  __esModule: true,
  default: () => 'actual-native'
}));

jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee,
  // An unset floor passes the raw fee through, so a null raw fee stays null.
  useClaimFloorBaseFee: () => (mockFloorFee === undefined ? mockBaseFee : mockFloorFee)
}));

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isAutoConsumeEnabled: () => mockAutoConsume
}));

jest.mock('lib/platform', () => ({
  ...jest.requireActual('lib/platform'),
  isExtension: () => false
}));

jest.mock('lib/miden/back/note-checker-storage', () => ({
  getPersistedSeenNoteIds: jest.fn(async () => new Set<string>()),
  persistSeenNoteIds: jest.fn(async () => undefined),
  clearPersistedSeenNoteIds: jest.fn(async () => undefined)
}));

const note = (id: string, faucetId: string, amount: string): NoteFixture => ({
  id,
  faucetId,
  amount,
  isBeingClaimed: false,
  standardPayment: true
});

// Mounts the monitor and lets it seed from `seedNotes`: the address effect re-arms the first-fetch seed after
// mount, so the seed lands on the render after it, as it does at launch.
const mountSeeded = (seedNotes: NoteFixture[]) => {
  const hook = renderHook(() => useNoteToastMonitor('pk-1'));
  mockNotes = seedNotes;
  hook.rerender();
  return hook;
};

beforeEach(() => {
  mockNotes = [];
  mockBaseFee = null;
  mockFloorFee = undefined;
  mockAutoConsume = true;
  useWalletStore.setState({ seenNoteIds: new Set<string>(), isNoteToastVisible: false, noteToastShownAt: null });
});

describe('useNoteToastMonitor with the real store', () => {
  it('never toasts a native note that was hidden when first listed, once the fee reveals it', () => {
    // On a chain that charges nothing the dust note rides in an auto-consume batch, so it is hidden at the seed.
    mockFloorFee = 0;
    const { rerender } = mountSeeded([note('seeded', 'faucet-other', '1000000'), note('dust', NATIVE, '1')]);

    mockFloorFee = 10;
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);

    // A genuinely new note the user must claim still toasts, so the check above can fail.
    mockNotes = [...(mockNotes ?? []), note('new-manual', 'faucet-other', '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(true);
  });

  it('toasts a worthwhile native note while the claim floor is unknown', () => {
    // A null floor leaves native notes manual. The first fetch seeds them without a toast; one that arrives later
    // toasts. The unset floor passes the null raw fee through.
    mockBaseFee = null;
    mockFloorFee = undefined;
    const { rerender } = mountSeeded([note('seeded', 'faucet-other', '1000000'), note('dust', NATIVE, '1')]);
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);

    mockNotes = [...(mockNotes ?? []), note('arrived', NATIVE, '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(true);
  });

  it('toasts a new legacy display note while suppressing the actual native fee note', () => {
    mockBaseFee = 7;
    const { rerender } = mountSeeded([note('seeded', 'faucet-other', '1000000')]);
    mockNotes = [...(mockNotes ?? []), note('actual', NATIVE, '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);
    expect(useWalletStore.getState().seenNoteIds.has('actual')).toBe(true);
    mockNotes = [...(mockNotes ?? []), note('legacy', 'faucet-id', '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(true);
    expect(useWalletStore.getState().seenNoteIds.has('legacy')).toBe(true);
  });

  it('never toasts a note auto-consume was claiming, when it arrives or once the setting is turned off (#811)', () => {
    mockFloorFee = 10;
    const { rerender } = mountSeeded([note('manual', 'faucet-other', '1000000')]);

    // A worthwhile native note arrives while auto-consume is on, beside a manual note that is already listed.
    mockNotes = [...(mockNotes ?? []), note('auto', NATIVE, '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);
    expect(useWalletStore.getState().seenNoteIds.has('auto')).toBe(true);

    mockAutoConsume = false;
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);

    mockNotes = [...(mockNotes ?? []), note('new-manual', 'faucet-other', '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(true);
  });
});
