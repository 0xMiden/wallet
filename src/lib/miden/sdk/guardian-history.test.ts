import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { decodeGuardianSummary } from './guardian-history';

let mockAssetId = 'asset';
let mockNativeLoaded = false;
let mockFeeLoaded = false;
const mockAssets = () => ({ fungibleAssets: () => [{ faucetId: () => mockAssetId, amount: () => 17n }] });
const mockMetadata = () => ({ sender: () => 'sender', noteType: () => 1 });
let mockStorage: bigint[];
let mockRoot: string;
let mockAttachment: bigint[] = [];
const mockFull = {
  id: () => ({ toString: () => 'note' }),
  attachments: () => [{ toWords: () => [{ toU64s: () => mockAttachment }] }],
  assets: mockAssets,
  metadata: mockMetadata,
  recipient: () => ({
    serialNum: () => ({ toFelts: () => [0n, 42n, 0n, 0n].map(value => ({ asInt: () => value })) }),
    script: () => ({ root: () => ({ toHex: () => mockRoot }) }),
    storage: () => ({ items: () => mockStorage.map(value => ({ asInt: () => value })) })
  })
};
const mockFree = jest.fn();
let mockPartial = false;
const mockSummary = {
  free: mockFree,
  accountDelta: () => ({ id: () => ({ toString: () => 'account' }) }),
  inputNotes: () => ({ notes: () => [{ note: () => mockFull }] }),
  outputNotes: () => ({
    notes: () => [
      {
        assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'fee', amount: () => 3n }] }),
        metadata: () => ({ tag: () => ({ asU32: () => 0xfee }) })
      },
      {
        id: () => ({ toString: () => 'output' }),
        intoFull: () => (mockPartial ? undefined : mockFull),
        assets: mockAssets,
        metadata: () => ({ sender: () => 'sender', noteType: () => 0, tag: () => ({ asU32: () => 1 }) })
      }
    ]
  })
};

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionSummary: { deserialize: () => mockSummary },
  AccountId: {
    fromPrefixSuffix: (prefix: { asInt(): bigint }, suffix: { asInt(): bigint }) =>
      `${prefix.asInt()}-${suffix.asInt()}`
  },
  NoteScript: {
    pswap: () => ({ root: () => ({ toHex: () => 'pswap' }) }),
    p2id: () => ({ root: () => ({ toHex: () => 'p2id' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => 'p2ide' }) })
  },
  NoteType: { Public: 1, Private: 0 }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(),
  getVerificationBaseFee: jest.fn(),
  getNativeAssetIdSync: () => (mockNativeLoaded ? 'fee' : null),
  getVerificationBaseFeeSync: () => (mockFeeLoaded ? 3 : null)
}));
jest.mock('./helpers', () => ({ getBech32AddressFromAccountId: (id: string) => id }));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: () => new Uint8Array() }));

beforeEach(() => {
  mockFree.mockClear();
  mockAssetId = 'asset';
  mockNativeLoaded = false;
  mockFeeLoaded = false;
  jest.mocked(getNativeAssetId).mockImplementation(async () => {
    mockNativeLoaded = true;
    return 'fee';
  });
  jest.mocked(getVerificationBaseFee).mockImplementation(async () => {
    mockFeeLoaded = true;
    return 3;
  });
  mockPartial = false;
  mockAttachment = [];
  mockRoot = 'p2id';
  mockStorage = [11n, 22n];
});

it('decodes P2ID recipients, input assets and the separate fee', async () => {
  const decoded = await decodeGuardianSummary('summary');
  expect(decoded.outputNotes[0]?.recipient).toBe('22-11');
  expect(decoded.inputNotes[0]?.assets).toEqual([{ faucetId: 'asset', amount: '17' }]);
  expect(decoded.inputNotes[0]?.visibility).toBe('public');
  expect(decoded.fee).toEqual({ faucetId: 'fee', amount: '3' });
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('decodes the recipient and reclaim height from the full P2IDE note', async () => {
  mockRoot = 'p2ide';
  mockStorage = [99n, 88n, 11n, 22n, 500n, 0n];
  expect((await decodeGuardianSummary('summary')).outputNotes[0]).toMatchObject({
    recipient: '22-11',
    reclaimHeight: 500
  });
});

it('retains partial private output assets without a fabricated recipient', async () => {
  mockPartial = true;
  expect((await decodeGuardianSummary('summary')).outputNotes[0]).toEqual({
    id: 'output',
    assets: [{ faucetId: 'asset', amount: '17' }],
    sender: 'sender',
    visibility: 'private'
  });
});

it('does not read a recipient from an unsupported script or storage layout', async () => {
  mockRoot = 'custom';
  expect((await decodeGuardianSummary('summary')).outputNotes[0]?.recipient).toBeUndefined();
  mockRoot = 'p2ide';
  expect((await decodeGuardianSummary('summary')).outputNotes[0]?.recipient).toBeUndefined();
});

it('bounds the summary before deserialization', async () => {
  await expect(decodeGuardianSummary('x'.repeat(4_000_001))).rejects.toThrow('too large');
  expect(mockFree).not.toHaveBeenCalled();
});

it('decodes the requested asset and order ID from a PSWAP note', async () => {
  mockRoot = 'pswap';
  mockStorage = [11n, 22n, 300n, 0n, 1n, 33n, 44n];
  expect((await decodeGuardianSummary('summary')).outputNotes[0]?.swap).toEqual({
    orderId: '42',
    requestedAsset: { faucetId: '22-11', amount: '300' }
  });
});

it('links a payback attachment only when its order matches the serial number', async () => {
  mockAttachment = [300n, 42n, 1n, 0n];
  expect((await decodeGuardianSummary('summary')).inputNotes[0]?.swap).toEqual({ orderId: '42' });
  mockAttachment = [300n, 43n, 1n, 0n];
  expect((await decodeGuardianSummary('summary')).inputNotes[0]?.swap).toBeUndefined();
  mockAttachment = [0n, 0n, 0n, 0n];
  expect((await decodeGuardianSummary('summary')).inputNotes[0]?.swap).toBeUndefined();
});

it('loads fee metadata before decoding a retained summary', async () => {
  await decodeGuardianSummary('summary');
  expect(getNativeAssetId).toHaveBeenCalled();
  expect(getVerificationBaseFee).toHaveBeenCalled();
});

it('does not decode inflated amounts when fee metadata is unavailable', async () => {
  jest.mocked(getVerificationBaseFee).mockResolvedValue(null);
  await expect(decodeGuardianSummary('summary')).rejects.toThrow('fee metadata is unavailable');
  expect(mockFree).not.toHaveBeenCalled();
});

it('separates a native-token send from its fee with an empty metadata cache', async () => {
  mockAssetId = 'fee';
  const summary = await decodeGuardianSummary('summary');
  expect(summary.outputNotes).toHaveLength(1);
  expect(summary.outputNotes[0]?.assets).toEqual([{ faucetId: 'fee', amount: '17' }]);
  expect(summary.fee).toEqual({ faucetId: 'fee', amount: '3' });
});
