import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { selectNativeEthFaucet, selectNativeEthToken } from 'lib/remote-config/values';

import {
  agglayerDeliveredAmount,
  findPendingBridgeInByEarnWithdrawTxId,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  suppressedLinkedConsumeIds,
  takeAgglayerBridgeInInfo,
  takeUsdcxBridgeInInfo,
  applyBridgeInInfoForNotes,
  setAgglayerSenderForE2E
} from './bridge-in';
import { IBridgeInInfo, ITransaction } from '../db/types';

const mockStore: Record<string, unknown> = {};

jest.mock('../front/storage', () => ({
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  fetchFromStorage: jest.fn(async (key: string) => mockStore[key]),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = value;
  })
}));

const mockAnyOfToArray = jest.fn();
const mockTransactions: any[] = [];
// Rows `tagConsumeRow` searches by note id, kept apart from `mockTransactions`
// so the AggLayer suites above are unaffected.
const mockNoteIdRows: any[] = [];
const mockModify = jest.fn(async (mutate: (row: ITransaction) => void, index: unknown) => {
  const row =
    typeof index === 'object' && index !== null
      ? mockNoteIdRows.find(record => record.id === Reflect.get(index, 'id'))
      : undefined;
  if (row) mutate(row);
  return row ? 1 : 0;
});
jest.mock('lib/agglayer/constant', () => ({ AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL: 'ETH' }));
// The delivery sender is the registry's native-ETH faucet (hex); the consume reads its sender in bech32. The bridge
// registers that faucet with scale 10: a deposit of w wei arrives as floor(w / 10^10) (#1326).
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: jest.fn(() => ({})),
  initBridgeConfig: jest.fn(async () => ({}))
}));
jest.mock('lib/remote-config/values', () => ({
  selectNativeEthFaucet: jest.fn(() => '0xagg'),
  selectNativeEthToken: jest.fn(() => ({
    midenFaucetId: '0xagg',
    originToken: '0x0000000000000000000000000000000000000000',
    originNetwork: 0,
    scale: 10
  }))
}));
// As the SDK parses ids: one text per account whichever form names it, and not the text the registry names the faucet
// in, so only a match that converts both sides finds the sender.
const mockAccountText: Record<string, string> = {
  'agg-sender': 'agg-account',
  '0xagg': 'agg-account',
  'usdcx-faucet-bech32': 'usdcx-faucet-account',
  '0xusdcx': 'usdcx-faucet-account'
};
jest.mock('lib/miden/sdk/helpers', () => ({
  accountRefToSdk: (ref: string) => {
    if (ref === 'unreadable-sender') throw new Error('not an account id');
    return { toString: () => mockAccountText[ref] ?? `${ref}-account` };
  },
  sameWalletAccountId: (a: string, b: string) => (mockAccountText[a] ?? a) === (mockAccountText[b] ?? b)
}));
// USDCx is the chain's native asset: the wallet discovers the faucet id, here in hex.
const mockGetNativeAssetId = jest.fn(async () => '0xusdcx');
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: () => mockGetNativeAssetId()
}));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((index?: unknown) => ({
      anyOf: jest.fn(() => ({ toArray: mockAnyOfToArray })),
      anyOfIgnoreCase: jest.fn((...noteIds: string[]) => ({
        filter: jest.fn((predicate: (tx: ITransaction) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows
              .filter(row => row.noteIds?.some((id: string) => noteIds.includes(id.toLowerCase())))
              .find(predicate)
          )
        }))
      })),
      // `where({ id })` for the modify path; `where('noteIds').equals(id)` for the lookup.
      modify: (mutate: (row: ITransaction) => void) => mockModify(mutate, index),
      equals: jest.fn((noteId: string) => ({
        filter: jest.fn((predicate: (tx: any) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows.filter(row => row.noteIds?.includes(noteId)).find(row => predicate(row))
          )
        }))
      })),
      first: jest.fn(async () =>
        typeof index === 'object' && index !== null
          ? mockNoteIdRows.find(row => row.id === Reflect.get(index, 'id'))
          : undefined
      ),
      index
    })),
    filter: jest.fn((predicate: (tx: any) => boolean) => ({
      toArray: jest.fn(async () => mockTransactions.filter(predicate))
    }))
  }
}));

const REGISTRY_KEY = 'epoch_bridge_in_intents';
const EVM_OWNER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  mockTransactions.splice(0);
  mockNoteIdRows.splice(0);
});

