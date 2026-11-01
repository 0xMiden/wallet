import { runInNewContext } from 'node:vm';

import { STRUCTURAL_GUARDIAN_TYPES } from 'lib/miden/db/types';
import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import {
  COMPLETION_GUARDS,
  COMPLETION_STEPS,
  GUARDIAN_SIGNER_IN_SET,
  GUARDIAN_SIGNING_KEYS,
  HOT_KEY_ROTATION_PENDING,
  PROPOSAL_GUARDS,
  PROPOSAL_STEPS,
  SECURITY_CHANGE_ACTIONS,
  annotateCrash,
  backgroundAgeOf,
  readPageNavigation,
  snapshotCrashDiagnostics,
  withCompletionStep,
  withProposalStep
} from './crash-diagnostics';
import { USER_ERROR_SURFACES } from './user-visible-error';

describe('source-bound crash diagnostics', () => {
  it.each(['landed-local', 'landed-external', 'invalid', 'processing', 'not-landed', 'unknown'])(
    'retains the closed consume verdict %s',
    consumeVerdict => {
      const failure = new Error('consume failed');
      annotateCrash(failure, { consumeVerdict });
      expect(snapshotCrashDiagnostics(failure)).toEqual({ consumeVerdict });
    }
  );

  it('takes no closed submit report field from a generic annotation or a cause', () => {
    const fields = {
      submitApproachHidden: 'half_or_more',
      proofWindow: 'under_30_blocks',
      submitHidden: 'yes',
      submitLeg: 'under_9s'
    } as const;
    const cause = new Error('cause');
    annotateCrash(cause, fields);
    const failure = new Error('wrapper', { cause });
    annotateCrash(failure, fields);
    for (const field of Object.keys(fields)) {
      expect(snapshotCrashDiagnostics(cause)).not.toHaveProperty(field);
      expect(snapshotCrashDiagnostics(failure)).not.toHaveProperty(field);
    }
  });

  it('rejects an unlisted consume verdict', () => {
    const failure = new Error('consume failed');
    annotateCrash(failure, { consumeVerdict: 'unlisted-consume-verdict' });
    expect(snapshotCrashDiagnostics(failure)).toEqual({});
  });

  it('accepts only the fixed client roles at client construction', () => {
    for (const clientRole of ['primary', 'realm_reader']) {
      const failure = new Error('client creation failed');
      annotateCrash(failure, { operation: 'sdk_initialize', stage: 'client_create', clientRole });
      expect(snapshotCrashDiagnostics(failure)).toMatchObject({ clientRole });
    }
    const invalid = new Error('client creation failed');
    annotateCrash(invalid, {
      operation: 'sdk_initialize',
      stage: 'client_create',
      clientRole: 'client /private/0xfeed'
    });
    expect(snapshotCrashDiagnostics(invalid)).toEqual({ operation: 'sdk_initialize', stage: 'client_create' });
    const wrongStage = new Error('client creation failed');
    annotateCrash(wrongStage, { operation: 'sdk_initialize', stage: 'mock_create', clientRole: 'primary' });
    expect(snapshotCrashDiagnostics(wrongStage)).toEqual({ operation: 'sdk_initialize', stage: 'mock_create' });
  });

  it('annotates a DOMException at the fixed client construction boundary', () => {
    const failure = new DOMException('database path /private/0xfeed and balance 12.5', 'UnknownError');
    annotateCrash(failure, {
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled',
      clientRole: 'realm_reader'
    });
    expect(snapshotCrashDiagnostics(failure)).toEqual({
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled',
      clientRole: 'realm_reader'
    });
    expect(JSON.stringify(snapshotCrashDiagnostics(failure))).not.toMatch(/private|0xfeed|12\.5/);
  });

  it('retains a coherent storage pair on the exact frozen Error', () => {
    const failure = Object.freeze(new Error('cursor request failed'));
    annotateCrash(failure, { storageOwner: 'wallet_transactions', storageOperation: 'cursor' });
    expect(snapshotCrashDiagnostics(failure)).toEqual({
      storageOwner: 'wallet_transactions',
      storageOperation: 'cursor'
    });
    expect(snapshotCrashDiagnostics(new Error('unrelated'))).toEqual({});
  });

  it('accepts every compatible closed owner and operation', () => {
    for (const storageOwner of ['wallet_transactions', 'wallet_limits']) {
      for (const storageOperation of ['get', 'query', 'count', 'cursor', 'mutate', 'transaction', 'open']) {
        const pair = { storageOwner, storageOperation };
        const failure = new Error('storage failure');
        annotateCrash(failure, pair);
        expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
      }
    }
    for (const storageOperation of ['transaction', 'open']) {
      const pair = { storageOwner: 'wallet_database', storageOperation };
      const failure = new Error('database failure');
      annotateCrash(failure, pair);
      expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
    }
    const diagnostics = jest.requireActual<Record<string, unknown>>('./crash-diagnostics');
    const valueSets: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['STORAGE_OWNERS', ['wallet_transactions', 'wallet_limits', 'wallet_database']],
      ['STORAGE_OPERATIONS', ['get', 'query', 'count', 'cursor', 'mutate', 'transaction', 'open']],
      ['PAGE_VISIBILITY', ['visible', 'hidden', 'unknown']]
    ];
    for (const [name, values] of valueSets) {
      const exported = diagnostics[name];
      expect(Array.isArray(exported)).toBe(true);
      if (!Array.isArray(exported)) throw new Error('missing closed value list');
      expect(exported).toHaveLength(values.length);
      expect(new Set(exported)).toEqual(new Set(values));
    }
  });

  it('rejects hostile and incompatible storage metadata without changing the failure', () => {
    const coerce = jest.fn(() => 'wallet_transactions');
    const poisoned = { toString: coerce, valueOf: coerce, [Symbol.toPrimitive]: coerce };
    const invalid: Record<string, unknown>[] = [
      { storageOwner: 'wallet_other', storageOperation: 'get' },
      { storageOwner: 'WALLET_TRANSACTIONS', storageOperation: 'cursor' },
      { storageOwner: 'wallet_transactions', storageOperation: 'CURSOR' },
      { storageOwner: poisoned, storageOperation: 'cursor' },
      { storageOwner: 'wallet_transactions', storageOperation: poisoned },
      { storageOwner: 'wallet_transactions', storageOperation: 'fetch' },
      { storageOwner: 'wallet_transactions' },
      { storageOwner: 'wallet_other', storageOperation: 'open' },
      { storageOwner: null, storageOperation: 'open' },
      { storageOperation: 'get' },
      { storageOperation: 'query' },
      { storageOperation: 'count' },
      { storageOperation: 'cursor' },
      { storageOperation: 'mutate' },
      { storageOperation: 'transaction' },
      { storageOperation: 'open' },
      { pageVisibility: 'visible' }
    ];
    for (const storageOperation of ['get', 'query', 'count', 'cursor', 'mutate']) {
      invalid.push({ storageOwner: 'wallet_database', storageOperation });
    }
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile Error check');
        }
      }
    );
    for (const input of invalid) {
      const failure = Object.freeze(new Error('original failure'));
      annotateCrash(failure, input);
      expect(snapshotCrashDiagnostics(failure)).toEqual({});
      expect(Object.getOwnPropertyNames(failure)).toEqual(['stack', 'message']);
      expect(() => annotateCrash(null, input)).not.toThrow();
      expect(() => annotateCrash(hostile, input)).not.toThrow();
      expect(snapshotCrashDiagnostics(hostile)).toEqual({});
    }
    expect(coerce).not.toHaveBeenCalled();
  });

  it('does not erase a valid pair or retain an unknown field', () => {
    const failure = new Error('failure');
    const pair = { storageOwner: 'wallet_limits', storageOperation: 'mutate' };
    annotateCrash(failure, pair);
    let payloadReads = 0;
    const payload: PropertyDescriptor = {
      get() {
        payloadReads++;
        throw new Error('payload must not be read');
      }
    };
    for (const input of [
      { storageOwner: 'wallet_transactions' },
      { storageOperation: 'get' },
      { storageOwner: 'wallet_database', storageOperation: 'cursor' },
      { storageOwner: 'unknown', storageOperation: 'open' }
    ]) {
      annotateCrash(failure, Object.defineProperty({ ...input }, 'payload', payload));
      expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
    }
    expect(payloadReads).toBe(0);
    expect(snapshotCrashDiagnostics(Object.assign(new Error('public fields'), pair))).toEqual({});
  });

  it('reads supplied storage accessors once and survives a throwing getter', () => {
    const failure = new Error('failure');
    let ownerReads = 0;
    let operationReads = 0;
    annotateCrash(failure, {
      get storageOwner() {
        return ownerReads++ === 0 ? 'wallet_transactions' : 'poison';
      },
      get storageOperation() {
        return operationReads++ === 0 ? 'cursor' : 'poison';
      }
    });
    const pair = { storageOwner: 'wallet_transactions', storageOperation: 'cursor' };
    expect(ownerReads).toBe(1);
    expect(operationReads).toBe(1);
    expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
    for (const field of ['storageOwner', 'storageOperation']) {
      const input = Object.defineProperty({ ...pair }, field, {
        get() {
          throw new Error('hostile accessor');
        }
      });
      expect(() => annotateCrash(failure, input)).not.toThrow();
      expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
      const unrelated = new Error('unrelated');
      expect(() => annotateCrash(unrelated, input)).not.toThrow();
      expect(snapshotCrashDiagnostics(unrelated)).toEqual({});
    }
  });

  it('selects whole storage annotations across bounded causes', () => {
    const inner = new Error('inner');
    annotateCrash(inner, {
      storageOwner: 'wallet_transactions',
      storageOperation: 'cursor',
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled'
    });
    const outer = new Error('outer', { cause: inner });
    annotateCrash(outer, { storageOwner: 'wallet_limits', storageOperation: 'get', stage: 'wasm_ready' });
    expect(snapshotCrashDiagnostics(outer)).toEqual({
      storageOwner: 'wallet_limits',
      storageOperation: 'get',
      operation: 'sdk_initialize',
      stage: 'wasm_ready',
      workerMode: 'disabled'
    });
    const opening = new Error('opening', { cause: inner });
    annotateCrash(opening, { storageOwner: 'wallet_database', storageOperation: 'open' });
    expect(snapshotCrashDiagnostics(opening)).toEqual({
      storageOwner: 'wallet_database',
      storageOperation: 'open',
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled'
    });
    let wrapper = inner;
    for (let i = 0; i < 3; i++) wrapper = new Error('wrapper', { cause: wrapper });
    expect(snapshotCrashDiagnostics(wrapper)).toEqual(snapshotCrashDiagnostics(inner));
    expect(snapshotCrashDiagnostics(new Error('fifth', { cause: wrapper }))).toEqual({});
    Object.defineProperty(inner, 'cause', { value: outer });
    expect(snapshotCrashDiagnostics(outer).storageOwner).toBe('wallet_limits');
    const hostile = new Error('hostile');
    annotateCrash(hostile, { storageOwner: 'wallet_limits', storageOperation: 'count' });
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('inaccessible cause');
      }
    });
    expect(snapshotCrashDiagnostics(hostile)).toEqual({ storageOwner: 'wallet_limits', storageOperation: 'count' });
  });

  it('promotes only unanimous validated storage pairs through fixed Dexie links', () => {
    const pair = { storageOwner: 'wallet_transactions', storageOperation: 'mutate' };
    const first = Object.freeze(new Error('first'));
    const second = new Error('second');
    annotateCrash(first, pair);
    annotateCrash(second, pair);
    expect(snapshotCrashDiagnostics(Object.assign(new Error('scalar'), { inner: first }))).toEqual(pair);
    expect(snapshotCrashDiagnostics(Object.assign(new Error('bulk'), { failures: [first, second] }))).toEqual(pair);
    const otherOwner = new Error('other owner');
    annotateCrash(otherOwner, { storageOwner: 'wallet_limits', storageOperation: 'mutate' });
    const otherOperation = new Error('other operation');
    annotateCrash(otherOperation, { storageOwner: 'wallet_transactions', storageOperation: 'get' });
    const opening = new Error('opening');
    annotateCrash(opening, { storageOperation: 'open' });
    for (const entry of [
      otherOwner,
      otherOperation,
      new Error('unannotated'),
      opening,
      null,
      'failure',
      Object.assign(new Error('public poison'), pair),
      { ...pair }
    ]) {
      expect(snapshotCrashDiagnostics(Object.assign(new Error('mixed'), { failures: [first, entry] }))).toEqual({});
    }
    expect(snapshotCrashDiagnostics(Object.assign(new Error('empty'), { failures: [] }))).toEqual({});
    const explicit = Object.assign(new Error('explicit'), { failures: [first, otherOwner] });
    annotateCrash(explicit, { storageOwner: 'wallet_database', storageOperation: 'open' });
    expect(snapshotCrashDiagnostics(explicit)).toEqual({ storageOwner: 'wallet_database', storageOperation: 'open' });
    const combined = Object.assign(new Error('two links'), { inner: first, failures: [second, otherOperation] });
    expect(snapshotCrashDiagnostics(combined)).toEqual({});
    const nonStorage = Object.assign(new Error('wrapper'), { inner: first });
    annotateCrash(first, { operation: 'sdk_initialize' });
    expect(snapshotCrashDiagnostics(nonStorage)).toEqual(pair);
  });

  it('bounds hostile and oversized fixed error links', () => {
    const pair = { storageOwner: 'wallet_transactions', storageOperation: 'cursor' };
    const leaf = new Error('leaf');
    annotateCrash(leaf, pair);
    let nested = leaf;
    for (let i = 0; i < 3; i++) nested = Object.assign(new Error('nested'), { inner: nested });
    expect(snapshotCrashDiagnostics(nested)).toEqual(pair);
    const invalid: Error[] = [Object.assign(new Error('fifth'), { inner: nested })];
    const cycle = new Error('cycle');
    Object.assign(cycle, { inner: cycle });
    invalid.push(cycle);
    for (const field of ['inner', 'failures']) {
      invalid.push(
        Object.defineProperty(new Error('hostile link'), field, {
          get() {
            throw new Error('link must be guarded');
          }
        })
      );
    }
    const inaccessibleEntries = [leaf, leaf];
    Object.defineProperty(inaccessibleEntries, '1', {
      get() {
        throw new Error('inaccessible entry');
      }
    });
    invalid.push(Object.assign(new Error('entry'), { failures: inaccessibleEntries }));
    invalid.push(Object.assign(new Error('invalid failures'), { failures: {} }));
    invalid.push(Object.assign(new Error('invalid inner'), { inner: {} }));
    let lengthCoercions = 0;
    const poisonedLength = {
      [Symbol.toPrimitive]() {
        lengthCoercions++;
        return 1;
      }
    };
    for (const length of [0.5, -1, NaN, Infinity, '1', poisonedLength]) {
      const failures = new Proxy([leaf, new Error('unannotated')], {
        get(target, key, receiver): unknown {
          return key === 'length' ? length : Reflect.get(target, key, receiver);
        }
      });
      invalid.push(Object.assign(new Error('invalid length'), { failures }));
    }
    const entries = Array.from({ length: 31 }, () => {
      const failure = new Error('entry');
      annotateCrash(failure, pair);
      return failure;
    });
    expect(snapshotCrashDiagnostics(Object.assign(new Error('32 nodes'), { failures: entries }))).toEqual(pair);
    invalid.push(Object.assign(new Error('33 nodes'), { failures: [...entries, leaf] }));
    expect(
      snapshotCrashDiagnostics(
        Object.assign(new Error('32 entries'), {
          failures: Array.from({ length: 32 }, () => leaf)
        })
      )
    ).toEqual(pair);
    let oversizedReads = 0;
    const oversized = Array.from({ length: 33 }, () => leaf);
    Object.defineProperty(oversized, '0', {
      get() {
        oversizedReads++;
        return leaf;
      }
    });
    invalid.push(Object.assign(new Error('33 entries'), { failures: oversized }));
    const group = Object.assign(new Error('group'), { failures: Array.from({ length: 17 }, () => leaf) });
    invalid.push(Object.assign(new Error('nested entries'), { failures: [group, group] }));
    for (const failure of invalid) {
      annotateCrash(failure, { operation: 'sdk_initialize', stage: 'client_create' });
      expect(snapshotCrashDiagnostics(failure)).toEqual({ operation: 'sdk_initialize', stage: 'client_create' });
    }
    expect(oversizedReads).toBe(0);
    expect(lengthCoercions).toBe(0);
    let forbiddenReads = 0;
    const protectedFailure = Object.assign(new Error('protected'), { inner: leaf });
    const forbidden: PropertyDescriptor = {
      get() {
        forbiddenReads++;
        throw new Error('private field');
      }
    };
    for (const field of ['payload', 'failedKeys', 'failuresByPos', 'message', 'name', 'row', 'request']) {
      Object.defineProperty(protectedFailure, field, forbidden);
    }
    expect(snapshotCrashDiagnostics(protectedFailure)).toEqual(pair);
    expect(forbiddenReads).toBe(0);
  });

  it.each<{ link: string; wrap: (cause: Error) => Error }>([
    {
      link: 'aggregate member',
      wrap: cause => Object.assign(new Error('aggregate', { cause }), { failures: [new Error('unannotated')] })
    },
    {
      link: 'scalar .inner',
      wrap: cause => Object.assign(new Error('scalar', { cause }), { inner: new Error('unannotated') })
    }
  ])('preserves inherited storage beside an unannotated $link', ({ wrap }) => {
    const cause = new Error('cause');
    annotateCrash(cause, {
      storageOwner: 'wallet_transactions',
      storageOperation: 'cursor',
      operation: 'sdk_initialize',
      stage: 'client_create',
      workerMode: 'disabled'
    });
    const outer = wrap(cause);
    annotateCrash(outer, { stage: 'wasm_ready' });
    expect(snapshotCrashDiagnostics(outer)).toEqual({
      storageOwner: 'wallet_transactions',
      storageOperation: 'cursor',
      operation: 'sdk_initialize',
      stage: 'wasm_ready',
      workerMode: 'disabled'
    });
  });

  it.each<{ link: string; wrap: (cause: Error) => Error }>([
    {
      link: 'conflicting owners',
      wrap: cause => {
        const other = new Error('other owner');
        annotateCrash(other, { storageOwner: 'wallet_limits', storageOperation: 'cursor' });
        return Object.assign(new Error('aggregate', { cause }), { failures: [cause, other] });
      }
    },
    {
      link: 'conflicting operations',
      wrap: cause => {
        const other = new Error('other operation');
        annotateCrash(other, { storageOwner: 'wallet_transactions', storageOperation: 'get' });
        return Object.assign(new Error('aggregate', { cause }), { failures: [cause, other] });
      }
    },
    ...['inner', 'failures'].map(field => ({
      link: `throwing ${field} getter`,
      wrap: (cause: Error): Error =>
        Object.defineProperty(new Error('inaccessible link', { cause }), field, {
          get() {
            throw new Error('inaccessible link');
          }
        })
    })),
    {
      link: 'throwing failure entry getter',
      wrap: cause => {
        const failures = [cause, cause];
        Object.defineProperty(failures, '1', {
          get() {
            throw new Error('inaccessible entry');
          }
        });
        return Object.assign(new Error('aggregate', { cause }), { failures });
      }
    },
    {
      link: 'oversized failure array',
      wrap: cause =>
        Object.assign(new Error('aggregate', { cause }), {
          failures: Array.from({ length: 33 }, () => cause)
        })
    },
    {
      link: 'oversized Error graph',
      wrap: cause =>
        Object.assign(new Error('aggregate', { cause }), {
          failures: Array.from({ length: 32 }, () => {
            const failure = new Error('entry');
            annotateCrash(failure, { storageOwner: 'wallet_transactions', storageOperation: 'cursor' });
            return failure;
          })
        })
    }
  ])(
    'clears inherited storage for $link while preserving other diagnostics and explicit outer precedence',
    ({ wrap }) => {
      const cause = new Error('cause');
      annotateCrash(cause, {
        storageOwner: 'wallet_transactions',
        storageOperation: 'cursor',
        operation: 'sdk_initialize',
        stage: 'client_create',
        workerMode: 'disabled'
      });
      const outer = wrap(cause);
      annotateCrash(outer, { stage: 'wasm_ready' });
      const other = { operation: 'sdk_initialize', stage: 'wasm_ready', workerMode: 'disabled' };
      expect(snapshotCrashDiagnostics(outer)).toEqual(other);
      annotateCrash(outer, { storageOwner: 'wallet_database', storageOperation: 'open' });
      expect(snapshotCrashDiagnostics(outer)).toEqual({
        ...other,
        storageOwner: 'wallet_database',
        storageOperation: 'open'
      });
      annotateCrash(outer, { storageOperation: 'open' });
      expect(snapshotCrashDiagnostics(outer)).toEqual({
        ...other,
        storageOwner: 'wallet_database',
        storageOperation: 'open'
      });
    }
  );

  it('returns detached storage snapshots', () => {
    const failure = new Error('failure');
    const pair = { storageOwner: 'wallet_transactions', storageOperation: 'get' };
    annotateCrash(failure, pair);
    const changed = snapshotCrashDiagnostics(failure);
    Object.assign(changed, { storageOwner: 'wallet_limits', storageOperation: 'count' });
    expect(snapshotCrashDiagnostics(failure)).toEqual(pair);
    const earlier = snapshotCrashDiagnostics(failure);
    const next = { storageOwner: 'wallet_database', storageOperation: 'transaction' };
    annotateCrash(failure, next);
    expect(earlier).toEqual(pair);
    expect(snapshotCrashDiagnostics(failure)).toEqual(next);
    annotateCrash(failure, { storageOperation: 'open' });
    expect(snapshotCrashDiagnostics(failure)).toEqual(next);
  });

  it('reads page visibility once with honest unknown fallback', () => {
    const diagnostics = jest.requireActual<Record<string, unknown>>('./crash-diagnostics');
    const readVisibility = diagnostics.readPageVisibility;
    expect(typeof readVisibility).toBe('function');
    if (typeof readVisibility !== 'function') throw new Error('missing visibility reader');
    const realm: Record<string, unknown> = {};
    const readInRealm = (): unknown => runInNewContext(`(${readVisibility.toString()})()`, realm);
    const cases: ReadonlyArray<readonly [PropertyDescriptor, string]> = [
      [{ value: { visibilityState: 'visible' } }, 'visible'],
      [{ value: { visibilityState: 'hidden' } }, 'hidden'],
      [{ value: { visibilityState: 'prerender' } }, 'unknown'],
      [{ value: { visibilityState: undefined } }, 'unknown'],
      [{ value: undefined }, 'unknown'],
      [
        {
          get() {
            throw new Error('inaccessible document');
          }
        },
        'unknown'
      ],
      [
        {
          value: {
            get visibilityState() {
              throw new Error('inaccessible visibility');
            }
          }
        },
        'unknown'
      ]
    ];
    for (const [descriptor, expected] of cases) {
      try {
        Object.defineProperty(realm, 'document', { configurable: true, ...descriptor });
        expect(readInRealm()).toBe(expected);
      } finally {
        Reflect.deleteProperty(realm, 'document');
      }
    }
    expect(readInRealm()).toBe('unknown');
    let reads = 0;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() {
          return reads++ === 0 ? 'visible' : 'hidden';
        }
      });
      expect(readVisibility()).toBe('visible');
      expect(reads).toBe(1);
    } finally {
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('loads and validates user-error diagnostics without loading a reporter or crash client', () => {
    const forbiddenDependencies = ['./user-visible-error', './crash'];
    for (const dependency of forbiddenDependencies) {
      jest.doMock(dependency, () => {
        throw new Error(`diagnostics loaded forbidden runtime ${dependency}`);
      });
    }

    try {
      let snapshot: unknown;
      expect(() =>
        jest.isolateModules(() => {
          const diagnostics = jest.requireActual<typeof import('./crash-diagnostics')>('./crash-diagnostics');
          const error = new Error('failure');
          diagnostics.annotateCrash(error, {
            userErrorId: 'usdcxFaucetUnavailable',
            userErrorSurface: 'review',
            message: 'private failure text'
          });
          snapshot = diagnostics.snapshotCrashDiagnostics(error);
        })
      ).not.toThrow();
      expect(snapshot).toEqual({ userErrorId: 'usdcxFaucetUnavailable', userErrorSurface: 'review' });
    } finally {
      for (const dependency of forbiddenDependencies) jest.dontMock(dependency);
    }
  });

  it('accepts the closed user-visible error id and every display surface', () => {
    for (const userErrorSurface of USER_ERROR_SURFACES) {
      const error = new Error('failure');
      annotateCrash(error, { userErrorId: 'usdcxFaucetUnavailable', userErrorSurface });
      expect(snapshotCrashDiagnostics(error)).toEqual({ userErrorId: 'usdcxFaucetUnavailable', userErrorSurface });
    }
  });

  it('drops user-visible error text and unlisted surfaces independently', () => {
    const error = new Error('failure');
    annotateCrash(error, { userErrorId: 'Unable to read 0x12ab', userErrorSurface: 'review' });
    expect(snapshotCrashDiagnostics(error)).toEqual({ userErrorSurface: 'review' });
    const other = new Error('failure');
    annotateCrash(other, { userErrorId: 'usdcxFaucetUnavailable', userErrorSurface: 'toast' });
    expect(snapshotCrashDiagnostics(other)).toEqual({ userErrorId: 'usdcxFaucetUnavailable' });
    const invalid = new Error('failure');
    annotateCrash(invalid, { userErrorId: { toString: () => 'usdcxFaucetUnavailable' }, userErrorSurface: null });
    expect(snapshotCrashDiagnostics(invalid)).toEqual({});
  });

  it('keeps diagnostics on the exact failure rather than the latest operation', () => {
    const first = new Error('first');
    const second = new Error('second');
    annotateCrash(first, { operation: 'intercom_request', requestType: WalletMessageType.UnlockRequest });
    annotateCrash(second, { operation: 'confirm_payload', confirmationId: 'missing' });
    expect(snapshotCrashDiagnostics(first)).toEqual({ operation: 'intercom_request', requestType: 'UNLOCK_REQUEST' });
    expect(snapshotCrashDiagnostics(second)).toEqual({ operation: 'confirm_payload', confirmationId: 'missing' });
    expect(snapshotCrashDiagnostics(new Error('third'))).toEqual({});
  });

  it('accepts only authoritative request enums, not response types or payload values', () => {
    for (const requestType of [WalletMessageType.UnlockResponse, 'password=sensitive', 'UNLOCK_REQUEST_suffix']) {
      const error = new Error('failure');
      annotateCrash(error, { requestType });
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
    const error = new Error('failure');
    annotateCrash(error, { requestType: MidenMessageType.DAppGetPayloadRequest });
    expect(snapshotCrashDiagnostics(error)).toEqual({ requestType: MidenMessageType.DAppGetPayloadRequest });
  });

  it('drops unknown fields and poisoned enum values without retaining their objects', () => {
    const error = new Error('failure');
    const poisoned = { operation: 'seed phrase', stage: 'unknown', workerMode: 'url', payload: 'secret' };
    annotateCrash(error, poisoned);
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    Object.assign(error, { operation: 'intercom_request' });
    expect(snapshotCrashDiagnostics(error)).toEqual({});
    expect(() => annotateCrash(null, poisoned)).not.toThrow();
  });

  it('cannot replace the original failure when a hostile object rejects Error checks', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile object');
        }
      }
    );
    expect(() => annotateCrash(hostile, { operation: 'sdk_initialize' })).not.toThrow();
    expect(snapshotCrashDiagnostics(hostile)).toEqual({});
  });

  it('never accepts a changing accessor after the allowlist check', () => {
    const error = new Error('failure');
    let reads = 0;
    const poisoned = {
      get operation() {
        return reads++ === 0 ? 'intercom_request' : 'secret phrase';
      }
    };
    annotateCrash(error, poisoned);
    expect(snapshotCrashDiagnostics(error)).toEqual({ operation: 'intercom_request' });
  });

  it("keeps a startup trap's memory evidence only as its fixed values", () => {
    const error = new Error('unreachable');
    annotateCrash(error, { sharedMemoryProbe: 'refused', extensionViews: '2-3' });
    expect(snapshotCrashDiagnostics(error)).toEqual({ sharedMemoryProbe: 'refused', extensionViews: '2-3' });
    for (const [sharedMemoryProbe, extensionViews] of [
      [5, 5],
      ['5', '5'],
      ['RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded', '4 +'],
      ['REFUSED', 'one']
    ]) {
      const dropped = new Error('unreachable');
      annotateCrash(dropped, { sharedMemoryProbe, extensionViews });
      expect(snapshotCrashDiagnostics(dropped)).toEqual({});
    }
  });

  it.each(['open', 'answered', 'window_closed', 'expired', 'payload_failed', 'unknown'])(
    "reads the background's confirmation_%s code back to its state",
    state => {
      const error = new Error('Not Found');
      annotateCrash(error, { confirmationHandler: `confirmation_${state}`, portReconnected: true });
      expect(snapshotCrashDiagnostics(error)).toEqual({ confirmationHandler: state, portReconnected: true });
    }
  );

  it('drops a confirmation code or a reconnect flag that is not exactly one of its values', () => {
    for (const confirmationHandler of [
      'expired',
      'confirmation_unknown 0xab',
      `0x${'ab'.repeat(32)}`,
      'confirmation_V1StGXR8_Z5jdHi6B-myT',
      'confirmation_',
      7
    ]) {
      const error = new Error('Not Found');
      annotateCrash(error, { confirmationHandler, portReconnected: 'true' });
      annotateCrash(error, { portReconnected: 1 });
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
    const error = new Error('Not Found');
    annotateCrash(error, { portReconnected: false });
    expect(snapshotCrashDiagnostics(error)).toEqual({ portReconnected: false });
  });

  it("reads the request shape, registry state and age the background's code carries after the state", () => {
    const error = new Error('Not Found');
    annotateCrash(error, {
      confirmationHandler: 'confirmation_unknown:array_with_string:pruned:10_to_60s',
      pageNavigation: 'reload'
    });
    expect(snapshotCrashDiagnostics(error)).toEqual({
      confirmationHandler: 'unknown',
      confirmationRequestShape: 'array_with_string',
      confirmationRegistry: 'pruned',
      backgroundAge: '10_to_60s',
      pageNavigation: 'reload'
    });
  });

  it('drops the whole code when any part after the state is not exactly one of its values', () => {
    for (const confirmationHandler of [
      'confirmation_unknown:',
      'confirmation_unknown:string',
      'confirmation_unknown:string:empty',
      'confirmation_unknown:string:empty:under_10s:',
      'confirmation_unknown:string:empty:under_10s:navigate',
      'confirmation_unknown:V1StGXR8_Z5jdHi6B-myT:empty:under_10s',
      'confirmation_unknown:string:V1StGXR8_Z5jdHi6B-myT:under_10s',
      'confirmation_unknown:string:empty:12034',
      'confirmation_V1StGXR8_Z5jdHi6B-myT:string:empty:under_10s'
    ]) {
      const error = new Error('Not Found');
      annotateCrash(error, { confirmationHandler, pageNavigation: 'https://evil.example/' });
      expect(snapshotCrashDiagnostics(error)).toEqual({});
    }
  });

  it.each([
    [0, 'under_10s'],
    [9_999, 'under_10s'],
    [10_000, '10_to_60s'],
    [59_999, '10_to_60s'],
    [60_000, '60_to_300s'],
    [299_999, '60_to_300s'],
    [300_000, 'over_300s'],
    [-1, 'unknown'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown']
  ])('buckets a background running for %p ms as %s', (ms, age) => {
    expect(backgroundAgeOf(ms)).toBe(age);
  });

  it("reads the page's navigation type, and unknown for anything else", () => {
    const withEntries = (getEntriesByType: (type: string) => unknown): string => {
      Object.defineProperty(performance, 'getEntriesByType', { configurable: true, value: getEntriesByType });
      try {
        return readPageNavigation();
      } finally {
        Reflect.deleteProperty(performance, 'getEntriesByType');
      }
    };
    for (const type of ['navigate', 'reload', 'back_forward', 'prerender']) {
      expect(withEntries(kind => (kind === 'navigation' ? [{ type }] : []))).toBe(type);
    }
    expect(withEntries(() => [{ type: 'https://evil.example/' }])).toBe('unknown');
    expect(withEntries(() => [])).toBe('unknown');
    expect(withEntries(() => [null])).toBe('unknown');
    expect(
      withEntries(() => {
        throw new Error('no timeline');
      })
    ).toBe('unknown');
    expect(readPageNavigation()).toBe('unknown');
  });

  it('returns detached snapshots and preserves annotations across wrappers', () => {
    const cause = new Error('cause');
    annotateCrash(cause, { operation: 'sdk_initialize', stage: 'client_create', workerMode: 'disabled' });
    const outer = new Error('outer', { cause });
    const snapshot = snapshotCrashDiagnostics(outer);
    expect(snapshot).toEqual({ operation: 'sdk_initialize', stage: 'client_create', workerMode: 'disabled' });
    snapshot.stage = 'mock_create';
    expect(snapshotCrashDiagnostics(outer).stage).toBe('client_create');
    Object.defineProperty(cause, 'cause', { value: outer });
    expect(snapshotCrashDiagnostics(outer).stage).toBe('client_create');
  });

  it('reports the structural guardian actions and no fourth name', () => {
    expect(SECURITY_CHANGE_ACTIONS).toEqual(STRUCTURAL_GUARDIAN_TYPES);
  });

  it('names only a closed security change beside the proposal step it records', () => {
    const accountId = 'mtst1qprivateaccount00';
    const hex = '0xabcdef1234';
    const amount = '987654321';
    const privateFailure = () => new Error(`fungible vault account ${accountId} ${hex} amount ${amount}`);
    for (const securityChange of ['switch-guardian', 'replace-hot-key', 'update-procedure-threshold'] as const) {
      const error = privateFailure();
      annotateCrash(error, { proposalStep: 'proposal_create', securityChange });
      const snapshot = snapshotCrashDiagnostics(error);
      expect(snapshot).toEqual({ proposalStep: 'proposal_create', securityChange });
      const reported = JSON.stringify(snapshot);
      expect(reported).not.toContain(accountId);
      expect(reported).not.toContain(hex);
      expect(reported).not.toContain(amount);
      expect(reported).not.toMatch(/0x[0-9a-f]/i);
    }
    const unlisted = privateFailure();
    annotateCrash(unlisted, { proposalStep: 'proposal_create', securityChange: `rotation ${hex} amount ${amount}` });
    annotateCrash(unlisted, { proposalStep: 'proposal_create', securityChange: { toString: () => 'switch-guardian' } });
    const unlistedSnapshot = snapshotCrashDiagnostics(unlisted);
    expect(unlistedSnapshot).toEqual({ proposalStep: 'proposal_create' });
    expect(JSON.stringify(unlistedSnapshot)).not.toContain(accountId);
    expect(JSON.stringify(unlistedSnapshot)).not.toContain(hex);
    expect(JSON.stringify(unlistedSnapshot)).not.toContain(amount);
    const alone = privateFailure();
    annotateCrash(alone, { securityChange: 'switch-guardian' });
    expect(snapshotCrashDiagnostics(alone)).toEqual({});
    const otherStep = privateFailure();
    annotateCrash(otherStep, { proposalStep: 'chain_sync', securityChange: 'switch-guardian' });
    expect(snapshotCrashDiagnostics(otherStep)).toEqual({ proposalStep: 'chain_sync' });
    const inner = privateFailure();
    annotateCrash(inner, { proposalStep: 'proposal_create', securityChange: 'switch-guardian' });
    const wrapped = new Error('wrapper', { cause: inner });
    annotateCrash(wrapped, { proposalStep: 'chain_sync' });
    expect(snapshotCrashDiagnostics(wrapped)).toEqual({ proposalStep: 'chain_sync' });
    const kept = privateFailure();
    annotateCrash(kept, { proposalStep: 'proposal_create', securityChange: 'replace-hot-key' });
    annotateCrash(kept, {
      proposalStep: 'chain_sync',
      securityChange: 'switch-guardian',
      proposalGuard: 'hot_key_missing'
    });
    expect(snapshotCrashDiagnostics(kept)).toEqual({
      proposalStep: 'proposal_create',
      securityChange: 'replace-hot-key'
    });
  });

  it('accepts every proposal step and guard, and a guard only beside its step', () => {
    for (const proposalStep of PROPOSAL_STEPS) {
      for (const proposalGuard of PROPOSAL_GUARDS) {
        const error = new Error('refused');
        annotateCrash(error, { proposalStep, proposalGuard });
        expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep, proposalGuard });
      }
    }
    const guardOnly = new Error('guard only');
    annotateCrash(guardOnly, { proposalGuard: 'hot_key_missing' });
    expect(snapshotCrashDiagnostics(guardOnly)).toEqual({});
    const unlisted = new Error('unlisted');
    annotateCrash(unlisted, { proposalStep: 'consume_build 0xabcdef', proposalGuard: 'other' });
    annotateCrash(unlisted, { proposalStep: { toString: () => 'service_load' } });
    expect(snapshotCrashDiagnostics(unlisted)).toEqual({});
  });

  it('keeps the innermost proposal step when an outer boundary names a broader one', async () => {
    const error = new Error('load failed');
    const inner = withProposalStep('service_load', () => Promise.reject(error));
    await expect(withProposalStep('service_select', () => inner)).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load' });
    annotateCrash(error, { proposalStep: 'chain_sync', proposalGuard: 'account_not_guardian', portReconnected: true });
    expect(snapshotCrashDiagnostics(error)).toEqual({ proposalStep: 'service_load', portReconnected: true });
  });

  it('returns the operation result and rethrows a non-Error rejection untouched', async () => {
    await expect(withProposalStep('proposal_create', async () => 7)).resolves.toBe(7);
    const refusal = { status: 409 };
    await expect(withProposalStep('proposal_create', () => Promise.reject(refusal))).rejects.toBe(refusal);
  });

  it('names the submit-crossing steps and the guardian sync guard as proposal facts', () => {
    expect(PROPOSAL_STEPS).toEqual(expect.arrayContaining(['submit_serialize', 'submit_pin', 'client_build']));
    expect(PROPOSAL_GUARDS).toContain('guardian_out_of_sync');
    const error = new Error('guardian out of sync');
    annotateCrash(error, { proposalStep: 'service_select', proposalGuard: 'guardian_out_of_sync' });
    expect(snapshotCrashDiagnostics(error)).toEqual({
      proposalStep: 'service_select',
      proposalGuard: 'guardian_out_of_sync'
    });
  });

  it('accepts the Guardian signer facts only as listed values, and only together', () => {
    for (const guardianSignerInSet of GUARDIAN_SIGNER_IN_SET) {
      for (const guardianSigningKey of GUARDIAN_SIGNING_KEYS) {
        for (const hotKeyRotationPending of HOT_KEY_ROTATION_PENDING) {
          const error = new Error('authentication failed');
          annotateCrash(error, { guardianSignerInSet, guardianSigningKey, hotKeyRotationPending });
          expect(snapshotCrashDiagnostics(error)).toEqual({
            guardianSignerInSet,
            guardianSigningKey,
            hotKeyRotationPending
          });
        }
      }
    }
    const partial = new Error('partial');
    annotateCrash(partial, { guardianSignerInSet: 'no', guardianSigningKey: 'hot' });
    expect(snapshotCrashDiagnostics(partial)).toEqual({});
    const unlisted = new Error('unlisted');
    annotateCrash(unlisted, {
      guardianSignerInSet: '0xabcdef0123456789',
      guardianSigningKey: 'hot',
      hotKeyRotationPending: 'no'
    });
    annotateCrash(unlisted, { guardianSignerInSet: 'yes', guardianSigningKey: 'device', hotKeyRotationPending: 'no' });
    annotateCrash(unlisted, { guardianSignerInSet: 'yes', guardianSigningKey: 'cold', hotKeyRotationPending: true });
    expect(snapshotCrashDiagnostics(unlisted)).toEqual({});
  });

  it('accepts every completion step and guard, and a guard only beside its step', () => {
    for (const completionStep of COMPLETION_STEPS) {
      for (const completionGuard of COMPLETION_GUARDS) {
        const error = new Error('completion failed');
        annotateCrash(error, { completionStep, completionGuard });
        expect(snapshotCrashDiagnostics(error)).toEqual({ completionStep, completionGuard });
      }
    }
    const guardOnly = new Error('guard only');
    annotateCrash(guardOnly, { completionGuard: 'no_input_notes' });
    expect(snapshotCrashDiagnostics(guardOnly)).toEqual({});
    const unlisted = new Error('unlisted');
    annotateCrash(unlisted, { completionStep: 'result_read 0xabcdef', completionGuard: 'other' });
    annotateCrash(unlisted, { completionStep: { toString: () => 'status_write' } });
    expect(snapshotCrashDiagnostics(unlisted)).toEqual({});
  });

  it('keeps the innermost completion step and leaves proposal facts alone', async () => {
    const error = new Error('write failed');
    const inner = withCompletionStep('status_write', () => Promise.reject(error));
    await expect(withCompletionStep('result_read', () => inner)).rejects.toBe(error);
    expect(snapshotCrashDiagnostics(error)).toEqual({ completionStep: 'status_write' });
    annotateCrash(error, { proposalStep: 'chain_sync' });
    expect(snapshotCrashDiagnostics(error)).toEqual({ completionStep: 'status_write', proposalStep: 'chain_sync' });
    await expect(withCompletionStep('row_read', async () => 7)).resolves.toBe(7);
    const refusal = { status: 409 };
    await expect(withCompletionStep('row_read', () => Promise.reject(refusal))).rejects.toBe(refusal);
  });
});

