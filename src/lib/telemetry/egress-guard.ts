/**
 * Every encoding a forbidden value could wear on the wire.
 *
 * A naive `body.includes(address)` check passes while leaking, because a
 * payload may carry the value base64'd, percent-escaped, JSON-escaped, or
 * hex-encoded — and `atob`/`decodeURIComponent` on the receiving end turns any
 * of those back into the secret. The egress guard asserts against all of them,
 * so "the raw string is absent" cannot be mistaken for "the value did not
 * leave".
 *
 * The variants deliberately mirror the decoders in `redact.ts`: anything that
 * module can see through is something an egress payload could be hiding a
 * secret behind.
 */

function utf8Bytes(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function percentEncodeEvery(value: string, hexCase: 'lower' | 'upper'): string {
  return utf8Bytes(value)
    .map(byte => {
      const hex = byte.toString(16).padStart(2, '0');
      return `%${hexCase === 'upper' ? hex.toUpperCase() : hex}`;
    })
    .join('');
}

function hexOf(value: string): string {
  let hex = '';
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

/** `\u0061\u0062` — the form a `JSON.stringify` with an escaping replacer emits. */
function unicodeEscape(value: string): string {
  let escaped = '';
  for (let i = 0; i < value.length; i++) {
    escaped += `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}`;
  }
  return escaped;
}

export function encodingVariantsOf(value: string): string[] {
  const variants = new Set<string>([
    value,
    value.toLowerCase(),
    value.toUpperCase(),
    encodeURIComponent(value),
    percentEncodeEvery(value, 'lower'),
    percentEncodeEvery(value, 'upper'),
    // JSON string escaping: `"` becomes `\"`, a newline becomes `\n`. A secret
    // embedded in a JSON body wears this form, not its raw one.
    JSON.stringify(value).slice(1, -1),
    unicodeEscape(value),
    hexOf(value),
    hexOf(value).toUpperCase()
  ]);

  try {
    const base64 = btoa(value);
    variants.add(base64);
    // base64url: what a value smuggled through a URL or a JWT-shaped token
    // looks like, and what `redact.ts` normalises before decoding.
    variants.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  } catch {
    // Non-latin1 input cannot be base64'd this way; the other variants cover it.
  }

  return [...variants];
}
