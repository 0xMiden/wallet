import { IBridgeInInfo } from '../db/types';

import { existingTransactionIds, registerPendingBridgeIn, takeBridgeInInfoForNotes } from './bridge-in';

const mockStore: Record<string, unknown> = {};

jest.mock('../front/storage', () => ({
  fetchFromStorage: jest.fn(async (key: string) => mockStore[key]),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = value;
  })
}));

const mockPrimaryKeys = jest.fn();
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn(() => ({ anyOf: jest.fn(() => ({ primaryKeys: mockPrimaryKeys })) }))
  }
}));

const REGISTRY_KEY = 'epoch_bridge_in_intents';
const EVM_OWNER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockStore)) delete mockStore[key];
});

describe('takeBridgeInInfoForNotes', () => {
  it('returns the parked info with the resolved note id and earn-withdraw link', async () => {
    const info: IBridgeInInfo = {
      provider: 'epoch',
      sourceSymbol: 'USDC',
      sourceAmount: '10',
      intentNonce: 'NONCE1',
      earnWithdrawTxId: 'TX1'
    };
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', info);
    // Simulate the delivery poll having already learned the note id.
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    const result = await takeBridgeInInfoForNotes(['note-abc']);

    expect(result).toMatchObject({ earnWithdrawTxId: 'TX1', midenNoteId: 'note-abc', sourceSymbol: 'USDC' });
    // Matched intent leaves the registry.
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  it('matches despite 0x-prefix / casing drift between allocator and SDK note ids', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', earnWithdrawTxId: 'TX1' });
    // Allocator reports an uppercase, 0x-prefixed id...
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = '0xABCDEF';

    // ...while the consumed note id from the SDK is bare lowercase hex.
    const result = await takeBridgeInInfoForNotes(['abcdef']);

    expect(result).toMatchObject({ earnWithdrawTxId: 'TX1' });
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
