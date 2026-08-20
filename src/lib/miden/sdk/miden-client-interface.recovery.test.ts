/**
 * The Guardian pending-note recovery SDK surface. All of the decision logic
 * that decides whether a recovery makes progress, gives up, or silently
 * under-reports lives in these three methods, and none of it was covered:
 *
 *   - when a block range is handed back as `saturated` for the caller to split,
 *     and when it must be imported as-is instead (the anti-infinite-split rule)
 *   - which node errors mean "span too wide" and which must NOT (a 429 answered
 *     by splitting doubles the request rate against a rate-limiting node)
 *   - failure accounting, which is what decides whether the ONE-SHOT
 *     `guardianNoteRecoveryPending` flag clears — an undercount clears it over
 *     notes that were never imported, losing them permanently
 *   - the creation-block search's bounds
 */

type RecoveryClientInterface = import('./miden-client-interface').MidenClientInterface;

const NOTE_TAG = { tag: 'note-tag' };

interface FakeRpc {
  syncNotes: jest.Mock;
  getNotesById: jest.Mock;
  getBlockHeaderByNumber: jest.Mock;
}

let fakeRpc: FakeRpc;
let noteImport: jest.Mock;

/** A `FetchedNote`-shaped entry: `noteId`/`inclusionProof` are properties. */
function fetchedNote(id: string, { withBody = true, proof = true } = {}) {
  return {
    noteId: id,
    inclusionProof: proof ? { proofFor: id } : undefined,
    asInputNote: () => (withBody ? { note: id } : undefined)
  };
}

function committedNote(id: string) {
  return { noteId: () => id };
}

function blockHeader(blockNum: number, timestamp: number) {
  return { blockNum: () => blockNum, timestamp: () => timestamp };
}

