/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { CALIBUR_ADDRESS, TEST_EXECUTOR, transactionSigner } from './harness';
import { memoryDatabase, type MemoryDatabase } from './sqlite';
import type { RelayAuthorization } from '../src/chain';
import { RelaySender, type RelayTransaction, type SenderDeps, type SubmitJob } from '../src/sender';

const RELAYER = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const USER = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ADDRESS_A: Hex = `0x${'0a'.repeat(20)}`;
const ADDRESS_B: Hex = `0x${'0b'.repeat(20)}`;
const ADDRESS_C: Hex = `0x${'0c'.repeat(20)}`;
const NOW = 1_700_000_000_000;

function idOf(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}

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

interface Setup {
  db: MemoryDatabase;
  sender: RelaySender;
  /** The number of stored rows at the start of each sign and each broadcast. */
  rowsAtSign: number[];
  broadcasts: { raw: Hex; rows: number }[];
}

interface SetupOptions {
  /** Wait this long inside the signer, so another submit can try to run. */
  signDelayMs?: number;
  signError?: Error;
  broadcastError?: Error;
}

/** Dependencies with a quiet chain and no timer, over the database. */
function quietDeps(db: MemoryDatabase): SenderDeps {
  return {
    sql: db,
    relayer: () => TEST_EXECUTOR,
    sign: transaction => RELAYER.signTransaction(transaction),
    broadcast: async () => 'accepted',
    receipts: async (_chainId, hashes) => hashes.map(() => null),
    fees: async () => ({ baseFee: 1n, priorityFee: 1n }),
    alarmAt: async () => null,
    schedule: async () => undefined,
    now: () => NOW
  };
}

function setup(options: SetupOptions = {}): Setup {
  const db = memoryDatabase();
  const rowsAtSign: number[] = [];
  const broadcasts: { raw: Hex; rows: number }[] = [];
  const count = (): number => db.run('SELECT id FROM inflight').length;
  const sender = new RelaySender({
    ...quietDeps(db),
    sign: async (transaction: RelayTransaction) => {
      rowsAtSign.push(count());
      if (options.signDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.signDelayMs));
      if (options.signError !== undefined) throw options.signError;
      return RELAYER.signTransaction(transaction);
    },
    broadcast: async (_chainId, raw) => {
      broadcasts.push({ raw, rows: count() });
      if (options.broadcastError !== undefined) throw options.broadcastError;
      return 'accepted';
    }
  });
  return { db, sender, rowsAtSign, broadcasts };
}

function rows(db: MemoryDatabase): Record<string, unknown>[] {
  return db.run('SELECT * FROM inflight ORDER BY nonce');
}

function nextNonce(db: MemoryDatabase): unknown {
  return db.run("SELECT value FROM meta WHERE key = 'next_nonce'")[0]?.value;
}

async function signedAuthorization(nonce: number): Promise<RelayAuthorization> {
  const signed = await USER.signAuthorization({ address: CALIBUR_ADDRESS, chainId: 8453, nonce });
  if (typeof signed.yParity !== 'number') throw new Error('The authorization has no yParity');
  return { address: CALIBUR_ADDRESS, chainId: 8453, nonce, r: signed.r, s: signed.s, yParity: signed.yParity };
}

