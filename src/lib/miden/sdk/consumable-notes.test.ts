/* eslint-disable import/first */
/**
 * Field-parity tests for the slice-4 consumable-note reducer
 * (`sdk/consumable-notes.ts`).
 *
 * This reducer is the single point where a live `InputNoteRecord` is reduced to
 * the plain `ConsumableNoteDto` that every former reach-through caller now
 * consumes. The move is behavior-affecting (live record → DTO), so these tests
 * pin down that the DTO carries EVERY field each of the four callers used:
 *   - sync-manager:   id, first-asset faucetId+amount, sender, noteType(string), swapOrder
 *   - dApp handler:   noteId, nullifier, noteType(enum), senderAccountId, state, ALL assets
 *   - swap settle:    id, noteType(string), swapAttachment
 *   - claimable-notes: id, first-asset faucetId+amount, sender, noteType(string), swapOrder
 *
 * A dropped field here is a funds-visibility regression (#331 class), hence the
 * exhaustive assertions.
 *
 * `getBech32AddressFromAccountId` is stubbed to a recognizable `bech32(<id>)`
 * transform so the tests can prove the bech32 encoding was applied to BOTH the
 * sender and every asset faucet id (the two account-id fields the DTO carries).
 */

// eslint-disable-next-line jest/no-export
export {};

jest.mock('./helpers', () => ({
  getBech32AddressFromAccountId: (accountId: unknown) => `bech32(${String(accountId)})`
}));

import { attachmentOrderAndDepth, reduceConsumableNoteRecord, reduceConsumableNoteRecords } from './consumable-notes';

// -------------------- live-record mock builder --------------------

type FakeAsset = { faucetId: string; amount: bigint };
type FakeAttachmentWord = [bigint, bigint, bigint, bigint];

function fakeRecord(
  opts: {
    id?: string | null;
    nullifier?: string | null;
    // undefined metadata models a partial (metadata-less) note.
    metadata?: { sender: string; noteType: number } | null;
    state?: number;
    assets?: FakeAsset[];
    attachments?: FakeAttachmentWord[][]; // outer = attachments, inner = words
  } = {}
): any {
  const {
    id = 'note-1',
    nullifier = '0xnullifier',
    metadata = { sender: 'senderAcct', noteType: 1 },
    state = 2,
    assets = [{ faucetId: 'faucetAcct', amount: 100n }],
    attachments
  } = opts;

  return {
    id: () => (id == null ? undefined : { toString: () => id }),
    nullifier: () => (nullifier == null ? undefined : nullifier),
    metadata: () =>
      metadata == null
        ? undefined
        : {
            sender: () => metadata.sender,
            noteType: () => metadata.noteType
          },
    state: () => state,
    details: () => ({
      assets: () => ({
        fungibleAssets: () =>
          assets.map(a => ({
            faucetId: () => a.faucetId,
            amount: () => ({ toString: () => a.amount.toString() })
          }))
      })
    }),
    attachments: () =>
      (attachments ?? []).map(words => ({
        toWords: () => words.map(w => ({ toU64s: () => BigUint64Array.from(w) }))
      }))
  };
}

// -------------------- attachmentOrderAndDepth --------------------

describe('attachmentOrderAndDepth', () => {
  it('extracts {orderId, depth} from a PSWAP payback word ([_, orderId, depth, 0])', () => {
    const rec = fakeRecord({ attachments: [[[999n, 77n, 3n, 0n]]] });
    expect(attachmentOrderAndDepth(rec)).toEqual({ orderId: '77', depth: 3 });
  });

  it('returns null when the note has no attachments', () => {
    expect(attachmentOrderAndDepth(fakeRecord({ attachments: [] }))).toBeNull();
  });

  it('returns null when no word carries the terminal-0 discriminator', () => {
    const rec = fakeRecord({ attachments: [[[1n, 2n, 3n, 4n]]] });
    expect(attachmentOrderAndDepth(rec)).toBeNull();
  });

  it('scans across multiple attachments/words and returns the first match', () => {
    const rec = fakeRecord({
      attachments: [
        [[1n, 2n, 3n, 4n]],
        [
          [5n, 6n, 7n, 8n],
          [0n, 42n, 9n, 0n]
        ]
      ]
    });
    expect(attachmentOrderAndDepth(rec)).toEqual({ orderId: '42', depth: 9 });
  });

  it('tolerates a note whose attachments() throws (returns null, does not propagate)', () => {
    const rec: any = {
      attachments: () => {
        throw new Error('boom');
      }
    };
    expect(attachmentOrderAndDepth(rec)).toBeNull();
  });

  it('tolerates a note with no attachments() method (optional-chained)', () => {
    expect(attachmentOrderAndDepth({} as any)).toBeNull();
  });
});

