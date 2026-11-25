/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { CALIBUR_ADDRESS, TEST_EXECUTOR, transactionSigner } from './harness';
import { memoryDatabase, type MemoryDatabase } from './sqlite';
import type { BroadcastOutcome, FeeQuote, ReceiptStatus, RelayAuthorization } from '../src/chain';
import {
  FINAL_ROW_TTL_MS,
  REPLACE_AFTER_MS,
  RelaySender,
  TICK_INTERVAL_MS,
  type SubmitJob,
  type SubmitOutcome
} from '../src/sender';

const KEY_A = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const KEY_B = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const USER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ADDRESS_A: Hex = `0x${'0a'.repeat(20)}`;
const ADDRESS_B: Hex = `0x${'0b'.repeat(20)}`;
const ADDRESS_C: Hex = `0x${'0c'.repeat(20)}`;
const START = 1_700_000_000_000;
const T = TICK_INTERVAL_MS;

function idOf(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}

function lower(address: string): Hex {
  return `0x${address.slice(2).toLowerCase()}`;
}

const RELAYER_A = lower(KEY_A.address);
const RELAYER_B = lower(KEY_B.address);

function job(overrides: Partial<SubmitJob> = {}): SubmitJob {
  return {
    id: idOf('01'),
    chainId: 8453,
    evmAddress: ADDRESS_A,
    data: '0xdeadbeef',
    gas: 240_000n,
    maxFeePerGas: 2_100_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    authorization: null,
    deadline: 1_900_000_000,
    chainNonce: 5,
    ...overrides
  };
}

async function signedAuthorization(nonce: number): Promise<RelayAuthorization> {
  const signed = await USER.signAuthorization({ address: CALIBUR_ADDRESS, chainId: 8453, nonce });
  if (typeof signed.yParity !== 'number') throw new Error('The authorization has no yParity');
  return { address: CALIBUR_ADDRESS, chainId: 8453, nonce, r: signed.r, s: signed.s, yParity: signed.yParity };
}

/** A Sender over node:sqlite with a fake chain, a fake alarm, a settable clock and a settable relayer key. */
class World {
  now = START;
  key: PrivateKeyAccount = KEY_A;
  alarm: number | null = null;
  readonly schedules: number[] = [];
  readonly sent: Hex[] = [];
  readonly receiptReads: Hex[][] = [];
  readonly status = new Map<Hex, ReceiptStatus>();
  quote: FeeQuote = { baseFee: 1_000_000_000n, priorityFee: 100_000_000n };
  feeReads = 0;
  receiptError: Error | null = null;
  feeError: Error | null = null;
  sendOutcome: BroadcastOutcome = 'accepted';
  signDelayMs = 0;
  /** The most signatures that ran at one time. */
  maxSigning = 0;
  private signing = 0;
  readonly db: MemoryDatabase = memoryDatabase();
  readonly sender: RelaySender;

  constructor() {
    this.sender = new RelaySender({
      sql: this.db,
      relayer: () => lower(this.key.address),
      sign: async transaction => {
        this.signing += 1;
        this.maxSigning = Math.max(this.maxSigning, this.signing);
        try {
          if (this.signDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.signDelayMs));
          return await this.key.signTransaction(transaction);
        } finally {
          this.signing -= 1;
        }
      },
      broadcast: async (_chainId, raw) => {
        this.sent.push(raw);
        return this.sendOutcome;
      },
      receipts: async (_chainId, hashes) => {
        this.receiptReads.push([...hashes]);
        if (this.receiptError !== null) throw this.receiptError;
        return hashes.map(hash => this.status.get(hash) ?? null);
      },
      fees: async () => {
        this.feeReads += 1;
        if (this.feeError !== null) throw this.feeError;
        return this.quote;
      },
      alarmAt: async () => this.alarm,
      schedule: async atMs => {
        this.alarm = atMs;
        this.schedules.push(atMs);
      },
      now: () => this.now
    });
  }

  /** Run the alarm as the runtime does: it is no longer armed while its handler runs. */
  fire(): Promise<void> {
    this.alarm = null;
    return this.sender.tick();
  }

  async submit(overrides: Partial<SubmitJob> = {}): Promise<Hex> {
    const outcome: SubmitOutcome = await this.sender.submit(job(overrides));
    if (outcome.status !== 'job') throw new Error('The submit was busy');
    return outcome.job.txHash;
  }

  rows(): Record<string, unknown>[] {
    return this.db.run('SELECT * FROM inflight ORDER BY nonce, id');
  }

  meta(key: string): unknown {
    return this.db.run('SELECT value FROM meta WHERE key = ?', key)[0]?.value;
  }

  sentAt(index: number): Hex {
    const raw = this.sent[index];
    if (raw === undefined) throw new Error(`No broadcast ${index}`);
    return raw;
  }
}

