/**
 * The public backfill's node reads (#2266). They run without the client lock,
 * so these tests also pin what the read keeps: only the tag matches the account
 * can consume and that are not spent. Its failure accounting decides whether
 * the ONE-SHOT `guardianNoteRecoveryPending` flag clears, so an undercount
 * loses notes permanently.
 */

const NOTE_TYPE_PRIVATE = 0;
const NOTE_TYPE_PUBLIC = 1;
const NOTE_TAG = { tag: 'note-tag' };

interface FakeRpc {
  syncNotes: jest.Mock;
  getNotesById: jest.Mock;
  getBlockHeaderByNumber: jest.Mock;
  syncNullifiers: jest.Mock;
}

let fakeRpc: FakeRpc;
/** Ids each `getNotesById` call asked for, as strings read before the call moved them. */
let requestedIdBatches: string[][];
/** Notes the account cannot consume, by id. */
let otherAccountNotes: Set<string>;

/** A nullifier word whose fourth element carries `prefix` in its top 16 bits. */
function nullifierWord(id: string, prefix = 1) {
  return {
    toHex: () => `nullifier-${id}`,
    toU64s: () => new BigUint64Array([0n, 0n, 0n, BigInt(prefix) << 48n])
  };
}

function sdkNote(id: string) {
  return { id, nullifier: () => nullifierWord(id) };
}

/**
 * A `FetchedNote`-shaped entry: `noteId`/`noteType` are properties,
 * `asInputNote()` a method. A body-less note defaults to PRIVATE, which is what
 * the SDK documents a missing body to mean.
 */
function fetchedNote(id: string, { withBody = true, noteType }: { withBody?: boolean; noteType?: number } = {}) {
  return {
    noteId: id,
    noteType: noteType ?? (withBody ? NOTE_TYPE_PUBLIC : NOTE_TYPE_PRIVATE),
    asInputNote: () => (withBody ? { note: () => sdkNote(id) } : undefined)
  };
}

/**
 * A `NoteId` handle with the SDK's ownership semantics. Passing one into an RPC
 * call MOVES it, so reading the handle afterwards traps. Against plain strings,
 * code that reads a requested id after the call passes and traps for real.
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

function committedNote(id: string) {
  return { noteId: () => noteIdHandle(id) };
}

function blockHeader(blockNum: number, timestamp: number) {
  return { blockNum: () => blockNum, timestamp: () => timestamp };
}

async function loadReader() {
  jest.doMock('@miden-sdk/miden-sdk/lazy', () => ({
    RpcClient: jest.fn(() => ({
      ...fakeRpc,
      // Delegates to the mock, then consumes the ids exactly as the real call does.
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
    NoteType: { Private: NOTE_TYPE_PRIVATE, Public: NOTE_TYPE_PUBLIC },
    Address: { fromAccountId: jest.fn(() => ({ toNoteTag: () => NOTE_TAG })) },
    NoteFile: {
      fromInputNote: jest.fn((inputNote: { note: () => { id: string } }) => ({
        serialize: () => new TextEncoder().encode(inputNote.note().id)
      }))
    }
  }));
  jest.doMock('lib/miden-chain/effective-endpoints', () => ({
    getEffectiveRpcUrl: () => 'https://rpc.example'
  }));
  jest.doMock('./helpers', () => ({
    walletAccountIdToSdk: () => ({ prefix: () => ({ asInt: () => 1n }), suffix: () => ({ asInt: () => 2n }) })
  }));
  jest.doMock('../helpers', () => ({
    mayEverConsume: jest.fn((note: { id: string }, account: { prefix: string; suffix: string }) => {
      expect(account).toEqual({ prefix: '1', suffix: '2' });
      return !otherAccountNotes.has(note.id);
    })
  }));
  return import('./recovery-public-notes');
}

/** The ids of the notes a read kept, from the bytes it serialized. */
function keptIds(noteFiles: Uint8Array[]): string[] {
  return noteFiles.map(bytes => new TextDecoder().decode(bytes));
}