const nativeGroup = {
  reownNativeOrigin: 'wallet_error',
  reownWalletResponseCode: 'internal_error',
  reownRequestAge: '120_to_300s',
  reownPublished: 'confirmed',
  reownBackgrounded: 'yes'
};

it('validatesTheWholeNativeGroupOnEveryBoundary', () => {
  const error = new Error('native failure');
  annotateCrash(error, { ...nativeGroup, payload: 'secret', code: -32603 });
  expect(snapshotCrashDiagnostics(error)).toEqual(nativeGroup);
  const detached = snapshotCrashDiagnostics(error);
  detached.reownPublished = 'unobserved';
  expect(snapshotCrashDiagnostics(error)).toEqual(nativeGroup);
  for (const key of ['reownNativeOrigin', 'reownRequestAge', 'reownPublished']) {
    for (const value of [undefined, 'unlisted', 42]) {
      const rejected = new Error('invalid');
      annotateCrash(rejected, { ...nativeGroup, [key]: value });
      expect(snapshotCrashDiagnostics(rejected)).toEqual({});
    }
  }
  for (const reownWalletResponseCode of [undefined, 'unlisted', -32603]) {
    const fallback = new Error('wallet');
    annotateCrash(fallback, { ...nativeGroup, reownWalletResponseCode, reownBackgrounded: 'unknown' });
    expect(snapshotCrashDiagnostics(fallback)).toEqual({
      reownNativeOrigin: 'wallet_error',
      reownWalletResponseCode: 'other',
      reownRequestAge: '120_to_300s',
      reownPublished: 'confirmed'
    });
  }
  const nonWallet = new Error('publisher');
  annotateCrash(nonWallet, { ...nativeGroup, reownNativeOrigin: 'publish_error' });
  expect(snapshotCrashDiagnostics(nonWallet)).toEqual({
    reownNativeOrigin: 'publish_error',
    reownRequestAge: '120_to_300s',
    reownPublished: 'confirmed',
    reownBackgrounded: 'yes'
  });
  const reads = new Map<string, number>();
  const changing: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nativeGroup))
    Object.defineProperty(changing, key, {
      get() {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        return count === 1 ? value : 'secret';
      }
    });
  const changingError = new Error('changing');
  annotateCrash(changingError, changing);
  expect(snapshotCrashDiagnostics(changingError)).toEqual(nativeGroup);
  expect([...reads.values()]).toEqual([1, 1, 1, 1, 1]);
});

