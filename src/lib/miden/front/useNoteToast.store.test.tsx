import '../../../../test/jest-mocks';

import { renderHook } from '@testing-library/react';

import { useWalletStore } from 'lib/store';

import { useNoteToastMonitor } from './useNoteToast';

// The monitor against the real store, so "never toasts" is read from the store's own toast flag rather than from
// the arguments of a mocked action. The native faucet id is the shared manual mock's (test/jest-mocks).
const NATIVE = 'faucet-id';

type NoteFixture = { id: string; faucetId: string; amount: string; isBeingClaimed: boolean };

let mockNotes: NoteFixture[] | undefined = [];
let mockBaseFee: number | null = null;
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

jest.mock('app/hooks/useVerificationBaseFee', () => ({
  __esModule: true,
  default: () => mockBaseFee
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
  isBeingClaimed: false
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
  mockAutoConsume = true;
  useWalletStore.setState({ seenNoteIds: new Set<string>(), isNoteToastVisible: false, noteToastShownAt: null });
});

describe('useNoteToastMonitor with the real store', () => {
  it('never toasts a native note that was hidden when first listed, once the fee reveals it', () => {
    // With the fee unknown the dust note rides in an auto-consume batch, so it is hidden at the seed.
    const { rerender } = mountSeeded([note('seeded', 'faucet-other', '1000000'), note('dust', NATIVE, '1')]);

    mockBaseFee = 10;
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(false);

    // A genuinely new note the user must claim still toasts, so the check above can fail.
    mockNotes = [...(mockNotes ?? []), note('new-manual', 'faucet-other', '1000000')];
    rerender();
    expect(useWalletStore.getState().isNoteToastVisible).toBe(true);
  });

  it('never toasts a note auto-consume was claiming, when it arrives or once the setting is turned off (#811)', () => {
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