// -------------------- reduceConsumableNoteRecord --------------------

describe('reduceConsumableNoteRecord — full field parity', () => {
  it('carries every field each caller reads (id, nullifier, noteType enum, sender bech32, state, ALL assets, swapAttachment)', () => {
    const rec = fakeRecord({
      id: '0xnote',
      nullifier: '0xnull',
      metadata: { sender: 'senderAcct', noteType: 1 },
      state: 6,
      assets: [
        { faucetId: 'faucetA', amount: 100n },
        { faucetId: 'faucetB', amount: 250n }
      ],
      attachments: [[[0n, 77n, 2n, 0n]]]
    });

    expect(reduceConsumableNoteRecord(rec)).toEqual({
      noteId: '0xnote',
      nullifier: '0xnull',
      // NUMERIC NoteType enum preserved for the dApp handler.
      noteType: 1,
      // sender bech32-encoded (proves getBech32AddressFromAccountId ran on sender()).
      senderAccountId: 'bech32(senderAcct)',
      // NUMERIC InputNoteState enum preserved.
      state: 6,
      // ALL fungible assets, each faucet id bech32-encoded, amount stringified.
      assets: [
        { amount: '100', faucetId: 'bech32(faucetA)' },
        { amount: '250', faucetId: 'bech32(faucetB)' }
      ],
      swapAttachment: { orderId: '77', depth: 2 }
    });
  });

  it('a partial (metadata-less) note → noteId present, nullifier null, noteType/sender undefined', () => {
    // Models the 0.15 partial: id present but metadata absent, so nullifier folds
    // out to undefined. Callers apply their own skip; the reducer does NOT drop it.
    const rec = fakeRecord({ id: '0xpartial', nullifier: null, metadata: null, state: 0 });
    expect(reduceConsumableNoteRecord(rec)).toEqual({
      noteId: '0xpartial',
      nullifier: null,
      noteType: undefined,
      senderAccountId: undefined,
      state: 0,
      assets: [{ amount: '100', faucetId: 'bech32(faucetAcct)' }],
      swapAttachment: null
    });
  });

  it('a note with no metadata-bearing id → noteId null (caller skips)', () => {
    const rec = fakeRecord({ id: null });
    expect(reduceConsumableNoteRecord(rec)?.noteId).toBeNull();
  });

  it('a note with no fungible assets → empty assets array (caller skips)', () => {
    const rec = fakeRecord({ assets: [] });
    expect(reduceConsumableNoteRecord(rec)?.assets).toEqual([]);
  });

  it('a note with no swap attachment → swapAttachment null', () => {
    expect(reduceConsumableNoteRecord(fakeRecord({ attachments: [] }))?.swapAttachment).toBeNull();
  });

  it('returns null (skips) when a record throws mid-reduction — batch survives', () => {
    const throwing: any = {
      id: () => ({ toString: () => 'x' }),
      nullifier: () => '0xn',
      metadata: () => ({ sender: () => 's', noteType: () => 1 }),
      state: () => 2,
      details: () => {
        throw new Error('details() exploded');
      },
      attachments: () => []
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(reduceConsumableNoteRecord(throwing)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping un-reducible note'), expect.any(Error));
    warn.mockRestore();
  });
});

describe('reduceConsumableNoteRecords — batch', () => {
  it('reduces every record and drops only the un-reducible ones', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const good = fakeRecord({ id: 'good' });
    const bad: any = {
      id: () => ({ toString: () => 'bad' }),
      nullifier: () => '0xn',
      metadata: () => ({ sender: () => 's', noteType: () => 1 }),
      state: () => 2,
      details: () => {
        throw new Error('boom');
      },
      attachments: () => []
    };
    const result = reduceConsumableNoteRecords([good, bad, fakeRecord({ id: 'good2' })]);
    expect(result.map(d => d.noteId)).toEqual(['good', 'good2']);
    warn.mockRestore();
  });
});
