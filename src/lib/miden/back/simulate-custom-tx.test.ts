import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds } from 'lib/miden/note-quarantine';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';

import { simulateCustomTransaction } from './simulate-custom-tx';

const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
// Provenance lookup: `null` = the wallet does NOT already hold this note, so the
// dry run is the thing introducing it. Defaults to "not held" for every id.
const getInputNote = jest.fn(async (_id: string): Promise<unknown> => null);
const executeRequest = jest.fn(async () => ({ result: { serialize: () => new Uint8Array([9, 9]) } }));
const fakeClient = { transactions: { executeRequest } };
const getMidenClient = jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState, getInputNote }));

// The lock hands its callback a HOLD, and the dry run re-checks ownership at every
// transition (#788 follow-up). Model both here: a hold-less pass-through would make
// `assertWasmHoldCurrent` throw on the happy path, and a mock with no way to revoke
// ownership could not exercise the eviction guards at all.
let currentWasmHold: object | null = null;
const revokeWasmHold = () => {
  currentWasmHold = null;
};

jest.mock('lib/miden/sdk/miden-client', () => ({
  // Lazy closure, not shorthand: the hoisted require of the module under test
  // runs this factory before the consts above are initialized.
  getMidenClient: () => getMidenClient(),
  getCurrentWasmLockHold: () => currentWasmHold,
  // Re-implements the real comparison against the mock's current hold — a no-op
  // here would make every eviction test below vacuously green.
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new Error(`operation abandoned ${where}`);
  },
  withWasmClientLock: jest.fn(async (fn: (hold: object) => Promise<unknown>) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  })
}));
jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: jest.fn((s: string) => ({ toString: () => `hex:${s}` }))
}));
jest.mock('lib/miden/note-quarantine', () => ({
  importedNoteIds: jest.fn((notes: string[] | undefined) => (notes ?? []).map(n => `id:${n}`)),
  quarantineNoteIds: jest.fn(async () => undefined)
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ __req: bytes })) }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  // `free` on the default anchor so the ordinary cases exercise a successful
  // release rather than `freeChainAnchor`'s swallow-and-warn branch.
  executeForSummary: jest.fn(async () => ({
    summary: { serialize: () => new Uint8Array([1, 2, 3]) },
    anchor: { __anchor: true, free: jest.fn() }
  }))
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length])),
  u8ToB64: jest.fn((u: Uint8Array) => `b64:${Array.from(u).join('-')}`)
}));