async function loadClient(): Promise<RecoveryClientInterface> {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
    RpcClient: jest.fn(() => fakeRpc),
    Endpoint: jest.fn(url => ({ url })),
    Address: { fromAccountId: jest.fn(() => ({ toNoteTag: () => NOTE_TAG })) },
    Note: { deserialize: jest.fn((bytes: Uint8Array) => ({ id: () => `note-${bytes[0]}` })) },
    InputNote: {
      authenticated: jest.fn((note, proof) => ({ note, proof, authenticated: true })),
      unauthenticated: jest.fn(note => ({ note, authenticated: false }))
    },
    NoteFile: { fromInputNote: jest.fn(inputNote => ({ file: inputNote })) }
  }));
  jest.doMock('lib/miden-chain/effective-endpoints', () => ({
    getEffectiveNetworkName: () => 'testnet',
    getEffectiveRpcUrl: () => 'https://rpc.example',
    getEffectiveProverUrl: () => undefined,
    getEffectiveNoteTransportUrl: () => undefined
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

describe('Guardian pending-note recovery (SDK surface)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    noteImport = jest.fn(async () => 'imported');
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

  describe('recoverPublicNotesRange', () => {
    it('imports every tag match that carries a body and reports no saturation', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('b')]);
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 2,
        failures: 0,
        saturated: false
      });
      expect(noteImport).toHaveBeenCalledTimes(2);
    });

    it('does not count a body-less tag match as a failure', async () => {
      // A tag match with no body is a PRIVATE note: unreachable here by design,
      // and the transport drain owns it. Counting it would keep the recovery
      // pending forever for any account that ever received a private note.
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a', { withBody: false })]);
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 0,
        failures: 0,
        saturated: false
      });
      expect(noteImport).not.toHaveBeenCalled();
    });

    it('counts ids the node omitted from its response as failures', async () => {
      // Silently treating a short response as success would clear the one-shot
      // pending flag over notes that were never imported.
      fakeRpc.syncNotes.mockResolvedValue({
        notes: () => [committedNote('a'), committedNote('b'), committedNote('c')]
      });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a')]);
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 1,
        failures: 2,
        saturated: false
      });
    });

    it('counts a note whose import throws', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('b')]);
      noteImport.mockRejectedValueOnce(new Error('store write failed'));
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 1,
        failures: 1,
        saturated: false
      });
    });

    it('reports saturation without importing when a wide range holds too many matches', async () => {
      // Importing a prefix would hold the WASM mutex for the prefix and then be
      // redone by the halves anyway.
      const many = Array.from({ length: 201 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 0,
        failures: 0,
        saturated: true
      });
      expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
      expect(noteImport).not.toHaveBeenCalled();
    });

    it('imports a dense range anyway once it is too narrow to split', async () => {
      // The anti-infinite-split rule: a thousand notes in one block still have
      // to be imported, and narrowing has stopped helping.
      const many = Array.from({ length: 201 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      fakeRpc.getNotesById.mockImplementation(async (ids: string[]) => ids.map(id => fetchedNote(id)));
      const client = await loadClient();

      const result = await client.recoverPublicNotesRange('acct', 0, 999);
      expect(result.saturated).toBe(false);
      expect(result.imported).toBe(201);
    });

    // One case per phrase the classifier accepts: these strings ARE the
    // contract with the node, and dropping one silently turns a splittable
    // range into a permanently failing source.
    it.each([
      'BlockPagination: requested block range is too large',
      'PaginationError: page too large',
      'query exceeded the safety cap',
      'query spans too many blocks',
      'block range exceeds the maximum number of blocks'
    ])('reports "%s" as saturation instead of throwing', async message => {
      fakeRpc.syncNotes.mockRejectedValue(new Error(message));
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).resolves.toEqual({
        imported: 0,
        failures: 0,
        saturated: true
      });
    });

    it('propagates a too-wide span that cannot be narrowed any further', async () => {
      fakeRpc.syncNotes.mockRejectedValue(new Error('BlockPagination: requested block range is too large'));
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 999)).rejects.toThrow('BlockPagination');
    });

    // Each message below ALSO looks like a span complaint ("block" plus "too
    // many"/"maximum number"), which is the only case where the rate-limit
    // guard changes the outcome: without it, splitting would answer a node that
    // is already rate-limiting by doubling the request rate against it.
    it.each([
      ['429', new Error('429 Too Many Requests: too many block range queries')],
      ['rate limit', new Error('rate limit exceeded: maximum number of block queries per minute')],
      ['ResourceExhausted', new Error('ResourceExhausted: too many block requests')]
    ])('treats a %s error as a real error even though it also mentions blocks', async (_label, error) => {
      fakeRpc.syncNotes.mockRejectedValue(error);
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).rejects.toThrow(error.message);
    });

    it('does not split for an unrelated node error', async () => {
      fakeRpc.syncNotes.mockRejectedValue(new Error('internal server error'));
      const client = await loadClient();

      await expect(client.recoverPublicNotesRange('acct', 0, 200_000)).rejects.toThrow('internal server error');
    });
  });

  describe('importRecoveryNoteBytes', () => {
    it('fetches proofs for the whole batch in ONE call and matches them by note id', async () => {
      // Per-note lookups cost up to 30s each inside one mutex hold; and the
      // response may come back reordered, so position cannot be trusted.
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('note-2'), fetchedNote('note-1')]);
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])])).resolves.toEqual({
        imported: 2,
        failures: 0
      });
      expect(fakeRpc.getNotesById).toHaveBeenCalledTimes(1);
      expect(fakeRpc.getNotesById).toHaveBeenCalledWith(['note-1', 'note-2']);
      // Both got their own proof, so both import authenticated.
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      expect(wasm.InputNote.authenticated).toHaveBeenCalledTimes(2);
      expect(wasm.InputNote.unauthenticated).not.toHaveBeenCalled();
    });

    it('imports a note with no proof as unauthenticated rather than dropping it', async () => {
      fakeRpc.getNotesById.mockResolvedValue([]);
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1])])).resolves.toEqual({
        imported: 1,
        failures: 0
      });
      const wasm = jest.requireMock('@miden-sdk/miden-sdk/lazy');
      expect(wasm.InputNote.unauthenticated).toHaveBeenCalledTimes(1);
    });

    it('still imports the batch when the proof lookup fails outright', async () => {
      fakeRpc.getNotesById.mockRejectedValue(new Error('node unreachable'));
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1])])).resolves.toEqual({
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

      await expect(client.importRecoveryNoteBytes([new Uint8Array([1]), new Uint8Array([2])])).resolves.toEqual({
        imported: 1,
        failures: 1
      });
      expect(wasm.Note.deserialize).toHaveBeenCalledTimes(2);
    });

    it('makes no proof call at all for an empty batch', async () => {
      const client = await loadClient();

      await expect(client.importRecoveryNoteBytes([])).resolves.toEqual({ imported: 0, failures: 0 });
      expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
    });
  });

  describe('resolveRecoveryScanRange', () => {
    it('returns the tip after a single header read when the creation time is unknown', async () => {
      // The resume path relies on this: passing 0 must not pay for a search.
      fakeRpc.getBlockHeaderByNumber.mockResolvedValue(blockHeader(500, 1_000_000));
      const client = await loadClient();

      await expect(client.resolveRecoveryScanRange(0)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
      expect(fakeRpc.getBlockHeaderByNumber).toHaveBeenCalledTimes(1);
    });

    it('binary-searches for the block just before the account existed', async () => {
      // Timestamp = block number, so the answer is checkable by hand: target is
      // 10_000 - 600 clock-skew margin = 9_400, so lo must land on 9_399.
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) =>
        blockNum === undefined ? blockHeader(20_000, 20_000) : blockHeader(blockNum, blockNum)
      );
      const client = await loadClient();

      const { startBlock, latestBlock } = await client.resolveRecoveryScanRange(10_000);
      expect(latestBlock).toBe(20_000);
      expect(startBlock).toBe(9_399);
    });

    it('starts at the tip when the account is newer than every block', async () => {
      fakeRpc.getBlockHeaderByNumber.mockResolvedValue(blockHeader(500, 1_000));
      const client = await loadClient();

      await expect(client.resolveRecoveryScanRange(5_000)).resolves.toEqual({ startBlock: 500, latestBlock: 500 });
    });

    it('scans from genesis when the chain is younger than the account timestamp', async () => {
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) =>
        blockNum === undefined ? blockHeader(500, 9_999) : blockHeader(0, 9_000)
      );
      const client = await loadClient();

      await expect(client.resolveRecoveryScanRange(5_000)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
    });

    it('abandons the search on its overall budget rather than holding the client', async () => {
      // Each read is bounded, but ~log2(tip) of them in one mutex-held op is
      // not. Giving up only widens the scan, which is safe.
      const realNow = Date.now;
      let clock = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) => {
        clock += 9_000;
        return blockNum === undefined ? blockHeader(10_000_000, 10_000_000) : blockHeader(blockNum, blockNum);
      });
      const client = await loadClient();

      const { startBlock } = await client.resolveRecoveryScanRange(5_000_000);
      // Bailed out early, so the start block is older (smaller) than the true
      // creation block — a wider scan, never a narrower one.
      expect(startBlock).toBeLessThan(4_999_400);
      expect(fakeRpc.getBlockHeaderByNumber.mock.calls.length).toBeLessThan(10);
    });
  });
});
