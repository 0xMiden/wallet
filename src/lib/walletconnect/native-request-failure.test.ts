import { readFileSync } from 'fs';
import { join } from 'path';

it('decodes only the named closed fields from the native code envelope', () => {
  const { decodeReownNativeFailureCode } = jest.requireActual<{
    decodeReownNativeFailureCode(code: unknown): unknown;
  }>('./native-request-failure');
  const code =
    'REOWN_NATIVE_REQUEST_FAILURE:' +
    JSON.stringify({
      nativeOrigin: 'wallet_error',
      walletResponseCode: 'internal_error',
      requestAge: '120_to_300s',
      published: 'confirmed',
      backgrounded: 'yes',
      topic: 'private-topic',
      rawCode: -32603,
      elapsedMs: 123456
    });
  expect(decodeReownNativeFailureCode(code)).toEqual({
    nativeOrigin: 'wallet_error',
    walletResponseCode: 'internal_error',
    requestAge: '120_to_300s',
    published: 'confirmed',
    backgrounded: 'yes'
  });
  expect(decodeReownNativeFailureCode('REOWN_NATIVE_REQUEST_FAILURE:{}')).toBeUndefined();
});

const base: { nativeOrigin: 'publish_error'; requestAge: 'unknown'; published: 'unobserved' } = {
  nativeOrigin: 'publish_error',
  requestAge: 'unknown',
  published: 'unobserved'
};
// Each rejected envelope differs from this valid one only in its prefix or trailing text.
const validCode = 'REOWN_NATIVE_REQUEST_FAILURE:' + JSON.stringify(base);
type WalletSnapshot = {
  nativeOrigin: 'wallet_error';
  walletResponseCode: 'internal_error' | 'other';
  requestAge: '120_to_300s';
  published: 'confirmed';
  backgrounded: 'yes';
};
const wallet: WalletSnapshot = {
  nativeOrigin: 'wallet_error',
  walletResponseCode: 'internal_error',
  requestAge: '120_to_300s',
  published: 'confirmed',
  backgrounded: 'yes'
};
type BoundaryModule = {
  REOWN_NATIVE_FAILURE_PREFIX: string;
  REOWN_NATIVE_ORIGINS: readonly string[];
  REOWN_WALLET_RESPONSE_CODES: readonly string[];
  REOWN_REQUEST_AGES: readonly string[];
  REOWN_PUBLICATIONS: readonly string[];
  REOWN_BACKGROUND_ANSWERS: readonly string[];
  validateReownNativeFailure(value: unknown): unknown;
  decodeReownNativeFailureCode(code: unknown): unknown;
  markReownNativeFailure(rejection: object, snapshot: WalletSnapshot | typeof base): boolean;
  readReownNativeFailure(rejection: unknown): unknown;
};

it('requires exact prefix and mandatory enums', () => {
  const {
    REOWN_NATIVE_FAILURE_PREFIX,
    REOWN_NATIVE_ORIGINS,
    REOWN_WALLET_RESPONSE_CODES,
    REOWN_REQUEST_AGES,
    REOWN_PUBLICATIONS,
    REOWN_BACKGROUND_ANSWERS,
    validateReownNativeFailure,
    decodeReownNativeFailureCode
  } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(REOWN_NATIVE_FAILURE_PREFIX).toBe('REOWN_NATIVE_REQUEST_FAILURE:');
  expect(REOWN_NATIVE_ORIGINS).toEqual([
    'argument_validation',
    'unconfigured',
    'request_construction_error',
    'request_call_error',
    'publish_error',
    'wallet_error',
    'request_expired',
    'session_deleted',
    'other'
  ]);
  expect(REOWN_WALLET_RESPONSE_CODES).toEqual([
    'user_rejected',
    'invalid_params',
    'internal_error',
    'provider_unauthorized',
    'method_unsupported',
    'provider_disconnected',
    'chain_disconnected',
    'chain_switch_failed',
    'request_invalid',
    'rpc_unavailable',
    'transaction_rejected',
    'rpc_limited',
    'other'
  ]);
  expect(REOWN_REQUEST_AGES).toEqual(['under_30s', '30_to_120s', '120_to_300s', 'over_300s', 'unknown']);
  expect(REOWN_PUBLICATIONS).toEqual(['confirmed', 'unobserved']);
  expect(REOWN_BACKGROUND_ANSWERS).toEqual(['yes', 'no']);
  for (const value of [
    null,
    [],
    {},
    { ...base, nativeOrigin: 4001 },
    { ...base, requestAge: '30000' },
    { ...base, published: 'yes' }
  ]) {
    expect(validateReownNativeFailure(value)).toBeUndefined();
  }
  expect(decodeReownNativeFailureCode('REOWN_NATIVE_REQUEST_FAILURE:{')).toBeUndefined();
  expect(decodeReownNativeFailureCode(validCode)).toEqual(base);
  expect(decodeReownNativeFailureCode('prefix ' + validCode)).toBeUndefined();
});

