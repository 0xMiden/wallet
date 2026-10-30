import { addEventProcessor, getCurrentScope } from '@sentry/browser';
import type { UpdatingHookContext } from 'dexie';

import * as Repo from 'lib/miden/repo';
import { isCrashReportingEnabledAsync } from 'lib/settings/helpers';
import { initCrashReporting, scrubEvent, stopCrashReporting } from 'lib/telemetry/crash';
import { snapshotProofWaitAvailability } from 'lib/telemetry/proof-wait-availability-diagnostics';
import * as failureReporter from 'lib/telemetry/transaction-failure';

import { judgeAndWrite } from './reconcile-unconfirmed';
import { ITransactionStatus, type ISubmitEvidence, type ITransaction } from '../db/types';

jest.mock('lib/settings/helpers', () => ({
  ...jest.requireActual('lib/settings/helpers'),
  isCrashReportingEnabledAsync: jest.fn(async () => true)
}));
jest.mock('lib/telemetry/report-operation', () => ({ reportOperation: jest.fn() }));
jest.mock('lib/telemetry/transaction-failure', () => {
  const actual = jest.requireActual<typeof import('lib/telemetry/transaction-failure')>(
    'lib/telemetry/transaction-failure'
  );
  return { ...actual, reportTransactionFailure: jest.fn(actual.reportTransactionFailure) };
});
jest.mock('../sdk/helpers', () => ({
  ...jest.requireActual('../sdk/helpers'),
  sameWalletAccountId: (a: string, b: string) => a === b
}));

const NOW = 1800000000;
const HEADER = `0x${'ab'.repeat(32)}`;
const INITIAL = `0x${'bc'.repeat(32)}`;
const FINAL = `0x${'cd'.repeat(32)}`;
const ACCOUNT = 'mtst1private-proof-wait-account';
const EXECUTING = 946237001234;
const SUBMITTING = EXECUTING + 9000;
const wire: string[] = [];
const roots: unknown[] = [];
let originalFetch: PropertyDescriptor | undefined;
let previousDsn: string | undefined;

const current = (overrides: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  attemptId: 'private-current-attempt',
  capturedAt: NOW - 50,
  source: 'stage',
  preSubmitEnd: true,
  refBlock: 100,
  expirationBlock: 700,
  ...overrides
});
const historical = (): ISubmitEvidence => ({
  attemptId: 'private-historical-attempt',
  capturedAt: NOW - 60,
  source: 'stage',
  transactionId: `0x${'de'.repeat(32)}`,
  initialCommitment: INITIAL,
  finalCommitment: FINAL,
  initialNonce: '5',
  outputNoteIds: [],
  nullifiers: [],
  refBlock: 100,
  refBlockCommitment: HEADER,
  expirationBlock: 700
});
const row = (overrides: Partial<ITransaction> = {}): ITransaction => ({
  id: 'private-proof-wait-row',
  accountId: ACCOUNT,
  type: 'consume',
  status: ITransactionStatus.Unconfirmed,
  initiatedAt: NOW - 120,
  stage: 'submitting',
  displayIcon: 'RECEIVE',
  mayHaveSubmitted: true,
  attemptId: 'private-current-attempt',
  stageTimestamps: { executing: EXECUTING, submitting: SUBMITTING },
  submitEvidence: [historical(), current()],
  rawError: 'failed to submit proven transaction: grpc request failed for submit_proven_transaction: deadline exceeded',
  ...overrides
});
const run = (during?: () => Promise<unknown>) =>
  judgeAndWrite('private-proof-wait-row', {
    nowSec: NOW,
    cadenceMs: 3000,
    node: {
      blockCommitment: async () => HEADER,
      account: async () => {
        await during?.();
        return { ok: true, state: { blockNum: 750, commitment: INITIAL } };
      },
      noteInclusions: async () => new Map(),
      nullifierHeight: async () => null
    }
  });
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
};

