// Real Dexie, real judgement and writes; only the node reads and the old landed check are faked.
import { inVerdictTurn } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';

import {
  guardianHoldRetryMessage,
  TRANSACTION_BEING_CHECKED_RETRY_ERROR,
  TRANSACTION_LANDING_PENDING_RETRY_ERROR
} from './constants';
import { NodeReads } from './reconcile-reads';
import { acknowledgementOf, requeueFailedTransaction, RETRY_REFUSAL_COPY, RetryOptions } from './retry';
import { ISubmitEvidence, ITransaction, ITransactionStatus } from '../db/types';
import { NoteTypeEnum } from '../types';

const mockNode: { current: NodeReads | undefined } = { current: undefined };
jest.mock('./reconcile-reads', () => ({
  ...jest.requireActual('./reconcile-reads'),
  createNodeReads: async () => mockNode.current
}));
const mockVerifySendLanded = jest.fn(async (): Promise<'landed' | 'unknown'> => 'unknown');
jest.mock('./cancel', () => ({
  ...jest.requireActual('./cancel'),
  verifySendLanded: () => mockVerifySendLanded()
}));
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0]
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));

type CopyKey = keyof typeof RETRY_REFUSAL_COPY;

const NOW = Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const HEADER = hex(1);
const INITIAL = hex(10);
const FINAL = hex(11);
const OTHER = hex(12);
const NOTE = hex(20);

const node = (
  tip: { blockNum: number; commitment?: string; nonce?: string },
  options: { notes?: Record<string, number>; header?: string; tipFails?: boolean } = {}
): NodeReads => ({
  blockCommitment: async () => options.header ?? HEADER,
  account: async () => (options.tipFails ? { ok: false, pruned: false, timedOut: false } : { ok: true, state: tip }),
  noteInclusions: async ids => {
    const found = new Map<string, number>();
    for (const id of ids) {
      const block = options.notes?.[id];
      if (block !== undefined) found.set(id, block);
    }
    return found;
  },
  nullifierHeight: async () => null
});
const UNDECIDED = node({ blockNum: 150, commitment: OTHER });
const DEAD = node({ blockNum: 750, commitment: INITIAL });
const LANDED = node({ blockNum: 150, commitment: OTHER }, { notes: { [NOTE]: 140 } });

const entry = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'a1',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: hex(2),
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [NOTE],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700,
  ...overrides
});

const unconfirmedSend = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'tx-1',
  type: 'send',
  accountId: 'mtst1acct_s',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  processingStartedAt: NOW - 110,
  completedAt: NOW - 100,
  attemptId: 'a1',
  stage: 'sending',
  mayHaveSubmitted: true,
  error: 'no definite outcome',
  noteType: NoteTypeEnum.Public,
  displayIcon: 'SEND',
  submitEvidence: [entry()],
  ...overrides
});

const read = () => Repo.transactions.where({ id: 'tx-1' }).first();
const refusal = (txId = 'tx-1', options: RetryOptions = {}): Promise<unknown> =>
  requeueFailedTransaction(txId, options).then(
    () => undefined,
    (e: unknown) => e
  );

