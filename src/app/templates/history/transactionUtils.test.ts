import { format } from 'date-fns';

import {
  fontColorForType,
  formatDate,
  isFaucetRequest,
  resolveSwapHistoryFields,
  TRANSACTION_COLORS
} from './transactionUtils';

// `lib/i18n` drags in the full i18next runtime. The unit under test only needs
// `getDateFnsLocale`; stub it to `undefined` so date-fns falls back to its
// default (en-US) locale and formatted output is deterministic.
jest.mock('lib/i18n', () => ({
  getDateFnsLocale: jest.fn(() => undefined)
}));

// `getTokenMetadata` reaches into the Miden SDK / metadata store; a steerable
// jest.fn lets each test drive the wallet-metadata fallback branch.
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: jest.fn()
}));

// The DEX swap registry pulls in SDK account-id helpers; stub the single lookup
// used here so tests choose between the registry-hit and fallback paths.
jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokenByFaucetId: jest.fn()
}));

// Native-asset resolution instantiates an RpcClient at import time; replace the
// sync accessor with a steerable jest.fn.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn()
}));

// `formatAmount` imports the front barrel (SDK metadata). Replace it with a
// deterministic marker so we can assert exactly which (amount, decimals) pair
// each swap side was formatted with.
jest.mock('lib/shared/format', () => ({
  formatAmount: jest.fn((amount: bigint, decimals: number | undefined) => `fmt(${amount},${decimals})`)
}));

import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { formatAmount } from 'lib/shared/format';

const mockGetTokenMetadata = getTokenMetadata as jest.MockedFunction<typeof getTokenMetadata>;
const mockGetSwapTokenByFaucetId = getSwapTokenByFaucetId as jest.MockedFunction<typeof getSwapTokenByFaucetId>;
const mockGetNativeAssetIdSync = getNativeAssetIdSync as jest.MockedFunction<typeof getNativeAssetIdSync>;
const mockFormatAmount = formatAmount as jest.MockedFunction<typeof formatAmount>;

// Minimal shapes — the real ITransaction/SwapToken/IHistoryEntry types are
// erased at runtime, so plain casts are enough for the branches exercised.
const swapToken = (symbol: string, decimals: number): any => ({ symbol, decimals });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveSwapHistoryFields', () => {
  it('resolves both sides from the DEX registry and formats present amounts', async () => {
    mockGetSwapTokenByFaucetId.mockImplementation((faucetId?: string) => {
      if (faucetId === 'offered-faucet') return swapToken('OFF', 8);
      if (faucetId === 'requested-faucet') return swapToken('REQ', 6);
      return undefined;
    });

    const tx: any = {
      faucetId: 'offered-faucet',
      amount: 100n,
      extraInputs: { requestedFaucetId: 'requested-faucet', requestedAmount: 250n }
    };

    const result = await resolveSwapHistoryFields(tx);

    expect(result).toEqual({
      amount: 'fmt(100,8)',
      token: 'OFF',
      requestedAmount: 'fmt(250,6)',
      requestedToken: 'REQ'
    });
    // Registry hit on both sides => wallet-metadata fallback never consulted.
    expect(mockGetTokenMetadata).not.toHaveBeenCalled();
    expect(mockFormatAmount).toHaveBeenCalledWith(100n, 8);
    expect(mockFormatAmount).toHaveBeenCalledWith(250n, 6);
  });

  it('falls back to wallet metadata, defaults missing faucet ids to null, and omits absent amounts', async () => {
    // Registry misses on both sides => the `?? await getTokenMetadata(...)` path.
    mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
    mockGetTokenMetadata.mockImplementation(async (tokenId: string | null) => {
      if (tokenId === null) return swapToken('NATIVE', 5) as any;
      return swapToken('WALLET', 3) as any;
    });

    // No extraInputs (=> {}), no faucetId (=> null), no amount, no requestedAmount.
    const tx: any = { amount: undefined };

    const result = await resolveSwapHistoryFields(tx);

    expect(result).toEqual({
      amount: undefined,
      token: 'NATIVE',
      requestedAmount: undefined,
      requestedToken: 'NATIVE'
    });
    // Both faucet ids were undefined => coalesced to null for the metadata lookup.
    expect(mockGetTokenMetadata).toHaveBeenNthCalledWith(1, null);
    expect(mockGetTokenMetadata).toHaveBeenNthCalledWith(2, null);
    expect(mockFormatAmount).not.toHaveBeenCalled();
  });

  it('mixes a registry-resolved offered side with a wallet-metadata requested side', async () => {
    mockGetSwapTokenByFaucetId.mockImplementation((faucetId?: string) =>
      faucetId === 'offered-faucet' ? swapToken('OFF', 8) : undefined
    );
    mockGetTokenMetadata.mockResolvedValue(swapToken('WALLET', 2) as any);

    const tx: any = {
      faucetId: 'offered-faucet',
      amount: undefined,
      extraInputs: { requestedFaucetId: 'unknown-faucet', requestedAmount: 7n }
    };

    const result = await resolveSwapHistoryFields(tx);

    expect(result).toEqual({
      amount: undefined, // offered amount absent
      token: 'OFF',
      requestedAmount: 'fmt(7,2)',
      requestedToken: 'WALLET'
    });
    // Only the requested side fell through to metadata, keyed by its faucet id.
    expect(mockGetTokenMetadata).toHaveBeenCalledTimes(1);
    expect(mockGetTokenMetadata).toHaveBeenCalledWith('unknown-faucet');
  });
});

