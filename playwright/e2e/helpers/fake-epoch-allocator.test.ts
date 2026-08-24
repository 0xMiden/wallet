/**
 * Unit cover for the fake allocator's smallocator PR #38 binding check.
 *
 * This validator has now been broken twice in ways the e2e could not surface
 * cheaply: first by importing `@epoch-protocol/epoch-intents-sdk`, whose
 * compiled ESM plain Node cannot load, and then by letting
 * `getSimpleWitnessHash` throw straight out to the request handler. Both turned
 * a *binding verdict* into a 500 that reads as harness breakage. These tests run
 * in Jest (harness `*.test.ts` files are let through `testPathIgnorePatterns`),
 * so the validator keeps working without paying for a chain-backed e2e run.
 */
import type { Mandate } from '@epoch-protocol/epoch-commons-sdk';
import { getSimpleWitnessHash } from '@epoch-protocol/epoch-commons-sdk';

import { FakeEpochAllocator } from './fake-epoch-allocator';

/** Same fixed widths the SDK packs a 32-byte binding hash into (7+7+7+7+4). */
const BINDING_FELT_BYTE_WIDTHS = [7, 7, 7, 7, 4];

// A witness typestring is a bare comma-separated field list (the repo calls it
// `extraDataTypestring`), NOT wrapped in `Mandate(...)` — the SDK splits on commas
// and reads the last token of each field as the name.
const WITNESS_TYPE_STRING = 'address recipient,uint256 amount';
const MANDATE = { recipient: '0x1111111111111111111111111111111111111111', amount: '1', midenNoteId: '0xnote' };

/** Pack a 0x hash into the felts a correctly-bound note would carry. */
function encodeHashToFelts(hash: string): string[] {
  const hex = hash.slice(2);
  const felts: string[] = [];
  let offset = 0;
  for (const width of BINDING_FELT_BYTE_WIDTHS) {
    felts.push(BigInt(`0x${hex.slice(offset, offset + width * 2)}`).toString());
    offset += width * 2;
  }
  return felts;
}

function boundFelts(): string[] {
  // `midenNoteId` is neutralized on both sides — the note id derives from the
  // attachment, so it cannot be committed to by it. The cast is safe here: the
  // hash reads ONLY the fields the witness typestring names, so a full trading
  // `Mandate` would add noise without changing the result.
  const mandate = { ...MANDATE, midenNoteId: '' } as unknown as Mandate;
  return encodeHashToFelts(getSimpleWitnessHash(mandate, WITNESS_TYPE_STRING));
}

/** Reach the private validator the request handler calls. */
function validate(alloc: FakeEpochAllocator, body: unknown): Promise<string | null> {
  return (alloc as unknown as { validateCompact: (b: unknown) => Promise<string | null> }).validateCompact(body);
}

const compactBody = (overrides: Record<string, unknown> = {}) => ({
  compact: { mandate: { ...MANDATE, ...overrides } },
  witnessTypeString: WITNESS_TYPE_STRING
});

describe('FakeEpochAllocator binding validation', () => {
  it('accepts a note whose attachment commits to the mandate', async () => {
    const alloc = new FakeEpochAllocator();
    const felts = boundFelts();
    alloc.setNoteInspector(async () => felts);

    await expect(validate(alloc, compactBody())).resolves.toBeNull();
  });

  it('rejects a note bound to a different mandate', async () => {
    const alloc = new FakeEpochAllocator();
    const felts = boundFelts();
    // Flip the first felt — the note now commits to a different hash.
    alloc.setNoteInspector(async () => [(BigInt(felts[0]!) ^ 1n).toString(), ...felts.slice(1)]);

    await expect(validate(alloc, compactBody())).resolves.toContain('not bound to the intent mandate');
  });

  it('rejects a note with no attachment at all', async () => {
    const alloc = new FakeEpochAllocator();
    alloc.setNoteInspector(async () => []);

    await expect(validate(alloc, compactBody())).resolves.toContain('not bound to the intent mandate');
  });

  it('rejects when the collateral note cannot be found', async () => {
    const alloc = new FakeEpochAllocator();
    alloc.setNoteInspector(async () => null);

    await expect(validate(alloc, compactBody())).resolves.toContain('not found on-chain');
  });

  it('reports a malformed mandate as a rejection rather than crashing', async () => {
    const alloc = new FakeEpochAllocator();
    alloc.setNoteInspector(async () => boundFelts());

    // `amount` is named by the witnessTypeString but absent from the mandate:
    // `getSimpleWitnessHash` throws, and that must not escape as a 500.
    const body = {
      compact: { mandate: { recipient: MANDATE.recipient, midenNoteId: '0xnote' } },
      witnessTypeString: WITNESS_TYPE_STRING
    };
    await expect(validate(alloc, body)).resolves.toContain('does not satisfy witnessTypeString');
  });

  it('stays a no-op when no inspector is wired (the pre-#38 blind ack)', async () => {
    const alloc = new FakeEpochAllocator();

    await expect(validate(alloc, compactBody())).resolves.toBeNull();
  });

  it('ignores intents that carry no Miden collateral', async () => {
    const alloc = new FakeEpochAllocator();
    alloc.setNoteInspector(async () => boundFelts());

    const body = { compact: { mandate: { recipient: MANDATE.recipient } }, witnessTypeString: WITNESS_TYPE_STRING };
    await expect(validate(alloc, body)).resolves.toBeNull();
  });
});