describe('resolveBridgeInNoteId', () => {
  const NOTE_ID = 'note-abc';
  const info: IBridgeInInfo = {
    provider: 'epoch',
    sourceAmount: '5',
    sourceSymbol: 'ETH',
    intentNonce: 'N1'
  };

  const consumeRow = (over: Record<string, unknown> = {}) => ({
    id: 'consume-1',
    type: 'consume',
    status: 2,
    noteIds: [NOTE_ID],
    amount: 5n,
    faucetId: 'faucet-a',
    ...over
  });

  it('tags the consume row that claimed the note, and drops the intent', async () => {
    mockNoteIdRows.push(consumeRow());
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  // A restored row records someone else's claim. Adopting it would retitle it
  // "Bridged from EVM", file this intent's amounts against it, and — because a
  // hit drops the intent — leave the wallet's own consume untagged forever.
  it('refuses a row restored from a backup, and keeps the intent pending', async () => {
    mockNoteIdRows.push(consumeRow({ restoredFromBackup: true }));
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).not.toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toHaveLength(1);
  });
});

// The registry scale the mock above names for the native-ETH faucet.
const SCALE = 10n ** 10n;

describe('takeAgglayerBridgeInInfo', () => {
  const DAY_SEC = 24 * 60 * 60;
  // The fixtures sit near the epoch; the clock is pinned just past them so every one is inside the delivery window.
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(() => nowSpy.mockRestore());

  it('reads the delivery sender only once this realm has hydrated the bridge config', async () => {
    let hydrated: () => void = () => undefined;
    jest.mocked(initBridgeConfig).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          hydrated = () =>
            resolve({ network: 'testnet', status: 'ready', config: null, derived: null, lastFetch: null });
        })
    );
    jest.mocked(selectNativeEthFaucet).mockClear();
    const taken = takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(selectNativeEthFaucet).not.toHaveBeenCalled();
    hydrated();
    await expect(taken).resolves.toBeUndefined();
    expect(selectNativeEthFaucet).toHaveBeenCalled();
  });

  it('matches sender, recipient and amount and selects the oldest pending row', async () => {
    mockTransactions.push(
      {
        id: 'newer',
        type: 'bridged-receive',
        accountId: 'miden-account_tag',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'older',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'submitting', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ provider: 'agglayer', bridgeReceiveTxId: 'older' });
  });

  // Matching rewrites the tracker row to `received` and makes the real consume
  // hide beneath it in history, so a restored tracker would adopt a genuine
  // incoming note and file the user's money under whatever the dump said.
  // The sender delivers bridged ETH, so an ERC-20 tracker must not adopt its note
  // even when it is older and its base-unit amount is the same.
  it('settles the ETH tracker, never an older ERC-20 tracker with the same amount', async () => {
    mockTransactions.push(
      {
        id: 'usdc',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'USDC' }
      },
      {
        id: 'eth',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'eth' });
  });

  it('never adopts a genuine note into a restored tracker', async () => {
    mockTransactions.push(
      {
        id: 'restored',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        restoredFromBackup: true,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'mine',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    // `restored` is the older row and would otherwise win the oldest-first pick.
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'mine' });
  });

  it('does not match a different sender or amount', async () => {
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'other', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();

    // Positive control: the same row matches with the configured sender and its amount.
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  it('matches the sender as an account, not as the text the registry names the faucet in', async () => {
    expect(accountRefToSdk('0xagg').toString()).not.toBe('0xagg');
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  it('logs a sender it cannot compare and takes no row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'unreadable-sender', amount: 5n })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        '[bridge-in] could not compare the delivery sender',
        'unreadable-sender',
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('matches nothing while the bridge config names no native-ETH faucet', async () => {
    jest.mocked(selectNativeEthFaucet).mockReturnValueOnce(null);
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();
  });

  it('takes an E2E sender instead of the registry faucet', async () => {
    setAgglayerSenderForE2E('cli-faucet');
    try {
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });
      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
      ).resolves.toBeUndefined();
      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'cli-faucet', amount: 5n })
      ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
    } finally {
      // An empty override clears it, so no later case inherits it.
      setAgglayerSenderForE2E('');
    }
  });

  it('floors a tracked wei amount at the scale it is given', () => {
    expect(agglayerDeliveredAmount(123_456_789_012_345_678n, 10)).toBe(12_345_678n);
    expect(agglayerDeliveredAmount(123_456_789_012_345_678n, 8)).toBe(1_234_567_890n);
  });

  it('compares at the scale the registry names for the native-ETH faucet', async () => {
    jest.mocked(selectNativeEthToken).mockReturnValueOnce({
      midenFaucetId: '0xagg',
      originToken: '0x0000000000000000000000000000000000000000',
      originNetwork: 0,
      scale: 8
    });
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * 10n ** 8n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'row' });
  });

  // An E2E sender stands in for the faucet only: the delivery's scale is still the registry's.
  it('matches nothing while the registry names no native-ETH scale, even from an E2E sender', async () => {
    setAgglayerSenderForE2E('cli-faucet');
    try {
      jest.mocked(selectNativeEthToken).mockReturnValueOnce(null);
      mockTransactions.push({
        id: 'row',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      });

      await expect(
        takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'cli-faucet', amount: 5n })
      ).resolves.toBeUndefined();
    } finally {
      setAgglayerSenderForE2E('');
    }
  });

  it('matches a scale-10 delivery to its wei tracker and never the unscaled wei amount', async () => {
    mockTransactions.push({
      id: 'wei',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 100_000_000_000_000_000n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '0.1', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({
        accountId: 'miden-account',
        senderAccountId: 'agg-sender',
        amount: 100_000_000_000_000_000n
      })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 10_000_000n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'wei' });
  });

  it('floors sub-scale dust the way the bridge does', async () => {
    mockTransactions.push({
      id: 'dust',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE + 123n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'dust' });
  });

  it('picks the oldest of two trackers that floor to the same delivery', async () => {
    mockTransactions.push(
      {
        id: 'exact',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'dusty',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE + 999n,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'dusty' });
  });

  it('skips a tracker with no amount', async () => {
    mockTransactions.push(
      {
        id: 'no-amount',
        type: 'bridged-receive',
        accountId: 'miden-account',
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'with-amount',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n * SCALE,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'with-amount' });
  });

  // A `ready` tracker is never polled again, so its 7-day timeout never fails it: without the bound, a tracker whose
  // delivery came long ago (and went untagged) would take the next deposit of the same amount (#1326).
  it('never adopts a delivery into a tracker older than the delivery window', async () => {
    nowSpy.mockReturnValue((8 * DAY_SEC + 100) * 1000);
    mockTransactions.push({
      id: 'stale',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 50,
      extraInputs: { provider: 'agglayer', phase: 'ready', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toBeUndefined();

    mockTransactions.push({
      id: 'fresh',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n * SCALE,
      initiatedAt: 8 * DAY_SEC,
      extraInputs: { provider: 'agglayer', phase: 'ready', sourceAmount: '5', sourceSymbol: 'ETH' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'fresh' });
  });
});

describe('takeUsdcxBridgeInInfo', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
  });
  afterEach(() => nowSpy.mockRestore());

  const DEPOSIT_HASH = `0x${'5'.repeat(64)}`;
  const tracker = (overrides: Record<string, unknown> = {}, extraInputs: Record<string, unknown> = {}) => ({
    id: 'row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    amount: 5_000_000n,
    initiatedAt: 1,
    ...overrides,
    extraInputs: {
      provider: 'usdcx',
      phase: 'ready',
      sourceAmount: '5',
      sourceSymbol: 'USDC',
      evmTxHash: DEPOSIT_HASH,
      ...extraInputs
    }
  });
  // The mint: the USDCx faucet sends a note of its own asset. The consume reads both ids in bech32.
  const mint = { accountId: 'miden-account', senderAccountId: 'usdcx-faucet-bech32', faucetId: 'usdcx-faucet-bech32' };

  it('matches the faucet, the account and the amount and selects the oldest broadcast deposit', async () => {
    mockTransactions.push(
      tracker({ id: 'newer', accountId: 'miden-account_tag', initiatedAt: 2 }),
      tracker({ id: 'older' }, { phase: 'delivering' })
    );

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toEqual({
      provider: 'usdcx',
      sourceAmount: '5',
      sourceSymbol: 'USDC',
      evmTxHash: DEPOSIT_HASH,
      bridgeReceiveTxId: 'older'
    });
  });

  it('leaves an ordinary faucet request alone when no deposit of that amount is open', async () => {
    mockTransactions.push(tracker());

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 100_000_000n })).resolves.toBeUndefined();
  });

  it('never waits for the native asset id when no USDCx deposit is open', async () => {
    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();

    expect(mockGetNativeAssetId).not.toHaveBeenCalled();
  });

  it.each([
    ['another sender', { senderAccountId: 'some-wallet' }],
    ['another asset', { faucetId: 'other-faucet' }],
    ['another account', { accountId: 'other-account' }]
  ])('does not match a note from %s', async (_label, overrides) => {
    mockTransactions.push(tracker());

    await expect(takeUsdcxBridgeInInfo({ ...mint, ...overrides, amount: 5_000_000n })).resolves.toBeUndefined();
  });

  it.each([
    ['was never broadcast', tracker({}, { evmTxHash: undefined, phase: 'submitting' })],
    ['already received its note', tracker({}, { phase: 'received' })],
    ['failed', tracker({}, { phase: 'failed' })],
    ['was restored from a backup', tracker({ restoredFromBackup: true })],
    ['is past the delivery window', tracker({ initiatedAt: -8 * 24 * 60 * 60 })],
    ['is for another route', tracker({}, { provider: 'agglayer' })]
  ])('does not match a deposit that %s', async (_label, row) => {
    mockTransactions.push(row);

    await expect(takeUsdcxBridgeInInfo({ ...mint, amount: 5_000_000n })).resolves.toBeUndefined();
  });
});

