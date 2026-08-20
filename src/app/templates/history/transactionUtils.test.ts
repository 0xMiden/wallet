import { format } from 'date-fns';

import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { formatAmount } from 'lib/shared/format';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  EARN_DEPOSIT_STATUS_LABEL_KEY,
  EARN_WITHDRAW_STATUS_LABEL_KEY,
  earnDepositSettlementOf,
  earnWithdrawAmountFields,
  earnWithdrawToneOf,
  fontColorForType,
  formatBridgeOutputAmount,
  formatDate,
  formatEarnWithdrawAmount,
  isBridgeInEntry,
  isCompletedTransaction,
  isEarnWithdrawEntry,
  isFaucetRequest,
  resolveSwapHistoryFields,
  swapSettlementOf,
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
      requestedToken: 'REQ',
      requestedFaucetId: 'requested-faucet'
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
      requestedToken: 'NATIVE',
      requestedFaucetId: undefined
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
      requestedToken: 'WALLET',
      requestedFaucetId: 'unknown-faucet'
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

// Bridge helpers work off plain `IHistoryEntry` fields, so a typed factory over
// the required keys is enough — no SDK or store doubles needed.
const bridgeEntry = (overrides: Partial<IHistoryEntry>): IHistoryEntry => ({
  key: 'entry-key',
  address: 'mtst1sender',
  timestamp: 1_700_000_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'bridged-send',
  ...overrides
});

describe('isCompletedTransaction', () => {
  it.each(['Sent', 'Received', 'Reclaimed', 'Executed'])('treats %s as completed', message => {
    expect(isCompletedTransaction(message)).toBe(true);
  });

  it.each(['Sending', 'Pending', '', 'sent'])('treats %s as not completed', message => {
    expect(isCompletedTransaction(message)).toBe(false);
  });
});

describe('formatBridgeOutputAmount', () => {
  it('passes undefined through', () => {
    expect(formatBridgeOutputAmount(undefined)).toBeUndefined();
  });

  it('rounds a full-precision value to 2 decimals', () => {
    expect(formatBridgeOutputAmount('1.239999999999999999')).toBe('1.24');
    expect(formatBridgeOutputAmount('0')).toBe('0.00');
  });

  it('pads a whole number to 2 decimals', () => {
    expect(formatBridgeOutputAmount('12')).toBe('12.00');
  });

  it('expands precision for a small non-zero output', () => {
    expect(formatBridgeOutputAmount('0.00126')).toBe('0.0013');
  });

  it('passes non-numeric input through unchanged', () => {
    expect(formatBridgeOutputAmount('not-a-number')).toBe('not-a-number');
  });
});

describe('bridgeStatusOf', () => {
  // ITransactionStatus.Failed === 3. A failed Miden tx never created a deposit,
  // so its terminal status must beat the route's own (initially pending) metadata.
  it('reports a failed Miden transaction as failed regardless of route metadata', () => {
    expect(bridgeStatusOf(bridgeEntry({ status: 3, bridgeProvider: 'agglayer', bridgeClaimStatus: 'pending' }))).toBe(
      'failed'
    );
  });

  it.each([
    ['ready', 'confirmed'],
    ['received', 'confirmed'],
    ['failed', 'failed'],
    [undefined, 'pending']
  ])('maps the inbound bridge phase %s', (bridgeInPhase, expected) => {
    expect(
      bridgeStatusOf(
        bridgeEntry({ txType: 'bridged-receive', bridgeInPhase: bridgeInPhase as IHistoryEntry['bridgeInPhase'] })
      )
    ).toBe(expected);
  });

  it('maps the agglayer claim lifecycle', () => {
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'agglayer', bridgeClaimStatus: 'claimed' }))).toBe('confirmed');
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'agglayer', bridgeClaimStatus: 'failed' }))).toBe('failed');
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'agglayer', bridgeClaimStatus: 'pending' }))).toBe('pending');
  });

  it('defaults an agglayer row with no claim status to pending', () => {
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'agglayer' }))).toBe('pending');
  });

  it('uses the polled intent status for the epoch route', () => {
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'epoch', bridgeEpochStatus: 'confirmed' }))).toBe('confirmed');
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'epoch', bridgeEpochStatus: 'failed' }))).toBe('failed');
  });

  it('defaults an epoch row with no polled status to pending', () => {
    expect(bridgeStatusOf(bridgeEntry({ bridgeProvider: 'epoch' }))).toBe('pending');
  });
});

