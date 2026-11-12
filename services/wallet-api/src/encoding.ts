import { BASE64URL } from './constants';

export const encoder = new TextEncoder();

/** @param hex Lowercase hex with an even length. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Convert a D1 BLOB value to bytes. D1 can return an array of numbers or an ArrayBuffer. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!Array.isArray(value)) throw new Error('Unexpected BLOB value');
  const bytes = new Uint8Array(value.length);
  value.forEach((item: unknown, index) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255) {
      throw new Error('Unexpected BLOB value');
    }
    bytes[index] = item;
  });
  return bytes;
}

/** The decoded length of a valid padded base64 string. */
export function base64Length(text: string): number {
  let padding = 0;
  if (text.endsWith('==')) padding = 2;
  else if (text.endsWith('=')) padding = 1;
  return (text.length / 4) * 3 - padding;
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  if (!BASE64URL.test(text)) throw new Error('Invalid base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return decodeBase64(padded);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(await sha256(encoder.encode(text)));
}
