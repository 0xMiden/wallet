import { renderHook } from '@testing-library/react';

import { useHistoryBadge } from './useHistoryBadge';

// --- Mocked dependencies -------------------------------------------------
// `useHistoryBadge` composes four collaborators. We mock each so we can drive
// every branch of the `useMemo` from the test without pulling in the SDK,
// settings storage, or async faucet discovery.

const mockUseAccount = jest.fn(() => ({ publicKey: 'test-account-123' }));
jest.mock('lib/miden/front', () => ({
  useAccount: () => mockUseAccount()
}));

const mockUseClaimableNotes = jest.fn();
jest.mock('lib/miden/front/claimable-notes', () => ({
  useClaimableNotes: (publicKey: string) => mockUseClaimableNotes(publicKey)
}));

const mockUseMidenFaucetId = jest.fn();
jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => mockUseMidenFaucetId()
}));

const mockIsAutoConsumeEnabled = jest.fn();
jest.mock('lib/settings/helpers', () => ({
  isAutoConsumeEnabled: () => mockIsAutoConsumeEnabled()
}));

const MIDEN_FAUCET = 'miden-faucet-id';
const OTHER_FAUCET = 'other-faucet-id';

describe('useHistoryBadge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults; individual tests override as needed.
    mockUseAccount.mockReturnValue({ publicKey: 'test-account-123' });
    mockUseMidenFaucetId.mockReturnValue(MIDEN_FAUCET);
    mockIsAutoConsumeEnabled.mockReturnValue(true);
    mockUseClaimableNotes.mockReturnValue({ data: [] });
  });

  it('returns false when auto-consume is disabled (short-circuit before reading notes)', () => {
    mockIsAutoConsumeEnabled.mockReturnValue(false);
    mockUseClaimableNotes.mockReturnValue({ data: [{ faucetId: MIDEN_FAUCET }] });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(false);
  });

  it('returns false when claimableNotes is undefined even though auto-consume is enabled', () => {
    mockIsAutoConsumeEnabled.mockReturnValue(true);
    mockUseClaimableNotes.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(false);
  });

  it('returns false when there are no claimable notes at all', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [] });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(false);
  });

  it('returns false when notes exist but none match the MIDEN faucet id', () => {
    mockUseClaimableNotes.mockReturnValue({
      data: [{ faucetId: OTHER_FAUCET }, { faucetId: 'yet-another' }]
    });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(false);
  });

  it('returns true when at least one claimable note matches the MIDEN faucet id', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [{ faucetId: MIDEN_FAUCET }] });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(true);
  });

  it('returns true when a matching note is mixed with non-matching notes (filter predicate both branches)', () => {
    mockUseClaimableNotes.mockReturnValue({
      data: [{ faucetId: OTHER_FAUCET }, { faucetId: MIDEN_FAUCET }, { faucetId: OTHER_FAUCET }]
    });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(true);
  });

  it('returns false when the faucet id is null and notes carry real faucet ids', () => {
    mockUseMidenFaucetId.mockReturnValue(null);
    mockUseClaimableNotes.mockReturnValue({ data: [{ faucetId: MIDEN_FAUCET }] });

    const { result } = renderHook(() => useHistoryBadge());

    expect(result.current).toBe(false);
  });

  it("queries claimable notes with the account's public key", () => {
    mockUseAccount.mockReturnValue({ publicKey: 'account-xyz' });

    renderHook(() => useHistoryBadge());

    expect(mockUseClaimableNotes).toHaveBeenCalledWith('account-xyz');
  });

  it('recomputes when claimable notes change between renders', () => {
    mockUseClaimableNotes.mockReturnValue({ data: [] });

    const { result, rerender } = renderHook(() => useHistoryBadge());
    expect(result.current).toBe(false);

    mockUseClaimableNotes.mockReturnValue({ data: [{ faucetId: MIDEN_FAUCET }] });
    rerender();

    expect(result.current).toBe(true);
  });
});
