/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { decodeFunctionData, keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { CALIBUR_ADDRESS, TEST_EXECUTOR, transactionSigner } from './harness';
import { memoryDatabase, type MemoryDatabase } from './sqlite';
import {
  CALIBUR_ABI,
  batchNonceOf,
  encodeExecution,
  type BatchCall,
  type BatchEnvelope
} from '../../../src/lib/evm-relay/batch';
import type { BroadcastOutcome, FeeQuote, ReceiptStatus, RelayAuthorization } from '../src/chain';
import {
  CANCEL_AFTER_DEADLINE_MS,
  CANCEL_GAS,
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
  sendError: Error | null = null;
  signError: Error | null = null;
  /** The stored `raw_tx` of every row at the start of each broadcast. */
  readonly storedAtSend: unknown[][] = [];
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
          if (this.signError !== null) throw this.signError;
          return await this.key.signTransaction(transaction);
        } finally {
          this.signing -= 1;
        }
      },
      broadcast: async (_chainId, raw) => {
        this.sent.push(raw);
        this.storedAtSend.push(this.rows().map(row => row.raw_tx));
        if (this.sendError !== null) throw this.sendError;
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

  it('signs a multi-call batch again with the same execute calldata and the calls in the same order', async () => {
    const calls: BatchCall[] = [
      { to: `0x${'2a'.repeat(20)}`, value: 0n, data: '0x095ea7b3' },
      { to: `0x${'3b'.repeat(20)}`, value: 7n, data: '0x' },
      { to: `0x${'4c'.repeat(20)}`, value: 0n, data: '0xcafe0001deadbeef' }
    ];
    const envelope: BatchEnvelope = {
      chainId: 8453,
      evmAddress: ADDRESS_A,
      executor: RELAYER_A,
      batchNonce: batchNonceOf(3n),
      salt: `0x${'00'.repeat(12)}${CALIBUR_ADDRESS.slice(2)}`,
      deadline: 1_900_000_000n
    };
    const data = encodeExecution(envelope, calls, `0x${'11'.repeat(65)}`);
    const world = new World();
    await world.submit({ data });
    expect(JSON.parse(String(world.rows()[0]?.request))).toEqual({
      to: ADDRESS_A,
      data,
      gas: '240000',
      authorization: null
    });
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();

    const first = parseTransaction(world.sentAt(0));
    const replacement = parseTransaction(world.sentAt(1));
    expect(replacement.nonce).toBe(first.nonce);
    expect(replacement.data).toBe(data);
    expect(first.data).toBe(data);
    const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data });
    if (decoded.functionName !== 'execute') throw new Error('The calldata is not execute');
    expect(decoded.args[0].batchedCall.calls.map(call => [call.to.toLowerCase(), call.value, call.data])).toEqual(
      calls.map(call => [call.to, call.value, call.data])
    );
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

  it('does not replace the fee after the deadline and sends the same bytes until 60 seconds after it', async () => {
    const world = new World();
    await world.submit({ deadline: START / 1000 + 120 });
    const raw = world.sentAt(0);
    world.now = START + 120_000;
    await world.fire();
    // REPLACE_AFTER_MS after the signature is exactly CANCEL_AFTER_DEADLINE_MS after the deadline: not more.
    world.now = START + 120_000 + CANCEL_AFTER_DEADLINE_MS;
    expect(world.now).toBe(START + REPLACE_AFTER_MS);
    await world.fire();
    expect(world.sent).toEqual([raw, raw, raw]);
    expect(world.feeReads).toBe(0);
    expect(world.rows()[0]).toMatchObject({ attempts: 1, cancel_hashes: '[]', state: 'pending' });
  });

  it('bumps a fee of 0 to 1, so a node takes the replacement', async () => {
    const world = new World();
    world.quote = { baseFee: 0n, priorityFee: 0n };
    await world.submit({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n });
    world.now = START + REPLACE_AFTER_MS;
    await world.fire();
    expect(parseTransaction(world.sentAt(1))).toMatchObject({ nonce: 5, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
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

describe('RelaySender cancel after the deadline', () => {
  /** The batch deadline of these tests, 120 seconds after START, in unix seconds. */
  const DEADLINE = START / 1000 + 120;
  /** The first time at which a cancel is due: more than CANCEL_AFTER_DEADLINE_MS after the deadline. */
  const CANCEL_AT = DEADLINE * 1000 + CANCEL_AFTER_DEADLINE_MS + 1;

  /** A world with one pending row of ADDRESS_A at nonce 5 whose deadline is DEADLINE. Returns its first hash. */
  async function expiring(world: World): Promise<Hex> {
    return world.submit({ deadline: DEADLINE });
  }

  /** Check that the bytes are a cancel: 0 from the relayer to itself, with no data, at nonce 5. */
  async function expectCancel(raw: Hex, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<void> {
    const transaction = parseTransaction(raw);
    expect(transaction).toMatchObject({
      type: 'eip1559',
      chainId: 8453,
      nonce: 5,
      to: RELAYER_A,
      gas: CANCEL_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas
    });
    expect(transaction.value ?? 0n).toBe(0n);
    expect(transaction.data).toBeUndefined();
    expect(transaction.authorizationList).toBeUndefined();
    await expect(transactionSigner(raw)).resolves.toBe(RELAYER_A);
  }

  it('signs a cancel more than 60 seconds after the deadline and stores it before the broadcast', async () => {
    const world = new World();
    const old = await expiring(world);
    world.now = CANCEL_AT;
    await world.fire();

    const cancel = world.sentAt(1);
    const hash = keccak256(cancel);
    // The node fees are below the old fees, so the cancel takes the old fees plus 15 %.
    await expectCancel(cancel, 2_415_000_000n, 115_000_000n);
    expect(world.storedAtSend[1]).toEqual([cancel]);
    expect(world.rows()[0]).toMatchObject({
      state: 'pending',
      nonce: 5,
      tx_hash: hash,
      sent_hashes: JSON.stringify([old, hash]),
      cancel_hashes: JSON.stringify([hash]),
      raw_tx: cancel,
      max_fee: '2415000000',
      max_priority_fee: '115000000',
      attempts: 2,
      signed_at: CANCEL_AT
    });
    expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state: 'pending', txHash: hash });
    expect(world.meta('next_nonce')).toBe('6');
    expect(world.feeReads).toBe(1);
    expect(jest.mocked(console.warn).mock.calls).toEqual([
      ['evm-relay: cancelled nonce 5 on chain 8453 after its deadline, attempt 1.']
    ]);
    expect(world.alarm).toBe(CANCEL_AT + T);
  });

  it('takes the node fees for the cancel when they are higher', async () => {
    const world = new World();
    world.quote = { baseFee: 3_000_000_000n, priorityFee: 500_000_000n };
    await expiring(world);
    world.now = CANCEL_AT;
    await world.fire();
    await expectCancel(world.sentAt(1), 6_500_000_000n, 500_000_000n);
    expect(world.rows()[0]).toMatchObject({ max_fee: '6500000000', max_priority_fee: '500000000' });
  });

  it('keeps the stored cancel when its broadcast fails, and sends it again at the next tick', async () => {
    const world = new World();
    await expiring(world);
    world.sendError = new Error('connect failed: https://rpc.example/secret-key');
    world.now = CANCEL_AT;
    await world.fire();
    const cancel = world.sentAt(1);
    expect(world.rows()[0]).toMatchObject({ state: 'pending', raw_tx: cancel, attempts: 2 });

    world.sendError = null;
    world.now += T;
    await world.fire();
    expect(world.sentAt(2)).toBe(cancel);
    expect(world.rows()[0]).toMatchObject({ state: 'pending', raw_tx: cancel, attempts: 2 });
    expect(world.feeReads).toBe(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('bumps the cancel fee after the replacement interval and never signs the batch again', async () => {
    const world = new World();
    const old = await expiring(world);
    world.now = CANCEL_AT;
    await world.fire();
    const first = world.sentAt(1);

    // Before the interval, the same cancel bytes go out again.
    world.now = CANCEL_AT + REPLACE_AFTER_MS - 1;
    await world.fire();
    expect(world.sentAt(2)).toBe(first);
    expect(world.feeReads).toBe(1);

    world.now = CANCEL_AT + REPLACE_AFTER_MS;
    await world.fire();
    const second = world.sentAt(3);
    await expectCancel(second, 2_777_250_000n, 132_250_000n);
    expect(world.storedAtSend[3]).toEqual([second]);
    expect(world.rows()[0]).toMatchObject({
      tx_hash: keccak256(second),
      sent_hashes: JSON.stringify([old, keccak256(first), keccak256(second)]),
      cancel_hashes: JSON.stringify([keccak256(first), keccak256(second)]),
      attempts: 3
    });
    expect(jest.mocked(console.warn).mock.calls.at(-1)).toEqual([
      'evm-relay: cancelled nonce 5 on chain 8453 after its deadline, attempt 2.'
    ]);
    // Every signature after the first is a cancel.
    for (const raw of world.sent.slice(1)) expect(parseTransaction(raw).to).toBe(RELAYER_A);
  });

  it('sends the stored bytes again when the fee read fails, and cancels at a later tick', async () => {
    const world = new World();
    await expiring(world);
    world.feeError = new Error('fees down');
    world.now = CANCEL_AT;
    await world.fire();
    expect(world.sent).toEqual([world.sentAt(0), world.sentAt(0)]);
    expect(world.rows()[0]?.cancel_hashes).toBe('[]');

    world.feeError = null;
    world.now += T;
    await world.fire();
    await expectCancel(world.sentAt(2), 2_415_000_000n, 115_000_000n);
  });

  it('keeps the old bytes when the cancel signature fails', async () => {
    const world = new World();
    await expiring(world);
    world.signError = new Error('signer down');
    world.now = CANCEL_AT;
    await world.fire();
    expect(world.sent).toEqual([world.sentAt(0), world.sentAt(0)]);
    expect(world.rows()[0]).toMatchObject({ attempts: 1, cancel_hashes: '[]', state: 'pending' });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('does not cancel when the node says a mined transaction holds the nonce', async () => {
    const world = new World();
    world.sendOutcome = 'nonce_used';
    await expiring(world);
    world.now = CANCEL_AT;
    await world.fire();
    expect(world.feeReads).toBe(0);
    expect(world.rows()[0]).toMatchObject({ attempts: 1, cancel_hashes: '[]' });
  });

  it.each(RECEIPTS)(
    'finishes the row as %s when the batch is mined after the cancel was sent',
    async (status, state) => {
      const world = new World();
      const old = await expiring(world);
      world.now = CANCEL_AT;
      await world.fire();
      const cancel = keccak256(world.sentAt(1));
      world.status.set(old, status);
      world.now += T;
      await world.fire();
      expect(world.receiptReads.at(-1)).toEqual([old, cancel]);
      expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state, txHash: old });
      expect(world.rows()[0]).toMatchObject({ raw_tx: null, request: null });
    }
  );

  it.each<ReceiptStatus>(['success', 'reverted'])(
    'finishes the row as expired with the cancel hash when the cancel is mined with status %s',
    async status => {
      const world = new World();
      const old = await expiring(world);
      world.now = CANCEL_AT;
      await world.fire();
      const cancel = keccak256(world.sentAt(1));
      world.status.set(cancel, status);
      world.now += T;
      await world.fire();
      expect(world.receiptReads.at(-1)).toEqual([old, cancel]);
      expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state: 'expired', txHash: cancel });
      expect(world.rows()[0]).toMatchObject({
        state: 'expired',
        tx_hash: cancel,
        raw_tx: null,
        request: null,
        updated_at: CANCEL_AT + T
      });
      expect(world.alarm).toBeNull();
    }
  );

  it('frees the address at once after expired, and deletes the row 24 hours later', async () => {
    const world = new World();
    await expiring(world);
    await expect(world.sender.submit(job({ id: idOf('02') }))).resolves.toEqual({ status: 'busy', id: idOf('01') });
    world.now = CANCEL_AT;
    await world.fire();
    world.status.set(keccak256(world.sentAt(1)), 'success');
    world.now += T;
    await world.fire();

    const outcome = await world.sender.submit(job({ id: idOf('02') }));
    expect(outcome.status === 'job' && outcome.job.state).toBe('pending');
    expect(world.rows().map(row => [row.id, row.state])).toEqual([
      [idOf('01'), 'expired'],
      [idOf('02'), 'pending']
    ]);

    world.now = CANCEL_AT + T + FINAL_ROW_TTL_MS + 1;
    await world.fire();
    expect(world.rows().map(row => row.id)).toEqual([idOf('02')]);
    expect(world.sender.get(idOf('01'))).toBeNull();
  });

  it.each([
    ['the chain pending count after the cancel', 6],
    ['an older chain pending count', 5]
  ])('gives a later relay the next nonce after the cancel is mined, with %s', async (_name, chainNonce) => {
    const world = new World();
    await expiring(world);
    world.now = CANCEL_AT;
    await world.fire();
    world.status.set(keccak256(world.sentAt(1)), 'success');
    world.now += T;
    await world.fire();
    expect(world.meta('next_nonce')).toBe('6');

    await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce, deadline: 1_900_000_000 });
    expect(world.rows().map(row => [row.id, row.nonce, row.state])).toEqual([
      [idOf('01'), 5, 'expired'],
      [idOf('02'), 6, 'pending']
    ]);
    expect(parseTransaction(world.sentAt(world.sent.length - 1)).nonce).toBe(6);
    expect(world.meta('next_nonce')).toBe('7');
  });

  it('does not cancel a row of an old relayer key, and cancels a row of the new key', async () => {
    const world = new World();
    const old = await expiring(world);
    world.key = KEY_B;
    await world.submit({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce: 5, deadline: DEADLINE });
    world.now = CANCEL_AT;
    await world.fire();
    expect(
      world.rows().map(row => [row.id, row.relayer, row.attempts, JSON.parse(String(row.cancel_hashes)).length])
    ).toEqual([
      [idOf('01'), RELAYER_A, 1, 0],
      [idOf('02'), RELAYER_B, 2, 1]
    ]);
    // The old row's bytes go out again unchanged, and it is followed to its receipt.
    expect(world.sent.filter(raw => raw === world.sentAt(0))).toHaveLength(2);
    world.status.set(old, 'reverted');
    world.now += T;
    await world.fire();
    expect(world.sender.get(idOf('01'))).toEqual({ id: idOf('01'), state: 'reverted', txHash: old });
  });

  it('does not cancel a row of an old key when it is the only pending row', async () => {
    const world = new World();
    await expiring(world);
    world.key = KEY_B;
    world.now = CANCEL_AT + 10 * REPLACE_AFTER_MS;
    await world.fire();
    expect(world.feeReads).toBe(0);
    expect(world.sent).toEqual([world.sentAt(0), world.sentAt(0)]);
    expect(world.rows()[0]).toMatchObject({ attempts: 1, cancel_hashes: '[]', state: 'pending' });
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