describe('applyBridgeInInfoForNotes', () => {
  it('returns the parked info with the resolved note id and bridge-receive link', async () => {
    const info: IBridgeInInfo = {
      provider: 'epoch',
      sourceSymbol: 'USDC',
      sourceAmount: '10',
      intentNonce: 'NONCE1',
      bridgeReceiveTxId: 'TX1'
    };
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', info);
    // Simulate the delivery poll having already learned the note id.
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['note-abc'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1', midenNoteId: 'note-abc', sourceSymbol: 'USDC' });
    // Matched intent leaves the registry.
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  it('matches despite 0x-prefix / casing drift between allocator and SDK note ids', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', bridgeReceiveTxId: 'TX1' });
    // Allocator reports an uppercase, 0x-prefixed id...
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = '0xABCDEF';

    // ...while the consumed note id from the SDK is bare lowercase hex.
    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['abcdef'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1' });
  });

  it('returns undefined when no consumed note matches a pending intent', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch' });
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    expect(await applyBridgeInInfoForNotes(['note-other'], async () => {})).toBe(false);
  });
});

describe('findPendingBridgeInByEarnWithdrawTxId', () => {
  it('returns the NEWEST matching intent when a resubmit left a stale entry for the same row', async () => {
    // Registry after a fail+retry on the same earn-withdraw row: the dead N1 (older,
    // first in the array as it was appended first) and the live N2 (newer). The lookup
    // must return N2 — returning the first match (N1) would re-strand the row on a dead
    // nonce, which is exactly the bug this ordering guards against.
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 2000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      },
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N2',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toEqual({
      intentNonce: 'N2',
      userAddress: EVM_OWNER
    });
  });

  it('returns undefined when no pending intent references the row', async () => {
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'OTHER' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toBeUndefined();
  });
});

