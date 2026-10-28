export const REOWN_NATIVE_FAILURE_PREFIX = 'REOWN_NATIVE_REQUEST_FAILURE:';
export const REOWN_IOS_FAILURE_PREFIX = 'REOWN_IOS_REQUEST_FAILURE:';

function closedValues<const Values extends readonly string[]>(...values: Values): Readonly<Values> {
  return Object.freeze(values);
}

export const REOWN_NATIVE_ORIGINS = closedValues(
  'argument_validation',
  'unconfigured',
  'request_construction_error',
  'request_call_error',
  'publish_error',
  'wallet_error',
  'request_expired',
  'session_deleted',
  'other'
);
export const REOWN_WALLET_RESPONSE_CODES = closedValues('user_rejected', 'invalid_params', 'internal_error', 'other');
export const REOWN_REQUEST_AGES = closedValues('under_30s', '30_to_120s', '120_to_300s', 'over_300s', 'unknown');
export const REOWN_PUBLICATIONS = closedValues('confirmed', 'unobserved');
export const REOWN_BACKGROUND_ANSWERS = closedValues('yes', 'no');

export type ReownNativeOrigin = (typeof REOWN_NATIVE_ORIGINS)[number];
export type ReownWalletResponseCode = (typeof REOWN_WALLET_RESPONSE_CODES)[number];
export type ReownRequestAge = (typeof REOWN_REQUEST_AGES)[number];
export type ReownPublication = (typeof REOWN_PUBLICATIONS)[number];
export type ReownBackgroundAnswer = (typeof REOWN_BACKGROUND_ANSWERS)[number];

export type ReownNativeFailure = Readonly<
  {
    requestAge: ReownRequestAge;
    published: ReownPublication;
    backgrounded?: ReownBackgroundAnswer;
  } & (
    | { nativeOrigin: 'wallet_error'; walletResponseCode: ReownWalletResponseCode }
    | { nativeOrigin: Exclude<ReownNativeOrigin, 'wallet_error'>; walletResponseCode?: never }
  )
>;

const IOS_CALL_ORIGINS = [
  'unconfigured',
  'argument_validation',
  'request_construction_error',
  'request_call_error'
] as const;
const ANDROID_WIRE_ORIGINS: ReadonlySet<ReownNativeOrigin> = new Set([
  'argument_validation',
  'unconfigured',
  'publish_error',
  'wallet_error',
  'request_expired',
  'session_deleted',
  'other'
]);

export function isReownIOSCallFailure(failure: ReownNativeFailure): boolean {
  return (
    IOS_CALL_ORIGINS.some(origin => origin === failure.nativeOrigin) &&
    failure.requestAge === 'unknown' &&
    failure.published === 'unobserved' &&
    failure.backgrounded === undefined &&
    failure.walletResponseCode === undefined
  );
}

export function decodeReownIOSFailureCode(code: unknown): ReownNativeFailure | undefined {
  if (typeof code !== 'string') return undefined;
  const nativeOrigin = IOS_CALL_ORIGINS.find(origin => code === REOWN_IOS_FAILURE_PREFIX + origin);
  return nativeOrigin === undefined ? undefined : { nativeOrigin, requestAge: 'unknown', published: 'unobserved' };
}

// Keyed by identity, so a frozen rejection can be marked and no field of the rejection ever carries the mark.
const NATIVE_FAILURES = new WeakMap<object, ReownNativeFailure>();

function readField(source: object, key: string): unknown {
  try {
    const value: unknown = Reflect.get(source, key);
    return value;
  } catch {
    // An unavailable optional field must not discard the mandatory observations.
    return undefined;
  }
}

export function validateReownNativeFailure(value: unknown): ReownNativeFailure | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const suppliedOrigin = readField(value, 'nativeOrigin');
    const suppliedAge = readField(value, 'requestAge');
    const suppliedPublication = readField(value, 'published');
    const nativeOrigin = REOWN_NATIVE_ORIGINS.find(origin => origin === suppliedOrigin);
    const requestAge = REOWN_REQUEST_AGES.find(age => age === suppliedAge);
    const published = REOWN_PUBLICATIONS.find(publication => publication === suppliedPublication);
    if (nativeOrigin === undefined || requestAge === undefined || published === undefined) return undefined;

    const suppliedBackground = readField(value, 'backgrounded');
    const backgrounded = REOWN_BACKGROUND_ANSWERS.find(answer => answer === suppliedBackground);
    const observations = { requestAge, published, ...(backgrounded === undefined ? {} : { backgrounded }) };
    if (nativeOrigin === 'wallet_error') {
      const suppliedCode = readField(value, 'walletResponseCode');
      const walletResponseCode = REOWN_WALLET_RESPONSE_CODES.find(code => code === suppliedCode) ?? 'other';
      return { nativeOrigin, walletResponseCode, ...observations };
    }
    return { nativeOrigin, ...observations };
  } catch {
    // Even Array.isArray can throw for a revoked proxy.
    return undefined;
  }
}

export function decodeReownNativeFailureCode(code: unknown): ReownNativeFailure | undefined {
  if (typeof code !== 'string' || !code.startsWith(REOWN_NATIVE_FAILURE_PREFIX)) return undefined;
  try {
    const value: unknown = JSON.parse(code.slice(REOWN_NATIVE_FAILURE_PREFIX.length));
    const failure = validateReownNativeFailure(value);
    return failure !== undefined && ANDROID_WIRE_ORIGINS.has(failure.nativeOrigin) ? failure : undefined;
  } catch {
    return undefined;
  }
}

export function markReownNativeFailure(rejection: object, snapshot: ReownNativeFailure): boolean {
  if (NATIVE_FAILURES.has(rejection)) return false;
  const validated = validateReownNativeFailure(snapshot);
  if (validated === undefined) return false;
  // Never freeze bridge-owned data or let it mutate a request's saved observations.
  NATIVE_FAILURES.set(rejection, Object.freeze(validated));
  return true;
}

export function readReownNativeFailure(rejection: unknown): ReownNativeFailure | undefined {
  if ((typeof rejection !== 'object' && typeof rejection !== 'function') || rejection === null) return undefined;
  // A prototype or a cause that is marked belongs to another rejection.
  return NATIVE_FAILURES.get(rejection);
}