beforeEach(async () => {
  jest.clearAllMocks();
  // clearAllMocks keeps an implementation a test installed, which would leak a late stamp into the next test.
  mockVerifySendLanded.mockImplementation(async () => 'unknown');
  mockNode.current = UNDECIDED;
  await Repo.transactions.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

describe('the tap-time proof (#1081)', () => {
  it('completes a row whose attempt landed, and queues nothing', async () => {
    mockNode.current = LANDED;
    await Repo.transactions.put(unconfirmedSend());
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Completed);
  });

  it('proves a dead row and requeues it in the same call, with no acknowledgement', async () => {
    mockNode.current = DEAD;
    await Repo.transactions.put(unconfirmedSend());
    await requeueFailedTransaction('tx-1');
    const row = await read();
    expect(row).toMatchObject({ status: ITransactionStatus.Queued });
    expect(row?.mayHaveSubmitted).toBeUndefined();
    expect(row?.attemptId).toBeUndefined();
    expect(row?.neverCommittedAt).toBeUndefined();
    expect(row?.submitEvidence?.[0]?.verdict).toBe('never-committed');
  });

  it('leaves an undecided row on today`s path: the acknowledgeable refusal, naming its attempt', async () => {
    await Repo.transactions.put(unconfirmedSend());
    const error = await refusal();
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.sendChecking);
    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });

  it('a recorded landing whose reads fail this time refuses with the wait message, never the acknowledgement', async () => {
    mockNode.current = node({ blockNum: 150 }, { tipFails: true });
    await Repo.transactions.put(
      unconfirmedSend({ submitEvidence: [entry({ landingSeenAtBlock: 140, landingSeenBy: 2 })] })
    );
    const error = await refusal('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect(error).toHaveProperty('message', TRANSACTION_LANDING_PENDING_RETRY_ERROR);
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('a row with evidence and no transactionId never reaches the hard refusal', async () => {
    await Repo.transactions.put(unconfirmedSend());
    const error = await refusal();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty('message', expect.stringMatching(/cannot be retried automatically/));
  });
});

describe('the safe marker (#1081)', () => {
  it('skips both may-have-submitted refusals', async () => {
    await Repo.transactions.put(unconfirmedSend({ status: ITransactionStatus.Failed, neverCommittedAt: NOW - 5 }));
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });

  it('keeps the liveness refusal, with copy that says the attempt is proven dead (PN-1), and keeps the marker', async () => {
    await Repo.transactions.put(
      unconfirmedSend({ status: ITransactionStatus.Failed, neverCommittedAt: NOW - 5, cancelledInFlightAt: NOW - 1 })
    );
    const error = await refusal();
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.sendLiveProven);
    expect(acknowledgementOf(error)).toBeNull();
    expect((await read())?.neverCommittedAt).toBe(NOW - 5);
  });

  it.each<['execute' | 'swap', CopyKey]>([
    ['execute', 'executeLiveProven'],
    ['swap', 'swapLiveProven']
  ])(
    'a proven %s still meets the liveness refusal through a recent end, with the proven copy (PN-1)',
    async (type, copy) => {
      await Repo.transactions.put(
        unconfirmedSend({
          type,
          status: ITransactionStatus.Failed,
          neverCommittedAt: NOW - 5,
          submitEvidence: [entry({ verdict: 'never-committed', endedBy: 'out-of-band', endedAt: NOW - 1 })]
        })
      );
      const error = await refusal();
      expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY[copy]);
      expect(error).toHaveProperty('message', expect.stringMatching(/^The network confirmed this/));
    }
  );

  it('a proven Agglayer row whose pipeline may still run requeues with no refusal at all', async () => {
    await Repo.transactions.put(
      unconfirmedSend({
        type: 'bridged-send',
        extraInputs: { provider: 'agglayer' },
        requestBytes: new Uint8Array([1]),
        status: ITransactionStatus.Failed,
        neverCommittedAt: NOW - 5,
        cancelledInFlightAt: NOW - 1,
        submitEvidence: [entry({ verdict: 'never-committed', endedBy: 'kill', endedAt: NOW - 1 })]
      })
    );
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });
});

describe('an unproven execute is acknowledgeable (#1081)', () => {
  const execute = (overrides: Partial<ITransaction> = {}) =>
    unconfirmedSend({
      type: 'execute',
      requestBytes: new Uint8Array([1]),
      submitEvidence: [entry({ fromExecute: true, expirationBlock: undefined })],
      ...overrides
    });

  it('an Unconfirmed execute whose entries list no nullifier requeues only with a matching acknowledgement', async () => {
    await Repo.transactions.put(execute());
    const error = await refusal();
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.executeChecking);
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });

  it('one whose entry lists a nullifier requeues as today', async () => {
    await Repo.transactions.put(
      execute({ submitEvidence: [entry({ fromExecute: true, nullifiers: [hex(30)], expirationBlock: undefined })] })
    );
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });

  it('a killed execute meets the liveness refusal inside the window, with no acknowledgement to give', async () => {
    await Repo.transactions.put(
      execute({
        status: ITransactionStatus.Failed,
        submitEvidence: [
          { attemptId: 'a1', capturedAt: NOW - 5, source: 'kill', endedBy: 'kill', endedAt: NOW - 5, fromExecute: true }
        ]
      })
    );
    const error = await refusal('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.executeLive);
    expect(acknowledgementOf(error)).toBeNull();
    expect((await read())?.status).toBe(ITransactionStatus.Failed);
  });

  it('past the window it meets the acknowledgeable refusal, answered by that attempt`s id', async () => {
    await Repo.transactions.put(
      execute({
        status: ITransactionStatus.Failed,
        submitEvidence: [
          {
            attemptId: 'a1',
            capturedAt: NOW - 7200,
            source: 'kill',
            endedBy: 'kill',
            endedAt: NOW - 7200,
            fromExecute: true
          }
        ]
      })
    );
    const error = await refusal();
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.executeStopped);
  });

  it('a #1250 Failed execute with no entries and no attempt id is refused with a null attempt', async () => {
    await Repo.transactions.put(
      execute({ status: ITransactionStatus.Failed, attemptId: undefined, submitEvidence: undefined })
    );
    expect(acknowledgementOf(await refusal())).toEqual({ attemptId: null });
  });

  it('an execute whose run has an id and no entry provably ended before its submit, and requeues as today', async () => {
    await Repo.transactions.put(
      execute({ status: ITransactionStatus.Failed, mayHaveSubmitted: undefined, submitEvidence: [] })
    );
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });

  it('an end entry with no flag still meets the refusal', async () => {
    await Repo.transactions.put(
      execute({
        status: ITransactionStatus.Failed,
        mayHaveSubmitted: undefined,
        submitEvidence: [{ attemptId: 'a1', capturedAt: NOW - 7200, source: 'end', fromExecute: true }]
      })
    );
    expect(acknowledgementOf(await refusal())).toEqual({ attemptId: 'a1' });
  });

  it('A dead by row 5 beside a retired pin B requeues with no acknowledgement', async () => {
    mockNode.current = node({ blockNum: 150, commitment: OTHER, nonce: '6' });
    await Repo.transactions.put(
      execute({
        attemptId: 'b',
        submitEvidence: [
          entry({ fromExecute: true, expirationBlock: undefined }),
          { attemptId: 'b', capturedAt: NOW, source: 'pin', preSubmitEnd: true, fromExecute: true }
        ]
      })
    );
    await requeueFailedTransaction('tx-1');
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
  });
});