describe('suppressedLinkedConsumeIds', () => {
  it('suppresses existing linked primaries but NOT a terminal-failed earn-withdraw row', async () => {
    // A live withdraw row is the single trace (suppress its consume). A FAILED withdraw
    // row is not — its delivered note must fall through to a visible receive — so it is
    // excluded even though it exists. Non-earn-withdraw primaries suppress on existence.
    // 'MISSING' has no row (the query returns only existing rows) so it is absent.
    mockAnyOfToArray.mockResolvedValue([
      { id: 'LIVE', type: 'earn-withdraw', extraInputs: { phase: 'delivering', evmOwner: EVM_OWNER } },
      { id: 'FAILED', type: 'earn-withdraw', extraInputs: { phase: 'failed' } },
      { id: 'SWAP', type: 'swap', extraInputs: {} }
    ]);

    const consumes: ITransaction[] = ['LIVE', 'FAILED', 'SWAP', 'MISSING'].map(id => ({
      id: `consume-${id}`,
      type: 'consume',
      accountId: 'account',
      status: 2,
      displayIcon: 'RECEIVE',
      initiatedAt: 1,
      extraInputs: id === 'SWAP' ? { swapOrderTxId: id } : { bridgeIn: { provider: 'epoch', earnWithdrawTxId: id } }
    }));
    const result = await suppressedLinkedConsumeIds(consumes);

    expect(result).toEqual(new Set(['consume-LIVE', 'consume-SWAP']));
  });

  it('short-circuits on an empty id list', async () => {
    const result = await suppressedLinkedConsumeIds([]);
    expect(result).toEqual(new Set());
    expect(mockAnyOfToArray).not.toHaveBeenCalled();
  });
});
