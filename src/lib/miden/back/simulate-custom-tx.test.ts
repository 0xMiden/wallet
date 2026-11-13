import { Address } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummaryAtTip } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds, releaseNoteIds } from 'lib/miden/note-quarantine';
import { prepareCustomRequestBytes } from 'lib/miden/sdk/custom-request';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';

import { simulateCustomTransaction } from './simulate-custom-tx';

const importNoteBytes = jest.fn(async () => 'noteid');
const syncState = jest.fn(async () => undefined);
// Provenance lookup: `null` = the wallet does NOT already hold this note, so the
// dry run is the thing introducing it. Defaults to "not held" for every id.
const getInputNote = jest.fn(async (_id: string): Promise<unknown> => null);
const executeRequest = jest.fn(async () => ({ result: { serialize: () => new Uint8Array([9, 9]) } }));
const fakeClient = { transactions: { executeRequest } };
const getMidenClient = jest.fn(async () => ({ client: fakeClient, importNoteBytes, syncState, getInputNote }));
type MockQuarantineAttempt = { abandoned: boolean };
const mockQuarantinedIds = new Set<string>();
const mockBeginQuarantineAttempt = jest.fn((): MockQuarantineAttempt => ({ abandoned: false }));
const mockAbandonQuarantineAttempt = jest.fn(async (attempt: MockQuarantineAttempt) => {
  attempt.abandoned = true;
});
const mockQuarantineCallObserver: { current?: () => void } = {};
const mockQuarantineNoteIds = jest.fn(async (ids: string[], attempt?: MockQuarantineAttempt) => {
  if (!attempt?.abandoned) ids.forEach(id => mockQuarantinedIds.add(id));
  mockQuarantineCallObserver.current?.();
});
const mockReleaseNoteIds = jest.fn(async (ids: string[]) => {
  ids.forEach(id => mockQuarantinedIds.delete(id));
});

// The lock hands its callback a HOLD, and the dry run re-checks ownership at every
// transition (#788 follow-up). Model both here: a hold-less pass-through would make
// `assertWasmHoldCurrent` throw on the happy path, and a mock with no way to revoke
// ownership could not exercise the eviction guards at all.
let currentWasmHold: object | null = null;
const revokeWasmHold = () => {
  currentWasmHold = null;
};
const mockRetireWasmClientForCaughtTrap = jest.fn();
// A WebAssembly trap from decoding an `importNotes` entry whose bytes start with `trap`.
const mockDecodeTrap = new WebAssembly.RuntimeError('unreachable');