it.each([
  ['missing origin', { requestAge: 'unknown', published: 'unobserved' }],
  ['missing age', { nativeOrigin: 'publish_error', published: 'unobserved' }],
  ['missing publication', { nativeOrigin: 'publish_error', requestAge: 'unknown' }],
  ['undefined origin', { ...base, nativeOrigin: undefined }],
  ['unlisted origin', { ...base, nativeOrigin: 'wallet_approve' }],
  ['numeric origin', { ...base, nativeOrigin: 4001 }],
  ['object origin', { ...base, nativeOrigin: { toString: (): string => 'publish_error' } }],
  ['null age', { ...base, requestAge: null }],
  ['unlisted age', { ...base, requestAge: '30000' }],
  ['numeric age', { ...base, requestAge: 30000 }],
  ['object age', { ...base, requestAge: { toString: (): string => 'unknown' } }],
  ['null publication', { ...base, published: null }],
  ['unlisted publication', { ...base, published: 'yes' }],
  ['boolean publication', { ...base, published: true }],
  ['object publication', { ...base, published: { toString: (): string => 'confirmed' } }],
  ['primitive', 'publish_error'],
  ['array with plausible fields', Object.assign([], base)]
])('requires exact prefix and mandatory enums: %s', (_label, value) => {
  const { validateReownNativeFailure, decodeReownNativeFailureCode } =
    jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(validateReownNativeFailure(value)).toBeUndefined();
  expect(decodeReownNativeFailureCode('REOWN_NATIVE_REQUEST_FAILURE:' + JSON.stringify(value))).toBeUndefined();
});

it.each([
  null,
  undefined,
  4001,
  false,
  {},
  [],
  '',
  'REOWN_NATIVE_REQUEST_FAILURE',
  'reown_native_request_failure:' + JSON.stringify(base),
  ' ' + validCode,
  'REOWN_NATIVE_REQUEST_FAILURE' + JSON.stringify(base),
  'REOWN_NATIVE_REQUEST_FAILURE:null',
  'REOWN_NATIVE_REQUEST_FAILURE:[]',
  'REOWN_NATIVE_REQUEST_FAILURE:"publish_error"',
  validCode + ' trailing'
])('requires exact prefix and mandatory enums for code %p', code => {
  const { decodeReownNativeFailureCode } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(decodeReownNativeFailureCode(code)).toBeUndefined();
});

it('normalizes only optional wallet and background categories', () => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(validateReownNativeFailure({ ...wallet, walletResponseCode: undefined })).toEqual({
    ...wallet,
    walletResponseCode: 'other'
  });
  expect(validateReownNativeFailure({ ...base, walletResponseCode: 'user_rejected', backgrounded: 'unknown' })).toEqual(
    base
  );
  const { walletResponseCode: _code, ...withoutCode } = wallet;
  expect(validateReownNativeFailure(withoutCode)).toEqual({ ...wallet, walletResponseCode: 'other' });
  const { backgrounded: _background, ...withoutBackground } = wallet;
  expect(validateReownNativeFailure(withoutBackground)).toEqual(withoutBackground);
});

it.each([undefined, null, 'unknown', '4001', 4001, -32603, false, {}, []])(
  'normalizes only optional wallet and background categories: %p',
  value => {
    const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
    expect(validateReownNativeFailure({ ...wallet, walletResponseCode: value })).toEqual({
      ...wallet,
      walletResponseCode: 'other'
    });
    expect(validateReownNativeFailure({ ...base, backgrounded: value, walletResponseCode: value })).toEqual(base);
  }
);

it.each(['argument_validation', 'unconfigured', 'publish_error', 'request_expired', 'session_deleted', 'other'])(
  'omits wallet response codes for %s',
  nativeOrigin => {
    const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
    expect(validateReownNativeFailure({ ...base, nativeOrigin, walletResponseCode: 'user_rejected' })).toEqual({
      ...base,
      nativeOrigin
    });
  }
);

it.each(['user_rejected', 'invalid_params', 'internal_error', 'other'])(
  'retains wallet category %s',
  walletResponseCode => {
    const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
    expect(validateReownNativeFailure({ ...wallet, walletResponseCode })).toEqual({ ...wallet, walletResponseCode });
  }
);

