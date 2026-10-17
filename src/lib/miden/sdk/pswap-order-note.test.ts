import { readPswapOrderNote } from './pswap-order-note';

const PSWAP_ROOT = 'pswap-root';

const mockGetNotesById = jest.fn();
const mockGetNullifierCommitHeight = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteId: { fromHex: (id: string) => ({ id }) },
  NoteScript: { pswap: () => ({ root: () => ({ toHex: () => 'pswap-root' }) }) },
  RpcClient: jest.fn(() => ({
    getNotesById: mockGetNotesById,
    getNullifierCommitHeight: mockGetNullifierCommitHeight,
    free: jest.fn()
  }))
}));
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => 'https://rpc.example' }));
jest.mock('./helpers', () => ({
  walletAccountIdToSdk: (accountId: string) => ({ toString: () => `sdk-${accountId}` })
}));

interface NoteShape {
  id?: string;
  root?: string;
  sender?: string;
}

const noteBody = ({ id = 'order-note', root = PSWAP_ROOT, sender = 'sdk-creator' }: NoteShape = {}) => ({
  id: () => ({ toString: () => id }),
  script: () => ({ root: () => ({ toHex: () => root }) }),
  metadata: () => ({ sender: () => ({ toString: () => sender }) }),
  nullifier: () => ({ nullifierOf: id })
});

const fetched = (note: ReturnType<typeof noteBody> | undefined, noteId = 'order-note', blockNum = 120) => ({
  noteId: { toString: () => noteId },
  note,
  inclusionProof: { location: () => ({ blockNum: () => blockNum }) }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('readPswapOrderNote', () => {
  it('answers open with the full note when its nullifier is unspent since its inclusion block', async () => {
    const note = noteBody();
    mockGetNotesById.mockResolvedValue([fetched(note)]);
    mockGetNullifierCommitHeight.mockResolvedValue(undefined);

    const read = await readPswapOrderNote('order-note', 'creator');

    expect(read).toEqual({ kind: 'open', note });
    expect(mockGetNotesById).toHaveBeenCalledWith([{ id: 'order-note' }]);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledWith({ nullifierOf: 'order-note' }, 120);
  });

  it('answers spent once the node holds the nullifier', async () => {
    mockGetNotesById.mockResolvedValue([fetched(noteBody())]);
    mockGetNullifierCommitHeight.mockResolvedValue(131);

    await expect(readPswapOrderNote('order-note', 'creator')).resolves.toEqual({ kind: 'spent' });
  });

  it.each([
    ['the node knows no note under the id', []],
    ['the answer names only another note', [fetched(noteBody({ id: 'other-note' }), 'other-note')]],
    ['the note has no public body', [fetched(undefined)]],
    ['the body reconstructs to another id', [fetched(noteBody({ id: 'other-note' }))]],
    ['the note is not a PSWAP note', [fetched(noteBody({ root: 'p2id-root' }))]],
    ['another account created the note', [fetched(noteBody({ sender: 'sdk-someone-else' }))]]
  ])('answers absent when %s, without reading a nullifier', async (_label, answer) => {
    mockGetNotesById.mockResolvedValue(answer);

    await expect(readPswapOrderNote('order-note', 'creator')).resolves.toEqual({ kind: 'absent' });
    expect(mockGetNullifierCommitHeight).not.toHaveBeenCalled();
  });

  it('rejects a failed note read rather than answering for the node', async () => {
    mockGetNotesById.mockRejectedValue(new Error('node unreachable'));

    await expect(readPswapOrderNote('order-note', 'creator')).rejects.toThrow('node unreachable');
  });

  it('rejects a failed nullifier read rather than calling the order open', async () => {
    mockGetNotesById.mockResolvedValue([fetched(noteBody())]);
    mockGetNullifierCommitHeight.mockRejectedValue(new Error('node unreachable'));

    await expect(readPswapOrderNote('order-note', 'creator')).rejects.toThrow('node unreachable');
  });
});