jest.mock('lib/miden/sdk/miden-client', () => ({
  // Lazy closure, not shorthand: the hoisted require of the module under test
  // runs this factory before the consts above are initialized.
  getMidenClient: () => getMidenClient(),
  getCurrentWasmLockHold: () => currentWasmHold,
  // Re-implements the real comparison against the mock's current hold — a no-op
  // here would make every eviction test below vacuously green.
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    const { WasmClientPoisonedError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
    throw new WasmClientPoisonedError('watchdog', new Error(`operation abandoned ${where}`));
  },
  withWasmClientLock: jest.fn(async (fn: (hold: object) => Promise<unknown>) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } catch (error) {
      // The real lock's caught-trap path: a callback that rejects with a trap retires the client through its holder.
      if (error instanceof WebAssembly.RuntimeError) mockRetireWasmClientForCaughtTrap(hold, error);
      throw error;
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  })
}));
// The real account-reference parser over the SDK stand-in below, spied only so a test can assert it never ran.
jest.mock('lib/miden/sdk/helpers', () => {
  const actual = jest.requireActual<typeof import('lib/miden/sdk/helpers')>('lib/miden/sdk/helpers');
  return { ...actual, accountRefToSdk: jest.fn(actual.accountRefToSdk) };
});
jest.mock('lib/miden/sdk/custom-request', () => ({
  prepareCustomRequestBytes: jest.fn(async (_client: unknown, _account: string, bytes: Uint8Array) => bytes)
}));
// As the real decode does: an entry that traps is skipped unless the caller asks for the trap, and one that cannot be
// read (`unreadable`) is always skipped.
jest.mock('lib/miden/note-quarantine', () => ({
  beginQuarantineAttempt: () => mockBeginQuarantineAttempt(),
  abandonQuarantineAttempt: (attempt: MockQuarantineAttempt) => mockAbandonQuarantineAttempt(attempt),
  importedNoteIds: jest.fn((notes: string[] | undefined, options?: { rethrowTraps?: boolean }) =>
    (notes ?? []).flatMap(n => {
      if (n.startsWith('trap') && options?.rethrowTraps) throw mockDecodeTrap;
      return n.startsWith('trap') || n.startsWith('unreadable') ? [] : [`id:${n}`];
    })
  ),
  quarantineNoteIds: jest.fn((...args: [string[], MockQuarantineAttempt?]) => mockQuarantineNoteIds(...args)),
  releaseNoteIds: (...args: [string[]]) => mockReleaseNoteIds(...args)
}));
// As strict as the SDK where it matters: fromHex takes only a literal `0x` and returns the canonical
// (lowercase) id, and fromBech32 rejects an underscore, standing in for a routing suffix it cannot decode.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  TransactionRequest: { deserialize: jest.fn((bytes: Uint8Array) => ({ __req: bytes })) },
  AccountId: {
    fromHex: jest.fn((hex: string) => {
      if (!hex.startsWith('0x')) throw new Error('hex encoded data must start with 0x');
      return { toString: () => hex.toLowerCase() };
    })
  },
  Address: {
    fromBech32: jest.fn((address: string) => {
      if (address.includes('_')) throw new Error('invalid note tag length');
      return { accountId: () => ({ toString: () => `hex:${address}` }) };
    })
  }
}));
jest.mock('@openzeppelin/miden-multisig-client', () => ({
  executeForSummaryAtTip: jest.fn(async () => ({ serialize: () => new Uint8Array([1, 2, 3]) }))
}));
jest.mock('lib/shared/helpers', () => ({
  b64ToU8: jest.fn((s: string) => new Uint8Array([s.length])),
  u8ToB64: jest.fn((u: Uint8Array) => `b64:${Array.from(u).join('-')}`)
}));