it.each(['under_30s', '30_to_120s', '120_to_300s', 'over_300s', 'unknown'])('retains request age %s', requestAge => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(validateReownNativeFailure({ ...base, requestAge })).toEqual({ ...base, requestAge });
});

it.each(['confirmed', 'unobserved'])('retains publication %s', published => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(validateReownNativeFailure({ ...base, published })).toEqual({ ...base, published });
});

it.each(['yes', 'no'])('retains background answer %s', backgrounded => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(validateReownNativeFailure({ ...base, backgrounded })).toEqual({ ...base, backgrounded });
});

it('decodes the golden native envelope identically after discarding unknown keys', () => {
  const { decodeReownNativeFailureCode } = jest.requireActual<BoundaryModule>('./native-request-failure');
  const fixture = readFileSync(join(__dirname, 'testing/native-request-failure-envelope.txt'), 'utf8').trimEnd();
  expect(fixture).toBe('REOWN_NATIVE_REQUEST_FAILURE:' + JSON.stringify(wallet));
  expect(decodeReownNativeFailureCode(fixture)).toEqual(wallet);
  expect(
    decodeReownNativeFailureCode(
      'REOWN_NATIVE_REQUEST_FAILURE:' +
        JSON.stringify({ ...wallet, topic: 'private-topic', rawCode: -32603, elapsedMs: 123456 })
    )
  ).toEqual(wallet);
});

it('marks by identity a detached immutable snapshot', () => {
  const { markReownNativeFailure, readReownNativeFailure } =
    jest.requireActual<BoundaryModule>('./native-request-failure');
  for (const seal of [Object.freeze, Object.seal, Object.preventExtensions]) {
    const sealed = seal(new Error('sealed'));
    expect(markReownNativeFailure(sealed, wallet)).toBe(true);
    expect(readReownNativeFailure(sealed)).toEqual(wallet);
    expect(Object.getOwnPropertySymbols(sealed)).toEqual([]);
  }
  const rejection = new Error('local', { cause: new Error('cause') });
  const cause = rejection.cause;
  expect(markReownNativeFailure(rejection, wallet)).toBe(true);
  expect(readReownNativeFailure(rejection)).toEqual(wallet);
  expect(Object.keys(rejection)).toEqual([]);
  expect(Object.getOwnPropertySymbols(rejection)).toEqual([]);
  expect(JSON.stringify(rejection)).toBe('{}');
  const supplied: WalletSnapshot & { topic: string } = { ...wallet, topic: 'private-topic' };
  const detached = new Error('detached');
  expect(markReownNativeFailure(detached, supplied)).toBe(true);
  expect(Object.isFrozen(supplied)).toBe(false);
  const stored = readReownNativeFailure(detached);
  expect(stored).toEqual(wallet);
  expect(stored).not.toBe(supplied);
  expect(Object.isFrozen(stored)).toBe(true);
  supplied.walletResponseCode = 'other';
  expect(readReownNativeFailure(detached)).toEqual(wallet);
  expect(readReownNativeFailure(rejection)).toEqual(wallet);
  expect(markReownNativeFailure(rejection, base)).toBe(false);
  expect(readReownNativeFailure(rejection)).toEqual(wallet);
  expect(rejection.cause).toBe(cause);
  expect(rejection.message).toBe('local');
  const plain = { message: 'plain', cause };
  expect(markReownNativeFailure(plain, base)).toBe(true);
  expect(readReownNativeFailure(plain)).toEqual(base);
  expect(plain.cause).toBe(cause);
  expect(Object.keys(plain)).toEqual(['message', 'cause']);
  const invalid = Object.defineProperty({ ...wallet }, 'published', {
    get() {
      throw new Error('unavailable publication');
    }
  });
  expect(markReownNativeFailure({}, invalid)).toBe(false);
  const callable = () => undefined;
  expect(markReownNativeFailure(callable, wallet)).toBe(true);
  expect(readReownNativeFailure(callable)).toEqual(wallet);
});

