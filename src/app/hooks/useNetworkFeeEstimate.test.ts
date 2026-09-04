import { renderHook } from '@testing-library/react';

import { useNetworkFeeEstimate } from './useNetworkFeeEstimate';
import useVerificationBaseFee from './useVerificationBaseFee';

jest.mock('./useVerificationBaseFee', () => ({
  __esModule: true,
  default: jest.fn()
}));

jest.mock('app/hooks/useMidenFaucetId', () => ({
  __esModule: true,
  default: () => 'native-faucet'
}));

// The store only supplies metadata; the native fallback is what resolves it.
jest.mock('lib/store', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) => selector({ assetsMetadata: {} })
}));

jest.mock('lib/miden/metadata/resolve', () => ({
  resolveDisplayMetadata: jest.fn(() => ({ symbol: 'MIDEN', decimals: 6 }))
}));

const mockHasKnownScale = jest.fn(() => true);
jest.mock('lib/miden/metadata/scale', () => ({
  hasKnownScale: (...args: unknown[]) => mockHasKnownScale(...(args as []))
}));

// Mocked so the assertion is about what the hook COMPUTES and hands over -- the
// bound and the scale -- rather than about `formatBigInt`, which has its own tests.
const mockFormatAmount = jest.fn((amount: bigint, decimals?: number) => `${amount}@${decimals}`);
jest.mock('lib/shared/format', () => ({
  formatAmount: (...args: unknown[]) => mockFormatAmount(...(args as [bigint, number]))
}));

const mockBaseFee = useVerificationBaseFee as jest.MockedFunction<typeof useVerificationBaseFee>;

describe('useNetworkFeeEstimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasKnownScale.mockReturnValue(true);
  });

  it('quotes the same upper bound the wallet reserves, so the number matches the withheld Available', () => {
    // 10000 base units x FEE_RESERVE_MULTIPLE (30) = 300000 => 0.3 at 6 decimals.
    mockBaseFee.mockReturnValue(10000);

    const { result } = renderHook(() => useNetworkFeeEstimate());

    // 10000 x 30 = 300000 smallest units, handed over at the fee asset's own scale.
    expect(mockFormatAmount).toHaveBeenCalledWith(300000n, 6);
    expect(result.current).toBe('300000@6 MIDEN');
  });

  it('renders nothing before the fee is discovered, rather than quoting zero', () => {
    // `null` is "unknown", not "free". Quoting a fee here would invent one.
    mockBaseFee.mockReturnValue(null);

    const { result } = renderHook(() => useNetworkFeeEstimate());

    expect(result.current).toBeUndefined();
  });

  it('renders nothing on a chain that charges nothing', () => {
    // A zero-fee chain (testnet) must look exactly as it did before fees existed.
    mockBaseFee.mockReturnValue(0);

    const { result } = renderHook(() => useNetworkFeeEstimate());

    expect(result.current).toBeUndefined();
  });

  it('renders nothing when the fee asset scale is unknown, rather than guessing a quantity', () => {
    // Same rule the receipt and the dApp sheet follow: an unscalable amount is
    // suppressed, never rendered at a guessed precision.
    mockBaseFee.mockReturnValue(10000);
    mockHasKnownScale.mockReturnValue(false);

    const { result } = renderHook(() => useNetworkFeeEstimate());

    expect(result.current).toBeUndefined();
  });
});
