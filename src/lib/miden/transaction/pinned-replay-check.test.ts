/* eslint-disable import/first -- the jest.mock() factories must be registered before the module under test loads. */
const mockDeserialize = jest.fn();
/** The SDK's account parse for the bech32 addresses these tests name, each to its account's canonical hex id. */
const mockBech32Accounts: Record<string, string> = {
  mtst1acct: `0x${'ab'.repeat(15)}`,
  mtst1other: `0x${'cd'.repeat(15)}`
};
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('@miden-sdk/miden-sdk/lazy');
  return {
    ...actual,
    TransactionRequest: { deserialize: (...args: unknown[]) => mockDeserialize(...args) },
    Address: {
      ...actual.Address,
      fromBech32: (address: string) => {
        const hex = mockBech32Accounts[address];
        if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
        return { accountId: () => ({ toString: () => hex }) };
      }
    },
    AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) }
  };
});

const mockSdkReady = jest.fn(async () => undefined);
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/constants'),
  ensureSdkWasmReady: () => mockSdkReady()
}));

let mockRpcUrl = 'https://node-a.example';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveRpcUrl: () => mockRpcUrl
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

import { NoteScript } from '@miden-sdk/miden-sdk/lazy';

import { checkPinnedReplayNotes, orderFromSavedRequest, swapOpensOrderFromRead } from './pinned-replay-check';
import { NodeReads, RPC_READ_TIMEOUT_MS } from './reconcile-reads';
import type { IApprovedCustomEffects } from '../db/types';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

const FIRST = `0x${'AA'.repeat(32)}`;
const SECOND = `0x${'BB'.repeat(32)}`;
const BYTES = new Uint8Array([1, 2, 3]);
/** The row's account, as `ACCOUNT` parses, and another account. */
const ACCOUNT_HEX = `0x${'ab'.repeat(15)}`;
const OTHER_HEX = `0x${'cd'.repeat(15)}`;

/** A note the saved request declares, under `sender`, the account its metadata names as the note's creator. */
const requestNote = (
  id: string,
  {
    noteType = 'Public',
    orderId = 42n,
    sender = ACCOUNT_HEX
  }: { noteType?: string; orderId?: bigint; sender?: string } = {}
) => ({
  id: () => ({ toString: () => id }),
  metadata: () => ({ noteType: () => noteType, sender: () => ({ toString: () => sender }) }),
  recipient: () => ({
    script: () => ({ root: () => NoteScript.pswap().root() }),
    serialNum: () => ({ toFelts: () => [{ asInt: () => 7n }, { asInt: () => orderId }] })
  })
});
const decodesTo = (...notes: ReturnType<typeof requestNote>[]) =>
  mockDeserialize.mockImplementation(() => ({ expectedOutputOwnNotes: () => notes }));

/** The node read, called with exactly the arguments the check passed, so a sender it names is seen. */
const noteInclusions = jest.fn<
  Promise<ReadonlyMap<string, number> | undefined>,
  [readonly string[], number, string?]
>();
const createReads = jest.fn(
  async (): Promise<NodeReads> => ({
    blockCommitment: async () => undefined,
    account: async () => ({ ok: false, pruned: false, timedOut: false }),
    noteInclusions: (...args) => noteInclusions(...args),
    nullifierHeight: async () => undefined
  })
);

const ACCOUNT = 'mtst1acct';
const send = { type: 'send' as const, accountId: ACCOUNT, requestBytes: BYTES };
const swap = { type: 'swap' as const, accountId: ACCOUNT, requestBytes: BYTES };