describe('bridgeRowDisplay', () => {
  it('renders an epoch row from its quoted output', () => {
    expect(
      bridgeRowDisplay(
        bridgeEntry({
          token: 'MIDEN',
          amount: 5n,
          bridgeProvider: 'epoch',
          bridgeOutputSymbol: 'USDC',
          bridgeOutputAmount: '4.987654',
          bridgeEpochStatus: 'confirmed'
        })
      )
    ).toEqual({
      inSymbol: 'MIDEN',
      outSymbol: 'USDC',
      outAmount: '4.99',
      providerLabel: 'Epoch',
      network: 'Sepolia',
      status: 'confirmed'
    });
  });

  it('defaults an agglayer row without an output symbol to ETH and falls back to the input amount', () => {
    expect(
      bridgeRowDisplay(
        bridgeEntry({ token: 'MIDEN', amount: 7n, bridgeProvider: 'agglayer', bridgeClaimStatus: 'claimed' })
      )
    ).toEqual({
      inSymbol: 'MIDEN',
      outSymbol: 'ETH',
      outAmount: '7',
      providerLabel: 'Agglayer',
      network: 'Sepolia',
      status: 'confirmed'
    });
  });

  it('falls back to em dash / USDC / "Bridge" when the row carries no provider or token', () => {
    expect(bridgeRowDisplay(bridgeEntry({}))).toEqual({
      inSymbol: '—',
      outSymbol: 'USDC',
      outAmount: undefined,
      providerLabel: 'Bridge',
      network: 'Sepolia',
      status: 'pending'
    });
  });
});

describe('isBridgeInEntry', () => {
  it('is true only for a consume row tagged with a bridge-in provider', () => {
    expect(isBridgeInEntry(bridgeEntry({ txType: 'consume', bridgeInProvider: 'epoch' }))).toBe(true);
  });

  it('is false for an untagged consume row', () => {
    expect(isBridgeInEntry(bridgeEntry({ txType: 'consume' }))).toBe(false);
  });

  it('is false for a non-consume row even when tagged', () => {
    expect(isBridgeInEntry(bridgeEntry({ txType: 'send', bridgeInProvider: 'agglayer' }))).toBe(false);
  });
});

describe('bridgeInRowDisplay', () => {
  it('flips the direction: EVM source token in, Miden token out', () => {
    expect(
      bridgeInRowDisplay(
        bridgeEntry({
          txType: 'consume',
          token: 'MIDEN',
          amount: 3n,
          bridgeInProvider: 'agglayer',
          bridgeInSourceSymbol: 'ETH'
        })
      )
    ).toEqual({
      inSymbol: 'ETH',
      outSymbol: 'MIDEN',
      outAmount: '3',
      providerLabel: 'Agglayer',
      network: 'Miden',
      status: 'confirmed'
    });
  });

  // Once the note is consumed the row's own amount is the truth, so a `received`
  // phase wins over the quoted output amount even on a bridged-receive row.
  it('prefers the row amount over the quoted output once the phase is received', () => {
    expect(
      bridgeInRowDisplay(
        bridgeEntry({
          txType: 'bridged-receive',
          bridgeInPhase: 'received',
          amount: 7n,
          bridgeInOutputAmount: '99',
          bridgeInProvider: 'epoch'
        })
      ).outAmount
    ).toBe('7');
  });

  it('defaults the source symbol to USDC and labels a non-agglayer provider Epoch', () => {
    expect(bridgeInRowDisplay(bridgeEntry({ txType: 'consume', bridgeInProvider: 'epoch' }))).toEqual({
      inSymbol: 'USDC',
      outSymbol: '—',
      outAmount: undefined,
      providerLabel: 'Epoch',
      network: 'Miden',
      status: 'confirmed'
    });
  });
});

describe('swap settlement state', () => {
  // Drives the swap row's chip AND the receipt's hero pill, so a wrong answer
  // here is visible in two places at once — and reads "Pending" forever on an
  // order that settled, which is the confusion this shared helper exists to end.
  // Same minimal-shape casting as the helpers above; only these fields are read.
  const swap = (extraInputs: Record<string, unknown>, status = 2): any => ({ type: 'swap', status, extraInputs });

  it('reports pending only for an auto-consumed order with an expiry and no stamp', () => {
    expect(swapSettlementOf(swap({ orderId: 42n, expiresAt: 1_700_000_120 }))).toBe('pending');
  });

  it('stops reporting pending once the order carries a settlement stamp', () => {
    expect(
      swapSettlementOf(swap({ orderId: 42n, expiresAt: 1_700_000_120, settledAt: 1_700_000_200 }))
    ).toBeUndefined();
  });

  it('lets a settlement outrank a reclaim — a batch with paybacks delivered funds', () => {
    expect(
      swapSettlementOf(
        swap({ orderId: 42n, expiresAt: 1_700_000_120, settledAt: 1_700_000_200, reclaimedAt: 1_700_000_300 })
      )
    ).toBeUndefined();
    expect(swapSettlementOf(swap({ orderId: 42n, expiresAt: 1_700_000_120, reclaimedAt: 1_700_000_300 }))).toBe(
      'reclaimed'
    );
  });

  it('leaves a manual-claim order Confirmed — nothing settles it on a schedule', () => {
    expect(swapSettlementOf(swap({ orderId: 42n, expiresAt: 1_700_000_120, autoConsume: false }))).toBeUndefined();
  });

  it('leaves a legacy order without an expiry Confirmed rather than pending forever', () => {
    expect(swapSettlementOf(swap({ orderId: 42n }))).toBeUndefined();
  });

  it('ignores an order id it never got and rows that are not completed swaps', () => {
    expect(swapSettlementOf(swap({ expiresAt: 1_700_000_120 }))).toBeUndefined();
    expect(swapSettlementOf(swap({ orderId: 42n, expiresAt: 1_700_000_120 }, 0))).toBeUndefined();
    expect(swapSettlementOf({ type: 'send', status: 2, extraInputs: { orderId: 42n } } as any)).toBeUndefined();
  });
});