describe('acknowledgements name their attempt (#1081)', () => {
  it('a stale acknowledgement counts as absent', async () => {
    await Repo.transactions.put(
      unconfirmedSend({ attemptId: 'a2', submitEvidence: [entry(), entry({ attemptId: 'a2', transactionId: hex(3) })] })
    );
    const error = await refusal('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a2' });
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('a row from before this change takes { attemptId: null }, which stops working once the row runs again', async () => {
    const legacy = unconfirmedSend({
      status: ITransactionStatus.Failed,
      attemptId: undefined,
      submitEvidence: undefined
    });
    await Repo.transactions.put(legacy);
    expect(acknowledgementOf(await refusal())).toEqual({ attemptId: null });
    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: null } });
    expect((await read())?.status).toBe(ITransactionStatus.Queued);
    await Repo.transactions.put({ ...legacy, attemptId: 'a9', mayHaveSubmitted: true });
    expect(acknowledgementOf(await refusal('tx-1', { acknowledged: { attemptId: null } }))).toEqual({
      attemptId: 'a9'
    });
  });
});

describe('the requeue write and evidence that moves under Retry (#1081)', () => {
  it('a late stamp filling evidence makes the write a no-op, and the rejudge finds the landing', async () => {
    await Repo.transactions.put(
      unconfirmedSend({
        submitEvidence: [{ attemptId: 'a1', capturedAt: NOW - 60, source: 'error-text', transactionId: hex(2) }]
      })
    );
    mockNode.current = LANDED;
    mockVerifySendLanded.mockImplementationOnce(async () => {
      await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
        row.submitEvidence = [entry()];
      });
      return 'unknown';
    });
    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect((await read())?.status).toBe(ITransactionStatus.Completed);
  });

  it('the second judging takes no acknowledgement: a send whose evidence moved under Retry is refused again', async () => {
    await Repo.transactions.put(
      unconfirmedSend({ submitEvidence: [{ attemptId: 'a1', capturedAt: NOW - 60, source: 'error-text' }] })
    );
    mockVerifySendLanded.mockImplementationOnce(async () => {
      await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
        row.submitEvidence = [{ attemptId: 'a1', capturedAt: NOW - 60, source: 'error-text', transactionId: hex(2) }];
      });
      return 'unknown';
    });
    const error = await refusal('tx-1', { acknowledged: { attemptId: 'a1' } });
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('two changes end the call with the being-checked refusal and queue nothing', async () => {
    // An Agglayer row needs no acknowledgement, so both judgings reach the write (a plain send's second, unacknowledged
    // judging refuses before it).
    await Repo.transactions.put(
      unconfirmedSend({
        type: 'bridged-send',
        extraInputs: { provider: 'agglayer' },
        requestBytes: new Uint8Array([1]),
        submitEvidence: [{ attemptId: 'a1', capturedAt: NOW - 60, source: 'error-text' }]
      })
    );
    let n = 0;
    mockVerifySendLanded.mockImplementation(async () => {
      n += 1;
      await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
        row.submitEvidence = [
          ...(row.submitEvidence ?? []),
          { attemptId: `late-${n}`, capturedAt: NOW, source: 'end' }
        ];
      });
      return 'unknown';
    });
    const error = await refusal();
    expect(error).toHaveProperty('message', TRANSACTION_BEING_CHECKED_RETRY_ERROR);
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('Retry`s own writes never void it: a persisted network mark still requeues an acknowledged send', async () => {
    mockNode.current = node({ blockNum: 150, commitment: OTHER }, { header: OTHER });
    await Repo.transactions.put(unconfirmedSend());
    await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Queued);
    expect(row?.submitEvidence?.[0]?.otherNetworkSince).toEqual(expect.any(Number));
  });
});