const RECEIPTS: [ReceiptStatus, string][] = [
  ['success', 'succeeded'],
  ['reverted', 'reverted']
];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RelaySender alarm', () => {
  it('arms one alarm for the first pending row, again while one remains, and none when none remains', async () => {
    const world = new World();
    await world.fire();
    expect(world.schedules).toEqual([]);

    const first = await world.submit();
    expect(world.schedules).toEqual([START + T]);
    world.now += 1_000;
    const second = await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B });
    expect(world.schedules).toEqual([START + T]);

    world.now = START + T;
    await world.fire();
    expect(world.schedules).toEqual([START + T, START + 2 * T]);

    world.status.set(first, 'success');
    world.status.set(second, 'reverted');
    world.now = START + 2 * T;
    await world.fire();
    expect(world.schedules).toHaveLength(2);
    expect(world.alarm).toBeNull();
  });

  it('arms again on a submit when the armed time is not after now', async () => {
    const world = new World();
    world.alarm = START;
    await world.submit();
    expect(world.schedules).toEqual([START + T]);
  });
});

describe('RelaySender tick', () => {
  it.each(RECEIPTS)('records a %s receipt and drops the signed bytes and the request', async (status, state) => {
    const world = new World();
    const hash = await world.submit();
    world.status.set(hash, status);
    world.now += 5_000;
    await world.fire();
    expect(world.rows()[0]).toMatchObject({
      state,
      tx_hash: hash,
      raw_tx: null,
      request: null,
      attempts: 1,
      updated_at: START + 5_000
    });
    expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state, txHash: hash });
    expect(world.receiptReads).toEqual([[hash]]);
    expect(world.sent).toHaveLength(1);
    expect(world.alarm).toBeNull();
  });

  it('sends the same bytes again without a receipt, and changes neither the row nor the nonce', async () => {
    const world = new World();
    await world.submit();
    const before = world.rows();
    world.now += 60_000;
    await world.fire();
    expect(world.sent).toEqual([before[0]?.raw_tx, before[0]?.raw_tx]);
    expect(world.rows()).toEqual(before);
    expect(world.meta('next_nonce')).toBe('6');
    expect(world.feeReads).toBe(0);
    expect(world.alarm).toBe(START + 60_000 + T);
  });

  it.each([
    ['the old fees plus 15 %', { baseFee: 1_000_000_000n, priorityFee: 100_000_000n }, 2_415_000_000n, 115_000_000n],
    ['the node fees', { baseFee: 3_000_000_000n, priorityFee: 500_000_000n }, 6_500_000_000n, 500_000_000n]
  ])('replaces the fee after the threshold with %s at the same nonce', async (_name, quote, maxFee, priority) => {
    const world = new World();
    world.quote = quote;
    const authorization = await signedAuthorization(3);
    const old = await world.submit({ authorization });
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();

    const raw = world.sentAt(1);
    const transaction = parseTransaction(raw);
    expect(transaction).toMatchObject({
      type: 'eip7702',
      chainId: 8453,
      nonce: 5,
      to: ADDRESS_A,
      data: '0xdeadbeef',
      gas: 240_000n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority
    });
    expect(maxFee * 100n >= 2_100_000_000n * 115n && maxFee >= 2n * quote.baseFee + quote.priorityFee).toBe(true);
    expect(priority * 100n >= 100_000_000n * 115n && priority >= quote.priorityFee).toBe(true);
    expect(transaction.authorizationList).toEqual([{ ...authorization, v: BigInt(authorization.yParity) + 27n }]);
    await expect(transactionSigner(raw)).resolves.toBe(TEST_EXECUTOR);
    expect(world.rows()[0]).toMatchObject({
      state: 'pending',
      nonce: 5,
      tx_hash: keccak256(raw),
      sent_hashes: JSON.stringify([old, keccak256(raw)]),
      raw_tx: raw,
      max_fee: maxFee.toString(),
      max_priority_fee: priority.toString(),
      attempts: 2,
      signed_at: START + REPLACE_AFTER_MS
    });
    expect(world.meta('next_nonce')).toBe('6');
    expect(world.feeReads).toBe(1);
    expect(jest.mocked(console.warn).mock.calls).toEqual([
      ['evm-relay: replaced the fee of nonce 5 on chain 8453, attempt 2.']
    ]);

    // The threshold counts from the new signature: the next tick sends the new bytes again.
    world.now += T;
    await world.fire();
    expect(world.sentAt(2)).toBe(raw);
    expect(world.rows()[0]?.attempts).toBe(2);
  });

  it('completes the row with the old hash when the old transaction is mined after a replacement', async () => {
    const world = new World();
    const old = await world.submit();
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    const replacement = keccak256(world.sentAt(1));
    world.status.set(old, 'success');
    world.now += T;
    await world.fire();
    expect(world.receiptReads[1]).toEqual([old, replacement]);
    expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state: 'succeeded', txHash: old });
  });

  it('does not replace the fee after the deadline and keeps sending the same bytes', async () => {
    const world = new World();
    await world.submit({ deadline: START / 1000 + 120 });
    const raw = world.sentAt(0);
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    world.now += 10 * REPLACE_AFTER_MS;
    await world.fire();
    expect(world.sent).toEqual([raw, raw, raw]);
    expect(world.feeReads).toBe(0);
    expect(world.rows()[0]?.attempts).toBe(1);
  });

  it('does not replace the fee when the node says a mined transaction holds the nonce', async () => {
    const world = new World();
    world.sendOutcome = 'nonce_used';
    const hash = await world.submit();
    expect(world.rows()[0]?.nonce_used).toBe(1);
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    expect(world.feeReads).toBe(0);
    expect(world.sent).toEqual([world.sentAt(0), world.sentAt(0)]);
    world.status.set(hash, 'success');
    await world.fire();
    expect(world.sender.get(idOf('01'))?.state).toBe('succeeded');
  });

  it('sends the old bytes again when the fee read fails', async () => {
    const world = new World();
    world.feeError = new Error('fees down');
    await world.submit();
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    expect(world.sent).toEqual([world.sentAt(0), world.sentAt(0)]);
    expect(world.rows()[0]?.attempts).toBe(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps every row and arms the next alarm when the receipt read fails', async () => {
    const world = new World();
    await world.submit();
    const before = world.rows();
    world.receiptError = new Error('connect failed: https://rpc.example/secret-key');
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    expect(world.rows()).toEqual(before);
    expect(world.sent).toHaveLength(1);
    expect(world.alarm).toBe(world.now + T);
    expect(jest.mocked(console.error).mock.calls).toEqual([['evm-relay: a Sender tick failed on chain 8453.']]);
  });

  it('keeps the nonce rule when a tick and a submit overlap', async () => {
    const world = new World();
    world.signDelayMs = 20;
    await world.submit();
    world.now = START + REPLACE_AFTER_MS;
    const [, outcome] = await Promise.all([
      world.fire(),
      world.sender.submit(job({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce: 5 }))
    ]);
    expect(outcome.status).toBe('job');
    expect(world.rows().map(row => [row.id, row.nonce, row.attempts])).toEqual([
      [idOf('01'), 5, 2],
      [idOf('02'), 6, 1]
    ]);
    expect(world.meta('next_nonce')).toBe('7');
    expect(world.maxSigning).toBe(1);
  });

  it('frees the address for a new relay once its row is final', async () => {
    const world = new World();
    const hash = await world.submit();
    await expect(world.sender.submit(job({ id: idOf('02') }))).resolves.toEqual({ status: 'busy', id: idOf('01') });
    world.status.set(hash, 'reverted');
    await world.fire();
    const outcome = await world.sender.submit(job({ id: idOf('02') }));
    expect(outcome.status === 'job' && outcome.job.state).toBe('pending');
    expect(world.rows().map(row => [row.id, row.nonce, row.state])).toEqual([
      [idOf('01'), 5, 'reverted'],
      [idOf('02'), 6, 'pending']
    ]);
  });
});