describe('isFaucetRequest', () => {
  it('returns false when there is no native faucet id yet', () => {
    mockGetNativeAssetIdSync.mockReturnValue(null);
    const entry: any = { transactionIcon: 'RECEIVE', faucetId: 'x', secondaryAddress: 'x' };
    expect(isFaucetRequest(entry)).toBe(false);
  });

  it('returns true when icon is RECEIVE and both ids match the native faucet', () => {
    mockGetNativeAssetIdSync.mockReturnValue('native-id');
    const entry: any = {
      transactionIcon: 'RECEIVE',
      faucetId: 'native-id',
      secondaryAddress: 'native-id'
    };
    expect(isFaucetRequest(entry)).toBe(true);
  });

  it('returns false when the icon is not RECEIVE', () => {
    mockGetNativeAssetIdSync.mockReturnValue('native-id');
    const entry: any = { transactionIcon: 'SEND', faucetId: 'native-id', secondaryAddress: 'native-id' };
    expect(isFaucetRequest(entry)).toBe(false);
  });

  it('returns false when the faucet id does not match', () => {
    mockGetNativeAssetIdSync.mockReturnValue('native-id');
    const entry: any = { transactionIcon: 'RECEIVE', faucetId: 'other', secondaryAddress: 'native-id' };
    expect(isFaucetRequest(entry)).toBe(false);
  });

  it('returns false when the secondary address does not match', () => {
    mockGetNativeAssetIdSync.mockReturnValue('native-id');
    const entry: any = { transactionIcon: 'RECEIVE', faucetId: 'native-id', secondaryAddress: 'other' };
    expect(isFaucetRequest(entry)).toBe(false);
  });
});

describe('fontColorForType', () => {
  it('maps send to the blue class', () => {
    expect(fontColorForType('send' as any)).toBe('text-send-blue');
  });

  it('maps consume to the green class', () => {
    expect(fontColorForType('consume' as any)).toBe('text-receive-green');
  });

  it('falls back to the faucet color for any other type', () => {
    expect(fontColorForType('faucet' as any)).toBe(TRANSACTION_COLORS.faucet);
    expect(fontColorForType('anything-else' as any)).toBe('#891DB1');
  });
});

describe('TRANSACTION_COLORS', () => {
  it('exposes the fixed palette', () => {
    expect(TRANSACTION_COLORS).toEqual({
      send: '#91ACC1',
      receive: '#99AC94',
      faucet: '#891DB1'
    });
  });
});

describe('formatDate', () => {
  // Reuse the real date-fns formatter with the default locale so expectations
  // stay correct regardless of the machine's timezone.
  const expected = (ms: number) => format(new Date(ms), 'dd MMM yyyy, HH:mm', { locale: undefined });

  it('treats a number as unix seconds (multiplied to ms)', () => {
    const secs = 1609502400; // 2021-01-01T12:00:00Z
    expect(formatDate(secs)).toBe(expected(secs * 1000));
  });

  it('treats a numeric string as unix seconds', () => {
    expect(formatDate('1609502400')).toBe(expected(1609502400 * 1000));
    // Fractional numeric string exercises parseFloat's decimal handling.
    expect(formatDate('1609502400.5')).toBe(expected(1609502400.5 * 1000));
  });

  it('parses a non-numeric but valid date string directly', () => {
    // parseFloat('Jan 1 2021') is NaN => the `new Date(timestamp)` branch.
    expect(formatDate('Jan 1 2021 12:00')).toBe(expected(new Date('Jan 1 2021 12:00').getTime()));
  });

  it('returns "Invalid Date" for an unparseable string', () => {
    expect(formatDate('not-a-real-date')).toBe('Invalid Date');
  });

  it('returns "Invalid Date" for a NaN number (invalid resulting date)', () => {
    expect(formatDate(NaN)).toBe('Invalid Date');
  });

  it('returns "Invalid Date" for a value that is neither number nor string', () => {
    expect(formatDate(null as any)).toBe('Invalid Date');
    expect(formatDate(undefined as any)).toBe('Invalid Date');
    expect(formatDate({} as any)).toBe('Invalid Date');
  });
});