it('reannotationNeverMixesNativeGroups', () => {
  const error = new Error('native failure');
  annotateCrash(error, { ...nativeGroup, operation: 'sdk_initialize', workerMode: 'enabled' });
  const publicationGroup = {
    reownNativeOrigin: 'publish_error',
    reownRequestAge: 'under_30s',
    reownPublished: 'unobserved'
  };
  annotateCrash(error, { ...publicationGroup, stage: 'client_create' });
  expect(snapshotCrashDiagnostics(error)).toEqual({
    ...publicationGroup,
    operation: 'sdk_initialize',
    workerMode: 'enabled',
    stage: 'client_create'
  });
  annotateCrash(error, { reownPublished: 'confirmed' });
  expect(snapshotCrashDiagnostics(error)).toEqual({
    operation: 'sdk_initialize',
    workerMode: 'enabled',
    stage: 'client_create'
  });
  const inner = new Error('inner');
  annotateCrash(inner, nativeGroup);
  const outer = new Error('outer', { cause: inner });
  annotateCrash(outer, publicationGroup);
  expect(snapshotCrashDiagnostics(outer)).toEqual(publicationGroup);
  const partial = new Error('partial', { cause: inner });
  annotateCrash(partial, { reownPublished: 'unobserved' });
  expect(snapshotCrashDiagnostics(partial)).toEqual(nativeGroup);
  const unmarked = new Error('unmarked');
  annotateCrash(unmarked, { reownPublished: 'confirmed' });
  expect(snapshotCrashDiagnostics(unmarked)).toEqual({});
  Object.defineProperty(inner, 'cause', {
    get() {
      throw new Error('hostile');
    }
  });
  expect(snapshotCrashDiagnostics(outer)).toEqual(publicationGroup);
});