describe('RelaySender cleanup', () => {
  it('deletes a final row 24 hours after its last change, at a tick or a submit, and never a pending row', async () => {
    const world = new World();
    const hash = await world.submit();
    world.status.set(hash, 'success');
    world.now += 1_000;
    await world.fire();
    await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B });

    world.now = START + 1_000 + FINAL_ROW_TTL_MS;
    await world.fire();
    expect(world.rows().map(row => row.id)).toEqual([idOf('01'), idOf('02')]);

    world.now += 1;
    await world.fire();
    expect(world.rows().map(row => row.id)).toEqual([idOf('02')]);
  });

  it('deletes an old final row at the start of a submit', async () => {
    const world = new World();
    const hash = await world.submit();
    world.status.set(hash, 'success');
    await world.fire();
    world.now += FINAL_ROW_TTL_MS + 1;
    await world.submit({ id: idOf('03'), evmAddress: ADDRESS_C });
    expect(world.rows().map(row => row.id)).toEqual([idOf('03')]);
  });
});

describe('RelaySender relayer key change', () => {
  it("resets the nonce counter to the new account's chain nonce", async () => {
    const world = new World();
    await world.submit();
    await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B });
    expect(world.meta('relayer')).toBe(RELAYER_A);
    world.key = KEY_B;
    await world.submit({ id: idOf('03'), evmAddress: ADDRESS_C, chainNonce: 2 });
    expect(world.rows().map(row => [row.id, row.relayer, row.nonce])).toEqual([
      [idOf('03'), RELAYER_B, 2],
      [idOf('01'), RELAYER_A, 5],
      [idOf('02'), RELAYER_A, 6]
    ]);
    expect(world.meta('next_nonce')).toBe('3');
    expect(world.meta('relayer')).toBe(RELAYER_B);
    await expect(transactionSigner(world.sentAt(2))).resolves.toBe(RELAYER_B);
  });

  it('keeps old and new pending rows of one nonce, replaces only the new one and follows the old to its receipt', async () => {
    const world = new World();
    const old = await world.submit();
    world.key = KEY_B;
    await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce: 5 });
    expect(world.rows().map(row => [row.id, row.relayer, row.nonce, row.state])).toEqual([
      [idOf('01'), RELAYER_A, 5, 'pending'],
      [idOf('02'), RELAYER_B, 5, 'pending']
    ]);

    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    expect(world.rows().map(row => [row.id, row.attempts])).toEqual([
      [idOf('01'), 1],
      [idOf('02'), 2]
    ]);
    // The old row's bytes go out again unchanged.
    expect(world.sent).toContain(world.sentAt(0));
    expect(world.sent.filter(raw => raw === world.sentAt(0))).toHaveLength(2);

    world.status.set(old, 'success');
    world.now += T;
    await world.fire();
    expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state: 'succeeded', txHash: old });
  });
});