describe('the verdict lock (#1081)', () => {
  it('a Retry started during a pass waits for it, then judges the row as the pass left it', async () => {
    mockNode.current = LANDED;
    await Repo.transactions.put(unconfirmedSend());
    let release: () => void = () => {};
    const pass = inVerdictTurn(
      'tx-1',
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
      { ifAvailable: true }
    );
    const retry = requeueFailedTransaction('tx-1');
    await Repo.transactions.where({ id: 'tx-1' }).modify(row => {
      row.status = ITransactionStatus.Completed;
    });
    release();
    await pass;
    // It judged the row as the pass left it: Completed, so not requeued.
    await expect(retry).rejects.toThrow(/not retryable/);
    expect((await read())?.status).toBe(ITransactionStatus.Completed);
  });

  it('a pass still running after 10 s gives the being-checked refusal', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    let release: () => void = () => {};
    let pass: Promise<unknown> = Promise.resolve();
    try {
      await Repo.transactions.put(unconfirmedSend());
      pass = inVerdictTurn(
        'tx-1',
        () =>
          new Promise<void>(resolve => {
            release = resolve;
          }),
        { ifAvailable: true }
      );
      const pending = refusal();
      await jest.advanceTimersByTimeAsync(10_001);
      expect(await pending).toHaveProperty('message', TRANSACTION_BEING_CHECKED_RETRY_ERROR);
    } finally {
      // Released here, so tx-1's verdict lock is free for every later test.
      release();
      await pass;
      jest.useRealTimers();
    }
  });
});

