import { readEpochNoteState } from './return-state';

const mockNotes = jest.fn();
const mockSpent = jest.fn();
const mockHead = jest.fn();
const mockFree = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteId: { fromHex: (id: string) => id },
  RpcClient: jest.fn(() => ({
    getNotesById: mockNotes,
    getNullifierCommitHeight: mockSpent,
    getBlockHeaderByNumber: mockHead,
    free: mockFree
  }))
}));
jest.mock('lib/miden-chain/constants', () => ({
  ensureSdkWasmReady: async () => {},
  getRpcEndpoint: () => 'node'
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => 'node' }));

beforeEach(() => {
  jest.clearAllMocks();
  mockNotes.mockResolvedValue([
    {
      noteId: { toString: () => 'note' },
      note: { nullifier: () => 'nullifier' },
      inclusionProof: { location: () => ({ blockNum: () => 100 }) }
    }
  ]);
  mockSpent.mockResolvedValue(undefined);
  mockHead.mockResolvedValue({ blockNum: () => 200 });
});

it('checks the nullifier from the inclusion block before offering a return', async () => {
  await expect(readEpochNoteState('note', 201)).resolves.toBe('waiting');
  expect(mockSpent).toHaveBeenCalledWith('nullifier', 100);
  expect(mockFree).toHaveBeenCalledTimes(1);
});
it('offers a claim at the recall height', async () => {
  await expect(readEpochNoteState('note', 200)).resolves.toBe('ready');
});
it('reports a consumed note without offering a claim', async () => {
  mockSpent.mockResolvedValue(150);
  await expect(readEpochNoteState('note', 200)).resolves.toBe('spent');
  expect(mockHead).not.toHaveBeenCalled();
});
it('does not treat a missing note as unspent', async () => {
  mockNotes.mockResolvedValue([]);
  await expect(readEpochNoteState('note', 200)).resolves.toBe('absent');
  expect(mockSpent).not.toHaveBeenCalled();
});
it('propagates a failed nullifier read and frees the client', async () => {
  mockSpent.mockRejectedValue(new Error('offline'));
  await expect(readEpochNoteState('note', 200)).rejects.toThrow('offline');
  expect(mockFree).toHaveBeenCalledTimes(1);
});
it('shares concurrent reads of the same note', async () => {
  await Promise.all([readEpochNoteState('note', 200), readEpochNoteState('note', 200)]);
  expect(mockNotes).toHaveBeenCalledTimes(1);
});
