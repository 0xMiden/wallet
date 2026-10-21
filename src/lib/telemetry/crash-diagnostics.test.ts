import { runInNewContext } from 'node:vm';

import { MidenMessageType } from 'lib/miden/types';
import { WalletMessageType } from 'lib/shared/types';

import {
  PROPOSAL_GUARDS,
  PROPOSAL_STEPS,
  annotateCrash,
  snapshotCrashDiagnostics,
  withProposalStep
} from './crash-diagnostics';
import { USER_ERROR_SURFACES } from './user-visible-error';

describe('source-bound crash diagnostics', () => {
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
});
