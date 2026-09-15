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
import { request } from 'node:http';

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

const WITHDRAW_OWNER = '0x1111111111111111111111111111111111111111';
const OTHER_OWNER = '0x2222222222222222222222222222222222222222';
const SOURCE_CHAIN_ID = 11155111;
const DELIVERY_CHAIN_ID = 999999999;
const allocationBody = (nonce: string, destinationChainId: number, owner = WITHDRAW_OWNER) => ({
  chainId: String(SOURCE_CHAIN_ID),
  compact: {
    sponsor: owner,
    nonce,
    expires: '2000000000',
    mandate: { destinationChainId: String(destinationChainId) }
  },
  witnessTypeString: 'uint256 destinationChainId',
  isRegisteredOnchain: true,
  sponsorSignature: '0x'
});

function allocatorRequest(
  allocator: FakeEpochAllocator,
  path: string,
  body?: unknown
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${allocator.baseUrl}${path}`,
      { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' } },
      response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(raw);
            resolve({ status: response.statusCode, body: parsed });
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const intentStatus = (allocator: FakeEpochAllocator, owner: string, nonce: string) =>
  allocatorRequest(allocator, `/intentStatus/${owner}/${nonce}`);

describe('FakeEpochAllocator allocation recovery transport', () => {
  let allocator: FakeEpochAllocator;

  beforeEach(async () => {
    allocator = new FakeEpochAllocator(0);
    await allocator.start();
  });

  afterEach(async () => {
    await allocator.stop();
  });

  it('parks the actual relay response after one acceptance without blocking other requests', async () => {
    const gate = allocator.parkRelayResponse();
    let answered = false;
    const pending = allocatorRequest(allocator, '/relay-execute', { execution: 'controlled' }).then(response => {
      answered = true;
      return response;
    });
    try {
      await gate.accepted;
      await expect(allocatorRequest(allocator, '/health')).resolves.toMatchObject({ status: 200 });
      expect(answered).toBe(false);
      expect(allocator.requests.filter(entry => entry.path === '/relay-execute')).toHaveLength(1);
      gate.release();
      await expect(pending).resolves.toMatchObject({ status: 200, body: { success: true } });
    } finally {
      gate.release();
      await pending;
    }
  });

  it('returns distinct quote and final allocation nonces, without reusing an exhausted sequence', async () => {
    allocator.setSuggestedNonces(['101', '102', '11', '103', '22']);
    for (const nonce of ['101', '102', '11', '103', '22']) {
      await expect(
        allocatorRequest(allocator, `/suggested-nonce/${SOURCE_CHAIN_ID}/${WITHDRAW_OWNER}`)
      ).resolves.toEqual({ status: 200, body: { success: true, nonce } });
    }
    await expect(
      allocatorRequest(allocator, `/suggested-nonce/${SOURCE_CHAIN_ID}/${WITHDRAW_OWNER}`)
    ).resolves.toMatchObject({ status: 500, body: { success: false } });
  });

  it('keeps the existing deposit nonce default without a programmed sequence', async () => {
    await expect(allocatorRequest(allocator, `/suggested-nonce/${SOURCE_CHAIN_ID}/${WITHDRAW_OWNER}`)).resolves.toEqual(
      { status: 200, body: { success: true, nonce: '1' } }
    );
  });

  it('keeps rejected and accepted siblings independent, including owners sharing a nonce', async () => {
    allocator.setAllocationOutcome(WITHDRAW_OWNER, '11', 'reject');
    await expect(allocatorRequest(allocator, '/compact', allocationBody('11', SOURCE_CHAIN_ID))).resolves.toMatchObject(
      { status: 503 }
    );
    await expect(
      allocatorRequest(allocator, '/compact', allocationBody('22', DELIVERY_CHAIN_ID))
    ).resolves.toMatchObject({ status: 200, body: { nonce: '22' } });
    await expect(intentStatus(allocator, WITHDRAW_OWNER, '11')).resolves.toEqual({ status: 200, body: [] });
    await expect(intentStatus(allocator, OTHER_OWNER, '22')).resolves.toEqual({ status: 200, body: [] });
    await expect(intentStatus(allocator, WITHDRAW_OWNER.toUpperCase(), '22')).resolves.toEqual({
      status: 200,
      body: [{ status: 'pending', chainId: DELIVERY_CHAIN_ID, transactionHash: '' }]
    });
    allocator.setAllocationOutcome(WITHDRAW_OWNER, '11', 'accept');
    await expect(allocatorRequest(allocator, '/compact', allocationBody('11', SOURCE_CHAIN_ID))).resolves.toMatchObject(
      { status: 200, body: { nonce: '11' } }
    );
    await expect(intentStatus(allocator, WITHDRAW_OWNER, '11')).resolves.toEqual({
      status: 200,
      body: [{ status: 'pending', chainId: SOURCE_CHAIN_ID, transactionHash: '' }]
    });
  });

  it.each(['11', '22'])('retains acceptance when allocation %s loses its response', async nonce => {
    allocator.setAllocationOutcome(WITHDRAW_OWNER, nonce, 'accept-response-loss');
    await expect(
      allocatorRequest(allocator, '/compact', allocationBody(nonce, DELIVERY_CHAIN_ID))
    ).resolves.toMatchObject({ status: 503 });
    await expect(intentStatus(allocator, WITHDRAW_OWNER, nonce)).resolves.toEqual({
      status: 200,
      body: [{ status: 'pending', chainId: DELIVERY_CHAIN_ID, transactionHash: '' }]
    });
  });

  it('programs exact delivery evidence without leaking it to an unaccepted sibling', async () => {
    allocator.setMidenNoteId('0xdelivery-note', { owner: WITHDRAW_OWNER, nonce: '22' });
    await expect(intentStatus(allocator, WITHDRAW_OWNER, '22')).resolves.toEqual({
      status: 200,
      body: [{ status: 'success', chainId: DELIVERY_CHAIN_ID, transactionHash: '', midenNoteId: '0xdelivery-note' }]
    });
    await expect(intentStatus(allocator, WITHDRAW_OWNER, '11')).resolves.toEqual({ status: 200, body: [] });
    allocator.setIntentStatus(WITHDRAW_OWNER, '22', [
      { status: 'failed', chainId: DELIVERY_CHAIN_ID, transactionHash: '' }
    ]);
    await expect(intentStatus(allocator, WITHDRAW_OWNER, '22')).resolves.toMatchObject({
      body: [{ status: 'failed', chainId: DELIVERY_CHAIN_ID }]
    });
  });

  it('accepts an identical replay and rejects altered payload under the same identity', async () => {
    const body = allocationBody('22', DELIVERY_CHAIN_ID);
    await expect(allocatorRequest(allocator, '/compact', body)).resolves.toMatchObject({ status: 200 });
    await expect(allocatorRequest(allocator, '/compact', body)).resolves.toMatchObject({ status: 200 });
    await expect(allocatorRequest(allocator, '/compact', { ...body, sponsorSignature: '0x01' })).resolves.toMatchObject(
      { status: 400, body: { success: false } }
    );
    expect(allocator.requests.filter(entry => entry.path === '/compact').map(entry => entry.body)).toEqual([
      body,
      body,
      { ...body, sponsorSignature: '0x01' }
    ]);
  });
});
