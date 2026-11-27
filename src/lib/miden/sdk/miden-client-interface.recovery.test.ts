/**
 * The Guardian pending-note recovery SDK surface that runs on the client: the
 * imports, under the client lock. Their failure accounting decides whether the
 * ONE-SHOT `guardianNoteRecoveryPending` flag clears — an undercount clears it
 * over notes that were never imported, losing them permanently. The public
 * backfill's node reads run without the lock and are tested in
 * `recovery-public-notes.test.ts`.
 */

import type { WasmLockHold } from './miden-client';

type RecoveryClientInterface = import('./miden-client-interface').MidenClientInterface;

/** Never the mutex owner, so a catch handed it can never retire anything. */
const NO_HOLD = {} as unknown as WasmLockHold;

const NOTE_TAG = { tag: 'note-tag' };

interface FakeRpc {
  syncNotes: jest.Mock;
  getNotesById: jest.Mock;
  getBlockHeaderByNumber: jest.Mock;
}

let fakeRpc: FakeRpc;
let noteImport: jest.Mock;
let historyOutputs: ReturnType<typeof historyOutput>[];
let historyOwner: string;
const historyFree = jest.fn();

function historyNote(id = 'sent', script = 'p2ide', sender = 'acct') {
  return {
    id: () => noteIdHandle(id),
    serialize: () => new Uint8Array([7]),
    metadata: () => ({ sender: () => sender }),
    recipient: () => ({ script: () => ({ root: () => ({ toHex: () => script }) }) })
  };
}

function historyOutput(note = historyNote(), full = true, noteType = NOTE_TYPE_PUBLIC) {
  return {
    id: () => note.id(),
    intoFull: () => (full ? note : undefined),
    metadata: () => ({ noteType: () => noteType })
  };
}
/** Ids each `getNotesById` call asked for, as strings read before the call moved them. */
let requestedIdBatches: string[][];

const NOTE_TYPE_PRIVATE = 0;
const NOTE_TYPE_PUBLIC = 1;

/**
 * A `FetchedNote`-shaped entry: `noteId`/`noteType`/`inclusionProof` are
 * properties, `asInputNote()` a method. A body-less note defaults to PRIVATE,
 * which is what the SDK documents a missing body to mean.
 */
function fetchedNote(
  id: string,
  { withBody = true, proof = true, noteType }: { withBody?: boolean; proof?: boolean; noteType?: number } = {}
) {
  return {
    noteId: id,
    noteType: noteType ?? (withBody ? NOTE_TYPE_PUBLIC : NOTE_TYPE_PRIVATE),
    inclusionProof: proof ? { proofFor: id } : undefined,
    asInputNote: () => (withBody ? { note: id } : undefined)
  };
}

/**
 * A `NoteId` handle with the SDK's ownership semantics. Passing one into an RPC
 * call MOVES it: wasm-bindgen unwraps every element of the array and zeroes the
 * JS wrapper's pointer, so reading the handle afterwards traps. Modelling that
 * here is what makes this suite able to see it — against plain strings, code
 * that reads a requested id after the call passes the test and traps against
 * the real SDK.
 */
function noteIdHandle(id: string) {
  let moved = false;
  return {
    move: () => {
      moved = true;
    },
    toString: () => {
      if (moved) throw new Error('null pointer passed to rust');
      return id;
    }
  };
}

function blockHeader(blockNum: number, timestamp: number) {
  return { blockNum: () => blockNum, timestamp: () => timestamp };
}

