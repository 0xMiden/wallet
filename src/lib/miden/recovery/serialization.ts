const BIGINT_TAG = '$bigint';

interface TaggedBigInt {
  [BIGINT_TAG]: string;
}

const ESCAPED_BIGINT_TAG = /^\$bigint\$+$/;

const CANONICAL_BIGINT = /^-?(0|[1-9]\d*)$/;

const soleKeyOf = (value: object): string | undefined => {
  if (Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
};

// A tag has exactly one key; tag-shaped user objects are escaped reversibly.
const isTaggedBigInt = (value: object): value is TaggedBigInt => {
  if (soleKeyOf(value) !== BIGINT_TAG) return false;
  const tagged: unknown = Reflect.get(value, BIGINT_TAG);
  return typeof tagged === 'string' && CANONICAL_BIGINT.test(tagged);
};

const BYTE_FIELDS = new Set(['requestBytes', 'resultBytes', 'noteFile', 'accountBytes']);

// Bound malformed imports before recursion or storage writes.
const MAX_WALK_DEPTH = 64;

// Uint8Array coercion would silently truncate corrupt cryptographic bytes.
const isByteValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;

const bytesFromArray = (value: unknown[], key: string): Uint8Array => {
  if (!value.every(isByteValue)) throw new Error(`importDb: ${key} contains a value that is not a byte`);
  return Uint8Array.from(value);
};

export const toSerializable = (value: unknown, _key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('exportDb: transaction row nested too deeply');
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(entry => toSerializable(entry, undefined, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const mapped = mapValues(value, (entry, key) => toSerializable(entry, key, depth + 1));
    const sole = soleKeyOf(mapped);
    // Real data wearing the tag's shape, escaped so the import walk gives it
    // back rather than reading it as a number this code wrote.
    if (sole !== undefined && (sole === BIGINT_TAG || ESCAPED_BIGINT_TAG.test(sole))) {
      return { [`${sole}$`]: mapped[sole] };
    }
    return mapped;
  }
  return value;
};

export const fromSerializable = (value: unknown, key?: string, depth = 0): unknown => {
  if (depth > MAX_WALK_DEPTH) throw new Error('importDb: dump nested too deeply');
  const isByteField = key !== undefined && BYTE_FIELDS.has(key);
  if (Array.isArray(value)) {
    // Legacy dumps stored byte arrays untagged, so they are restored by name.
    if (isByteField) return bytesFromArray(value, key);
    return value.map(entry => fromSerializable(entry, undefined, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (isTaggedBigInt(value)) return BigInt(value[BIGINT_TAG]);
    if (isByteField) throw new Error(`importDb: ${key} is not a byte array`);
    const sole = soleKeyOf(value);
    if (sole !== undefined && ESCAPED_BIGINT_TAG.test(sole)) {
      return { [sole.slice(0, -1)]: fromSerializable(Reflect.get(value, sole), undefined, depth + 1) };
    }
    return mapValues(value, (entry, entryKey) => fromSerializable(entry, entryKey, depth + 1));
  }
  return value;
};

export function mapValues(
  source: object,
  transform: (value: unknown, key: string) => unknown
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value, key)]));
}
