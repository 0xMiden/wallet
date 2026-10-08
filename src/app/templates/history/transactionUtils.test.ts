import { format } from 'date-fns';
import fs from 'fs';
import path from 'path';

import {
  TEST_BRIDGE_CONFIG_SNAPSHOT,
  TEST_EVM_USDC,
  TEST_MIDEN_USDC_FAUCET as MIDEN_USDC_FAUCET,
  TEST_NATIVE_ETH_FAUCET
} from 'lib/epoch/testing/bridge-config';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { getSwapTokenByFaucetId, TOKEN_IETH, TOKEN_IMIDEN } from 'lib/miden/swap/tokens';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { formatAmount } from 'lib/shared/format';

import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  bridgeInRowDisplay,
  bridgeRowDisplay,
  bridgeStatusOf,
  claimAccentColor,
  creditedAmount,
  earnDepositSettlementOf,
  earnWithdrawAmountFields,
  fontColorForType,
  formatDate,
  formatMoneyAmount,
  isBridgeInEntry,
  isCompletedTransaction,
  isEarnWithdrawEntry,
  isFaucetMintTransaction,
  isFaucetRequest,
  isReceiveEntry,
  labelHistoryEntry,
  MoneyKind,
  resolveConsumeExtraAmounts,
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

// The real constant, not a copy. It carries `scaleIsUnknown`, which is how
// `resolveConsumeExtraAmounts` tells "never looked this faucet up" apart from a
// stored record that genuinely says "Unknown" with real decimals.
const UNKNOWN_METADATA = jest.requireActual('lib/miden/metadata').DEFAULT_TOKEN_METADATA;

