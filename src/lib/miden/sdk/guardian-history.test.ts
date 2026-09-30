import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { decodeGuardianSummary } from './guardian-history';
import { WasmClientPoisonedError } from './wasm-client-poison';
import { GuardianHistoryDataError, GuardianHistoryFeeUnavailableError } from '../guardian/history-errors';

let mockAssetId = 'asset';
let mockNativeLoaded = false;
let mockFeeLoaded = false;
let mockFeeKnownAbsent = false;
let mockB64Error: unknown;
let mockDeserializeError: unknown;
let mockInputNotesError: unknown;
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
  inputNotes: () => {
    if (mockInputNotesError) throw mockInputNotesError;
    return { notes: () => [{ note: () => mockFull }] };
  },
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
  TransactionSummary: {
    deserialize: () => {
      if (mockDeserializeError) throw mockDeserializeError;
      return mockSummary;
    }
  },
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
  getVerificationBaseFeeSync: () => (mockFeeLoaded ? 3 : null),
  isVerificationBaseFeeKnownAbsent: () => mockFeeKnownAbsent
}));
jest.mock('./helpers', () => ({ getBech32AddressFromAccountId: (id: string) => id }));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: () => {
    if (mockB64Error) throw mockB64Error;
    return new Uint8Array();
  }
}));

beforeEach(() => {
  mockFree.mockClear();
  jest.mocked(getVerificationBaseFee).mockClear();
  jest.mocked(getNativeAssetId).mockClear();
  mockB64Error = undefined;
  mockDeserializeError = undefined;
  mockInputNotesError = undefined;
  mockAssetId = 'asset';
  mockNativeLoaded = false;
  mockFeeLoaded = false;
  mockFeeKnownAbsent = false;
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
  const error = await decodeGuardianSummary('x'.repeat(4_000_001)).catch((reason: unknown) => reason);
  expect((error as Error).name).toBe('GuardianHistoryDataError');
  expect(error).toBeInstanceOf(GuardianHistoryDataError);
  expect((error as Error).message).toBe('Guardian summary is too large');
  expect(mockFree).not.toHaveBeenCalled();
  expect(getVerificationBaseFee).not.toHaveBeenCalled();
});

it.each([null, undefined, 42, ''])(
  'reports a missing summary (%p) as invalid data before the fee lookup',
  async value => {
    const error = await decodeGuardianSummary(value as unknown as string).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(GuardianHistoryDataError);
    expect((error as Error).name).toBe('GuardianHistoryDataError');
    expect((error as Error).message).toBe('Guardian summary is missing');
    expect(getNativeAssetId).not.toHaveBeenCalled();
    expect(getVerificationBaseFee).not.toHaveBeenCalled();
    expect(mockFree).not.toHaveBeenCalled();
  }
);

it.each<[string, (failure: Error) => void]>([
  [
    'b64ToU8',
    failure => {
      mockB64Error = failure;
    }
  ],
  [
    'TransactionSummary.deserialize',
    failure => {
      mockDeserializeError = failure;
    }
  ]
])('reports a summary %s rejects as invalid data', async (_step, fail) => {
  const failure = new Error('malformed summary');
  fail(failure);
  const error = await decodeGuardianSummary('summary').catch((reason: unknown) => reason);
  expect((error as Error).name).toBe('GuardianHistoryDataError');
  expect(error).toBeInstanceOf(GuardianHistoryDataError);
  expect((error as Error).cause).toBe(failure);
  expect(mockFree).not.toHaveBeenCalled();
});

it('reports a summary whose notes do not decode as invalid data and still frees it', async () => {
  const failure = new Error('bad note');
  mockInputNotesError = failure;
  const error = await decodeGuardianSummary('summary').catch((reason: unknown) => reason);
  expect((error as Error).name).toBe('GuardianHistoryDataError');
  expect(error).toBeInstanceOf(GuardianHistoryDataError);
  expect((error as Error).cause).toBe(failure);
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it.each<[string, Error]>([
  ['a client eviction', new WasmClientPoisonedError('realm-error')],
  ['a WebAssembly trap', new WebAssembly.RuntimeError('unreachable')]
])('passes %s in the note walk through unchanged and still frees the summary', async (_kind, failure) => {
  mockInputNotesError = failure;
  await expect(decodeGuardianSummary('summary')).rejects.toBe(failure);
  expect(mockFree).toHaveBeenCalledTimes(1);
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
  mockFeeKnownAbsent = true;
  await expect(decodeGuardianSummary('summary')).rejects.toBeInstanceOf(GuardianHistoryFeeUnavailableError);
  expect(mockFree).not.toHaveBeenCalled();
});

it('passes a failed native asset lookup through unchanged', async () => {
  const failure = new Error('rpc down');
  jest.mocked(getNativeAssetId).mockRejectedValue(failure);
  await expect(decodeGuardianSummary('summary')).rejects.toBe(failure);
  expect(mockFree).not.toHaveBeenCalled();
});

it('reports a fee the chain has not answered for as a retryable failure', async () => {
  jest.mocked(getVerificationBaseFee).mockResolvedValue(null);
  const error = await decodeGuardianSummary('summary').catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(GuardianHistoryFeeUnavailableError);
  expect((error as Error).name).not.toBe('GuardianHistoryDataError');
  expect(mockFree).not.toHaveBeenCalled();
});

it('separates a native-token send from its fee with an empty metadata cache', async () => {
  mockAssetId = 'fee';
  const summary = await decodeGuardianSummary('summary');
  expect(summary.outputNotes).toHaveLength(1);
  expect(summary.outputNotes[0]?.assets).toEqual([{ faucetId: 'fee', amount: '17' }]);
  expect(summary.fee).toEqual({ faucetId: 'fee', amount: '3' });
});
