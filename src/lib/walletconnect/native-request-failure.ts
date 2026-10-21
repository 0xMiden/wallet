export const REOWN_NATIVE_FAILURE_PREFIX = 'REOWN_NATIVE_REQUEST_FAILURE:';

function closedValues<const Values extends readonly string[]>(...values: Values): Readonly<Values> {
  return Object.freeze(values);
}

export const REOWN_NATIVE_ORIGINS = closedValues(
  'argument_validation',
  'unconfigured',
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

// Keep ownership at the native boundary: ordinary bridge fields carry no mark.
const NATIVE_FAILURE = Symbol('reown-native-request-failure');
type MarkedRejection = { readonly [NATIVE_FAILURE]?: ReownNativeFailure };

function hasOwnMark(rejection: object): rejection is MarkedRejection {
  return Object.prototype.hasOwnProperty.call(rejection, NATIVE_FAILURE);
}

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
    return validateReownNativeFailure(value);
  } catch {
    return undefined;
  }
}

export function markReownNativeFailure(rejection: object, snapshot: ReownNativeFailure): boolean {
  try {
    if (hasOwnMark(rejection)) return false;
    const validated = validateReownNativeFailure(snapshot);
    if (validated === undefined) return false;
    // Never freeze bridge-owned data or let it mutate a request's saved observations.
    Object.defineProperty(rejection, NATIVE_FAILURE, { value: Object.freeze(validated) });
    return true;
  } catch {
    return false;
  }
}

export function readReownNativeFailure(rejection: unknown): ReownNativeFailure | undefined {
  try {
    if (
      (typeof rejection !== 'object' && typeof rejection !== 'function') ||
      rejection === null ||
      !hasOwnMark(rejection)
    )
      return undefined;
    // An inherited mark or a marked cause belongs to another rejection.
    return validateReownNativeFailure(rejection[NATIVE_FAILURE]);
  } catch {
    return undefined;
  }
}