// The DEX swap registry pulls in SDK account-id helpers; stub the single lookup
// used here so tests choose between the registry-hit and fallback paths.
jest.mock('lib/miden/swap/tokens', () => ({
  getSwapTokenByFaucetId: jest.fn(),
  normalizedFaucetId: (faucetId: string) => faucetId,
  TOKEN_IETH: jest.requireActual('lib/miden/swap/tokens').TOKEN_IETH,
  TOKEN_IMIDEN: jest.requireActual('lib/miden/swap/tokens').TOKEN_IMIDEN
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

// This realm's bridge config: the real, unloaded one, or the loaded testnet one a case sets.
let mockBridgeSnapshot: BridgeConfigSnapshot | undefined;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = undefined;
});

// The placeholder a bridge row shows for a token it cannot name (U+2014), built so no dash is typed here.
const NO_TOKEN = String.fromCharCode(0x2014);

// The bridge config as a page holds it before the document loads: nothing is labelled.
const UNLOADED: BridgeConfigSnapshot = {
  network: 'testnet',
  status: 'loading',
  config: null,
  derived: null,
  lastFetch: null
};

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

describe('resolveConsumeExtraAmounts', () => {
  const consumeTx = (assetTotals?: { faucetId: string; amount: bigint }[]): any => ({
    type: 'consume',
    faucetId: 'faucet-a',
    amount: 20n,
    assetTotals
  });

  it('returns nothing for a non-consume transaction', async () => {
    await expect(resolveConsumeExtraAmounts({ type: 'send', faucetId: 'faucet-a' } as any)).resolves.toEqual([]);
    expect(mockGetTokenMetadata).not.toHaveBeenCalled();
  });

  it('returns nothing for a legacy consume row without assetTotals', async () => {
    await expect(resolveConsumeExtraAmounts(consumeTx(undefined))).resolves.toEqual([]);
  });

  // The row names it at render (`labelHistoryEntry`), so a stored line never holds a label the config may move off.
  it('keeps the chain symbol of a claimed line of the testnet bridge faucet', async () => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
    mockGetTokenMetadata.mockResolvedValue({ symbol: 'USDC', name: 'USDC', decimals: 6 });

    await expect(
      resolveConsumeExtraAmounts(
        consumeTx([
          { faucetId: 'faucet-a', amount: 20n },
          { faucetId: MIDEN_USDC_FAUCET, amount: 5n }
        ])
      )
    ).resolves.toEqual([{ faucetId: MIDEN_USDC_FAUCET, amount: 'fmt(5,6)', token: 'USDC' }]);
  });

  it('excludes the primary faucet and formats each secondary with its own decimals', async () => {
    mockGetTokenMetadata.mockImplementation(async (faucetId: string | null) =>
      faucetId === 'faucet-b' ? ({ symbol: 'BBB', decimals: 2 } as any) : ({ symbol: 'CCC', decimals: 8 } as any)
    );

    await expect(
      resolveConsumeExtraAmounts(
        consumeTx([
          { faucetId: 'faucet-a', amount: 20n },
          { faucetId: 'faucet-b', amount: 10n },
          { faucetId: 'faucet-c', amount: 5n }
        ])
      )
    ).resolves.toEqual([
      { faucetId: 'faucet-b', amount: 'fmt(10,2)', token: 'BBB' },
      { faucetId: 'faucet-c', amount: 'fmt(5,8)', token: 'CCC' }
    ]);
  });

  // Every entry on a history page resolves under one Promise.all, so a single
  // unresolvable faucet must not take the whole page down with it — but it must
  // not invent a number either. The unknown-token fallback's 6 decimals is a
  // placeholder, and a batch claim's secondary faucets are precisely the ones the
  // wallet has never held: scaling an 18-decimal token by 6 renders it 10^12 too
  // large, and nothing on screen would distinguish that from a correct total.
  it.each([
    ['the lookup throws', () => mockGetTokenMetadata.mockRejectedValue(new Error('faucet lookup failed'))],
    ['the lookup resolves to the unknown-token default', () => mockGetTokenMetadata.mockResolvedValue(UNKNOWN_METADATA)]
  ])('names the asset but withholds the amount when %s', async (_label, arrange) => {
    arrange();

    const resolved = await resolveConsumeExtraAmounts(
      consumeTx([
        { faucetId: 'faucet-a', amount: 20n },
        { faucetId: 'faucet-b', amount: 10n }
      ])
    );

    expect(resolved).toEqual([{ faucetId: 'faucet-b', amount: undefined, token: 'Unknown' }]);
  });

  // The other half: a faucet the wallet DOES know is still scaled by its own
  // decimals. Withholding here would hide a total the wallet can state exactly.
  it('keeps the amount when the faucet resolves to real metadata', async () => {
    mockGetTokenMetadata.mockResolvedValue({ symbol: 'BBB', decimals: 18 } as any);

    const resolved = await resolveConsumeExtraAmounts(
      consumeTx([
        { faucetId: 'faucet-a', amount: 20n },
        { faucetId: 'faucet-b', amount: 10n }
      ])
    );

    expect(resolved).toEqual([{ faucetId: 'faucet-b', amount: 'fmt(10,18)', token: 'BBB' }]);
  });
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

  // Off the registry AND unresolvable: the placeholder's 6 decimals are a guess,
  // and scaling a swap by them misreports how much was offered and asked for.
  // Both sides are still named.
  it('withholds both amounts when neither side resolves to a real scale', async () => {
    mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
    mockGetTokenMetadata.mockResolvedValue({
      symbol: 'Unknown',
      name: 'Unknown',
      decimals: 6,
      scaleIsUnknown: true
    } as any);

    const tx: any = {
      amount: 1000n,
      faucetId: 'offered-faucet',
      extraInputs: { requestedAmount: 2000n, requestedFaucetId: 'requested-faucet' }
    };

    const result = await resolveSwapHistoryFields(tx);

    expect(result.amount).toBeUndefined();
    expect(result.requestedAmount).toBeUndefined();
    expect(result.token).toBe('Unknown');
    expect(result.requestedToken).toBe('Unknown');
  });

  it('does not label missing swap assets as the native token', async () => {
    mockGetSwapTokenByFaucetId.mockReturnValue(undefined);
    const tx: ITransaction = {
      id: 'recovered-swap',
      accountId: 'account',
      type: 'swap',
      status: ITransactionStatus.Completed,
      initiatedAt: 1,
      displayIcon: 'SWAP'
    };
    const result = await resolveSwapHistoryFields(tx);
    expect(result.token).toBeUndefined();
    expect(result.requestedToken).toBeUndefined();
    expect(result.requestedAmount).toBeUndefined();
    expect(mockGetTokenMetadata).not.toHaveBeenCalled();
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

  it('returns true for a claim in flight whose entry has no icon yet', () => {
    mockGetNativeAssetIdSync.mockReturnValue('native-id');
    const entry: any = {
      transactionIcon: undefined,
      txType: 'consume',
      faucetId: 'native-id',
      secondaryAddress: 'native-id'
    };
    expect(isFaucetRequest(entry)).toBe(true);
  });
});

describe('isReceiveEntry', () => {
  it('counts a settled receive by its icon', () => {
    expect(isReceiveEntry({ transactionIcon: 'RECEIVE', txType: 'consume' })).toBe(true);
  });

  it('counts a claim still in flight, whose entry has no icon yet', () => {
    expect(isReceiveEntry({ transactionIcon: undefined, txType: 'consume' })).toBe(true);
  });

  it('does not count a send in flight', () => {
    expect(isReceiveEntry({ transactionIcon: undefined, txType: 'send' })).toBe(false);
  });

  it('does not count a failed claim', () => {
    expect(isReceiveEntry({ transactionIcon: 'FAILED', txType: 'consume' })).toBe(false);
  });

  it('does not count a settled send', () => {
    expect(isReceiveEntry({ transactionIcon: 'SEND', txType: 'send' })).toBe(false);
  });
});

describe('isFaucetMintTransaction', () => {
  // A stored row's ids can read back null; while the native faucet is still unknown (null too),
  // only the guard stops null === null from calling an ordinary claim a faucet mint.
  it('is not a faucet mint while the native faucet is unknown and the row names no faucet', () => {
    const transaction: any = { type: 'consume', faucetId: null, secondaryAccountId: null };
    expect(isFaucetMintTransaction(transaction, null)).toBe(false);
  });
});

describe('claimAccentColor', () => {
  const bridgeIn = { bridgeIn: { provider: 'agglayer' } };

  // Activity and the detail page slate every bridge-in row, so its claim arrow does too.
  it('gives a bridge-in claim the bridge slate', () => {
    const transaction: any = {
      type: 'consume',
      faucetId: 'bridged',
      secondaryAccountId: 'bridge',
      extraInputs: bridgeIn
    };
    expect(claimAccentColor(transaction, 'native')).toBe('#777487');
  });

  it('puts the bridge slate ahead of the faucet rose', () => {
    const transaction: any = {
      type: 'consume',
      faucetId: 'native',
      secondaryAccountId: 'native',
      extraInputs: bridgeIn
    };
    expect(claimAccentColor(transaction, 'native')).toBe('#777487');
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
    expect(fontColorForType('anything-else' as any)).toBe('#BA839F');
  });
});

describe('TRANSACTION_COLORS', () => {
  it('exposes the fixed palette', () => {
    expect(TRANSACTION_COLORS).toEqual({
      send: 'var(--tx-sent)',
      receive: 'var(--tx-received)',
      faucet: '#BA839F',
      bridge: '#777487'
    });
  });

  // Regression guard for the mismatched-purple bug: TransactionIcon draws the
  // send, receive and faucet circles from these JS constants (not from the CSS
  // vars), so each must stay byte-for-byte in sync with main.css or the Activity
  // row and the detail hero drift apart again. This covered the faucet alone
  // while send and receive had the same exposure and no guard at all.
  //
  // What it does NOT cover: any OTHER file that copies one of these hues. It reads
  // main.css and this module and nothing else, so a third copy elsewhere stays
  // invisible here - which is exactly how TransactionSummaryBadge kept painting the
  // retired send and swap colours. That file carries its own guard.
  // Send and receive REFERENCE the token rather than copying its value, so they cannot drift by
  // construction; what this pins is that they reference the right one and that it exists. The
  // colour itself is pinned, resolved through the alias and in both themes, by
  // `lib/ui/design-tokens.test.ts`'s "keeps the white activity glyph at 3:1" cases.
  it.each([
    ['send', '--tx-sent'],
    ['receive', '--tx-received']
  ] as const)('points %s at the %s token rather than copying it', (key, token) => {
    const css = fs.readFileSync(path.join(__dirname, '../../../main.css'), 'utf8');
    expect(TRANSACTION_COLORS[key]).toBe(`var(${token})`);
    expect(css).toMatch(new RegExp(`${token}:`));
  });

  // The faucet has no action colour to alias (it is not one of Home's five), so it stays a literal
  // and keeps the byte-for-byte guard: declared once for `:root` and once for `.dark`, both
  // agreeing with the constant TransactionIcon draws from.
  it('keeps faucet in sync with the --tx-faucet token in main.css', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../../main.css'), 'utf8');
    const matches = [...css.matchAll(/--tx-faucet:\s*(#[0-9a-fA-F]{6});/g)].map(m => m[1]!.toUpperCase());
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(TRANSACTION_COLORS.faucet);
    expect(matches[1]).toBe(TRANSACTION_COLORS.faucet);
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

// A restore keeps a row's extraInputs as the dump recorded them, so a hand-edited backup can put a
// number, or a BigInt from a `$bigint` tag, in an amount field every reader types as a string.
const restoredEntry = (overrides: Partial<IHistoryEntry>, stored: Record<string, unknown>): IHistoryEntry =>
  Object.assign(bridgeEntry(overrides), stored);

describe('isCompletedTransaction', () => {
  it.each(['Sent', 'Received', 'Reclaimed', 'Executed'])('treats %s as completed', message => {
    expect(isCompletedTransaction(message)).toBe(true);
  });

  it.each(['Sending', 'Pending', '', 'sent'])('treats %s as not completed', message => {
    expect(isCompletedTransaction(message)).toBe(false);
  });
});

// One rule for every Bridge and Earn amount. 10.6555 separates the three kinds: down reads
// 10.65, up reads 10.66 and half-up would read 10.66 too, so only an exact 10.6555 is typed.
describe('formatMoneyAmount', () => {
  const kinds: MoneyKind[] = ['receives', 'pays', 'typed'];
  const rounded: MoneyKind[] = ['receives', 'pays'];
  const separating: [MoneyKind, string][] = [
    ['receives', '10.65'],
    ['pays', '10.66'],
    ['typed', '10.6555']
  ];

  it.each(separating)('reads 10.6555 %s as %s', (kind, expected) => {
    expect(formatMoneyAmount('10.6555', kind)).toBe(expected);
  });

  // Parsed from its text, never through Number(): as a double, 1.239999999999999999 is 1.24.
  it('rounds an eighteen-digit received amount down from its exact text', () => {
    expect(formatMoneyAmount('1.239999999999999999', 'receives')).toBe('1.23');
  });

  it.each(kinds)('trims zeros and never pads (%s)', kind => {
    expect(formatMoneyAmount('12.5000', kind)).toBe('12.5');
    expect(formatMoneyAmount('12.00', kind)).toBe('12');
    expect(formatMoneyAmount('0', kind)).toBe('0');
  });

  it('expands a tiny amount to two significant places, down or up by kind', () => {
    expect(formatMoneyAmount('0.000001234', 'receives')).toBe('0.0000012');
    expect(formatMoneyAmount('0.000001234', 'pays')).toBe('0.0000013');
    expect(formatMoneyAmount('0.000001234', 'typed')).toBe('0.000001234');
  });

  it('keeps six decimals for ETH and WETH, the typed-amount cap', () => {
    expect(formatMoneyAmount('0.015', 'receives', 'ETH')).toBe('0.015');
    expect(formatMoneyAmount('0.015', 'receives', 'USDC')).toBe('0.01');
    expect(formatMoneyAmount('0.123456789', 'receives', 'ETH')).toBe('0.123456');
    expect(formatMoneyAmount('0.123456789', 'pays', 'ETH')).toBe('0.123457');
    expect(formatMoneyAmount('0.123456789', 'receives', 'WETH')).toBe('0.123456');
  });

  it('shows a typed amount as typed, without grouping, a trailing separator or trailing zeros', () => {
    expect(formatMoneyAmount('1,234.50', 'typed')).toBe('1234.5');
    expect(formatMoneyAmount('1.', 'typed')).toBe('1');
    expect(formatMoneyAmount('10.65555555', 'typed', 'ETH')).toBe('10.65555555');
  });

  it('reads an empty or non-numeric typed amount as 0', () => {
    expect(formatMoneyAmount('', 'typed')).toBe('0');
    expect(formatMoneyAmount('not-a-number', 'typed')).toBe('0');
  });

  it.each(rounded)('passes a non-numeric %s amount through unchanged', kind => {
    expect(formatMoneyAmount('not-a-number', kind)).toBe('not-a-number');
  });

  it.each(kinds)('passes undefined through (%s)', kind => {
    expect(formatMoneyAmount(undefined, kind)).toBeUndefined();
  });

  // Expanding 9e9999999 would build ten million digits during render.
  it.each(['1e41', '1e-41', '9e9999999', '1e-9999999'])(
    'reads %s, outside the display window, as non-numeric without expanding it',
    value => {
      expect(formatMoneyAmount(value, 'typed')).toBe('0');
      expect(formatMoneyAmount(value, 'receives')).toBe(value);
      expect(formatMoneyAmount(value, 'pays')).toBe(value);
    }
  );

  it('still expands a value at the edge of the display window', () => {
    expect(formatMoneyAmount('1e40', 'typed')).toBe(`1${'0'.repeat(40)}`);
    expect(formatMoneyAmount('1e-40', 'typed')).toBe(`0.${'0'.repeat(39)}1`);
    expect(formatMoneyAmount('1e40', 'receives')).toBe(`1${'0'.repeat(40)}`);
  });

  // The Slow detail hero formats a stored source amount; a throw here takes the page down.
  describe('a stored amount a restored backup left as a number or a BigInt', () => {
    const stored = (value: unknown) => restoredEntry({}, { bridgeInSourceAmount: value }).bridgeInSourceAmount;

    it.each(separating)('reads the number 10.6555 %s as %s', (kind, expected) => {
      expect(formatMoneyAmount(stored(10.6555), kind)).toBe(expected);
    });

    it('reads a typed number exactly', () => {
      expect(formatMoneyAmount(stored(0.015), 'typed', 'ETH')).toBe('0.015');
      expect(formatMoneyAmount(stored(1e21), 'typed')).toBe('1000000000000000000000');
    });

    it.each(kinds)('reads a BigInt as its value (%s)', kind => {
      expect(formatMoneyAmount(stored(12n), kind)).toBe('12');
    });

    // A one-element array stringifies to its element, so only the type check keeps ['12'] from reading 12.
    it('reads any other shape as 0 when typed and passes it through when rounded', () => {
      const shape = { amount: '12' };
      const list = ['12'];
      expect(formatMoneyAmount(stored(shape), 'typed')).toBe('0');
      expect(formatMoneyAmount(stored(list), 'typed')).toBe('0');
      expect(formatMoneyAmount(stored(null), 'typed')).toBe('0');
      expect(formatMoneyAmount(stored(shape), 'receives')).toBe(shape);
      expect(formatMoneyAmount(stored(shape), 'pays')).toBe(shape);
      expect(formatMoneyAmount(stored(list), 'receives')).toBe(list);
      expect(formatMoneyAmount(stored(list), 'pays')).toBe(list);
    });
  });
});

// What a received row credited: its base-unit amount scaled by the delivered faucet, rounded down.
describe('creditedAmount', () => {
  it('scales the amount by the faucet and rounds it down at the asset precision', () => {
    mockFormatAmount.mockReturnValueOnce('150.126456');

    expect(creditedAmount(150_126_456n, { symbol: 'USDC', name: 'USDC', decimals: 6 })).toBe('150.12');
    expect(mockFormatAmount).toHaveBeenCalledWith(150_126_456n, 6);
  });

  it('keeps six decimals for a credited ETH amount', () => {
    mockFormatAmount.mockReturnValueOnce('0.015123456789');

    expect(creditedAmount(15_123_456_789_000_000n, { symbol: 'ETH', name: 'Ether', decimals: 18 })).toBe('0.015123');
  });

  it('withholds the amount when the faucet scale is a guess or the row has no amount', () => {
    expect(creditedAmount(100n, UNKNOWN_METADATA)).toBeUndefined();
    expect(creditedAmount(100n, undefined)).toBeUndefined();
    expect(creditedAmount(undefined, { symbol: 'USDC', name: 'USDC', decimals: 6 })).toBeUndefined();
    expect(mockFormatAmount).not.toHaveBeenCalled();
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
        UNLOADED,
        bridgeEntry({
          token: 'MIDEN',
          amount: '5',
          bridgeProvider: 'epoch',
          bridgeOutputSymbol: 'USDC',
          bridgeOutputAmount: '4.987654',
          bridgeEpochStatus: 'confirmed'
        })
      )
    ).toEqual({
      inSymbol: 'MIDEN',
      outSymbol: 'USDC',
      inLabel: 'MIDEN',
      outLabel: 'USDC',
      // Truncated, not rounded up: a quote must not promise more than it pays.
      outAmount: '4.98',
      providerLabel: 'Epoch',
      network: 'Sepolia',
      status: 'confirmed'
    });
  });

  it('rounds a stored quote down and drops the padding of a legacy display string', () => {
    const quoted = (bridgeOutputAmount: string) =>
      bridgeRowDisplay(
        UNLOADED,
        bridgeEntry({ token: 'MIDEN', amount: '5', bridgeProvider: 'epoch', bridgeOutputAmount })
      ).outAmount;

    expect(quoted('10.655599')).toBe('10.65');
    expect(quoted('12.00')).toBe('12');
    expect(quoted('0.00')).toBe('0');
  });

  it('defaults an agglayer row without an output symbol to ETH and falls back to the input amount', () => {
    expect(
      bridgeRowDisplay(
        UNLOADED,
        bridgeEntry({ token: 'MIDEN', amount: '7', bridgeProvider: 'agglayer', bridgeClaimStatus: 'claimed' })
      )
    ).toEqual({
      inSymbol: 'MIDEN',
      outSymbol: 'ETH',
      inLabel: 'MIDEN',
      outLabel: 'ETH',
      outAmount: '7',
      providerLabel: 'Agglayer',
      network: 'Sepolia',
      status: 'confirmed'
    });
  });

  it('falls back to em dash / USDC / "Bridge" when the row carries no provider or token', () => {
    expect(bridgeRowDisplay(UNLOADED, bridgeEntry({}))).toEqual({
      inSymbol: '—',
      outSymbol: 'USDC',
      inLabel: NO_TOKEN,
      outLabel: 'USDC',
      outAmount: undefined,
      providerLabel: 'Bridge',
      network: 'Sepolia',
      status: 'pending'
    });
  });

  // Proves the value HistoryItem/HistoryView render for a bridge-out list row: neither
  // reformats `outAmount` themselves, so this function's return is the list row's amount.
  // An agglayer row never carries a quoted output (that field is Epoch-only), so this is the
  // typed Miden-side send amount and must show as entered, not cut to two decimals.
  it('shows a Slow-route amount as entered in the fallback path, not cut to two decimals', () => {
    expect(
      bridgeRowDisplay(UNLOADED, bridgeEntry({ token: 'ETH', amount: '0.015', bridgeProvider: 'agglayer' })).outAmount
    ).toBe('0.015');
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
        UNLOADED,
        bridgeEntry({
          txType: 'consume',
          token: 'MIDEN',
          amount: '3',
          bridgeInProvider: 'agglayer',
          bridgeInSourceSymbol: 'ETH'
        })
      )
    ).toEqual({
      inSymbol: 'ETH',
      outSymbol: 'MIDEN',
      inLabel: 'ETH',
      outLabel: 'MIDEN',
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
        UNLOADED,
        bridgeEntry({
          txType: 'bridged-receive',
          bridgeInPhase: 'received',
          amount: '7',
          bridgeInOutputAmount: '99',
          bridgeInProvider: 'epoch'
        })
      ).outAmount
    ).toBe('7');
  });

  // The list row and the detail hero both read this, so a received amount is rounded here, once.
  it("rounds a received bridge-in's credited amount down at the asset precision", () => {
    const received = (amount: string, symbol: string) =>
      bridgeInRowDisplay(
        UNLOADED,
        bridgeEntry({
          txType: 'bridged-receive',
          bridgeInPhase: 'received',
          amount,
          bridgeInOutputAmount: '99',
          bridgeInOutputSymbol: symbol,
          bridgeInProvider: 'epoch'
        })
      ).outAmount;

    expect(received('150.126456', 'USDC')).toBe('150.12');
    expect(received('0.0151236567', 'ETH')).toBe('0.015123');
  });

  it('shows an in-flight "you receive" amount as typed, without padding', () => {
    const inFlight = (bridgeInOutputAmount: string) =>
      bridgeInRowDisplay(
        UNLOADED,
        bridgeEntry({
          txType: 'bridged-receive',
          bridgeInPhase: 'delivering',
          amount: '10',
          bridgeInOutputAmount,
          bridgeInProvider: 'epoch'
        })
      ).outAmount;

    expect(inFlight('10.6555')).toBe('10.6555');
    // A row written before the stored value went exact holds a padded display string.
    expect(inFlight('12.00')).toBe('12');
  });

  // Activity and Token Detail build this row during render, so a throw here takes the list down.
  it('shows an in-flight "you receive" a restored backup left as a number or a BigInt', () => {
    const inFlight = (bridgeInOutputAmount: unknown) =>
      bridgeInRowDisplay(
        UNLOADED,
        restoredEntry(
          { txType: 'bridged-receive', bridgeInPhase: 'delivering', amount: '10', bridgeInProvider: 'epoch' },
          { bridgeInOutputAmount }
        )
      ).outAmount;

    expect(inFlight(10.6555)).toBe('10.6555');
    expect(inFlight(12n)).toBe('12');
  });

  // With no stored "you receive" the row's own amount shows: a Slow row's is the typed amount, any other row's
  // (a row with no provider reads as Epoch) is the quote's tokenOut, which rounds down.
  describe('an in-flight bridge-in with no stored "you receive"', () => {
    const fallback = (bridgeInProvider: IHistoryEntry['bridgeInProvider'], amount: string) =>
      bridgeInRowDisplay(
        UNLOADED,
        bridgeEntry({
          txType: 'bridged-receive',
          bridgeInPhase: 'delivering',
          amount,
          bridgeInOutputSymbol: 'USDC',
          bridgeInProvider
        })
      ).outAmount;

    it('rounds a Fast row down', () => {
      expect(fallback('epoch', '9.987654')).toBe('9.98');
    });

    it('rounds a row with no provider down, as Fast', () => {
      expect(fallback(undefined, '9.987654')).toBe('9.98');
    });

    it('shows a Slow row as typed', () => {
      expect(fallback('agglayer', '1.234567')).toBe('1.234567');
    });
  });

  // Rows written before the fix carry the allocator's token `name` as a symbol,
  // which for Sepolia USDC is the contract address.
  it('ignores a stored symbol that is an EVM contract address', () => {
    const address = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
    const display = bridgeInRowDisplay(
      UNLOADED,
      bridgeEntry({
        txType: 'bridged-receive',
        bridgeInPhase: 'received',
        token: 'USDC',
        bridgeInProvider: 'epoch',
        bridgeInSourceSymbol: address,
        bridgeInOutputSymbol: address
      })
    );
    expect(display.inSymbol).toBe('USDC');
    expect(display.outSymbol).toBe('USDC');
  });

  it('defaults the source symbol to USDC and labels a non-agglayer provider Epoch', () => {
    expect(bridgeInRowDisplay(UNLOADED, bridgeEntry({ txType: 'consume', bridgeInProvider: 'epoch' }))).toEqual({
      inSymbol: 'USDC',
      outSymbol: '—',
      inLabel: 'USDC',
      outLabel: NO_TOKEN,
      outAmount: undefined,
      providerLabel: 'Epoch',
      network: 'Miden',
      status: 'confirmed'
    });
  });
});

describe('bridge rows testnet bridge USDC label', () => {
  beforeEach(() => {
    mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
  });

  // The document names the EVM USDC before its Sepolia read succeeds; the Miden side is named from the document too.
  it('labels the EVM USDC side from the document alone while its token read has not succeeded', () => {
    const documentOnly: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
    mockBridgeSnapshot = documentOnly;

    const out = bridgeRowDisplay(
      documentOnly,
      bridgeEntry({ token: 'USDC', faucetId: MIDEN_USDC_FAUCET, amount: '5', bridgeProvider: 'epoch' })
    );
    const usdcIn = bridgeInRowDisplay(
      documentOnly,
      bridgeEntry({ txType: 'consume', token: 'USDC', faucetId: MIDEN_USDC_FAUCET, bridgeInProvider: 'epoch' })
    );
    const ethIn = bridgeInRowDisplay(
      documentOnly,
      bridgeEntry({ txType: 'consume', token: 'ETH', bridgeInProvider: 'agglayer', bridgeInSourceSymbol: 'ETH' })
    );

    expect([out.outLabel, usdcIn.inLabel, ethIn.inLabel]).toEqual(['Test Epoch USDC', 'Test Epoch USDC', 'ETH']);
  });

  it('labels both sides of an Epoch bridge-out of the bridge faucet', () => {
    expect(
      bridgeRowDisplay(
        TEST_BRIDGE_CONFIG_SNAPSHOT,
        bridgeEntry({
          token: 'USDC',
          faucetId: MIDEN_USDC_FAUCET,
          amount: '5',
          bridgeProvider: 'epoch',
          bridgeOutputSymbol: 'USDC',
          bridgeOutputAmount: '4.987654'
        })
      )
    ).toMatchObject({
      inSymbol: 'USDC',
      inLabel: 'Test Epoch USDC',
      outSymbol: 'USDC',
      outLabel: 'Test Epoch USDC',
      outAmount: '4.98'
    });
  });

  it.each(['USDC', TEST_EVM_USDC.address])(
    'labels an old Epoch bridge-in row saved with USDC or with the token address (%s)',
    saved => {
      expect(
        bridgeInRowDisplay(
          TEST_BRIDGE_CONFIG_SNAPSHOT,
          bridgeEntry({
            txType: 'consume',
            token: 'USDC',
            faucetId: MIDEN_USDC_FAUCET,
            amount: '3',
            bridgeInProvider: 'epoch',
            bridgeInSourceSymbol: saved
          })
        )
      ).toMatchObject({ inSymbol: 'USDC', inLabel: 'Test Epoch USDC', outSymbol: 'USDC', outLabel: 'Test Epoch USDC' });
    }
  );

  it('labels a Slow-route bridge-in of the configured USDC like the review does', () => {
    expect(
      bridgeInRowDisplay(
        TEST_BRIDGE_CONFIG_SNAPSHOT,
        bridgeEntry({
          txType: 'consume',
          token: 'USDC',
          faucetId: MIDEN_USDC_FAUCET,
          amount: '3',
          bridgeInProvider: 'agglayer',
          bridgeInSourceSymbol: 'USDC'
        })
      )
    ).toMatchObject({ inLabel: 'Test Epoch USDC', outLabel: 'Test Epoch USDC' });
  });

  it('leaves an Agglayer ETH row on ETH', () => {
    expect(
      bridgeInRowDisplay(
        TEST_BRIDGE_CONFIG_SNAPSHOT,
        bridgeEntry({
          txType: 'consume',
          token: 'ETH',
          faucetId: TEST_NATIVE_ETH_FAUCET,
          amount: '0.015',
          bridgeInProvider: 'agglayer',
          bridgeInSourceSymbol: 'ETH'
        })
      )
    ).toMatchObject({ inLabel: 'ETH', outLabel: 'ETH' });
    expect(
      bridgeRowDisplay(
        TEST_BRIDGE_CONFIG_SNAPSHOT,
        bridgeEntry({ token: 'ETH', faucetId: TEST_NATIVE_ETH_FAUCET, amount: '0.015', bridgeProvider: 'agglayer' })
      )
    ).toMatchObject({ inLabel: 'ETH', outLabel: 'ETH' });
  });
});

describe('labelHistoryEntry', () => {
  const claim = bridgeEntry({
    txType: 'consume',
    faucetId: MIDEN_USDC_FAUCET,
    token: 'USDC',
    amount: '5',
    extraAmounts: [
      { faucetId: MIDEN_USDC_FAUCET, amount: '2', token: 'USDC' },
      { faucetId: TEST_NATIVE_ETH_FAUCET, amount: '1', token: 'ETH' }
    ]
  });

  it("labels a row's token and each extra amount by its own faucet", () => {
    expect(labelHistoryEntry(TEST_BRIDGE_CONFIG_SNAPSHOT, claim)).toEqual({
      ...claim,
      token: 'Test Epoch USDC',
      extraAmounts: [
        { faucetId: MIDEN_USDC_FAUCET, amount: '2', token: 'Test Epoch USDC' },
        { faucetId: TEST_NATIVE_ETH_FAUCET, amount: '1', token: 'ETH' }
      ]
    });
  });

  it('keeps every symbol before the bridge config loads', () => {
    expect(labelHistoryEntry(UNLOADED, claim)).toEqual(claim);
  });

  it('labels each side of a swap row by its own faucet, so iETH reads "Test iETH" on either side (#477)', () => {
    const swapRow = bridgeEntry({
      txType: 'swap',
      faucetId: TOKEN_IMIDEN.faucetId,
      token: 'MIDEN',
      requestedFaucetId: TOKEN_IETH.faucetId,
      requestedToken: 'IETH'
    });
    expect(labelHistoryEntry(TEST_BRIDGE_CONFIG_SNAPSHOT, swapRow)).toMatchObject({
      token: 'MIDEN',
      requestedToken: 'Test iETH'
    });
    expect(
      labelHistoryEntry(TEST_BRIDGE_CONFIG_SNAPSHOT, {
        ...swapRow,
        faucetId: TOKEN_IETH.faucetId,
        token: 'IETH',
        requestedFaucetId: TOKEN_IMIDEN.faucetId,
        requestedToken: 'MIDEN'
      })
    ).toMatchObject({ token: 'Test iETH', requestedToken: 'MIDEN' });
  });

  it.each(['earn-withdraw', 'earn-deposit'] as const)('leaves a %s row on the token its own fields chose', txType => {
    const row = bridgeEntry({ txType, faucetId: MIDEN_USDC_FAUCET, token: 'USDC', amount: '5' });
    expect(labelHistoryEntry(TEST_BRIDGE_CONFIG_SNAPSHOT, row)).toEqual(row);
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
});

describe('earnWithdrawAmountFields', () => {
  const extra = {
    phase: 'redeeming' as const,
    evmOwner: '0x1111111111111111111111111111111111111111',
    marketUid: 'DUMMY_LENDING:11155111:0xunderlying',
    // A remainder above half: rounded down it reads 10.5, typed 10.509 and rounded up 10.51.
    sourceAmount: '10.509000',
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

  it('switches to the delivered destination amount, rounded down, once the note is received', () => {
    mockFormatAmount.mockReturnValueOnce('2.599999');

    // The consume path patches the row with what actually landed; the consume
    // row itself is suppressed, so this row must not keep claiming the USDC side.
    expect(earnWithdrawAmountFields({ ...extra, phase: 'received' }, 250_000_000n, destinationMetadata)).toEqual({
      amount: '2.59',
      token: 'MIDEN'
    });
    expect(mockFormatAmount).toHaveBeenCalledWith(250_000_000n, 8);
  });

  // This branch exists BECAUSE the received leg is denominated in the
  // destination faucet's asset, so its decimals are the whole point. Without
  // them there is no scale to apply: `formatAmount`'s own default is a
  // statement about a different token. Nor is there a name: the stored output
  // symbol is the bridged note's source token, not the asset that arrived.
  it('withholds the amount when the destination faucet never resolved', () => {
    expect(earnWithdrawAmountFields({ ...extra, phase: 'received', outputSymbol: 'USDC' }, 100n, undefined)).toEqual({
      amount: undefined,
      token: undefined
    });
  });

  it('withholds the amount when the destination resolved only to the placeholder', () => {
    const placeholder = { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true };

    expect(earnWithdrawAmountFields({ ...extra, phase: 'received', outputSymbol: 'MDN' }, 100n, placeholder)).toEqual({
      amount: undefined,
      token: 'Unknown'
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
});