describe('simulateCustomTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuarantinedIds.clear();
    delete mockQuarantineCallObserver.current;
    mockBeginQuarantineAttempt.mockReset().mockImplementation(() => ({ abandoned: false }));
    mockAbandonQuarantineAttempt.mockReset().mockImplementation(async attempt => {
      attempt.abandoned = true;
    });
    mockQuarantineNoteIds.mockReset().mockImplementation(async (ids, attempt) => {
      if (!attempt?.abandoned) ids.forEach(id => mockQuarantinedIds.add(id));
      mockQuarantineCallObserver.current?.();
    });
    mockReleaseNoteIds.mockReset().mockImplementation(async ids => {
      ids.forEach(id => mockQuarantinedIds.delete(id));
    });
    getInputNote.mockImplementation(async () => null);
    // Some tests queue a behaviour for one of the two syncs; one left unused must not reach the next test.
    syncState.mockReset().mockImplementation(async () => undefined);
  });

  it('imports notes, syncs, executes for summary and returns serialized summary', async () => {
    const res = await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importNoteBytes).toHaveBeenCalledTimes(2);
    expect(syncState).toHaveBeenCalledTimes(2);
    expect(executeForSummaryAtTip).toHaveBeenCalledWith(fakeClient, 'hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toMatchObject({ summaryBytes: 'b64:1-2-3' });
  });

  it('previews the wallet-enriched request rather than the dApp bytes', async () => {
    const prepared = new Uint8Array([42, 43, 44]);
    jest.mocked(prepareCustomRequestBytes).mockResolvedValueOnce(prepared);
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toMatchObject({ summaryBytes: 'b64:1-2-3' });
    expect(executeForSummaryAtTip).toHaveBeenCalledWith(fakeClient, 'hex:mtst1abc', { __req: prepared });
  });

  it('reuses the enriched bytes if summary signing needs local execution', async () => {
    const prepared = new Uint8Array([42, 43, 44]);
    jest.mocked(prepareCustomRequestBytes).mockResolvedValueOnce(prepared);
    jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('failed to generate signature'));
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: prepared });
    expect(prepareCustomRequestBytes).toHaveBeenCalledTimes(1);
  });

  it('reports a summary that cannot serialize as { error }', async () => {
    (executeForSummaryAtTip as jest.Mock).mockResolvedValueOnce({
      serialize: () => {
        throw new Error('summary serialize failed');
      }
    });

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(res).toEqual({ error: 'summary serialize failed' });
  });

  it('quarantines the imported notes (derived ids) before importing them', async () => {
    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });
    expect(importedNoteIds).toHaveBeenCalledWith(['noteA', 'noteB'], { rethrowTraps: true });
    expect(quarantineNoteIds).toHaveBeenCalledWith(
      ['id:noteA', 'id:noteB'],
      expect.objectContaining({ abandoned: false })
    );
    // Quarantine must be placed before the notes actually land in the client DB.
    const quarantineOrder = (quarantineNoteIds as jest.Mock).mock.invocationCallOrder[0]!;
    const importOrder = importNoteBytes.mock.invocationCallOrder[0]!;
    expect(quarantineOrder).toBeLessThan(importOrder);
  });

  it('quarantines with an empty id list when importNotes is missing', async () => {
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importedNoteIds).toHaveBeenCalledWith(undefined, { rethrowTraps: true });
    expect(quarantineNoteIds).toHaveBeenCalledWith([], expect.objectContaining({ abandoned: false }));
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
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteB'], expect.objectContaining({ abandoned: false }));
  });

  it('does not import a carried note the wallet already holds', async () => {
    const introducedNote = 'noteB-extra';
    getInputNote.mockImplementation(async (id: string) => (id === 'id:noteA' ? { alreadyHere: true } : null));

    await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', introducedNote]
    });

    expect(importNoteBytes).toHaveBeenCalledTimes(1);
    expect(importNoteBytes).toHaveBeenCalledWith(new Uint8Array([introducedNote.length]), expect.anything());
  });

  it('treats a failed provenance lookup as already-held (quarantines nothing)', async () => {
    getInputNote.mockRejectedValueOnce(new Error('note store unavailable'));
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA'] });
    expect(quarantineNoteIds).toHaveBeenCalledWith([], expect.objectContaining({ abandoned: false }));
  });

  it('syncs again after an import, before executing, for a carried note committed since the first sync', async () => {
    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA'] });

    expect(syncState).toHaveBeenCalledTimes(2);
    expect(importNoteBytes.mock.invocationCallOrder[0]).toBeLessThan(syncState.mock.invocationCallOrder[1]!);
    expect(syncState.mock.invocationCallOrder[1]).toBeLessThan(
      jest.mocked(executeForSummaryAtTip).mock.invocationCallOrder[0]!
    );
  });

  it('syncs once, before the lookups, when it imports nothing', async () => {
    getInputNote.mockImplementation(async () => ({ alreadyHere: true }));

    await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA'] });

    expect(importNoteBytes).not.toHaveBeenCalled();
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(syncState.mock.invocationCallOrder[0]).toBeLessThan(getInputNote.mock.invocationCallOrder[0]!);
  });

  it('tolerates a missing importNotes list', async () => {
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(importNoteBytes).not.toHaveBeenCalled();
    expect(res.summaryBytes).toBe('b64:1-2-3');
  });

  // Inside the hold a trap from decoding the dApp's note bytes has to reach the lock, which retires the client, and
  // the dry run must stop before it quarantines or imports anything on that client.
  describe('a WebAssembly trap while decoding an importNotes entry', () => {
    it('in its id fails the dry run before the quarantine write and every import, and retires the client', async () => {
      const res = await simulateCustomTransaction({
        address: 'mtst1abc',
        transactionRequest: 'reqB64',
        importNotes: ['noteA', 'trap-id']
      });

      expect(res).toEqual({ error: 'unreachable' });
      expect(mockRetireWasmClientForCaughtTrap).toHaveBeenCalledWith(expect.anything(), mockDecodeTrap);
      expect(getInputNote).not.toHaveBeenCalled();
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
    });

    it('is not what an ordinary decode failure is: that entry is still skipped and the rest import', async () => {
      const res = await simulateCustomTransaction({
        address: 'mtst1abc',
        transactionRequest: 'reqB64',
        importNotes: ['noteA', 'unreadable']
      });

      expect(res).toMatchObject({ summaryBytes: 'b64:1-2-3', introducedNoteIds: ['id:notea'] });
      expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteA'], expect.objectContaining({ abandoned: false }));
      expect(importNoteBytes).toHaveBeenCalledTimes(2);
      expect(mockRetireWasmClientForCaughtTrap).not.toHaveBeenCalled();
    });
  });

  it('returns { error } when execution throws, without rethrowing and without the introduced ids', async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(new Error('note not found'));
    const res = await simulateCustomTransaction({
      address: 'mtst1abc',
      transactionRequest: 'reqB64',
      importNotes: ['noteA']
    });
    expect(res).toEqual({ error: 'note not found' });
  });

  it('returns a string error when execution rejects with a non-Error value', async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce('boom');
    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    expect(res).toEqual({ error: 'boom' });
  });

  it('parses a hex address as hex, never through the bech32 parser', async () => {
    const res = await simulateCustomTransaction({ address: '0xabc', transactionRequest: 'reqB64' });
    expect(executeForSummaryAtTip).toHaveBeenCalledWith(fakeClient, '0xabc', { __req: expect.any(Uint8Array) });
    expect(Address.fromBech32).not.toHaveBeenCalled();
    expect(res).toMatchObject({ summaryBytes: 'b64:1-2-3' });
  });

  it('lowercases an uppercase 0X prefix, which AccountId.fromHex rejects, for the summary and the fallback', async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
    );

    const res = await simulateCustomTransaction({ address: '0XABC', transactionRequest: 'reqB64' });

    expect(executeForSummaryAtTip).toHaveBeenCalledWith(fakeClient, '0xabc', { __req: expect.any(Uint8Array) });
    expect(executeRequest).toHaveBeenCalledWith('0xabc', { __req: expect.any(Uint8Array) });
    expect(Address.fromBech32).not.toHaveBeenCalled();
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
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
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(err);

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    // Executed locally against the same account — nothing proven or submitted.
    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
  });

  // Signing failures can still use the wallet execution fallback; unrelated
  // kernel failures must remain errors rather than being retried.
  it.each([
    [
      'the kernel auth-request failure',
      new Error(
        "failed to execute transaction kernel program: error during processing of event 'miden::protocol::auth::request'\n  |-> failed to generate signature\n  `-> storage error: Failed to get secret key from IndexedDB"
      )
    ],
    ['the bare keystore miss', new Error('storage error: Failed to get secret key from IndexedDB')]
  ])('falls back to a local execution when the summary client cannot sign (%s)', async (_label, err) => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(err);

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
  });

  it.each([
    ['the 0.17 create-time message', new Error('no fee faucet is known for network `mlcl`')],
    ['the option name', new Error('pass `feeFaucetId` when creating the client')]
  ])('falls back to a local execution when the summary client has no fee faucet (%s)', async (_label, err) => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(err);

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
  });

  it('still reports a genuine execution failure as { error } rather than executing locally', async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(new Error('note not found'));

    const res = await simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

    expect(executeRequest).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'note not found' });
  });

  it('keeps a genuine dry-run error whose text is Simulation timed out as an error result', async () => {
    jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(new Error('Simulation timed out'));

    await expect(simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' })).resolves.toEqual({
      error: 'Simulation timed out'
    });
    expect(executeRequest).not.toHaveBeenCalled();
  });

  // #788 follow-up: a watchdog eviction hands the mutex to a successor without
  // stopping this callback, so the abandoned dry run must stop at its next
  // transition instead of borrowing a client somebody else is inside. Nothing
  // here ever submits, so every transition is guardable; each test parks the
  // eviction inside one await and asserts the flow went no further.
  describe('abandons the dry run at the next transition after a lock eviction', () => {
    const input = { address: 'mtst1abc', transactionRequest: 'reqB64', importNotes: ['noteA', 'noteB'] };

    const expectHoldLoss = async (simulation: Promise<unknown>, where: string) => {
      const { WasmClientPoisonedError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
      await expect(simulation).rejects.toBeInstanceOf(WasmClientPoisonedError);
      await expect(simulation).rejects.toMatchObject({
        cause: expect.objectContaining({ message: `operation abandoned ${where}` })
      });
      expect(mockBeginQuarantineAttempt).toHaveBeenCalledTimes(1);
      expect(mockAbandonQuarantineAttempt).toHaveBeenCalledWith(mockBeginQuarantineAttempt.mock.results[0]?.value);
    };

    it('during the client build: nothing WASM runs at all', async () => {
      getMidenClient.mockImplementationOnce(async () => {
        revokeWasmHold();
        return { client: fakeClient, importNoteBytes, syncState, getInputNote };
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'after the client build');
      expect(getInputNote).not.toHaveBeenCalled();
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
      expect(syncState).not.toHaveBeenCalled();
      expect(executeForSummaryAtTip).not.toHaveBeenCalled();
    });

    it('during the sync before the lookups: no lookup, quarantine write or import runs', async () => {
      syncState.mockImplementationOnce(async () => {
        revokeWasmHold();
        return undefined;
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'after the provenance sync');
      expect(getInputNote).not.toHaveBeenCalled();
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
    });

    it('during a provenance lookup: the loop stops before the next one, and the poison is not swallowed as "already held"', async () => {
      getInputNote.mockImplementationOnce(async () => {
        revokeWasmHold();
        return null;
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'before the provenance lookup');
      expect(getInputNote).toHaveBeenCalledTimes(1);
      expect(quarantineNoteIds).not.toHaveBeenCalled();
      expect(importNoteBytes).not.toHaveBeenCalled();
    });

    it('during the quarantine write (a Dexie await the watchdog does not pause for): no note is imported', async () => {
      (quarantineNoteIds as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'after the quarantine write');
      expect(importNoteBytes).not.toHaveBeenCalled();
      // Only the sync before the lookups ran.
      expect(syncState).toHaveBeenCalledTimes(1);
    });

    it('during a note import: the loop stops before the next import', async () => {
      importNoteBytes.mockImplementationOnce(async () => {
        revokeWasmHold();
        return 'noteid';
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'before the note import');
      expect(importNoteBytes).toHaveBeenCalledTimes(1);
      // Only the sync before the lookups ran.
      expect(syncState).toHaveBeenCalledTimes(1);
    });

    it('during the sync after the imports: neither the id parse nor the execution runs', async () => {
      syncState
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          revokeWasmHold();
          return undefined;
        });

      await expectHoldLoss(simulateCustomTransaction(input), 'after the post-import sync');
      expect(importNoteBytes).toHaveBeenCalledTimes(2);
      expect(accountRefToSdk).not.toHaveBeenCalled();
      expect(executeForSummaryAtTip).not.toHaveBeenCalled();
    });

    it('during the summary execution: the summary is not serialized', async () => {
      const serialize = jest.fn(() => new Uint8Array([1, 2, 3]));
      (executeForSummaryAtTip as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
        return { serialize };
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'before the summary serialize');
      // `summary.serialize()` reads through the evicted client's RefCell, which
      // is the double borrow the guard exists to prevent.
      expect(serialize).not.toHaveBeenCalled();
    });

    it('during a summary execution that ends already-authorized: the local fallback never executes', async () => {
      (executeForSummaryAtTip as jest.Mock).mockImplementationOnce(async () => {
        revokeWasmHold();
        throw Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' });
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'before the local execution fallback');
      expect(executeRequest).not.toHaveBeenCalled();
    });

    it('during the fallback executeRequest: its result is not serialized', async () => {
      (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
      );
      const serialize = jest.fn(() => new Uint8Array([9, 9]));
      executeRequest.mockImplementationOnce(async () => {
        revokeWasmHold();
        return { result: { serialize } };
      });

      await expectHoldLoss(simulateCustomTransaction(input), 'before the result serialize');
      expect(serialize).not.toHaveBeenCalled();
    });
  });

  it('a simulation timeout rejects with CustomSimulationTimeoutError', async () => {
    jest.useFakeTimers();
    try {
      (executeForSummaryAtTip as jest.Mock).mockImplementationOnce(() => new Promise(() => {}));

      const resultPromise = simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });

      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();

      await expect(resultPromise).rejects.toMatchObject({
        name: 'CustomSimulationTimeoutError',
        message: 'The wallet could not finish simulating this transaction. Try again.'
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not quarantine an imported note after timeout release wins', async () => {
    jest.useFakeTimers();
    const attempt = { abandoned: false };
    mockBeginQuarantineAttempt.mockReturnValueOnce(attempt);
    let resolveLookup!: (result: unknown) => void;
    let signalLookup!: () => void;
    const lookupStarted = new Promise<void>(resolve => {
      signalLookup = resolve;
    });
    getInputNote.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveLookup = resolve;
          signalLookup();
        })
    );
    let signalQuarantine!: () => void;
    const quarantineCalled = new Promise<void>(resolve => {
      signalQuarantine = resolve;
    });
    mockQuarantineCallObserver.current = signalQuarantine;

    try {
      const simulation = simulateCustomTransaction({
        address: 'mtst1abc',
        transactionRequest: 'reqB64',
        importNotes: ['noteA']
      });
      await lookupStarted;
      jest.advanceTimersByTime(20_000);
      await simulation.catch(() => undefined);

      await releaseNoteIds(['id:noteA']);
      resolveLookup(null);
      await quarantineCalled;

      expect(mockQuarantinedIds.has('id:noteA')).toBe(false);
      expect(mockAbandonQuarantineAttempt).toHaveBeenCalledWith(attempt);
      expect(mockQuarantineNoteIds).toHaveBeenCalledWith(['id:noteA'], attempt);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('an abandoned dry run', () => {
  it('waits for quarantine abandonment before rethrowing a kill', async () => {
    const { WasmClientPoisonedError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
    const eviction = new WasmClientPoisonedError('watchdog');
    const attempt = { abandoned: false };
    mockBeginQuarantineAttempt.mockReturnValueOnce(attempt);
    let releaseAbandon!: () => void;
    let signalAbandon!: () => void;
    const abandonStarted = new Promise<void>(resolve => {
      signalAbandon = resolve;
    });
    const abandonFinished = new Promise<void>(resolve => {
      releaseAbandon = resolve;
    });
    mockAbandonQuarantineAttempt.mockImplementationOnce(async current => {
      current.abandoned = true;
      signalAbandon();
      await abandonFinished;
    });
    jest.mocked(executeForSummaryAtTip).mockRejectedValueOnce(eviction);
    const simulation = simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' });
    let settled = false;
    const settledSimulation = simulation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    try {
      await Promise.race([abandonStarted, settledSimulation]);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockAbandonQuarantineAttempt).toHaveBeenCalledWith(attempt);
      expect(settled).toBe(false);
    } finally {
      releaseAbandon();
    }
    await expect(simulation).rejects.toBe(eviction);
  });

  it('rethrows a lock eviction so the request can retry', async () => {
    const { WasmClientPoisonedError } = jest.requireActual('lib/miden/sdk/wasm-client-poison');
    const eviction = new WasmClientPoisonedError('watchdog');
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(eviction);

    await expect(simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' })).rejects.toBe(
      eviction
    );
  });

  it('rethrows a terminated client so the request can retry', async () => {
    const terminated = new Error('Client terminated');
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(terminated);

    await expect(simulateCustomTransaction({ address: 'mtst1abc', transactionRequest: 'reqB64' })).rejects.toBe(
      terminated
    );
  });
});

describe('introduced-note provenance', () => {
  // Signing credits only the consumed notes this request brought in. `importNotes` is dApp-authored and its ids can
  // name a note the user already holds, so the ids come from the wallet's own already-held check.
  beforeEach(() => {
    jest.clearAllMocks();
    getInputNote.mockImplementation(async () => null);
  });

  it('returns the ids of the carried notes the wallet did not already hold', async () => {
    getInputNote.mockImplementation(async (id: string) => (id === 'id:noteA' ? { alreadyHere: true } : null));

    const result = await simulateCustomTransaction({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });

    expect(result).toEqual({ summaryBytes: 'b64:1-2-3', introducedNoteIds: ['id:noteb'] });
  });

  it('returns no introduced id for a carried note the wallet already held, on either result', async () => {
    getInputNote.mockImplementation(async () => ({ alreadyHere: true }));
    const input = { address: 'mtst1sender', transactionRequest: 'reqB64', importNotes: ['noteA'] };

    await expect(simulateCustomTransaction(input)).resolves.toEqual({
      summaryBytes: 'b64:1-2-3',
      introducedNoteIds: []
    });
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
    );
    await expect(simulateCustomTransaction(input)).resolves.toEqual({
      executedBytes: 'b64:9-9',
      introducedNoteIds: []
    });
  });

  it('judges a carried note against the synced client: a note the sync brings in is held, not introduced', async () => {
    // The account's own public note is on chain but not in the client until a sync. Looked up before it, the note
    // read as introduced and the approval credited its value as brought in by the request.
    let synced = false;
    syncState.mockImplementationOnce(async () => {
      synced = true;
    });
    getInputNote.mockImplementation(async (id: string) => (synced && id === 'id:noteA' ? { alreadyHere: true } : null));

    const result = await simulateCustomTransaction({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteA', 'noteB']
    });

    expect(result).toEqual({ summaryBytes: 'b64:1-2-3', introducedNoteIds: ['id:noteb'] });
    expect(quarantineNoteIds).toHaveBeenCalledWith(['id:noteB'], expect.anything());
    expect(importNoteBytes).toHaveBeenCalledTimes(1);
  });

  it('syncs before the held-note lookups', async () => {
    await simulateCustomTransaction({ address: 'mtst1sender', transactionRequest: 'reqB64', importNotes: ['noteA'] });

    expect(syncState.mock.invocationCallOrder[0]).toBeLessThan(getInputNote.mock.invocationCallOrder[0]!);
  });

  it('returns the introduced ids with an executed result too', async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
    );

    const result = await simulateCustomTransaction({
      address: 'mtst1sender',
      transactionRequest: 'reqB64',
      importNotes: ['noteA']
    });

    expect(result).toEqual({ executedBytes: 'b64:9-9', introducedNoteIds: ['id:notea'] });
  });
});

describe('the dApp account reference', () => {
  beforeEach(() => jest.clearAllMocks());

  it("is parsed by its address part when a composite's routing suffix fails the bech32 parser", async () => {
    (executeForSummaryAtTip as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('nope'), { code: 'TRANSACTION_ALREADY_AUTHORIZED' })
    );

    const res = await simulateCustomTransaction({ address: 'mtst1abc_qruqqypuyph', transactionRequest: 'reqB64' });

    expect(executeForSummaryAtTip).toHaveBeenCalledWith(fakeClient, 'hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(executeRequest).toHaveBeenCalledWith('hex:mtst1abc', { __req: expect.any(Uint8Array) });
    expect(res).toMatchObject({ executedBytes: 'b64:9-9' });
  });
});