test('startup evidence is closed and bound to the eligibility startup identity', () => {
  const error = new Error('private seed alpha bravo account=0x123 amount=12 https://private.example');
  annotateCrash(error, {
    userErrorId: 'walletAccessUnavailableBody',
    userErrorSurface: 'startup',
    startupEligibilityStage: 'eligibility_retry',
    startupEligibilityReason: 'version_mismatch',
    startupEligibilityRetry: 'retry_failed'
  });
  expect(snapshotCrashDiagnostics(error)).toMatchObject({
    startupEligibilityStage: 'eligibility_retry',
    startupEligibilityReason: 'version_mismatch',
    startupEligibilityRetry: 'retry_failed'
  });
  const hostile = new Error('other');
  annotateCrash(hostile, {
    userErrorId: 'walletAccessUnavailableBody',
    userErrorSurface: 'startup',
    startupEligibilityStage: 'https://private.example',
    startupEligibilityReason: '0x123',
    startupEligibilityRetry: 'seed alpha bravo'
  });
  expect(snapshotCrashDiagnostics(hostile)).toEqual({
    userErrorId: 'walletAccessUnavailableBody',
    userErrorSurface: 'startup'
  });
});

test('reannotating an error for a different display cannot retain a startup attempt', () => {
  const error = new Error('failed');
  annotateCrash(error, {
    userErrorId: 'walletAccessUnavailableBody',
    userErrorSurface: 'startup',
    startupEligibilityStage: 'eligibility_lookup',
    startupEligibilityReason: 'version_mismatch',
    startupEligibilityRetry: 'not_attempted'
  });
  annotateCrash(error, { userErrorId: 'usdcxFaucetUnavailable', userErrorSurface: 'review' });
  expect(snapshotCrashDiagnostics(error)).not.toHaveProperty('startupEligibilityStage');
});

it.each(['walletAccessUnavailableBody', 'usdcxFaucetUnavailable'])(
  'never inherits another startup attempt through a cause for %s',
  userErrorId => {
    const inner = new Error('old attempt');
    annotateCrash(inner, {
      userErrorId: 'walletAccessUnavailableBody',
      userErrorSurface: 'startup',
      startupEligibilityStage: 'eligibility_lookup',
      startupEligibilityReason: 'version_mismatch',
      startupEligibilityRetry: 'not_attempted'
    });
    const outer = new Error('new display', { cause: inner });
    annotateCrash(outer, { userErrorId, userErrorSurface: 'startup' });
    expect(snapshotCrashDiagnostics(outer)).not.toHaveProperty('startupEligibilityStage');
  }
);