describe('simulateCustomTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getInputNote.mockImplementation(async () => null);
  });

  it('imports notes, syncs, executes for summary and returns serialized summary', async () => {
    const res = await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importNoteBytes).toHaveBeenCalledTimes(2);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(executeForSummary).toHaveBeenCalledWith(
      fakeClient,
      'hex:mtst1abc',
      { __req: expect.any(Uint8Array) },
      expect.any(String)
    );
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  // #784: the dry run has no use for the anchor, but "no use for it" is not the
  // same as "may drop it" — it is a WASM handle over a partial blockchain, and
  // the summary branch is the guardian one, so a multisig account would strand
  // one per confirm dialog.
  it('releases the anchor it never uses, on success and on a serialize failure', async () => {
    const free = jest.fn();
    (executeForSummary as jest.Mock).mockResolvedValueOnce({
      summary: { serialize: () => new Uint8Array([1, 2, 3]) },
      anchor: { __anchor: true, free }
    });

    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(free).toHaveBeenCalledTimes(1);

    // The `finally` half: a summary that cannot serialize must not also leak.
    // The free throws too, so the result assertion is load-bearing for the
    // swallow — a raw `anchor.free()` would report the null pointer instead of
    // the real failure.
    const freeOnThrow = jest.fn(() => {
      throw new Error('null pointer passed to rust');
    });
    (executeForSummary as jest.Mock).mockResolvedValueOnce({
      summary: {
        serialize: () => {
          throw new Error('summary serialize failed');
        }
      },
      anchor: { __anchor: true, free: freeOnThrow }
    });

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(freeOnThrow).toHaveBeenCalledTimes(1);
    // Releasing the anchor must not swallow or replace the real failure.
    expect(res).toEqual({ error: 'summary serialize failed' });
  });

  // The success direction: there is no in-flight error here, so an unswallowed
  // free would INVENT one and hand the dApp `{ error }` for a dry run that
  // actually succeeded — turning a cleanup failure into a failed confirm.
  it('still returns the summary when releasing the anchor fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (executeForSummary as jest.Mock).mockResolvedValueOnce({
      summary: { serialize: () => new Uint8Array([1, 2, 3]) },
      anchor: {
        __anchor: true,
        free: jest.fn(() => {
          throw new Error('null pointer passed to rust');
        })
      }
    });

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
    warn.mockRestore();
  });

  it('quarantines the imported notes (derived ids) before importing them', async () => {
    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importedNoteIds).toHaveBeenCalledWith(['noteA', 'noteB']);
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteA', 'id:noteB']);
    // Quarantine must be placed before the notes actually land in the client DB.
    const quarantineOrder = (quarantineNoteIds as jest.Mock).mock.invocationCallOrder[0]!;
    const importOrder = importNoteBytes.mock.invocationCallOrder[0]!;
    expect(quarantineOrder).toBeLessThan(importOrder);
  });

  it('quarantines with an empty id list when importNotes is missing', async () => {
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importedNoteIds).toHaveBeenCalledWith(undefined);
    expect(quarantineNoteIds).toHaveBeenCalledWith([]);
    expect(getInputNote).not.toHaveBeenCalled();
  });

  it('does NOT quarantine a note the wallet already holds', async () => {
    // The dApp controls `importNotes` and a decline releases nothing, so
    // quarantining an already-held note would hide the user's own claimable
    // funds permanently. Only the ids this dry run introduces may be hidden.
    getInputNote.mockImplementation(async (id: string) => (id === 'id:noteA' ? { alreadyHere: true } : null));
    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(getInputNote).toHaveBeenCalledWith('id:noteA');
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteB']);
  });

  it('treats a failed provenance lookup as already-held (quarantines nothing)', async () => {
    getInputNote.mockRejectedValueOnce(new Error('note store unavailable'));
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA'] });
    expect(quarantineNoteIds).toHaveBeenCalledWith([]);
  });

  it('tolerates a missing importNotes list', async () => {
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importNoteBytes).not.toHaveBeenCalled();
    expect(res.summaryBytes).toBe('b64:1-2-3');
  });

  it('returns { error } when execution throws, without rethrowing', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(new Error('note not found'));
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'note not found' });
  });

  it('returns a string error when execution rejects with a non-Error value', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce('boom');
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'boom' });
  });

  it('passes a hex address straight through without calling accountIdStringToSdk', async () => {
    const res = await simulateCustomTransaction({ address: '0xabc', transactionRequest: 'reqB64' });
    expect(executeForSummary).toHaveBeenCalledWith(
      fakeClient,
      '0xabc',
      { __req: expect.any(Uint8Array) },
      expect.any(String)
    );
    expect(accountIdStringToSdk as jest.Mock).not.toHaveBeenCalled();
    expect(res).toEqual({ summaryBytes: 'b64:1-2-3' });
  });

  // Regression: web-sdk 0.16 inverted `executeForSummary`'s contract — the summary
  // only exists while authorization is PENDING, and a transaction that executes
  // successfully now rejects with `TRANSACTION_ALREADY_AUTHORIZED`. That is every
  // ordinary single-sig account, so the confirm screen's verified (ground-truth)
  // asset view — the anti-phishing control — was unreachable for all of them and
  // the UI showed the loss as a transient "could not verify by simulation".
  it.each([
    ['an error carrying the SDK code', Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })],
    ['a Node-style code-prefixed message', new Error('TRANSACTION_ALREADY_AUTHORIZED: no summary produced')],
    ['the SDK display text', new Error('transaction is already fully authorized, so no transaction summary')]
  ])('falls back to a local execution when the account is already authorized (%s)', async (_label, err) => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(err);

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    // Executed locally against the same account — nothing proven or submitted.
    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toEqual({ executedBytes: 'b64:9-9' });
  });

  it('still reports a genuine execution failure as { error } rather than executing locally', async () => {
    (executeForSummary as jest.Mock).mockRejectedValueOnce(new Error('note not found'));

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(executeRequest).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'note not found' });
  });

  // #788 follow-up: a watchdog eviction hands the mutex to a successor without
  // stopping this callback, so the abandoned dry run must stop at its next
  // transition instead of borrowing a client somebody else is inside. Nothing
  // here ever submits, so every transition is guardable; each test parks the
  // eviction inside one await and asserts the flow went no further.
  describe('abandons the dry run at the next transition after a lock eviction', () => {
    const input = { address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA', 'noteB'] };

    it('during the client build: nothing WASM runs at all', async () => {
      getMidenClient.mockImplementationOnce(async () => {
        revokeWasmHold();
        return { client: fakeClient, importNoteBytes, syncState, getInputNote };
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned after the client build' });
      expect(getInputNote).not.toHaveBeenCalled();
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
      expect(syncState).not.toHaveBeenCalled();
      expect(executeForSummary).not.toHaveBeenCalled();
    });

    it('during a provenance lookup: the loop stops before the next one, and the poison is not swallowed as "already held"', async () => {
      getInputNote.mockImplementationOnce(async () => {
        revokeWasmHold();
        return null;
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned before the provenance lookup' });
      expect(getInputNote).toHaveBeenCalledTimes(1);
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
    });

    it('during the quarantine write (a Dexie await the watchdog does not pause for): no note is imported', async () => {
      (quarantineNoteIds as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned after the quarantine write' });
      expect(importNoteBytes).not.toHaveBeenCalled();
      expect(syncState).not.toHaveBeenCalled();
    });

    it('during a note import: the loop stops before the next import', async () => {
      importNoteBytes.mockImplementationOnce(async () => {
        revokeWasmHold();
        return 'noteid';
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned before the note import' });
      expect(importNoteBytes).toHaveBeenCalledTimes(1);
      expect(syncState).not.toHaveBeenCalled();
    });

    it('during the sync: neither the id parse nor the execution runs', async () => {
      syncState.mockImplementationOnce(async () => {
        revokeWasmHold();
        return undefined;
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned after the sync' });
      expect(accountIdStringToSdk).not.toHaveBeenCalled();
      expect(executeForSummary).not.toHaveBeenCalled();
    });

    it('during executeForSummary: the summary is not serialized and the anchor is deliberately NOT freed', async () => {
      const serialize = jest.fn(() => new Uint8Array([1, 2, 3]));
      const free = jest.fn();
      (executeForSummary as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
        return { summary: { serialize }, anchor: { __anchor: true, free } };
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned before the summary serialize' });
      // Both are WASM calls on objects from the evicted client's realm — freeing
      // the anchor here would be exactly the touch the guard exists to prevent,
      // so the abandoned path strands it (the poison recovery owns cleanup).
      expect(serialize).not.toHaveBeenCalled();
      expect(free).not.toHaveBeenCalled();
    });

    it('during an executeForSummary that ends already-authorized: the local fallback never executes', async () => {
      (executeForSummary as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
        throw Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' });
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned before the local execution fallback' });
      expect(executeRequest).not.toHaveBeenCalled();
    });

    it('during the fallback executeRequest: its result is not serialized', async () => {
      (executeForSummary as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
      );
      const serialize = jest.fn(() => new Uint8Array([9, 9]));
      executeRequest.mockImplementationOnce(async () => {
        revokeWasmHold();
        return { result: { serialize } };
      });

      const res = await simulateCustomTransaction(input);

      expect(res).toEqual({ error: 'operation abandoned before the result serialize' });
      expect(serialize).not.toHaveBeenCalled();
    });
  });

  it('times out and returns { error: "Simulation timed out" } when the locked work hangs', async () => {
    jest.useFakeTimers();
    try {
      (executeForSummary as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();

      const res = await resultPromise;
      expect(res).toEqual({ error: 'Simulation timed out' });
    } finally {
      jest.useRealTimers();
    }
  });
});