beforeEach(() => {
  jest.clearAllMocks();
  mockCallbackOutcomes.length = 0;
  mockLockFailure.current = undefined;
  mockRpcUrl = 'https://node-a.example';
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
      noteIds: [FIRST.toLowerCase(), SECOND.toLowerCase()],
      block: 140,
      scope: 'https://node-a.example'
    });
    expect(mockDeserialize).toHaveBeenCalledWith(BYTES);
    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase(), SECOND.toLowerCase()], RPC_READ_TIMEOUT_MS);
  });

  it('names the endpoint it asked, not one the wallet moved to during the read', async () => {
    noteInclusions.mockImplementation(async () => {
      mockRpcUrl = 'https://node-b.example';
      return new Map([[FIRST.toLowerCase(), 77]]);
    });

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toMatchObject({
      kind: 'committed',
      noteId: FIRST.toLowerCase(),
      block: 77,
      scope: 'https://node-a.example'
    });
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
    await expect(checkPinnedReplayNotes({ type: 'send', accountId: ACCOUNT }, { createReads })).resolves.toEqual({
      kind: 'none'
    });
    await expect(
      checkPinnedReplayNotes({ type: 'send', accountId: ACCOUNT, requestBytes: new Uint8Array() }, { createReads })
    ).resolves.toEqual({ kind: 'none' });

    expect(mockDeserialize).toHaveBeenCalledTimes(1);
    expect(createReads).not.toHaveBeenCalled();
  });

  it('a trap while decoding reaches the WASM lock and reports a read that gave no answer, without a node read', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    mockDeserialize.mockImplementation(() => {
      throw trap;
    });

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
    expect(mockCallbackOutcomes).toEqual([{ rejected: trap }]);
    expect(createReads).not.toHaveBeenCalled();
  });

  it('a read that fails after the request decoded is a read that gave no answer, not an unreadable request', async () => {
    mockDeserialize.mockImplementation(() => ({
      expectedOutputOwnNotes: () => {
        throw new Error('recursive use of an object detected');
      }
    }));

    await expect(checkPinnedReplayNotes(send, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
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
      block: 140,
      scope: 'https://node-a.example',
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

describe('the notes an execute`s approval recorded', () => {
  const THIRD = `0x${'CC'.repeat(32)}`;
  /** An execute row whose approval recorded `approvedOutputNoteIds`, as the store holds it. */
  const execute = (approvedOutputNoteIds: unknown) => {
    const approvedEffects: IApprovedCustomEffects = {
      shape: 'summary',
      outgoing: [],
      incoming: [],
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      recipients: [],
      inputNotesConsumed: 0,
      outputNotesCreated: 1,
      storageChanged: false
    };
    // The store can hold anything here (`importDb` fills it from a user-supplied file).
    Object.assign(approvedEffects, { approvedOutputNoteIds });
    return { type: 'execute' as const, accountId: ACCOUNT, requestBytes: BYTES, approvedEffects };
  };

  it('asks the node for its own notes and the well-formed approved ones, each once', async () => {
    decodesTo(requestNote(FIRST));
    const approved = [SECOND, FIRST.toLowerCase(), 'not-a-note-id', `0x${'dd'.repeat(31)}`, 7];

    await expect(checkPinnedReplayNotes(execute(approved), { createReads })).resolves.toEqual({
      kind: 'absent',
      noteIds: [FIRST.toLowerCase(), SECOND.toLowerCase()]
    });
    expect(noteInclusions).toHaveBeenCalledWith(
      [FIRST.toLowerCase(), SECOND.toLowerCase()],
      RPC_READ_TIMEOUT_MS,
      ACCOUNT
    );
  });

  it('reports an approved note the node holds as committed when the request pins no own note', async () => {
    decodesTo();
    noteInclusions.mockResolvedValue(new Map([[THIRD.toLowerCase(), 140]]));

    await expect(checkPinnedReplayNotes(execute([THIRD]), { createReads })).resolves.toEqual({
      kind: 'committed',
      noteId: THIRD.toLowerCase(),
      noteIds: [THIRD.toLowerCase()],
      block: 140,
      scope: 'https://node-a.example'
    });
  });

  it('reports none, with no node read, when neither the request nor the approval names a well-formed note', async () => {
    decodesTo();

    await expect(checkPinnedReplayNotes(execute(['not-a-note-id']), { createReads })).resolves.toEqual({
      kind: 'none'
    });
    await expect(checkPinnedReplayNotes(execute({ noteId: THIRD }), { createReads })).resolves.toEqual({
      kind: 'none'
    });
    expect(createReads).not.toHaveBeenCalled();
  });

  it('an approved note does not stand in for a saved request that does not decode', async () => {
    mockDeserialize.mockImplementation(() => {
      throw new Error('could not deserialize');
    });

    await expect(checkPinnedReplayNotes(execute([THIRD]), { createReads })).resolves.toEqual({
      kind: 'unknown',
      cause: 'decode'
    });
    expect(createReads).not.toHaveBeenCalled();
  });

  it('a send`s check reads only the notes its request pins', async () => {
    decodesTo(requestNote(FIRST));

    await checkPinnedReplayNotes({ ...execute([THIRD]), type: 'send' }, { createReads });

    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase()], RPC_READ_TIMEOUT_MS);
  });
});

describe('the account that created a pinned note', () => {
  /**
   * The node's metadata for FIRST names another sender than the one its id commits to: a read that names this row's
   * account as the sender gets no answer.
   */
  const heldOnlyElsewhere = () =>
    noteInclusions.mockImplementation(async (_ids, _timeoutMs, sender) =>
      sender === undefined ? new Map([[FIRST.toLowerCase(), 140]]) : undefined
    );
  const execute = { type: 'execute' as const, accountId: ACCOUNT, requestBytes: BYTES };

  it('an execute`s check counts only a copy its own account created, and one under another sender is unknown', async () => {
    decodesTo(requestNote(FIRST));
    heldOnlyElsewhere();

    await expect(checkPinnedReplayNotes(execute, { createReads })).resolves.toEqual({ kind: 'unknown', cause: 'read' });
    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase()], RPC_READ_TIMEOUT_MS, ACCOUNT);
  });

  it.each<[string, typeof send | typeof swap]>([
    ['send', send],
    ['swap', swap]
  ])('a %s`s check names no sender, so the node`s copy is committed whatever sender it names', async (_type, row) => {
    decodesTo(requestNote(FIRST));
    heldOnlyElsewhere();

    await expect(checkPinnedReplayNotes(row, { createReads })).resolves.toMatchObject({
      kind: 'committed',
      noteId: FIRST.toLowerCase()
    });
    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase()], RPC_READ_TIMEOUT_MS);
  });
});