async function loadClient(): Promise<RecoveryClientInterface> {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
    RpcClient: jest.fn(() => ({
      ...fakeRpc,
      // Delegates to the mock (so call assertions still work), then consumes
      // the ids exactly as the real call does.
      getNotesById: async (ids: Array<{ move?: () => void }>) => {
        requestedIdBatches.push(ids.map(String));
        try {
          return await fakeRpc.getNotesById(ids);
        } finally {
          for (const id of ids) id.move?.();
        }
      }
    })),
    Endpoint: jest.fn(url => ({ url })),
    TransactionSummary: {
      deserialize: () => ({
        accountDelta: () => ({ id: () => historyOwner }),
        outputNotes: () => ({ notes: () => historyOutputs }),
        free: historyFree
      })
    },
    NoteScript: { p2ide: () => ({ root: () => ({ toHex: () => 'p2ide' }) }) },
    // The shared wasm mock stands NoteType up as strings; the real enum is
    // numeric and the accounting compares against it.
    NoteType: { Private: NOTE_TYPE_PRIVATE, Public: NOTE_TYPE_PUBLIC },
    Address: { fromAccountId: jest.fn(() => ({ toNoteTag: () => NOTE_TAG })) },
    Note: { deserialize: jest.fn((bytes: Uint8Array) => ({ id: () => noteIdHandle(`note-${bytes[0]}`) })) },
    InputNote: {
      // Consumes the proof, as the real one does.
      authenticated: jest.fn((note, proof: { moved?: boolean }) => {
        if (proof.moved) throw new Error('null pointer passed to rust');
        proof.moved = true;
        return { note, proof, authenticated: true };
      }),
      unauthenticated: jest.fn(note => ({ note, authenticated: false }))
    },
    NoteFile: {
      fromInputNote: jest.fn(inputNote => ({ file: inputNote })),
      deserialize: jest.fn(() => ({ kind: 'notefile' })),
      fromExpectedNote: jest.fn()
    },
    NoteDetails: jest.fn()
  }));
  jest.doMock('lib/miden-chain/effective-endpoints', () => ({
    getEffectiveNetworkName: () => 'testnet',
    getEffectiveRpcUrl: () => 'https://rpc.example',
    getEffectiveProverUrl: () => undefined,
    getEffectiveNoteTransportUrl: () => undefined,
    getEffectiveFeeFaucetId: () => '0xfee'
  }));
  jest.doMock('lib/miden/activity/fee-notes', () => ({
    splitExecutedOutputNotes: () => ({ userNotes: historyOutputs })
  }));
  jest.doMock('./helpers', () => ({
    ...jest.requireActual('./helpers'),
    walletAccountIdToSdk: (id: string) => id
  }));
  jest.doMock('lib/miden/activity/connectivity-state', () => ({
    markConnectivityIssue: jest.fn(),
    clearConnectivityIssue: jest.fn()
  }));

  const { MidenClientInterface } = await import('./miden-client-interface');
  return Reflect.apply(MidenClientInterface.fromClient, MidenClientInterface, [
    { notes: { import: noteImport, fetchPrivate: jest.fn(async () => undefined) } },
    'testnet'
  ]);
}

/**
 * The client under test beside the real lock from the same registry. The lock's own singleton is a fake whose marking
 * and free are recorded, so a retire through a hold of that lock is observable.
 */
async function lockedClient() {
  const client = await loadClient();
  const lock = await import('./miden-client');
  const { MidenClientInterface } = await import('./miden-client-interface');
  const singletonFree = jest.fn();
  const singletonMarkPoisoned = jest.fn();
  jest
    .spyOn(MidenClientInterface, 'create')
    .mockImplementation(
      async () => ({ free: singletonFree, markPoisoned: singletonMarkPoisoned }) as unknown as RecoveryClientInterface
    );
  return { client, lock, wasm: jest.requireMock('@miden-sdk/miden-sdk/lazy'), singletonFree, singletonMarkPoisoned };
}