beforeAll(() => {
  originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  previousDsn = process.env.SENTRY_DSN;
  addEventProcessor((event, hint) => {
    roots.push(hint.originalException);
    return event;
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: unknown, init?: { body?: unknown }) => {
      if (String(input).includes('/envelope/')) wire.push(String(init?.body));
      return { status: 200, headers: new Headers() };
    }
  });
});
afterAll(() => {
  if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
  else Reflect.deleteProperty(globalThis, 'fetch');
  if (previousDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = previousDsn;
});
beforeEach(async () => {
  wire.length = 0;
  roots.length = 0;
  jest.clearAllMocks();
  process.env.SENTRY_DSN = 'https://publickey@o0.ingest.de.sentry.io/1';
  jest.mocked(isCrashReportingEnabledAsync).mockResolvedValue(true);
  await Repo.transactions.clear();
  initCrashReporting({ listenToGlobals: false });
});
afterEach(async () => {
  await settle();
  stopCrashReporting();
  getCurrentScope().clear();
});

interface AvailabilityCase {
  expected: string;
  overrides?: Partial<ITransaction>;
  entry?: Partial<ISubmitEvidence>;
  bucket?: string;
}
const cases: AvailabilityCase[] = [
  { expected: 'current_attempt_missing', overrides: { attemptId: undefined } },
  { expected: 'current_entry_missing', overrides: { attemptId: 'private-missing-attempt' } },
  { expected: 'execution_time_invalid', overrides: { stageTimestamps: { submitting: SUBMITTING } } },
  { expected: 'submit_time_invalid', overrides: { stageTimestamps: { executing: EXECUTING, submitting: NaN } } },
  {
    expected: 'time_order_invalid',
    overrides: { stageTimestamps: { executing: EXECUTING, submitting: EXECUTING - 1 } }
  },
  { expected: 'reference_block_missing', entry: { refBlock: undefined } },
  { expected: 'expiration_block_missing', entry: { expirationBlock: undefined } },
  { expected: 'reference_block_invalid', entry: { refBlock: NaN } },
  { expected: 'expiration_block_invalid', entry: { expirationBlock: Infinity } },
  { expected: 'expiry_order_invalid', entry: { expirationBlock: 100 } },
  {
    expected: 'derived_wait_invalid',
    overrides: { stageTimestamps: { executing: -Number.MAX_VALUE, submitting: Number.MAX_VALUE } }
  },
  { expected: 'derived_window_invalid', entry: { refBlock: -Number.MAX_VALUE, expirationBlock: Number.MAX_VALUE } },
  { expected: 'available', bucket: 'under_half_window' },
  {
    expected: 'current_attempt_missing',
    overrides: { attemptId: undefined, stageTimestamps: {} },
    entry: { refBlock: undefined, expirationBlock: undefined }
  },
  {
    expected: 'execution_time_invalid',
    overrides: { stageTimestamps: { executing: NaN, submitting: NaN } },
    entry: { refBlock: undefined }
  },
  {
    expected: 'execution_time_invalid',
    overrides: {
      stageTimestamps: Object.defineProperty({}, 'executing', { enumerable: true, value: 'private-invalid-time' })
    }
  },
  {
    expected: 'submit_time_invalid',
    overrides: {
      stageTimestamps: Object.defineProperty({ executing: EXECUTING }, 'submitting', {
        enumerable: true,
        value: 'private-invalid-time'
      })
    }
  },
  { expected: 'reference_block_missing', entry: { refBlock: undefined, expirationBlock: undefined } },
  { expected: 'expiration_block_missing', entry: { refBlock: NaN, expirationBlock: undefined } },
  { expected: 'reference_block_invalid', entry: { refBlock: NaN, expirationBlock: NaN } },
  {
    expected: 'derived_wait_invalid',
    overrides: { stageTimestamps: { executing: -Number.MAX_VALUE, submitting: Number.MAX_VALUE } },
    entry: { refBlock: -Number.MAX_VALUE, expirationBlock: Number.MAX_VALUE }
  },
  {
    expected: 'available',
    overrides: { stageTimestamps: { executing: EXECUTING, submitting: EXECUTING } },
    bucket: 'under_half_window'
  },
  {
    expected: 'available',
    overrides: { stageTimestamps: { executing: -10, submitting: -10 } },
    entry: { refBlock: -100 },
    bucket: 'under_half_window'
  },
  {
    expected: 'available',
    overrides: { stageTimestamps: { executing: 0, submitting: 900000 } },
    bucket: 'over_half_window'
  },
  {
    expected: 'available',
    overrides: { stageTimestamps: { executing: 0, submitting: 1803000 } },
    bucket: 'past_window'
  }
];

it.each(cases)(
  'retains only current calculation availability $expected through real verdict and serialized capture',
  async ({ expected, overrides, entry, bucket }) => {
    await Repo.transactions.put(row({ submitEvidence: [historical(), current(entry)], ...overrides }));
    expect((await run()).kind).toBe('never-committed');
    await settle();
    expect(wire).toHaveLength(1);
    const serialized = wire[0] ?? '';
    expect(serialized).toContain('point node_verdict; never_committed; rule expired');
    expect(serialized).toContain(`proof wait ${bucket ?? 'unavailable'}. authentication`);
    expect(serialized).toContain('"level":"error"');
    expect(serialized).toContain(`"proofWaitAvailability":"${expected}"`);
    for (const secret of [
      ACCOUNT,
      HEADER,
      INITIAL,
      FINAL,
      'private-current-attempt',
      'private-historical-attempt',
      String(EXECUTING),
      String(SUBMITTING)
    ])
      expect(serialized).not.toContain(secret);
    expect(await Repo.transactions.get('private-proof-wait-row')).toMatchObject({
      status: ITransactionStatus.Failed,
      neverCommittedAt: NOW
    });
    const nativeEvent: Record<string, unknown> = {
      extra: { walletDiagnostics: { proofWaitAvailability: 'private-injected', raw: ACCOUNT } }
    };
    scrubEvent(nativeEvent, { originalException: roots[0] });
    nativeEvent.extra = {
      walletDiagnostics: { proofWaitAvailability: 'current_entry_missing', privateTimestamp: EXECUTING }
    };
    scrubEvent(nativeEvent, { originalException: roots[0] });
    const nativeWire = JSON.stringify(nativeEvent);
    expect(nativeWire).toContain(`"proofWaitAvailability":"${expected}"`);
    expect(nativeWire).not.toContain('private-injected');
    expect(nativeWire).not.toContain(ACCOUNT);
    expect(nativeWire).not.toContain(String(EXECUTING));
  }
);

it.each(
  cases.filter(({ expected }) => ['current_attempt_missing', 'derived_window_invalid', 'available'].includes(expected))
)(
  'binds producer availability $expected to the same single report input only',
  async ({ expected, overrides, entry }) => {
    const report = jest.mocked(failureReporter.reportTransactionFailure);
    try {
      await Repo.transactions.put(row({ submitEvidence: [historical(), current(entry)], ...overrides }));
      expect((await run()).kind).toBe('never-committed');
      expect(report).toHaveBeenCalledTimes(1);
      const input = report.mock.calls[0]?.[0];
      expect(snapshotProofWaitAvailability(input)).toBe(expected);
      expect(snapshotProofWaitAvailability({ ...input })).toBeUndefined();
      expect(snapshotProofWaitAvailability(input?.error)).toBeUndefined();
    } finally {
      report.mockClear();
    }
  }
);

it.each([
  {
    label: 'valid current entry',
    entry: {},
    expected: [
      'reference',
      'expiration',
      'reference',
      'expiration',
      'expiration',
      'reference',
      'expiration',
      'reference'
    ]
  },
  { label: 'missing current reference', entry: { refBlock: undefined }, expected: ['reference'] }
])('preserves original short circuit and block field read order for $label', async ({ entry, expected }) => {
  const reads: string[] = [];
  let recording = false;
  const observeRead = (label: string, value: unknown) => () => {
    if (recording) reads.push(label);
    return value;
  };
  const updating = function (this: UpdatingHookContext<ITransaction, string>, modifications: unknown) {
    if (
      typeof modifications !== 'object' ||
      modifications === null ||
      Reflect.get(modifications, 'error') === undefined
    )
      return;
    const entries: unknown = Reflect.get(modifications, 'submitEvidence');
    if (!Array.isArray(entries)) return;
    for (const observed of entries) {
      if (
        typeof observed !== 'object' ||
        observed === null ||
        Reflect.get(observed, 'attemptId') !== 'private-current-attempt'
      )
        continue;
      for (const [field, label] of [
        ['refBlock', 'reference'],
        ['expirationBlock', 'expiration']
      ]) {
        if (field === undefined || label === undefined) continue;
        const value: unknown = Reflect.get(observed, field);
        Object.defineProperty(observed, field, {
          enumerable: true,
          configurable: true,
          get: observeRead(label, value)
        });
      }
    }
    const originalFind = entries.find.bind(entries);
    Object.defineProperty(entries, 'find', {
      configurable: true,
      value: (predicate: (value: unknown, index: number, members: unknown[]) => unknown) => {
        if (recording) reads.push('find');
        return originalFind((value, index, members) => {
          if (recording) reads.push('candidate');
          return predicate(value, index, members);
        });
      }
    });
    this.onsuccess = () => {
      recording = true;
    };
  };
  Repo.transactions.hook('updating', updating);
  try {
    await Repo.transactions.put(row({ submitEvidence: [historical(), current(entry)] }));
    expect((await run()).kind).toBe('never-committed');
    // The window `submitApproach` reports comes after the calculation above, which it leaves as it was.
    expect(reads).toEqual([
      'find',
      'candidate',
      'candidate',
      ...expected,
      'find',
      'candidate',
      'candidate',
      'reference',
      'expiration'
    ]);
  } finally {
    Repo.transactions.hook('updating').unsubscribe(updating);
  }
});

it.each(['status', 'evidence', 'restored'])(
  'does not invent a report after the selected row changes at the %s boundary',
  async change => {
    await Repo.transactions.put(row());
    await run(async () =>
      Repo.transactions.where({ id: 'private-proof-wait-row' }).modify(fresh => {
        if (change === 'status') fresh.status = ITransactionStatus.Completed;
        else if (change === 'restored') fresh.restoredFromBackup = true;
        else
          fresh.submitEvidence = [
            ...(fresh.submitEvidence ?? []),
            { attemptId: 'private-new-attempt', capturedAt: NOW, source: 'stage' }
          ];
      })
    );
    await settle();
    expect(wire).toHaveLength(0);
  }
);
it('uses the committed changed current attempt association rather than the selected id', async () => {
  await Repo.transactions.put(row());
  expect(
    (
      await run(async () =>
        Repo.transactions.where({ id: 'private-proof-wait-row' }).modify({ attemptId: 'private-new-current' })
      )
    ).kind
  ).toBe('never-committed');
  await settle();
  expect(wire).toHaveLength(1);
  expect(wire[0]).toContain('"proofWaitAvailability":"current_entry_missing"');
});
it('keeps the committed verdict and original report when the weak observation cannot be recorded', async () => {
  await Repo.transactions.put(row());
  const originalSet = WeakMap.prototype.set;
  const set = jest.spyOn(WeakMap.prototype, 'set').mockImplementation(function (
    this: WeakMap<WeakKey, unknown>,
    key: WeakKey,
    value: unknown
  ) {
    if (value === 'available') throw new Error('private observation failure');
    return originalSet.call(this, key, value);
  });
  try {
    expect((await run()).kind).toBe('never-committed');
    await settle();
    expect(wire).toHaveLength(1);
    expect(wire[0]).toContain('proof wait under_half_window');
    expect(wire[0]).not.toContain('proofWaitAvailability');
    expect(wire[0]).not.toContain('private observation failure');
  } finally {
    set.mockRestore();
  }
});

it('removes scope, native and structural canonical availability without producer provenance', async () => {
  getCurrentScope().setExtra('walletDiagnostics', { proofWaitAvailability: 'available', privateAccount: ACCOUNT });
  failureReporter.reportTransactionFailure({
    type: 'consume',
    point: 'node_verdict',
    reason: 'never_committed',
    neverCommittedRule: 'expired',
    error: Object.assign(new Error('private untrusted SDK failure'), { proofWaitAvailability: 'available' })
  });
  await settle();
  expect(wire).toHaveLength(1);
  expect(wire[0]).not.toContain('proofWaitAvailability');
  expect(wire[0]).not.toContain(ACCOUNT);
  const event: Record<string, unknown> = {
    extra: { walletDiagnostics: { proofWaitAvailability: 'available', raw: ACCOUNT } }
  };
  const scrubbed = scrubEvent(event, { originalException: roots[0] });
  expect(JSON.stringify(scrubbed)).not.toContain('proofWaitAvailability');
  expect(JSON.stringify(scrubbed)).not.toContain(ACCOUNT);
});