describe('pending-note recovery public backfill reads', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    requestedIdBatches = [];
    otherAccountNotes = new Set();
    fakeRpc = {
      syncNotes: jest.fn(async () => ({ notes: () => [] })),
      getNotesById: jest.fn(async () => []),
      getBlockHeaderByNumber: jest.fn(async () => blockHeader(900_000, 0)),
      syncNullifiers: jest.fn(async () => [])
    };
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  describe('readRecoverablePublicNotes', () => {
    it('keeps every unspent tag match of the account that carries a body', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('b')]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(keptIds(read.noteFiles)).toEqual(['a', 'b']);
      expect(read).toEqual(expect.objectContaining({ failures: 0, saturated: false, nextNoteOffset: undefined }));
      expect(fakeRpc.syncNotes).toHaveBeenCalledWith(0, 200_000, [NOTE_TAG]);
    });

    it('drops the tag matches another account owns, with no nullifier request for them', async () => {
      // The tag is a 14-bit prefix of the account id, so on a busy chain most
      // matches are other accounts' notes.
      otherAccountNotes = new Set(['a', 'b']);
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('b')]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(read.noteFiles).toEqual([]);
      expect(read.failures).toBe(0);
      expect(fakeRpc.syncNullifiers).not.toHaveBeenCalled();
    });

    it('drops the notes the node shows spent, in one nullifier request from the range start to the tip', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('b')]);
      fakeRpc.syncNullifiers.mockResolvedValue([{ nullifier: () => nullifierWord('a'), blockNum: () => 5 }]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 1_000, 200_999);
      expect(keptIds(read.noteFiles)).toEqual(['b']);
      expect(read.failures).toBe(0);
      expect(fakeRpc.syncNullifiers).toHaveBeenCalledTimes(1);
      // One distinct 16-bit prefix for both notes, read over the range start to the tip.
      expect(fakeRpc.syncNullifiers).toHaveBeenCalledWith(new Uint16Array([1]), 1_000, 900_000);
    });

    it('keeps every note when the nullifier check fails, without counting a failure', async () => {
      // The check only saves imports: a spent note imported anyway is marked
      // consumed by the next sync.
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a')]);
      fakeRpc.syncNullifiers.mockRejectedValue(new Error('node unavailable'));
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(keptIds(read.noteFiles)).toEqual(['a']);
      expect(read.failures).toBe(0);
    });

    it('does not count a body-less tag match as a failure', async () => {
      // A tag match with no body is a PRIVATE note: unreachable here by design,
      // and the transport drain owns it. Counting it would keep the recovery
      // pending forever for any account that ever received a private note.
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a', { withBody: false })]);
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).resolves.toEqual({
        noteFiles: [],
        failures: 0,
        saturated: false,
        nextNoteOffset: undefined
      });
    });

    it('counts a public note the node returned without a body', async () => {
      // The SDK documents a missing body as the PRIVATE case; a public note with
      // no body is the node failing to serve what it said it had.
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a', { withBody: false, noteType: NOTE_TYPE_PUBLIC })]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(read.failures).toBe(1);
      expect(read.noteFiles).toEqual([]);
    });

    // A right-length response can still be the wrong notes. Counting length
    // alone reads that as a clean chunk, and a clean chunk is what lets the
    // orchestrator clear the one-shot flag.
    it('counts a duplicated id as one answer, not two', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a'), committedNote('b')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a'), fetchedNote('a')]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(keptIds(read.noteFiles)).toEqual(['a']);
      expect(read.failures).toBe(1);
    });

    it('counts an id it never asked for as no answer at all', async () => {
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => [committedNote('a')] });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('substituted')]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(read.noteFiles).toEqual([]);
      expect(read.failures).toBe(1);
    });

    it('counts ids the node omitted from its response as failures', async () => {
      fakeRpc.syncNotes.mockResolvedValue({
        notes: () => [committedNote('a'), committedNote('b'), committedNote('c')]
      });
      fakeRpc.getNotesById.mockResolvedValue([fetchedNote('a')]);
      const { readRecoverablePublicNotes } = await loadReader();

      const read = await readRecoverablePublicNotes('acct', 0, 200_000);
      expect(keptIds(read.noteFiles)).toEqual(['a']);
      expect(read.failures).toBe(2);
    });

    it('reports saturation without reading a body when a wide range holds too many matches', async () => {
      const many = Array.from({ length: 201 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).resolves.toEqual({
        noteFiles: [],
        failures: 0,
        saturated: true
      });
      expect(fakeRpc.getNotesById).not.toHaveBeenCalled();
    });

    // A range too narrow to split still has to be read, but not all at once:
    // anyone can aim volume at a note tag. So it pages by note.
    it('pages a dense unsplittable range instead of reading it all at once', async () => {
      const many = Array.from({ length: 450 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      fakeRpc.getNotesById.mockImplementation(async (ids: unknown[]) => ids.map(id => fetchedNote(String(id))));
      const { readRecoverablePublicNotes } = await loadReader();

      const first = await readRecoverablePublicNotes('acct', 0, 999);
      expect(first.noteFiles).toHaveLength(200);
      expect(first.nextNoteOffset).toBe(200);

      const second = await readRecoverablePublicNotes('acct', 0, 999, first.nextNoteOffset);
      expect(second.noteFiles).toHaveLength(200);
      expect(second.nextNoteOffset).toBe(400);

      // The last page finishes the range: no cursor back.
      const third = await readRecoverablePublicNotes('acct', 0, 999, second.nextNoteOffset);
      expect(third.noteFiles).toHaveLength(50);
      expect(third.nextNoteOffset).toBeUndefined();
    });

    it('reads the notes of the requested page, not the first ones again', async () => {
      const many = Array.from({ length: 250 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      fakeRpc.getNotesById.mockImplementation(async (ids: unknown[]) => ids.map(id => fetchedNote(String(id))));
      const { readRecoverablePublicNotes } = await loadReader();

      await readRecoverablePublicNotes('acct', 0, 999, 200);

      expect(requestedIdBatches).toEqual([Array.from({ length: 50 }, (_, i) => `n${200 + i}`)]);
    });

    it('does not page a range it can still narrow', async () => {
      const many = Array.from({ length: 450 }, (_, i) => committedNote(`n${i}`));
      fakeRpc.syncNotes.mockResolvedValue({ notes: () => many });
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).resolves.toEqual({
        noteFiles: [],
        failures: 0,
        saturated: true
      });
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
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).resolves.toEqual({
        noteFiles: [],
        failures: 0,
        saturated: true
      });
    });

    it('propagates a too-wide span that cannot be narrowed any further', async () => {
      fakeRpc.syncNotes.mockRejectedValue(new Error('BlockPagination: requested block range is too large'));
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 999)).rejects.toThrow('BlockPagination');
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
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).rejects.toThrow(error.message);
    });

    it('does not split for an unrelated node error', async () => {
      fakeRpc.syncNotes.mockRejectedValue(new Error('internal server error'));
      const { readRecoverablePublicNotes } = await loadReader();

      await expect(readRecoverablePublicNotes('acct', 0, 200_000)).rejects.toThrow('internal server error');
    });
  });

  describe('resolveRecoveryScanRange', () => {
    it('returns the tip after a single header read when the creation time is unknown', async () => {
      // The resume path relies on this: passing 0 must not pay for a search.
      fakeRpc.getBlockHeaderByNumber.mockResolvedValue(blockHeader(500, 1_000_000));
      const { resolveRecoveryScanRange } = await loadReader();

      await expect(resolveRecoveryScanRange(0)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
      expect(fakeRpc.getBlockHeaderByNumber).toHaveBeenCalledTimes(1);
    });

    it('binary-searches for the block just before the account existed', async () => {
      // Timestamp = block number, so the answer is checkable by hand: target is
      // 10_000 - 600 clock-skew margin = 9_400, so lo must land on 9_399.
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) =>
        blockNum === undefined ? blockHeader(20_000, 20_000) : blockHeader(blockNum, blockNum)
      );
      const { resolveRecoveryScanRange } = await loadReader();

      const { startBlock, latestBlock } = await resolveRecoveryScanRange(10_000);
      expect(latestBlock).toBe(20_000);
      expect(startBlock).toBe(9_399);
    });

    // The scan runs once and a clean pass clears the one-shot flag, so every
    // disagreement between the Guardian's clock and the node's has to widen the
    // scan. Starting at the tip would scan one block, find nothing and report
    // success.
    it('scans from genesis when the account claims to be newer than the chain tip', async () => {
      fakeRpc.getBlockHeaderByNumber.mockResolvedValue(blockHeader(500, 1_000));
      const { resolveRecoveryScanRange } = await loadReader();

      await expect(resolveRecoveryScanRange(5_000)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
    });

    it('scans from genesis when the node reports no tip timestamp', async () => {
      fakeRpc.getBlockHeaderByNumber.mockResolvedValue(blockHeader(500, 0));
      const { resolveRecoveryScanRange } = await loadReader();

      await expect(resolveRecoveryScanRange(5_000)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
      expect(fakeRpc.getBlockHeaderByNumber).toHaveBeenCalledTimes(1);
    });

    it('abandons the search when a block reports no timestamp', async () => {
      // The bisection is only sound over increasing timestamps; a zero would
      // push the start block past the account's real creation block.
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) => {
        if (blockNum === undefined) return blockHeader(20_000, 20_000);
        if (blockNum === 0) return blockHeader(0, 1);
        return blockHeader(blockNum, 0);
      });
      const { resolveRecoveryScanRange } = await loadReader();

      await expect(resolveRecoveryScanRange(10_000)).resolves.toEqual({ startBlock: 0, latestBlock: 20_000 });
    });

    it('scans from genesis when the chain is younger than the account timestamp', async () => {
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) =>
        blockNum === undefined ? blockHeader(500, 9_999) : blockHeader(0, 9_000)
      );
      const { resolveRecoveryScanRange } = await loadReader();

      await expect(resolveRecoveryScanRange(5_000)).resolves.toEqual({ startBlock: 0, latestBlock: 500 });
    });

    it('abandons the search on its overall budget', async () => {
      // Each read is bounded, but ~log2(tip) of them is not. Giving up only
      // widens the scan, which is safe.
      const realNow = Date.now;
      let clock = realNow();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      fakeRpc.getBlockHeaderByNumber.mockImplementation(async (blockNum?: number) => {
        clock += 9_000;
        return blockNum === undefined ? blockHeader(10_000_000, 10_000_000) : blockHeader(blockNum, blockNum);
      });
      const { resolveRecoveryScanRange } = await loadReader();

      const { startBlock } = await resolveRecoveryScanRange(5_000_000);
      // Bailed out early, so the start block is older (smaller) than the true
      // creation block — a wider scan, never a narrower one.
      expect(startBlock).toBeLessThan(4_999_400);
      expect(fakeRpc.getBlockHeaderByNumber.mock.calls.length).toBeLessThan(10);
    });
  });
});