it('ignores forged fields and marks hostile objects by identity without touching them', () => {
  const { validateReownNativeFailure, markReownNativeFailure, readReownNativeFailure } =
    jest.requireActual<BoundaryModule>('./native-request-failure');
  expect(readReownNativeFailure({ nativeOrigin: 'wallet_error', diagnostics: wallet })).toBeUndefined();
  expect(readReownNativeFailure({ ...wallet, reownNativeFailure: wallet })).toBeUndefined();
  for (const value of [null, undefined, false, 4001, 'wallet_error', Symbol('unmarked')]) {
    expect(readReownNativeFailure(value)).toBeUndefined();
  }
  const marked = new Error('marked');
  expect(markReownNativeFailure(marked, wallet)).toBe(true);
  expect(readReownNativeFailure(new Error('outer', { cause: marked }))).toBeUndefined();
  expect(readReownNativeFailure(Object.assign({}, marked))).toBeUndefined();
  const inherited: object = Object.create(marked);
  expect(readReownNativeFailure(inherited)).toBeUndefined();
  expect(markReownNativeFailure(inherited, base)).toBe(true);
  expect(readReownNativeFailure(inherited)).toEqual(base);
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile get');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor');
      },
      defineProperty() {
        throw new Error('hostile define');
      }
    }
  );
  expect(() => validateReownNativeFailure(hostile)).not.toThrow();
  expect(validateReownNativeFailure(hostile)).toBeUndefined();
  expect(readReownNativeFailure(hostile)).toBeUndefined();
  expect(markReownNativeFailure(hostile, wallet)).toBe(true);
  expect(readReownNativeFailure(hostile)).toEqual(wallet);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  expect(() => validateReownNativeFailure(revoked.proxy)).not.toThrow();
  expect(validateReownNativeFailure(revoked.proxy)).toBeUndefined();
  expect(readReownNativeFailure(revoked.proxy)).toBeUndefined();
  expect(markReownNativeFailure(revoked.proxy, wallet)).toBe(true);
  expect(readReownNativeFailure(revoked.proxy)).toEqual(wallet);
});

it.each(['nativeOrigin', 'requestAge', 'published'])('ignores throwing mandatory accessor %s', field => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  const hostile = Object.defineProperty({ ...base }, field, {
    get() {
      throw new Error(field);
    }
  });
  expect(() => validateReownNativeFailure(hostile)).not.toThrow();
  expect(validateReownNativeFailure(hostile)).toBeUndefined();
});

it('reads each named field once and never reads unknown fields', () => {
  const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
  const reads = new Map<PropertyKey, number>();
  const source = new Proxy(
    { ...wallet, topic: 'private-topic' },
    {
      get(target, key) {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (count > 1 || key === 'topic') throw new Error('unexpected read');
        const value: unknown = Reflect.get(target, key);
        return value;
      }
    }
  );
  expect(validateReownNativeFailure(source)).toEqual(wallet);
  expect([...reads.entries()].sort()).toEqual([
    ['backgrounded', 1],
    ['nativeOrigin', 1],
    ['published', 1],
    ['requestAge', 1],
    ['walletResponseCode', 1]
  ]);
  const optional = Object.defineProperties(
    { ...wallet },
    {
      walletResponseCode: {
        get() {
          throw new Error('wallet code');
        }
      },
      backgrounded: {
        get() {
          throw new Error('background');
        }
      }
    }
  );
  expect(validateReownNativeFailure(optional)).toEqual({
    nativeOrigin: 'wallet_error',
    walletResponseCode: 'other',
    requestAge: '120_to_300s',
    published: 'confirmed'
  });
});

it.each(['request_construction_error', 'request_call_error'])(
  'accepts iOS fixed call origin %s without a wallet response',
  origin => {
    const { validateReownNativeFailure } = jest.requireActual<BoundaryModule>('./native-request-failure');
    expect(
      validateReownNativeFailure({ nativeOrigin: origin, requestAge: 'unknown', published: 'unobserved' })
    ).toEqual({
      nativeOrigin: origin,
      requestAge: 'unknown',
      published: 'unobserved'
    });
  }
);

it.each([
  'provider_unauthorized',
  'method_unsupported',
  'provider_disconnected',
  'chain_disconnected',
  'chain_switch_failed',
  'request_invalid',
  'rpc_unavailable',
  'transaction_rejected',
  'rpc_limited'
])('retains the closed native wallet response category %s without raw fields', category => {
  const { decodeReownNativeFailureCode } =
    jest.requireActual<typeof import('./native-request-failure')>('./native-request-failure');
  const envelope =
    'REOWN_NATIVE_REQUEST_FAILURE:' +
    JSON.stringify({
      nativeOrigin: 'wallet_error',
      walletResponseCode: category,
      requestAge: 'unknown',
      published: 'unobserved',
      rawCode: -32003,
      message: 'private'
    });
  expect(decodeReownNativeFailureCode(envelope)).toEqual({
    nativeOrigin: 'wallet_error',
    walletResponseCode: category,
    requestAge: 'unknown',
    published: 'unobserved'
  });
});
