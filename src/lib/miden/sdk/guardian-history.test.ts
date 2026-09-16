import { decodeGuardianSummary } from './guardian-history';

const mockAssets = () => ({ fungibleAssets: () => [{ faucetId: () => 'asset', amount: () => 17n }] });
const mockMetadata = () => ({ sender: () => 'sender', noteType: () => 1 });
let mockStorage: bigint[];
let mockRoot: string;
const mockFull = {
  id: () => ({ toString: () => 'note' }),
  assets: mockAssets,
  metadata: mockMetadata,
  recipient: () => ({
    script: () => ({ root: () => ({ toHex: () => mockRoot }) }),
    storage: () => ({ items: () => mockStorage.map(value => ({ asInt: () => value })) })
  })
};
const mockFree = jest.fn();
let mockPartial = false;
const mockSummary = {
  free: mockFree,
  accountDelta: () => ({ id: () => ({ toString: () => 'account' }) }),
  inputNotes: () => ({ notes: () => [{ note: () => mockFull }] })
};

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionSummary: { deserialize: () => mockSummary },
  AccountId: { fromPrefixSuffix: (prefix: { asInt(): bigint }, suffix: { asInt(): bigint }) => `${prefix.asInt()}-${suffix.asInt()}` },
  NoteScript: {
    p2id: () => ({ root: () => ({ toHex: () => 'p2id' }) }),
    p2ide: () => ({ root: () => ({ toHex: () => 'p2ide' }) })
  },
  NoteType: { Public: 1, Private: 0 }
}));
jest.mock('./helpers', () => ({ getBech32AddressFromAccountId: (id: string) => id }));
jest.mock('lib/shared/helpers', () => ({ b64ToU8: () => new Uint8Array() }));
jest.mock('lib/miden/activity/fee-notes', () => ({
  splitExecutedOutputNotes: () => ({
    feeNote: { assets: () => ({ fungibleAssets: () => [{ faucetId: () => 'fee', amount: () => 3n }] }) },
    userNotes: [{
      id: () => ({ toString: () => 'output' }),
      intoFull: () => mockPartial ? undefined : mockFull,
      assets: mockAssets,
      metadata: () => ({ sender: () => 'sender', noteType: () => 0 })
    }]
  })
}));

beforeEach(() => {
  mockFree.mockClear();
  mockPartial = false;
  mockRoot = 'p2id';
  mockStorage = [11n, 22n];
});

it('decodes P2ID recipients, input assets and the separate fee', () => {
  const decoded = decodeGuardianSummary('summary');
  expect(decoded.outputNotes[0]?.recipient).toBe('22-11');
  expect(decoded.inputNotes[0]?.assets).toEqual([{ faucetId: 'asset', amount: '17' }]);
  expect(decoded.inputNotes[0]?.visibility).toBe('public');
  expect(decoded.fee).toEqual({ faucetId: 'fee', amount: '3' });
  expect(mockFree).toHaveBeenCalledTimes(1);
});

it('decodes the recipient and reclaim height from the full P2IDE note', () => {
  mockRoot = 'p2ide';
  mockStorage = [99n, 88n, 11n, 22n, 500n, 0n];
  expect(decodeGuardianSummary('summary').outputNotes[0]).toMatchObject({ recipient: '22-11', reclaimHeight: 500 });
});

it('retains partial private output assets without a fabricated recipient', () => {
  mockPartial = true;
  expect(decodeGuardianSummary('summary').outputNotes[0]).toEqual({
    id: 'output', assets: [{ faucetId: 'asset', amount: '17' }], sender: 'sender', visibility: 'private'
  });
});

it('does not read a recipient from an unsupported script or storage layout', () => {
  mockRoot = 'custom';
  expect(decodeGuardianSummary('summary').outputNotes[0]?.recipient).toBeUndefined();
  mockRoot = 'p2ide';
  expect(decodeGuardianSummary('summary').outputNotes[0]?.recipient).toBeUndefined();
});

it('bounds the summary before deserialization', () => {
  expect(() => decodeGuardianSummary('x'.repeat(4_000_001))).toThrow('too large');
  expect(mockFree).not.toHaveBeenCalled();
});
