import {
  bindCommittedGuardianEvidence,
  clearCommittedGuardianIntent,
  clearCommittedGuardianIntents,
  committedGuardianOperationBinding,
  finishCommittedGuardianIntent,
  issueCommittedGuardianIntent
} from './committed-completion';
import { ITransactionStatus, ReplaceHotKeyTransaction, SwitchGuardianTransaction } from '../db/types';

const TRANSACTION_ID = `0x${'ab'.repeat(32)}`;
const FINAL_COMMITMENT = `0x${'cd'.repeat(32)}`;
const EVIDENCE = { transactionId: TRANSACTION_ID, finalCommitment: FINAL_COMMITMENT };
const BINDING = JSON.stringify(['replace-hot-key', 'account', 'new-hot']);
const TWO_HOURS = 2 * 60 * 60 * 1000;

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise was not initialized');
  };
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  clearCommittedGuardianIntents();
  jest.useRealTimers();
});

it('GEO012 derives an exact structural operation binding without trusting the row id', () => {
  const hot = new ReplaceHotKeyTransaction('account', false);
  hot.extraInputs = { newHotPublicKey: 'new-hot', guardianEndpoint: 'https://old.guardian.example' };
  hot.status = ITransactionStatus.GeneratingTransaction;
  const binding = committedGuardianOperationBinding(hot);
  expect(binding).toBe(BINDING);
  const other = { ...hot, id: 'other-row' };
  expect(committedGuardianOperationBinding(other)).toBe(binding);
  expect(committedGuardianOperationBinding({ ...hot, accountId: 'another-account' })).not.toBe(binding);
  expect(
    committedGuardianOperationBinding({ ...hot, extraInputs: { ...hot.extraInputs, newHotPublicKey: 'other' } })
  ).not.toBe(binding);
  const endpoint = new SwitchGuardianTransaction('account', 'https://new.guardian.example', false);
  expect(committedGuardianOperationBinding(endpoint)).toBe(
    JSON.stringify(['switch-guardian', 'account', 'https://new.guardian.example'])
  );
  expect(committedGuardianOperationBinding({ ...hot, type: 'send' })).toBeUndefined();
  expect(committedGuardianOperationBinding({ ...hot, extraInputs: {} })).toBeUndefined();
});

it('GEO012 passes only complete normalized trusted evidence to one consumed continuation', async () => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, {
    transactionId: TRANSACTION_ID.toUpperCase().replace('0X', '0x'),
    finalCommitment: FINAL_COMMITMENT.toUpperCase().replace('0X', '0x')
  });
  await expect(finishCommittedGuardianIntent(token)).resolves.toBeUndefined();
  expect(complete).toHaveBeenCalledWith(EVIDENCE, expect.any(Function), expect.any(Number));
  expect(complete).toHaveBeenCalledTimes(1);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
});

