export async function inspectAuth(data, clientBytes, { challenge, origin, type }) {
  if (!(data instanceof Uint8Array) || data.length < 37 || (data[32] & 5) !== 5) {
    throw new Error('AUTH_DATA_INVALID');
  }
  const client = JSON.parse(new TextDecoder().decode(clientBytes));
  const encoded = btoa(String.fromCharCode(...challenge)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (!client || client.origin !== origin || client.type !== type || client.challenge !== encoded ||
      (client.crossOrigin !== undefined && client.crossOrigin !== false)) {
    throw new Error('CLIENT_BINDING_INVALID');
  }
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)));
  if (!expected.every((v, i) => data[i] === v)) throw new Error('RP_HASH_INVALID');
  return { uv: true, backupEligible: Boolean(data[32] & 8) };
}

export function takePrf(extensions) {
  const value = extensions?.prf?.results?.first;
  if (!(value instanceof ArrayBuffer)) throw new Error('PRF_UNAVAILABLE');
  const bytes = new Uint8Array(value);
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw new Error('PRF_UNAVAILABLE');
  }
  return bytes;
}

export function sameBytes(a, b) {
  if (a.byteLength !== 32 || b.byteLength !== 32) throw new Error('PRF_UNAVAILABLE');
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