describe('Guardian pending-note recovery (SDK surface)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    noteImport = jest.fn(async () => 'imported');
    requestedIdBatches = [];
    historyOutputs = [];
    historyOwner = 'acct';
    historyFree.mockClear();
    fakeRpc = {
      syncNotes: jest.fn(async () => ({ notes: () => [] })),
      getNotesById: jest.fn(async () => []),
      getBlockHeaderByNumber: jest.fn(async () => blockHeader(0, 0))
    };
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  describe('importGuardianHistoryP2ideNotes', () => {
    it('imports full public and private P2IDE notes and skips other scripts and senders', async () => {
      historyOutputs = [
        historyOutput(),
        historyOutput(historyNote('private'), true, NOTE_TYPE_PRIVATE),
        historyOutput(historyNote('ordinary', 'p2id')),
        historyOutput(historyNote('foreign', 'p2ide', 'other')),
        historyOutput(historyNote('partial-private'), false, NOTE_TYPE_PRIVATE)
      ];
      const client = await loadClient();
      for (const output of historyOutputs) {
        await client.importGuardianHistoryP2ideNotes('summary', 'acct', output.id().toString(), NO_HOLD);
      }
      expect(noteImport).toHaveBeenCalledTimes(2);
      expect(historyFree).toHaveBeenCalledTimes(historyOutputs.length);
    });

    it('fetches a partial public output by id and imports it only when it is P2IDE', async () => {
      historyOutputs = [historyOutput(historyNote('sent'), false)];
      fakeRpc.getNotesById.mockResolvedValue([{ noteId: 'sent', asInputNote: () => ({ note: () => historyNote() }) }]);
      const client = await loadClient();
      await client.importGuardianHistoryP2ideNotes('summary', 'acct', 'sent', NO_HOLD);
      expect(noteImport).toHaveBeenCalledTimes(1);
      expect(requestedIdBatches[0]).toEqual(['sent']);
    });

    it('skips a public output whose body has another script', async () => {
      historyOutputs = [historyOutput(historyNote('sent'), false)];
      fakeRpc.getNotesById.mockResolvedValue([
        { noteId: 'sent', asInputNote: () => ({ note: () => historyNote('sent', 'p2id') }) }
      ]);
      const client = await loadClient();
      await client.importGuardianHistoryP2ideNotes('summary', 'acct', 'sent', NO_HOLD);
      expect(noteImport).not.toHaveBeenCalled();
    });

    it('fails when the public body is missing so recovery can retry', async () => {
      historyOutputs = [historyOutput(historyNote(), false)];
      const client = await loadClient();
      await expect(client.importGuardianHistoryP2ideNotes('summary', 'acct', 'sent', NO_HOLD)).rejects.toThrow(
        'missing'
      );
      expect(noteImport).not.toHaveBeenCalled();
    });

    it('rejects a summary from another account before importing notes', async () => {
      historyOwner = 'other';
      historyOutputs = [historyOutput()];
      const client = await loadClient();
      await expect(client.importGuardianHistoryP2ideNotes('summary', 'acct', 'sent', NO_HOLD)).rejects.toThrow(
        'account'
      );
      expect(noteImport).not.toHaveBeenCalled();
    });

    it('reports an import failure so the history page is not checkpointed', async () => {
      historyOutputs = [historyOutput()];
      noteImport.mockRejectedValue(new Error('storage failure'));
      const client = await loadClient();
      await expect(client.importGuardianHistoryP2ideNotes('summary', 'acct', 'sent', NO_HOLD)).rejects.toThrow(
        'Could not import'
      );
    });
  });

  describe('importRecoveryNoteBytes', () => {
    it('fetches proofs for the whole batch in ONE call and matches them by note id', async () => {
      // Per-note lookups cost up to 30s each inside one mutex hold; and the
      // response may come back reordered, so position cannot be trusted.
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('note-2'), fetchedNote('note-1')]);
      const client = await loadClient();

      await expect(
        client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])], NO_HOLD)
      ).resolves.toEqual({
        imported: 2,
        failures: 0
      });
      expect(fakeRpc.getNotesById).toHaveBeenCalledTimes(1);
      expect(requestedIdBatches).toEqual([['note-1', 'note-2']]);
      // Both got their own proof, so both import authenticated.
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      expect(wasm.InputNote.authenticated).toHaveBeenCalledTimes(2);
      expect(wasm.InputNote.unauthenticated).not.toHaveBeenCalled();
    });

    it('imports a repeated note once instead of reusing its already-moved proof', async () => {
      // The Guardian chooses what is in the batch. Handing the same proof to
      // `authenticated` twice fails the second import, which keeps the one-shot
      // pending flag set and makes every later pass fail the same way.
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('note-1')]);
      const client = await loadClient();

      await expect(
        client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([1])], NO_HOLD)
      ).resolves.toEqual({
        imported: 1,
        failures: 0
      });
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      expect(wasm.InputNote.authenticated).toHaveBeenCalledTimes(1);
    });

    it('imports a note with no proof as unauthenticated rather than dropping it', async () => {
      fakeRpc.getNotesById.mockResolvedValue([]);
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1])], NO_HOLD)).resolves.toEqual({
        imported: 1,
        failures: 0
      });
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      expect(wasm.InputNote.unauthenticated).toHaveBeenCalledTimes(1);
    });

    it('still imports the batch when the proof lookup fails outright', async () => {
      fakeRpc.getNotesById.mockRejectedValue(new Error('node unreachable'));
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1])], NO_HOLD)).resolves.toEqual({
        imported: 1,
        failures: 0
      });
    });

    it('counts an undeserializable note without losing the rest of the batch', async () => {
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      const client = await loadClient();
      jest.requireMock('@miden-sdk/miden-sdk/lazy').Note.deserialize.mockImplementationOnce(() => {
        throw new Error('corrupt note bytes');
      });

      await expect(
        client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])], NO_HOLD)
      ).resolves.toEqual({
        imported: 1,
        failures: 1
      });
      expect(wasm.Note.deserialize).toHaveBeenCalledTimes(2);
    });

    it('stops the batch at a terminated client, rethrowing its refusal', async () => {
      const terminated = new Error('WebClient terminated');
      noteImport.mockRejectedValueOnce(terminated);
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])], NO_HOLD)).rejects.toBe(
        terminated
      );
      expect(noteImport).toHaveBeenCalledTimes(1);
    });

    it('makes no proof call at all for an empty batch', async () => {
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([], NO_HOLD)).resolves.toEqual({ imported: 0, failures: 0 });
      expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
    });
  });

  describe('a trap caught under the lock', () => {
    type Locked = Awaited<ReturnType<typeof lockedClient>>;
    type Arrange = (error: unknown, wasm: Locked['wasm']) => void;

    /** Runs `call` under the real lock, its rejection turned into its outcome so only a catch's own retire marks. */
    async function underLock(call: (locked: Locked, hold: WasmLockHold) => Promise<unknown>, arrange: Arrange) {
      const locked = await lockedClient();
      const { WasmClientPoisonedError } = await import('./wasm-client-poison');
      const listener = jest.fn();
      locked.lock.onWasmClientPoisoned(listener);
      const before = await locked.lock.getMidenClient();
      return {
        ...locked,
        WasmClientPoisonedError,
        listener,
        before,
        run: async (error: unknown, catchInside = true) => {
          arrange(error, locked.wasm);
          return locked.lock.withWasmClientLock(async hold => {
            await locked.lock.getMidenClient();
            const outcome = call(locked, hold);
            return catchInside ? outcome.catch((reason: unknown) => reason) : outcome;
          });
        }
      };
    }

    async function expectRetiredOnce(state: Awaited<ReturnType<typeof underLock>>) {
      expect(state.singletonMarkPoisoned).toHaveBeenCalledTimes(1);
      expect(state.listener).toHaveBeenCalledTimes(1);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(state.singletonFree).toHaveBeenCalledTimes(1);
      expect(await state.lock.getMidenClient()).not.toBe(state.before);
    }

    async function expectNothingMarked(state: Awaited<ReturnType<typeof underLock>>) {
      expect(state.singletonMarkPoisoned).not.toHaveBeenCalled();
      expect(state.listener).not.toHaveBeenCalled();
      expect(await state.lock.getMidenClient()).toBe(state.before);
    }

    const importBatch = ({ client }: Locked, hold: WasmLockHold) =>
      client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])], hold);

    const recoverySites: Array<[string, Arrange, () => void]> = [
      [
        'a note deserialize',
        (error, wasm) => {
          wasm.Note.deserialize.mockImplementation((bytes: Uint8Array) => {
            if (bytes[0] === 2) throw error;
            return { id: () => noteIdHandle(`note-${bytes[0]}`) };
          });
        },
        () => {
          expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
          expect(noteImport).not.toHaveBeenCalled();
        }
      ],
      [
        'the proof lookup',
        error => {
          fakeRpc.getNotesById.mockRejectedValue(error);
        },
        () => expect(noteImport).not.toHaveBeenCalled()
      ],
      [
        'a note import',
        error => {
          noteImport.mockRejectedValueOnce(error);
        },
        () => expect(noteImport).toHaveBeenCalledTimes(1)
      ]
    ];

    it.each(recoverySites)(
      'importRecoveryNoteBytes retires a trap from %s through its hold and stops',
      async (_site, arrange, nothingAfter) => {
        const trap = new WebAssembly.RuntimeError('unreachable');
        const state = await underLock(importBatch, arrange);
        expect(await state.run(trap)).toBe(trap);
        nothingAfter();
        await expectRetiredOnce(state);
      }
    );

    it.each(recoverySites)(
      'importRecoveryNoteBytes passes an eviction from %s through without a retire and stops',
      async (_site, arrange, nothingAfter) => {
        const state = await underLock(importBatch, arrange);
        const evicted = new state.WasmClientPoisonedError('realm-error');
        expect(await state.run(evicted)).toBe(evicted);
        nothingAfter();
        await expectNothingMarked(state);
      }
    );

    it.each(recoverySites)(
      'importRecoveryNoteBytes passes a terminated client from %s through without a retire and stops',
      async (_site, arrange, nothingAfter) => {
        const state = await underLock(importBatch, arrange);
        const terminated = new Error('WebClient terminated');
        expect(await state.run(terminated)).toBe(terminated);
        nothingAfter();
        await expectNothingMarked(state);
      }
    );

    it('a trap importRecoveryNoteBytes retired and rethrew is not retired again by its lock', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      const state = await underLock(importBatch, recoverySites[0]![1]);
      await expect(state.run(trap, false)).rejects.toBe(trap);
      expect(state.singletonMarkPoisoned).toHaveBeenCalledTimes(1);
      expect(state.listener).toHaveBeenCalledTimes(1);
    });

    const importOne = ({ client }: Locked, hold: WasmLockHold) => client.importNoteBytes(new Uint8Array([1]), hold);
    const notANoteFile = (wasm: Locked['wasm']) =>
      wasm.NoteFile.deserialize.mockImplementation(() => {
        throw new Error('not a NoteFile');
      });

    it.each<[string, Arrange, number, number]>([
      [
        'the NoteFile deserialize',
        (error, wasm) => {
          wasm.NoteFile.deserialize.mockImplementation(() => {
            throw error;
          });
        },
        0,
        0
      ],
      [
        'the Note deserialize fallback',
        (error, wasm) => {
          notANoteFile(wasm);
          wasm.Note.deserialize.mockImplementation(() => {
            throw error;
          });
        },
        1,
        0
      ],
      [
        "the fallback's conversion",
        (error, wasm) => {
          notANoteFile(wasm);
          wasm.Note.deserialize.mockImplementation(() => ({
            assets: () => 'assets',
            recipient: () => 'recipient',
            metadata: () => ({ tag: () => 'tag' })
          }));
          wasm.NoteFile.fromExpectedNote.mockImplementation(() => {
            throw error;
          });
        },
        1,
        0
      ],
      [
        'the notes import',
        error => {
          noteImport.mockRejectedValueOnce(error);
        },
        0,
        1
      ]
    ])(
      'importNoteBytes retires a trap from %s through its hold and rethrows it',
      async (_site, arrange, noteDeserializes, imports) => {
        const trap = new WebAssembly.RuntimeError('unreachable');
        const state = await underLock(importOne, arrange);
        expect(await state.run(trap)).toBe(trap);
        expect(state.wasm.Note.deserialize).toHaveBeenCalledTimes(noteDeserializes);
        expect(noteImport).toHaveBeenCalledTimes(imports);
        await expectRetiredOnce(state);
      }
    );

    it('importNoteBytes passes an eviction from the NoteFile deserialize through with no fallback', async () => {
      const state = await underLock(importOne, (error, wasm) => {
        wasm.NoteFile.deserialize.mockImplementation(() => {
          throw error;
        });
      });
      const evicted = new state.WasmClientPoisonedError('realm-error');
      expect(await state.run(evicted)).toBe(evicted);
      expect(state.wasm.Note.deserialize).not.toHaveBeenCalled();
      await expectNothingMarked(state);
    });

    it('importNoteBytes passes a terminated client from the NoteFile deserialize through with no fallback', async () => {
      const state = await underLock(importOne, (error, wasm) => {
        wasm.NoteFile.deserialize.mockImplementation(() => {
          throw error;
        });
      });
      const terminated = new Error('Client terminated');
      expect(await state.run(terminated)).toBe(terminated);
      expect(state.wasm.Note.deserialize).not.toHaveBeenCalled();
      await expectNothingMarked(state);
    });

    const importFiles = ({ client }: Locked, hold: WasmLockHold) =>
      client.importRecoveryNoteFiles([new Uint8Array([1]), new Uint8Array([2])], hold);

    it('importRecoveryNoteFiles imports every note file and makes no node request', async () => {
      const state = await underLock(importFiles, () => {});
      expect(await state.run(undefined)).toEqual({ imported: 2, failures: 0 });
      expect(state.wasm.NoteFile.deserialize.mock.calls).toEqual([[new Uint8Array([1])], [new Uint8Array([2])]]);
      expect(noteImport).toHaveBeenCalledTimes(2);
      expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
    });

    it('importRecoveryNoteFiles counts a note whose import fails and goes on', async () => {
      const state = await underLock(importFiles, () => {
        noteImport.mockRejectedValueOnce(new Error('store write failed'));
      });
      expect(await state.run(undefined)).toEqual({ imported: 1, failures: 1 });
      await expectNothingMarked(state);
    });

    it('importRecoveryNoteFiles retires a trap from a note import through its hold and stops', async () => {
      const trap = new WebAssembly.RuntimeError('unreachable');
      const state = await underLock(importFiles, error => {
        noteImport.mockRejectedValueOnce(error);
      });
      expect(await state.run(trap)).toBe(trap);
      expect(noteImport).toHaveBeenCalledTimes(1);
      await expectRetiredOnce(state);
    });

    it('importRecoveryNoteFiles passes a terminated client through without a retire and stops', async () => {
      const terminated = new Error('WebClient terminated');
      const state = await underLock(importFiles, error => {
        noteImport.mockRejectedValueOnce(error);
      });
      expect(await state.run(terminated)).toBe(terminated);
      expect(noteImport).toHaveBeenCalledTimes(1);
      await expectNothingMarked(state);
    });

    it('importRecoveryNoteFiles imports nothing for a hold that no longer owns the lock', async () => {
      const state = await underLock(
        ({ client }) => client.importRecoveryNoteFiles([new Uint8Array([1])], NO_HOLD),
        () => {}
      );
      expect(await state.run(undefined)).toBeInstanceOf(state.WasmClientPoisonedError);
      expect(noteImport).not.toHaveBeenCalled();
    });
  });
});