describe('RelaySender', () => {
  it('stores a signed type 2 transaction with the next nonce before it broadcasts it', async () => {
    const { db, sender, broadcasts } = setup();
    const outcome = await sender.submit(job());
    const [row] = rows(db);
    const raw = broadcasts[0]?.raw;
    if (row === undefined || raw === undefined) throw new Error('Nothing was stored or sent');
    expect(outcome).toEqual({ status: 'job', job: { id: idOf('01'), state: 'pending', txHash: keccak256(raw) } });
    expect(broadcasts).toEqual([{ raw, rows: 1 }]);
    expect(row).toEqual({
      id: idOf('01'),
      evm_address: ADDRESS_A,
      relayer: TEST_EXECUTOR,
      tx_hash: keccak256(raw),
      sent_hashes: JSON.stringify([keccak256(raw)]),
      cancel_hashes: '[]',
      raw_tx: raw,
      request: JSON.stringify({ to: ADDRESS_A, data: '0xdeadbeef', gas: '240000', authorization: null }),
      nonce: 5,
      max_fee: '2100000000',
      max_priority_fee: '100000000',
      deadline: 1_900_000_000,
      state: 'pending',
      attempts: 1,
      nonce_used: 0,
      created_at: NOW,
      signed_at: NOW,
      updated_at: NOW
    });
    expect(nextNonce(db)).toBe('6');

    const transaction = parseTransaction(raw);
    expect(transaction).toMatchObject({
      type: 'eip1559',
      chainId: 8453,
      nonce: 5,
      to: ADDRESS_A,
      data: '0xdeadbeef',
      gas: 240_000n,
      maxFeePerGas: 2_100_000_000n,
      maxPriorityFeePerGas: 100_000_000n
    });
    expect(transaction.authorizationList).toBeUndefined();
    await expect(transactionSigner(raw)).resolves.toBe(TEST_EXECUTOR);
  });

  it('signs a type 4 transaction with the authorization when one is given', async () => {
    const { db, sender, broadcasts } = setup();
    const authorization = await signedAuthorization(3);
    await sender.submit(job({ authorization }));
    const raw = broadcasts[0]?.raw;
    if (raw === undefined) throw new Error('Nothing was sent');
    const transaction = parseTransaction(raw);
    expect(transaction.type).toBe('eip7702');
    expect(transaction.to).toBe(ADDRESS_A);
    expect(transaction.authorizationList).toEqual([{ ...authorization, v: BigInt(authorization.yParity) + 27n }]);
    await expect(transactionSigner(raw)).resolves.toBe(TEST_EXECUTOR);
    expect(rows(db)[0]?.request).toBe(
      JSON.stringify({ to: ADDRESS_A, data: '0xdeadbeef', gas: '240000', authorization })
    );
  });

  it('returns the stored relay for the same id: one row, one signature, one broadcast', async () => {
    const { db, sender, rowsAtSign, broadcasts } = setup();
    const first = await sender.submit(job());
    const again = await sender.submit(job({ chainNonce: 9, gas: 1n }));
    expect(again).toEqual(first);
    expect(rows(db)).toHaveLength(1);
    expect(rowsAtSign).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
    expect(sender.get(idOf('01'))).toEqual(first.status === 'job' ? first.job : null);
    expect(sender.get(idOf('99'))).toBeNull();
  });

  it('answers busy with the open relay for another batch of a pending address', async () => {
    const { db, sender, rowsAtSign } = setup();
    await sender.submit(job());
    await expect(sender.submit(job({ id: idOf('02') }))).resolves.toEqual({ status: 'busy', id: idOf('01') });
    expect(rows(db)).toHaveLength(1);
    expect(rowsAtSign).toHaveLength(1);
  });

  it('takes the larger of the chain nonce and the stored next nonce', async () => {
    const { db, sender } = setup();
    await sender.submit(job({ chainNonce: 5 }));
    // The chain has not seen the first transaction yet: the stored next nonce wins.
    await sender.submit(job({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce: 3 }));
    // The chain is ahead of the store: the chain nonce wins.
    await sender.submit(job({ id: idOf('03'), evmAddress: ADDRESS_C, chainNonce: 10 }));
    expect(rows(db).map(row => row.nonce)).toEqual([5, 6, 10]);
    expect(nextNonce(db)).toBe('11');
  });

  it('gives two concurrent submits different nonces and commits each row before the next signature', async () => {
    const { db, sender, rowsAtSign } = setup({ signDelayMs: 20 });
    const outcomes = await Promise.all([
      sender.submit(job({ chainNonce: 5 })),
      sender.submit(job({ id: idOf('02'), evmAddress: ADDRESS_B, chainNonce: 5 }))
    ]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['job', 'job']);
    expect(rows(db).map(row => [row.id, row.nonce])).toEqual([
      [idOf('01'), 5],
      [idOf('02'), 6]
    ]);
    // The second submit chose its nonce only after the first row was committed.
    expect(rowsAtSign).toEqual([0, 1]);
  });

  it('reserves no nonce when the signature fails, and the next submit runs', async () => {
    const failing = setup({ signError: new Error('signer down') });
    await expect(failing.sender.submit(job())).rejects.toThrow('signer down');
    expect(rows(failing.db)).toEqual([]);
    expect(nextNonce(failing.db)).toBeUndefined();

    const { db, sender } = setup();
    await sender.submit(job());
    const second = new RelaySender({ ...quietDeps(db), sign: () => Promise.reject(new Error('signer down')) });
    await expect(second.submit(job({ id: idOf('02'), evmAddress: ADDRESS_B }))).rejects.toThrow('signer down');
    expect(nextNonce(db)).toBe('6');
    await sender.submit(job({ id: idOf('03'), evmAddress: ADDRESS_C, chainNonce: 0 }));
    expect(rows(db).map(row => row.nonce)).toEqual([5, 6]);
  });

  it('answers pending and keeps the row when the broadcast fails', async () => {
    const { db, sender, broadcasts } = setup({ broadcastError: new Error('node down') });
    const outcome = await sender.submit(job());
    expect(outcome.status === 'job' && outcome.job.state).toBe('pending');
    expect(broadcasts.map(broadcast => broadcast.rows)).toEqual([1]);
    expect(rows(db)[0]?.raw_tx).toBe(broadcasts[0]?.raw);
  });

  it('refuses a job of another chain', async () => {
    const { db, sender } = setup();
    await sender.submit(job());
    await expect(sender.submit(job({ id: idOf('02'), evmAddress: ADDRESS_B, chainId: 1 }))).rejects.toThrow(
      'The Sender serves another chain.'
    );
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses a second pending row of one relayer nonce or one address in SQL', async () => {
    const { db, sender } = setup();
    await sender.submit(job());
    const insert = (id: Hex, address: Hex, nonce: number, relayer: Hex = TEST_EXECUTOR): void => {
      db.run(
        `INSERT INTO inflight (id, evm_address, relayer, tx_hash, sent_hashes, raw_tx, request, nonce, max_fee,
          max_priority_fee, deadline, state, attempts, created_at, signed_at, updated_at)
          VALUES (?, ?, ?, '0x', '[]', '0x', '{}', ?, '1', '1', 1, 'pending', 1, 1, 1, 1)`,
        id,
        address,
        relayer,
        nonce
      );
    };
    expect(() => insert(idOf('02'), ADDRESS_B, 5)).toThrow(/UNIQUE/);
    expect(() => insert(idOf('03'), ADDRESS_A, 6)).toThrow(/UNIQUE/);
    // Another relayer account has its own nonces.
    expect(() => insert(idOf('05'), ADDRESS_C, 5, `0x${'99'.repeat(20)}`)).not.toThrow();
    db.run("UPDATE inflight SET state = 'succeeded'");
    expect(() => insert(idOf('04'), ADDRESS_A, 5)).not.toThrow();
  });

  it('refuses a pending row without signed bytes in SQL', async () => {
    const { db, sender } = setup();
    await sender.submit(job());
    expect(() => db.run('UPDATE inflight SET raw_tx = NULL')).toThrow(/CHECK/);
    expect(() => db.run("UPDATE inflight SET state = 'succeeded', raw_tx = NULL, request = NULL")).not.toThrow();
  });

  it('allows the four states and refuses another state in SQL', async () => {
    const { db, sender } = setup();
    await sender.submit(job());
    expect(() => db.run("UPDATE inflight SET state = 'cancelled', raw_tx = NULL, request = NULL")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE inflight SET state = 'expired', raw_tx = NULL, request = NULL")).not.toThrow();
    expect(sender.get(idOf('01'))?.state).toBe('expired');
    db.run("UPDATE inflight SET state = 'reverted'");
    expect(sender.get(idOf('01'))?.state).toBe('reverted');
  });
});
