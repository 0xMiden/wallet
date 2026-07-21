import { renderHook } from '@testing-library/react';

import { useHasUnclaimedNotes } from './useHasUnclaimedNotes';

// --- Mocked dependencies -------------------------------------------------
// `useHasUnclaimedNotes` composes two collaborators. We mock each so we can
// drive every branch without pulling in the SDK or the claimable-notes query
// machinery.

const mockUseAccount = jest.fn(() => ({ publicKey: 'test-account-123' }));
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount()
}));

const mockUseClaimableNotes = jest.fn();
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: (publicKey: string) => mockUseClaimableNotes(publicKey)
}));

describe('useHasUnclaimedNotes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override as needed.
    mockUseAccount.mockReturnValue({ publicKey: 'test-account-123' });
    mockUseClaimableNotes.mockReturnValue({ data: [] });
  });

  it('returns false when claimableNotes is undefined (?. short-circuits, ?? 0 fallback)', () => {
    mockUseClaimableNotes.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useHasUnclaimedNotes());

    expect(result.current).toBe(false);
  });

  it('returns false when the query result itself has no data field', () => {
    mockUseClaimableNotes.mockReturnValue({});

    const { result } = renderHook(() => useHasUnclaimedNotes());

    expect(result.current).toBe(false);
  });

  it('returns false when there are no claimable notes (empty array, length 0)', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [] });

    const { result } = renderHook(() => useHasUnclaimedNotes());

    expect(result.current).toBe(false);
  });

  it('returns true when there is exactly one claimable note', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [{ id: 'note-1' }] });

    const { result } = renderHook(() => useHasUnclaimedNotes());

    expect(result.current).toBe(true);
  });

  it('returns true when there are multiple claimable notes', () => {
    mockUseClaimableNotes.mockReturnValue({
      data: [{ id: 'note-1' }, { id: 'note-2' }, { id: 'note-3' }]
    });

    const { result } = renderHook(() => useHasUnclaimedNotes());

    expect(result.current).toBe(true);
  });

  it("queries claimable notes with the account's public key", () => {
    mockUseAccount.mockReturnValue({ publicKey: 'account-xyz' });

    renderHook(() => useHasUnclaimedNotes());

    expect(mockUseClaimableNotes).toHaveBeenCalledWith('account-xyz');
  });

  it('recomputes when claimable notes change between renders', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [] });

    const { result, rerender } = renderHook(() => useHasUnclaimedNotes());
    expect(result.current).toBe(false);

    mockUseClaimableNotes.mockReturnValue({ data: [{ id: 'note-1' }] });
    rerender();

    expect(result.current).toBe(true);
  });
});
