import { createRecoveryCanonicalReads, retainedNoteIdentity } from './canonical-reads';
import { retireRecoveryNotes } from './retirement';
import type { RecoveryEntry, RecoveryJournalSnapshot, RecoveryNoteEntry } from './types';

const mockFree = jest.fn();
let mockId: string | undefined = 'note';
let mockNullifier: string | undefined = 'exact';
const mockScan = jest.fn<
  Promise<{ nullifier: () => { toHex: () => string; free: () => void }; blockNum: () => number; free: () => void }[]>,
  [Uint16Array, number, number]
>();
const mockHeader = jest.fn(async () => ({
  commitment: () => ({ toHex: () => 'header', free: mockFree }),
  free: mockFree
}));
const mockRpcFree = jest.fn();

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteFile: {
    deserialize: () => ({
      noteId: () => (mockId === undefined ? undefined : { toString: () => mockId, free: mockFree }),
      nullifier: () => mockNullifier,
      inclusionProof: () => ({ location: () => ({ blockNum: () => 10, free: mockFree }), free: mockFree }),
      free: mockFree
    })
  },
  Word: { fromHex: () => ({ toU64s: () => [0n, 0n, 0n, 0x1234000000000000n], free: mockFree }) },
  RpcClient: jest.fn(() => ({ getBlockHeaderByNumber: mockHeader, syncNullifiers: mockScan, free: mockRpcFree }))
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: async () => {},
  getRpcEndpoint: () => 'configured-node'
}));

const note: RecoveryNoteEntry = {
  kind: 'note',
  id: 'note',
  provenance: 'output',
  format: 'full',
  noteFile: new Uint8Array([1])
};
const snapshot = (): RecoveryJournalSnapshot => ({
  version: 1,
  sequence: 1,
  scope: { network: 'adapter', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
  accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'state' }],
  entries: [note]
});
const update = () => ({
  nullifier: () => ({ toHex: () => 'exact', free: mockFree }),
  blockNum: () => 10,
  free: mockFree
});
beforeEach(() => {
  mockId = 'note';
  mockNullifier = 'exact';
  mockScan.mockReset().mockResolvedValue([update()]);
  mockHeader.mockClear();
  mockRpcFree.mockClear();
});

it('binds the actual retained file identity and full nullifier before scanning one prefix and one block', async () => {
  expect(retainedNoteIdentity(note)).toEqual({ nullifier: 'exact', fromBlock: 10 });
  const reads = await createRecoveryCanonicalReads();
  const retained: RecoveryEntry[][] = [];
  expect(
    await retireRecoveryNotes({
      snapshot: snapshot(),
      reads,
      deadline: Date.now() + 1000,
      assertCurrent: () => {},
      retain: async entries => {
        retained.push(entries);
      }
    })
  ).toBe(1);
  expect(mockScan).toHaveBeenCalledWith(new Uint16Array([0x1234]), 10, 10);
  expect(mockHeader).toHaveBeenNthCalledWith(1, 10, false);
  expect(mockHeader).toHaveBeenNthCalledWith(2, 10, false);
  expect(retained).toEqual([[]]);
});

it('keeps metadata-only output and mismatched retained identities regardless of the full format hint', async () => {
  for (const identity of [undefined, 'wrong', 'note']) {
    mockId = identity;
    mockNullifier = identity === 'note' ? undefined : 'exact';
    const reads = await createRecoveryCanonicalReads();
    const retain = jest.fn();
    expect(
      await retireRecoveryNotes({
        snapshot: snapshot(),
        reads,
        deadline: Date.now() + 1000,
        assertCurrent: () => {},
        retain
      })
    ).toBe(0);
    expect(retain).not.toHaveBeenCalled();
  }
  expect(mockScan).not.toHaveBeenCalled();
});

it('Task4C3G6 encodes the normalized nullifier for the exact native Word parser before RPC scanning', async () => {
  const sdk = jest.requireMock<{
    Word: { fromHex: (hex: string) => { toU64s: () => bigint[]; free: () => void } };
  }>('@miden-sdk/miden-sdk/lazy');
  const fromHex = jest.spyOn(sdk.Word, 'fromHex').mockImplementation(hex => {
    if (hex.length !== 66 || !hex.startsWith('0x')) throw new Error('InvalidLength');
    return { toU64s: () => [0n, 0n, 0n, 0x5656565656565656n], free: mockFree };
  });
  const nullifier = '56'.repeat(32);
  mockScan.mockResolvedValue([
    {
      nullifier: () => ({ toHex: () => `0x${nullifier}`, free: mockFree }),
      blockNum: () => 19,
      free: mockFree
    }
  ]);
  const reads = await createRecoveryCanonicalReads();
  try {
    const outcome = await reads.scan(nullifier, 19).then(
      updates => ({ updates, error: undefined }),
      (error: unknown) => ({ updates: undefined, error })
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.updates).toEqual([{ nullifier: `0x${nullifier}`, block: 19 }]);
    expect(fromHex).toHaveBeenCalledWith(`0x${nullifier}`);
    expect(mockScan).toHaveBeenCalledWith(new Uint16Array([0x5656]), 19, 19);
  } finally {
    reads.dispose();
    fromHex.mockRestore();
  }
});

it('holds the real outstanding RPC across a fresh reader and rejects its late continuation', async () => {
  let release = () => {};
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  mockScan.mockImplementationOnce(async () => {
    await pending;
    return [update()];
  });
  const retain = jest.fn();
  const first = retireRecoveryNotes({
    snapshot: snapshot(),
    reads: await createRecoveryCanonicalReads(),
    deadline: Date.now() + 20,
    assertCurrent: () => {},
    retain
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(await first).toBe(0);
  expect(
    await retireRecoveryNotes({
      snapshot: snapshot(),
      reads: await createRecoveryCanonicalReads(),
      deadline: Date.now() + 1000,
      assertCurrent: () => {},
      retain
    })
  ).toBe(0);
  expect(mockScan).toHaveBeenCalledTimes(1);
  expect(mockRpcFree).not.toHaveBeenCalled();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(retain).not.toHaveBeenCalled();
  expect(mockHeader).toHaveBeenCalledTimes(1);
});

it('Task4C1 disposes a timed-out RPC exactly once only after the underlying request settles', async () => {
  let release = () => {};
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  mockScan.mockImplementationOnce(async () => {
    await pending;
    return [update()];
  });
  const reads = await createRecoveryCanonicalReads();
  const retain = jest.fn();
  const result = retireRecoveryNotes({
    snapshot: snapshot(),
    reads,
    deadline: Date.now() + 20,
    assertCurrent: () => {},
    retain
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(await result).toBe(0);
  reads.dispose();
  expect(mockRpcFree).not.toHaveBeenCalled();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(mockRpcFree).toHaveBeenCalledTimes(1);
  reads.dispose();
  expect(mockRpcFree).toHaveBeenCalledTimes(1);
  await expect(reads.header(10)).rejects.toThrow('closed');
  expect(retain).not.toHaveBeenCalled();
});