// A run as this account creates its notes in its own name, so a saved request that declares one under another
// account can never be sent from this account. The wallet queued such a request before it refused one whose
// approval dry run failed.
describe('the account an execute`s saved request names as its notes` sender', () => {
  const execute = { type: 'execute' as const, accountId: ACCOUNT, requestBytes: BYTES };

  it.each<[string, ReturnType<typeof requestNote>[]]>([
    ['its one note', [requestNote(FIRST, { sender: OTHER_HEX })]],
    ['one of its notes', [requestNote(FIRST), requestNote(SECOND, { sender: OTHER_HEX })]]
  ])(
    'a request declaring %s under another account is one no Retry can send, and asks the node nothing',
    async (_case, notes) => {
      decodesTo(...notes);

      await expect(checkPinnedReplayNotes(execute, { createReads })).resolves.toEqual({
        kind: 'unknown',
        cause: 'sender'
      });
      expect(mockCallbackOutcomes).toEqual([{ rejected: expect.any(Error) }]);
      expect(createReads).not.toHaveBeenCalled();
      expect(noteInclusions).not.toHaveBeenCalled();
    }
  );

  // The row keeps the id the dApp named, in any form the wallet parses; the note's metadata names its sender in hex.
  it.each<[string, string]>([
    ['a bech32 address', ACCOUNT],
    ['a composite public key', `${ACCOUNT}_qr7qqq9wr6w`],
    ['upper-case hex', `0X${'AB'.repeat(15)}`]
  ])('a request declaring its notes under the row`s own account, stored as %s, still asks the node', async (_f, id) => {
    decodesTo(requestNote(FIRST), requestNote(SECOND));
    noteInclusions.mockResolvedValue(new Map([[SECOND.toLowerCase(), 140]]));

    await expect(checkPinnedReplayNotes({ ...execute, accountId: id }, { createReads })).resolves.toMatchObject({
      kind: 'committed',
      noteId: SECOND.toLowerCase()
    });
    expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase(), SECOND.toLowerCase()], RPC_READ_TIMEOUT_MS, id);
  });

  // The wallet builds a send's, a swap's and a bridged send's request in the row's own name.
  it.each(['send', 'swap', 'bridged-send'] as const)(
    'a %s`s request is not checked for the sender it declares',
    async type => {
      decodesTo(requestNote(FIRST, { sender: OTHER_HEX }));
      noteInclusions.mockResolvedValue(new Map([[FIRST.toLowerCase(), 140]]));

      await expect(
        checkPinnedReplayNotes({ type, accountId: ACCOUNT, requestBytes: BYTES }, { createReads })
      ).resolves.toMatchObject({
        kind: 'committed',
        noteId: FIRST.toLowerCase()
      });
      expect(noteInclusions).toHaveBeenCalledWith([FIRST.toLowerCase()], RPC_READ_TIMEOUT_MS);
    }
  );
});

describe('orderFromSavedRequest', () => {
  it('names the order of the saved request`s one public PSWAP note', async () => {
    decodesTo(requestNote(FIRST, { orderId: 42n }));

    await expect(orderFromSavedRequest(BYTES)).resolves.toEqual({ orderId: '42', orderNoteId: FIRST });
  });

  it('loads the SDK first, and with an SDK that is not ready takes no lock and decodes nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdkReady.mockRejectedValueOnce(new Error('wasm failed to load'));
    try {
      await expect(orderFromSavedRequest(BYTES)).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    expect(mockSdkReady).toHaveBeenCalledTimes(1);
    expect(mockCallbackOutcomes).toEqual([]);
    expect(mockDeserialize).not.toHaveBeenCalled();
  });

  it('reads nothing for missing or empty bytes', async () => {
    await expect(orderFromSavedRequest(undefined)).resolves.toBeUndefined();
    await expect(orderFromSavedRequest(new Uint8Array())).resolves.toBeUndefined();

    expect(mockSdkReady).not.toHaveBeenCalled();
    expect(mockDeserialize).not.toHaveBeenCalled();
  });
});

describe('swapOpensOrderFromRead', () => {
  const swap = (extraInputs: Record<string, unknown>) => ({
    type: 'swap' as const,
    extraInputs: { requestedFaucetId: 'faucet-req', requestedAmount: 9n, ...extraInputs }
  });

  // The order is recorded beside the bytes it was read off, so no landed writer decodes them again.
  it('a swap whose saved request recorded a well-formed order needs no decode', () => {
    expect(swapOpensOrderFromRead(swap({ requestOrder: { orderId: '42', noteId: FIRST.toLowerCase() } }))).toBe(false);
  });

  it.each<[string, unknown]>([
    ['no record', undefined],
    ['a hex order id', { orderId: '0x2a', noteId: FIRST }],
    ['a note id that is not note-id shaped', { orderId: '42', noteId: 'order-note' }],
    ['no note id', { orderId: '42' }]
  ])('a swap with %s still needs one', (_label, requestOrder) => {
    expect(swapOpensOrderFromRead(swap(requestOrder === undefined ? {} : { requestOrder }))).toBe(true);
  });
});