it.each([
  undefined,
  {},
  { transactionId: TRANSACTION_ID },
  { finalCommitment: FINAL_COMMITMENT },
  { transactionId: '0xab', finalCommitment: FINAL_COMMITMENT },
  { transactionId: TRANSACTION_ID, finalCommitment: '0xcd' }
])('GEO012 incomplete evidence %j never grants completion', async evidence => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, evidence);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it.each([
  { rowId: 'another-row', attemptId: 'attempt' },
  { rowId: 'row', attemptId: 'another-attempt' }
])('GEO012 another row or attempt cannot bind this intent: %j', async ({ rowId, attemptId }) => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence(rowId, attemptId, BINDING, EVIDENCE);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it('GEO012 a different original operation retires authority even with the same row and attempt', async () => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence(
    'row',
    'attempt',
    JSON.stringify(['replace-hot-key', 'account', 'other-hot']),
    EVIDENCE
  );
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it('GEO012 repeating identical evidence preserves the immutable binding', async () => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, { ...EVIDENCE });
  await finishCommittedGuardianIntent(token);
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each([
  { ...EVIDENCE, transactionId: `0x${'ef'.repeat(32)}` },
  { ...EVIDENCE, finalCommitment: `0x${'ef'.repeat(32)}` }
])('GEO012 conflicting evidence permanently retires the token: %j', async evidence => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, evidence);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it('GEO012 replacing an active row intent retires the previous token and attempt', async () => {
  const previous = jest.fn(async () => undefined);
  const current = jest.fn(async () => undefined);
  const oldToken = issueCommittedGuardianIntent('row', 'first', BINDING, previous);
  bindCommittedGuardianEvidence('row', 'first', BINDING, EVIDENCE);
  const token = issueCommittedGuardianIntent('row', 'second', BINDING, current);
  bindCommittedGuardianEvidence('row', 'second', BINDING, EVIDENCE);
  expect(token).not.toBe(oldToken);
  await expect(finishCommittedGuardianIntent(oldToken)).rejects.toThrow();
  await finishCommittedGuardianIntent(token);
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);
});

it('GEO012 consumes authority before the first asynchronous completion finishes', async () => {
  const entered = deferred<void>();
  const answer = deferred<void>();
  const complete = jest.fn(async () => {
    entered.resolve();
    await answer.promise;
  });
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  const pending = finishCommittedGuardianIntent(token);
  try {
    await entered.promise;
    await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    answer.resolve();
    await pending;
  }
});

it('GEO012 a failed continuation cannot replay its captured pointer write', async () => {
  const failure = new Error('Current wallet changed');
  const complete = jest.fn(async () => {
    throw failure;
  });
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  await expect(finishCommittedGuardianIntent(token)).rejects.toBe(failure);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each([
  { age: TWO_HOURS - 1, allowed: true },
  { age: TWO_HOURS, allowed: false }
])('GEO012 the active lifetime is bounded at $age milliseconds', async ({ age, allowed }) => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  jest.advanceTimersByTime(age);
  const outcome = await finishCommittedGuardianIntent(token).then(
    () => true,
    () => false
  );
  expect(outcome).toBe(allowed);
  expect(complete).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it('GEO012 caps orphan intents, permits replacement at the cap and frees retired capacity', async () => {
  const complete = jest.fn(async () => undefined);
  const tokens = Array.from({ length: 64 }, (_, index) =>
    issueCommittedGuardianIntent(`row-${index}`, 'attempt', BINDING, complete)
  );
  expect(() => issueCommittedGuardianIntent('overflow', 'attempt', BINDING, complete)).toThrow();
  const replacement = issueCommittedGuardianIntent('row-0', 'replacement', BINDING, complete);
  expect(replacement).not.toBe(tokens[0]);
  await expect(finishCommittedGuardianIntent(tokens[0] ?? '')).rejects.toThrow();
  clearCommittedGuardianIntent('row-1');
  expect(() => issueCommittedGuardianIntent('freed', 'attempt', BINDING, complete)).not.toThrow();
  jest.advanceTimersByTime(TWO_HOURS);
  expect(() => issueCommittedGuardianIntent('after-expiry', 'attempt', BINDING, complete)).not.toThrow();
});

it('GEO012 clears exactly one row or all rows without invoking any continuation', async () => {
  const complete = jest.fn(async () => undefined);
  const first = issueCommittedGuardianIntent('first', 'attempt', BINDING, complete);
  const second = issueCommittedGuardianIntent('second', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('first', 'attempt', BINDING, EVIDENCE);
  bindCommittedGuardianEvidence('second', 'attempt', BINDING, EVIDENCE);
  clearCommittedGuardianIntent('first');
  await expect(finishCommittedGuardianIntent(first)).rejects.toThrow();
  await finishCommittedGuardianIntent(second);
  const third = issueCommittedGuardianIntent('third', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('third', 'attempt', BINDING, EVIDENCE);
  clearCommittedGuardianIntents();
  await expect(finishCommittedGuardianIntent(third)).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
});

it.each(['replacement', 'clear-row', 'clear-all', 'expiry'])(
  'GEO012 %s invalidates an in-progress capability before its guarded write',
  async retirement => {
    const entered = deferred<void>();
    const answer = deferred<void>();
    const write = jest.fn();
    const complete = jest.fn(async (_evidence: unknown, assertCurrent: () => void) => {
      entered.resolve();
      await answer.promise;
      assertCurrent();
      write();
    });
    const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
    bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
    if (retirement === 'expiry') jest.advanceTimersByTime(TWO_HOURS - 1);
    const pending = finishCommittedGuardianIntent(token).then(
      () => true,
      () => false
    );
    try {
      await entered.promise;
      if (retirement === 'replacement') issueCommittedGuardianIntent('row', 'next', BINDING, async () => undefined);
      if (retirement === 'clear-row') clearCommittedGuardianIntent('row');
      if (retirement === 'clear-all') clearCommittedGuardianIntents();
      if (retirement === 'expiry') jest.advanceTimersByTime(1);
      answer.resolve();
      expect(await pending).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally {
      answer.resolve();
      await pending;
    }
  }
);

it.each([
  { supplied: undefined, elapsed: 15_000, allowed: false },
  { supplied: 1_000_000, elapsed: 15_000, allowed: false },
  { supplied: 20, elapsed: 19, allowed: true },
  { supplied: 20, elapsed: 20, allowed: false }
])(
  'GEO012 a caller deadline can only shorten the 15 second finish budget: %j',
  async ({ supplied, elapsed, allowed }) => {
    const entered = deferred<void>();
    const answer = deferred<void>();
    const write = jest.fn();
    const complete = jest.fn(async (_evidence: unknown, assertCurrent: () => void) => {
      entered.resolve();
      await answer.promise;
      assertCurrent();
      write();
    });
    const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
    bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
    const deadline = supplied === undefined ? undefined : Date.now() + supplied;
    const pending = finishCommittedGuardianIntent(token, deadline).then(
      () => true,
      () => false
    );
    try {
      await entered.promise;
      jest.advanceTimersByTime(elapsed);
      answer.resolve();
      expect(await pending).toBe(allowed);
      expect(write).toHaveBeenCalledTimes(allowed ? 1 : 0);
    } finally {
      answer.resolve();
      await pending;
    }
  }
);

it('GEO012 moving the wall clock backward cannot extend an in-progress finish', async () => {
  const entered = deferred<void>();
  const answer = deferred<void>();
  const write = jest.fn();
  const complete = jest.fn(async (_evidence: unknown, assertCurrent: () => void) => {
    entered.resolve();
    await answer.promise;
    assertCurrent();
    write();
  });
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  const pending = finishCommittedGuardianIntent(token).then(
    () => true,
    () => false
  );
  try {
    await entered.promise;
    jest.setSystemTime(Date.now() - TWO_HOURS);
    jest.advanceTimersByTime(15_000);
    answer.resolve();
    expect(await pending).toBe(false);
    expect(write).not.toHaveBeenCalled();
  } finally {
    answer.resolve();
    await pending;
  }
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
  'GEO012 invalid deadline offset %s retires the token',
  async offset => {
    const complete = jest.fn(async () => undefined);
    const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
    bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
    await expect(finishCommittedGuardianIntent(token, Date.now() + offset)).rejects.toThrow();
    await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  }
);

it('GEO012 an undefined original operation cannot bind or revive a sealed intent', async () => {
  const complete = jest.fn(async () => undefined);
  const token = issueCommittedGuardianIntent('row', 'attempt', BINDING, complete);
  bindCommittedGuardianEvidence('row', 'attempt', undefined, EVIDENCE);
  bindCommittedGuardianEvidence('row', 'attempt', BINDING, EVIDENCE);
  await expect(finishCommittedGuardianIntent(token)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
});

it('GEO012 an in-progress continuation still occupies the bounded registry until it settles', async () => {
  const entered = deferred<void>();
  const answer = deferred<void>();
  const complete = jest.fn(async (_evidence: unknown, assertCurrent: () => void) => {
    entered.resolve();
    await answer.promise;
    assertCurrent();
  });
  const tokens = Array.from({ length: 64 }, (_, index) =>
    issueCommittedGuardianIntent(`row-${index}`, 'attempt', BINDING, complete)
  );
  bindCommittedGuardianEvidence('row-0', 'attempt', BINDING, EVIDENCE);
  const pending = finishCommittedGuardianIntent(tokens[0] ?? '');
  try {
    await entered.promise;
    expect(() => issueCommittedGuardianIntent('overflow', 'attempt', BINDING, complete)).toThrow();
  } finally {
    answer.resolve();
    await pending;
  }
  expect(() => issueCommittedGuardianIntent('freed', 'attempt', BINDING, complete)).not.toThrow();
});
