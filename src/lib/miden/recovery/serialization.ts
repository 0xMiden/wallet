const BIGINT_TAG = '$bigint';

interface TaggedBigInt {
  [BIGINT_TAG]: string;
}

/**
 * `$bigint$`, `$bigint$$`, … — the escaped forms of real data that happens to
 * have the tag's exact shape.
 *
 * The tag is a reserved word in a namespace the wallet does not control: rows
 * carry `extraInputs`, which holds objects a dApp had a hand in. An object that
 * is literally `{"$bigint": "…"}` would come back from a round-trip as a BigInt
 * rather than as itself — and when its string is not a number, `BigInt()` throws
 * and takes the whole import down with it, from data a dApp chose. Escaping by
 * appending a `$` on the way out and stripping one on the way back in is
 * reversible at every nesting level, so no object can be mistaken for a tag.
 */
const ESCAPED_BIGINT_TAG = /^\$bigint\$+$/;

/**
 * Only a canonical decimal integer is a tag this code wrote — `toString()` on a
 * BigInt produces nothing else. Anything else under the key is foreign data that
 * merely borrowed the name, and is left exactly as it is rather than fed to
 * `BigInt()` to throw.
 */
const CANONICAL_BIGINT = /^-?(0|[1-9]\d*)$/;

/** The object's only own key, or undefined if it does not have exactly one. */
const soleKeyOf = (value: object): string | undefined => {
  if (Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
};

// Requires the tag to be the object's ONLY key. A tagged BigInt this code wrote
// never has siblings, so anything that does is real data that merely resembles
// the tag — and collapsing it to a BigInt would silently discard every other
// field on it.
const isTaggedBigInt = (value: object): value is TaggedBigInt => {
  if (soleKeyOf(value) !== BIGINT_TAG) return false;
  const tagged: unknown = Reflect.get(value, BIGINT_TAG);
  return typeof tagged === 'string' && CANONICAL_BIGINT.test(tagged);
};

/**
 * Byte fields are written as plain number arrays (`toSerializable` turns every
 * `Uint8Array` into one) and restored by name.
 */
const BYTE_FIELDS = new Set(['requestBytes', 'resultBytes', 'noteFile']);

/**
 * A transaction row nests two or three levels. The bound exists so a malformed
 * file fails here, in the pure mapping step, instead of surviving the walk to
 * become a partial write — and so a hostile dump cannot recurse the walker into
 * a stack overflow. `importDb` replaces the table atomically, so a failure at
 * either point costs the user nothing; failing early just keeps the reason close
 * to the cause.
 */
const MAX_WALK_DEPTH = 64;

/**
 * These are cryptographic request/result blobs. A byte that did not survive the
 * file intact is not a cosmetic defect — it is a different blob, and nothing
 * downstream re-checks it, so the only place the damage can still be noticed is
 * here. `Uint8Array` silently truncates whatever it is handed (`999` stores as
 * `231`, `-1` as `255`, a string as `0`), which is exactly the wrong behaviour
 * for a value whose whole purpose is to be exact.
 */
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

export function mapValues(source: object, transform: (value: unknown, key: string) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, transform(value, key)]));
}