describe('earn withdraw helpers', () => {
  it('tags only earn-withdraw entries', () => {
    expect(isEarnWithdrawEntry(bridgeEntry({ txType: 'earn-withdraw' }))).toBe(true);
    expect(isEarnWithdrawEntry(bridgeEntry({ txType: 'earn-deposit' }))).toBe(false);
    expect(isEarnWithdrawEntry(bridgeEntry({ txType: 'send' }))).toBe(false);
  });

  it('trims a human decimal amount to two places, rounding down', () => {
    expect(formatEarnWithdrawAmount('2.50000000')).toBe('2.5');
    expect(formatEarnWithdrawAmount('1.239')).toBe('1.23');
    expect(formatEarnWithdrawAmount('7')).toBe('7');
  });

  it('expands precision for a small non-zero withdrawal amount', () => {
    expect(formatEarnWithdrawAmount('0.001239')).toBe('0.0012');
  });

  it('passes a non-numeric amount through unchanged', () => {
    expect(formatEarnWithdrawAmount('not-a-number')).toBe('not-a-number');
  });

  it('maps each phase to a bridge status tone', () => {
    expect(earnWithdrawToneOf('redeeming')).toBe('pending');
    expect(earnWithdrawToneOf('delivering')).toBe('pending');
    expect(earnWithdrawToneOf('received')).toBe('confirmed');
    expect(earnWithdrawToneOf('failed')).toBe('failed');
    expect(earnWithdrawToneOf(undefined)).toBe('pending');
  });

  it('has a label key for every phase', () => {
    expect(EARN_WITHDRAW_STATUS_LABEL_KEY).toEqual({
      redeeming: 'earnWithdrawStatusRedeeming',
      delivering: 'earnWithdrawStatusDelivering',
      received: 'received',
      failed: 'failed'
    });
  });
});

describe('earnWithdrawAmountFields', () => {
  const extra = {
    phase: 'redeeming' as const,
    evmOwner: '0x1111111111111111111111111111111111111111',
    marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
    sourceAmount: '10.500000',
    sourceSymbol: 'USDC',
    destinationFaucetId: 'native-id'
  };
  const destinationMetadata = { symbol: 'MIDEN', decimals: 8, name: 'Miden', faucetId: 'native-id' };

  it.each(['redeeming', 'delivering', 'failed'] as const)(
    'shows the redeemed source side while the withdrawal is %s',
    phase => {
      // The row's atomic `amount` is denominated in the native faucet, so
      // formatting it against USDC decimals would mis-scale it.
      expect(earnWithdrawAmountFields({ ...extra, phase }, 999n, destinationMetadata)).toEqual({
        amount: '10.5',
        token: 'USDC'
      });
    }
  );

  it('switches to the delivered destination amount once the note is received', () => {
    // The consume path patches the row with what actually landed; the consume
    // row itself is suppressed, so this row must not keep claiming the USDC side.
    expect(earnWithdrawAmountFields({ ...extra, phase: 'received' }, 250_000_000n, destinationMetadata)).toEqual({
      amount: formatAmount(250_000_000n, 8),
      token: 'MIDEN'
    });
  });

  it('falls back to the recorded output symbol when destination metadata is missing', () => {
    expect(earnWithdrawAmountFields({ ...extra, phase: 'received', outputSymbol: 'MDN' }, 100n, undefined)).toEqual({
      amount: formatAmount(100n, undefined),
      token: 'MDN'
    });
  });

  it('keeps the source side on a received row that was never patched with an amount', () => {
    expect(earnWithdrawAmountFields({ ...extra, phase: 'received' }, undefined, destinationMetadata)).toEqual({
      amount: '10.5',
      token: 'USDC'
    });
  });
});

describe('earn deposit settlement helpers', () => {
  it('treats an unstamped lending leg as still pending', () => {
    // The row is database-Completed as soon as the Miden collateral note lands,
    // so "no epochStatus yet" must never read as Confirmed.
    expect(earnDepositSettlementOf(bridgeEntry({ txType: 'earn-deposit' }))).toBe('pending');
  });

  it('passes an explicit settlement through', () => {
    expect(earnDepositSettlementOf(bridgeEntry({ txType: 'earn-deposit', earnDepositStatus: 'confirmed' }))).toBe(
      'confirmed'
    );
    expect(earnDepositSettlementOf(bridgeEntry({ txType: 'earn-deposit', earnDepositStatus: 'failed' }))).toBe(
      'failed'
    );
  });

  it('reuses the shared status label keys (no new i18n keys)', () => {
    expect(EARN_DEPOSIT_STATUS_LABEL_KEY).toEqual({
      pending: 'pending',
      confirmed: 'confirmed',
      failed: 'failed'
    });
  });
});
