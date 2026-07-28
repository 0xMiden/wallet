import {
  existingTransactionIds,
  registerPendingBridgeIn,
  takeAgglayerBridgeInInfo,
  takeBridgeInInfoForNotes
} from './bridge-in';
import { IBridgeInInfo } from '../db/types';

const mockStore: Record<string, unknown> = {};

jest.mock('../front/storage', () => ({
  fetchFromStorage: jest.fn(async (key: string) => mockStore[key]),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = value;
  })
}));

const mockPrimaryKeys = jest.fn();
const mockTransactions: any[] = [];
jest.mock('lib/agglayer/constant', () => ({ AGGLAYER_BRIDGE_NOTE_SENDER_ACCOUNT_ID: 'agg-sender' }));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn(() => ({ anyOf: jest.fn(() => ({ primaryKeys: mockPrimaryKeys })) })),
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
});

describe('takeAgglayerBridgeInInfo', () => {
  it('matches sender, recipient and amount and selects the oldest pending row', async () => {
    mockTransactions.push(
      {
        id: 'newer',
        type: 'bridged-receive',
        accountId: 'miden-account_tag',
        amount: 5n,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'older',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'submitting', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ provider: 'agglayer', bridgeReceiveTxId: 'older' });
  });

  it('does not match a different sender or amount', async () => {
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'other', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();
  });
});

describe('takeBridgeInInfoForNotes', () => {
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

    const result = await takeBridgeInInfoForNotes(['note-abc']);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1', midenNoteId: 'note-abc', sourceSymbol: 'USDC' });
    // Matched intent leaves the registry.
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  it('matches despite 0x-prefix / casing drift between allocator and SDK note ids', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', bridgeReceiveTxId: 'TX1' });
    // Allocator reports an uppercase, 0x-prefixed id...
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = '0xABCDEF';

    // ...while the consumed note id from the SDK is bare lowercase hex.
    const result = await takeBridgeInInfoForNotes(['abcdef']);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1' });
  });

  it('returns undefined when no consumed note matches a pending intent', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch' });
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    expect(await takeBridgeInInfoForNotes(['note-other'])).toBeUndefined();
  });
});

describe('existingTransactionIds', () => {
  it('returns the subset of ids that exist as rows', async () => {
    mockPrimaryKeys.mockResolvedValue(['TX1']);

    const result = await existingTransactionIds(['TX1', 'TX2', 'TX1']);

    expect(result).toEqual(new Set(['TX1']));
  });

  it('short-circuits on an empty id list', async () => {
    const result = await existingTransactionIds([]);
    expect(result).toEqual(new Set());
    expect(mockPrimaryKeys).not.toHaveBeenCalled();
  });
});