describe('the refusal copy (#1081)', () => {
  it('an execute`s copy names no send and no balance; a swap`s names no send; a stopped send keeps today`s text', () => {
    const executeKeys: CopyKey[] = ['executeChecking', 'executeStopped', 'executeLive', 'executeLiveProven'];
    for (const key of executeKeys) {
      expect(RETRY_REFUSAL_COPY[key]).not.toMatch(/send|balance/i);
    }
    const swapKeys: CopyKey[] = ['swapChecking', 'swapStopped', 'swapLive', 'swapLiveProven'];
    for (const key of swapKeys) {
      expect(RETRY_REFUSAL_COPY[key]).not.toMatch(/send/i);
    }
    expect(RETRY_REFUSAL_COPY.sendStopped).toBe(
      'This send may already have reached the network, and there is no way to confirm it. Retrying could send it twice. Check your balance first - if it did not go through, you can retry anyway.'
    );
  });

  it('says the wallet is still checking exactly while the reconciler judges the row', async () => {
    await Repo.transactions.put(unconfirmedSend({ submitEvidence: [entry({ verdict: 'unresolvable' })] }));
    expect(await refusal()).toHaveProperty('message', RETRY_REFUSAL_COPY.sendStopped);
  });

  it('reads the row as the tap-time check left it: a check that just stopped the reconciler gives the stopped copy', async () => {
    // Past the initial nonce with no proof either way (7 is not 5 + 1, so not superseded), so the check marks the only
    // checkable entry 'unresolvable'.
    mockNode.current = node({ blockNum: 150, commitment: OTHER, nonce: '7' });
    await Repo.transactions.put(unconfirmedSend());
    const error = await refusal();
    expect(error).toHaveProperty('message', RETRY_REFUSAL_COPY.sendStopped);
    expect(acknowledgementOf(error)).toEqual({ attemptId: 'a1' });
    expect((await read())?.submitEvidence?.[0]?.verdict).toBe('unresolvable');
  });
});

describe('the Guardian hold (#1081)', () => {
  const kept = (capturedAt: number) => entry({ candidateKept: true, guardianProposalNonce: 9, capturedAt });

  it('refuses while a kept candidate is under 600 s old, naming when it clears; an acknowledgement does not bypass it', async () => {
    await Repo.transactions.put(unconfirmedSend({ submitEvidence: [kept(NOW - 100)] }));
    const expected = guardianHoldRetryMessage(NOW + 500);
    expect(((await refusal()) as Error).message).toBe(expected);
    expect(((await refusal('tx-1', { acknowledged: { attemptId: 'a1' } })) as Error).message).toBe(expected);
    expect((await read())?.status).toBe(ITransactionStatus.Unconfirmed);
  });

  it('holds a proven row too', async () => {
    await Repo.transactions.put(
      unconfirmedSend({
        status: ITransactionStatus.Failed,
        neverCommittedAt: NOW - 10,
        submitEvidence: [kept(NOW - 100)]
      })
    );
    expect(((await refusal()) as Error).message).toBe(guardianHoldRetryMessage(NOW + 500));
  });

  it('holds a guardian Agglayer row too', async () => {
    await Repo.transactions.put(
      unconfirmedSend({
        type: 'bridged-send',
        extraInputs: { provider: 'agglayer' },
        requestBytes: new Uint8Array([1]),
        submitEvidence: [kept(NOW - 100)]
      })
    );
    expect(((await refusal()) as Error).message).toBe(guardianHoldRetryMessage(NOW + 500));
  });

  // Hold bounds, on an injected clock: refused at capturedAt + 599 s, today's path at + 600 s.
  it('holds until capturedAt + 600 s exactly, then takes the acknowledgeable path', async () => {
    const clock = jest.spyOn(Date, 'now');
    try {
      await Repo.transactions.put(unconfirmedSend({ submitEvidence: [kept(NOW - 599)] }));
      clock.mockReturnValue(NOW * 1000);
      expect(((await refusal()) as Error).message).toBe(guardianHoldRetryMessage(NOW + 1));
      clock.mockReturnValue((NOW + 1) * 1000);
      expect(acknowledgementOf(await refusal())).toEqual({ attemptId: 'a1' });
      await requeueFailedTransaction('tx-1', { acknowledged: { attemptId: 'a1' } });
      expect((await read())?.status).toBe(ITransactionStatus.Queued);
    } finally {
      clock.mockRestore();
    }
  });

  it('lets the row through once the hold has passed, and never asks for an abandon itself', async () => {
    mockNode.current = DEAD;
    await Repo.transactions.put(unconfirmedSend({ submitEvidence: [kept(NOW - 601)] }));
    await requeueFailedTransaction('tx-1');
    const row = await read();
    expect(row?.status).toBe(ITransactionStatus.Queued);
    // Retry runs in the UI realm, which on the extension holds no Guardian service: the entry stays as it was.
    expect(row?.submitEvidence?.[0]?.candidateKept).toBe(true);
  });
});
