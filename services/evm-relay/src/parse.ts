// Strict parse helpers of the config and the request bodies. Each helper narrows a value from `unknown`, or throws
// ParseError with the path of the value and the rule that it breaks. Every address leaves in lower case.
import { isRecord } from './http';

export type Hex = `0x${string}`;

/** A value does not have the expected shape. The message names the path and the rule. */
export class ParseError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A decimal integer of at most 78 digits, so the BigInt parse stays small. 2^256 has 78 digits. */
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const ZERO_ADDRESS: Hex = `0x${'0'.repeat(40)}`;
const UINT256_LIMIT = 2n ** 256n;

export function fail(path: string, rule: string): never {
  throw new ParseError(`${path} ${rule}.`);
}

/** Return the object when it has every required field and no field outside the two lists. */
export function shape(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is missing');
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'is not a known field');
  }
  return value;
}

export function address(value: unknown, path: string, allowZero = false): Hex {
  if (typeof value !== 'string' || !ADDRESS.test(value)) fail(path, 'must be a 20-byte hex address');
  const hex: Hex = `0x${value.slice(2).toLowerCase()}`;
  if (!allowZero && hex === ZERO_ADDRESS) fail(path, 'must not be the zero address');
  return hex;
}

/** `0x` and exactly `bytes` bytes of hex, returned in lower case. */
export function hexBytes(value: unknown, path: string, bytes: number): Hex {
  if (typeof value !== 'string' || value.length !== 2 + 2 * bytes || !/^0x[0-9a-fA-F]*$/.test(value)) {
    fail(path, `must be ${bytes} bytes of hex`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

/** `0x` and any whole number of bytes of hex, also none (`0x`), returned in lower case. */
export function hexData(value: unknown, path: string): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) fail(path, 'must be hex bytes');
  return `0x${value.slice(2).toLowerCase()}`;
}

/** A JSON number that is a safe integer of at least `min`. */
export function safeInteger(value: unknown, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(path, `must be an integer of at least ${min}`);
  }
  return value;
}

/** A decimal string below 2^256. */
export function amount(value: unknown, path: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail(path, 'must be a decimal integer string');
  const parsed = BigInt(value);
  if (parsed >= UINT256_LIMIT) fail(path, 'must be below 2^256');
  return parsed;
}
