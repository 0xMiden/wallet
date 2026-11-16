/* eslint-disable import/first -- the jest.mock() factories must be registered before the module under test loads. */
const mockDeserialize = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  TransactionRequest: { deserialize: (...args: unknown[]) => mockDeserialize(...args) }
}));

const mockSdkReady = jest.fn(async () => undefined);
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: () => mockSdkReady()
}));

/** What each hold's callback settled with, so a test can see that a trap left it as itself. */
const mockCallbackOutcomes: unknown[] = [];
const mockLockFailure: { current: unknown } = { current: undefined };
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: async (operation: () => Promise<unknown>) => {
    if (mockLockFailure.current !== undefined) throw mockLockFailure.current;
    try {
      const value = await operation();
      mockCallbackOutcomes.push({ value });
      return value;
    } catch (error) {
      mockCallbackOutcomes.push({ rejected: error });
      throw error;
    }
  }
}));

import { checkPinnedReplayNotes } from './pinned-replay-check';
import { NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

const FIRST = `0x${'AA'.repeat(32)}`;
const SECOND = `0x${'BB'.repeat(32)}`;
const BYTES = new Uint8Array([1, 2, 3]);

const requestNote = (
  id: string,
  { noteType = 'Public', orderId = 42n }: { noteType?: string; orderId?: bigint } = {}
) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => noteType }),
  recipient: () => ({ serialNum: () => ({ toFelts: () => [{ asInt: () => 7n }, { asInt: () => orderId }] }) })
});
const decodesTo = (...notes: ReturnType<typeof requestNote>[]) =>
  mockDeserialize.mockImplementation(() => ({ expectedOutputOwnNotes: () => notes }));

const noteInclusions = jest.fn<Promise<ReadonlyMap<string, number> | undefined>, [readonly string[], number]>();
const createReads = jest.fn(
  async (): Promise<NodeReads> => ({
    blockCommitment: async () => undefined,
    account: async () => ({ ok: false, pruned: false, timedOut: false }),
    noteInclusions: (ids, timeoutMs) => noteInclusions(ids, timeoutMs),
    nullifierHeight: async () => undefined
  })
);

const send = { type: 'send' as const, requestBytes: BYTES };
const swap = { type: 'swap' as const, requestBytes: BYTES };

beforeEach(() => {
  jest.clearAllMocks();
  mockCallbackOutcomes.length = 0;
  mockLockFailure.current = undefined;
  mockSdkReady.mockImplementation(async () => undefined);
  decodesTo(requestNote(FIRST), requestNote(SECOND));
  noteInclusions.mockResolvedValue(new Map());
});

describe('checkPinnedReplayNotes', () => {
  it('reports the pinned note the node holds as committed', async () => {
    noteInclusions.mockResolvedValue(new Map([[SECOND.toLowerCase(), 140]]));

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({
      kind: 'committed',
      noteId: SECOND.toLowerCase(),
      noteIds: [FIRST.toLowerCase(), SECOND.toLowerCase()]
    });
    expect(mockDeserialize).toHaveBeenCalledWith(BYTES);
    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase(), SECOND.toLowerCase()], RPC_READ_TIMEOUT_MS);
  });

  it('reports absent when the node holds none of the pinned notes', async () => {
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({
      kind: 'absent',
      noteIds: [FIRST.toLowerCase(), SECOND.toLowerCase()]
    });
  });

  it('reports unknown on a failed read, and when the node cannot be reached', async () => {
    noteInclusions.mockResolvedValue(undefined);
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });

    createReads.mockRejectedValueOnce(new Error('no RpcClient'));
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
  });

  it('reports none for a request with no own note, or no request, and reads nothing from the node', async () => {
    decodesTo();
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'none' });
    await expect(checkPinnedReplayNotes({ type: 'send' }, { createReads })).resolves.toEqual({ kind: 'none' });
    await expect(
      checkPinnedReplayNotes({ type: 'send', requestBytes: new Uint8Array() }, { createReads })
    ).resolves.toEqual({ kind: 'none' });

    expect(mockDeserialize).toHaveBeenCalledTimes(1);
    expect(createReads).not.toHaveBeenCalled();
  });

  it('a trap while decoding reaches the WASM lock and reports unknown without a node read', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    mockDeserialize.mockImplementation(() => {
      throw trap;
    });

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'decode' });
    expect(mockCallbackOutcomes).toEqual([{ rejected: trap }]);
    expect(createReads).not.toHaveBeenCalled();
  });

  it('a request that does not decode reports unknown as a decode failure', async () => {
    mockDeserialize.mockImplementation(() => {
      throw new Error('could not deserialize');
    });

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'decode' });
    expect(createReads).not.toHaveBeenCalled();
  });

  it('an SDK that is not ready, or a hold the lock evicted, is a read that gave no answer', async () => {
    mockSdkReady.mockRejectedValueOnce(new Error('wasm failed to load'));
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
    expect(mockDeserialize).not.toHaveBeenCalled();

    mockLockFailure.current = new WasmClientPoisonedError('watchdog');
    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
    expect(createReads).not.toHaveBeenCalled();
  });
});

describe('the order a pinned swap opens', () => {
  it('reads the order id off the serial of a swap`s one public note', async () => {
    decodesTo(requestNote(FIRST, { orderId: 42n }));
    noteInclusions.mockResolvedValue(new Map([[FIRST.toLowerCase(), 140]]));

    await expect(checkPinnedReplayNotes(swap, { createReads })).resolves.toEqual({
      kind: 'committed',
      noteId: FIRST.toLowerCase(),
      noteIds: [FIRST.toLowerCase()],
      order: { orderId: '42', orderNoteId: FIRST }
    });
  });

  it.each<[string, ReturnType<typeof requestNote>[], typeof send | typeof swap]>([
    ['a swap with two own notes', [requestNote(FIRST), requestNote(SECOND)], swap],
    ['a swap whose note is private', [requestNote(FIRST, { noteType: 'Private' })], swap],
    ['a send', [requestNote(FIRST)], send]
  ])('reads no order for %s', async (_case, notes, row) => {
    decodesTo(...notes);
    noteInclusions.mockResolvedValue(new Map([[FIRST.toLowerCase(), 140]]));

    const check = await checkPinnedReplayNotes(row, { createReads });

    expect(check).toMatchObject({ kind: 'committed', noteId: FIRST.toLowerCase() });
    expect(check).not.toHaveProperty('order');
  });
});
