import { getMessage } from 'lib/i18n/core';

import { decodePlatformBytes, encodePlatformBytes } from './crypto';

async function extensionOrigin(): Promise<string> {
  const browser = (await import('webextension-polyfill')).default;
  return browser.runtime.getURL('').replace(/\/$/, '');
}

function publicCredential(value: Credential | null): PublicKeyCredential {
  if (
    typeof PublicKeyCredential === 'undefined' ||
    !(value instanceof PublicKeyCredential) ||
    value.type !== 'public-key' ||
    !(value.rawId instanceof ArrayBuffer) ||
    value.rawId.byteLength < 1 ||
    value.rawId.byteLength > 1023 ||
    value.id !== encodePlatformBytes(new Uint8Array(value.rawId))
  ) {
    throw new Error('Invalid platform credential');
  }
  return value;
}

function authenticatorData(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> {
  const response = credential.response;
  if (response instanceof AuthenticatorAttestationResponse) return new Uint8Array(response.getAuthenticatorData());
  if (response instanceof AuthenticatorAssertionResponse) return new Uint8Array(response.authenticatorData);
  throw new Error('Invalid platform assertion');
}

async function verifyCredential(
  credential: PublicKeyCredential,
  data: Uint8Array<ArrayBuffer>,
  challenge: Uint8Array<ArrayBuffer>,
  origin: string,
  type: 'webauthn.create' | 'webauthn.get'
): Promise<void> {
  if (data.length < 37 || ((data[32] ?? 0) & 5) !== 5) throw new Error('Platform user verification required');
  const client: unknown = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
  if (
    !client ||
    typeof client !== 'object' ||
    Reflect.get(client, 'type') !== type ||
    Reflect.get(client, 'origin') !== origin ||
    Reflect.get(client, 'challenge') !== encodePlatformBytes(challenge) ||
    (Reflect.get(client, 'crossOrigin') !== undefined && Reflect.get(client, 'crossOrigin') !== false)
  ) {
    throw new Error('Invalid platform assertion');
  }
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin)));
  if (!rpHash.every((byte, index) => data[index] === byte)) throw new Error('Invalid platform relying party');
}

function readPrfSecret(credential: PublicKeyCredential): string | null {
  const extensions: unknown = credential.getClientExtensionResults();
  if (!extensions || typeof extensions !== 'object') return null;
  const prf: unknown = Reflect.get(extensions, 'prf');
  if (!prf || typeof prf !== 'object') return null;
  const results: unknown = Reflect.get(prf, 'results');
  if (!results || typeof results !== 'object') return null;
  const first: unknown = Reflect.get(results, 'first');
  if (!(first instanceof ArrayBuffer) || first.byteLength !== 32) return null;
  return encodePlatformBytes(new Uint8Array(first));
}

function prfExtensions(salt: Uint8Array<ArrayBuffer>): AuthenticationExtensionsClientInputs & {
  prf: { eval: { first: Uint8Array<ArrayBuffer> } };
} {
  return { prf: { eval: { first: salt } } };
}

export async function createPlatformCredential(
  previousCredentialId: string | null,
  onCreated: (id: string, prfSalt: string, backupEligible: boolean) => Promise<void>
): Promise<{ credentialId: string; prfSecret: string }> {
  const origin = await extensionOrigin();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const label = getMessage('appName');
  const options: PublicKeyCredentialCreationOptions & { hints: string[] } = {
    challenge,
    rp: { name: label },
    user: { id: crypto.getRandomValues(new Uint8Array(64)), name: label, displayName: label },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 }
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred'
    },
    hints: ['client-device'],
    timeout: 60_000,
    excludeCredentials:
      previousCredentialId === null ? [] : [{ type: 'public-key', id: decodePlatformBytes(previousCredentialId) }],
    extensions: prfExtensions(salt)
  };
  const credential = publicCredential(await navigator.credentials.create({ publicKey: options }));
  let data = new Uint8Array(0);
  try {
    data = authenticatorData(credential);
  } finally {
    // Persist every returned ID before a validation failure or second native prompt can strand it.
    await onCreated(credential.id, encodePlatformBytes(salt), Boolean((data[32] ?? 0) & 8));
  }
  await verifyCredential(credential, data, challenge, origin, 'webauthn.create');
  const secret = readPrfSecret(credential);
  if (secret !== null) return { credentialId: credential.id, prfSecret: secret };
  return getPlatformCredential(credential.id, encodePlatformBytes(salt));
}

export async function getPlatformCredential(
  credentialId: string,
  prfSalt: string
): Promise<{ credentialId: string; prfSecret: string }> {
  const id = decodePlatformBytes(credentialId);
  const salt = decodePlatformBytes(prfSalt);
  if (salt.length !== 32) throw new Error('Invalid platform salt');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const origin = await extensionOrigin();
  const credential = publicCredential(
    await navigator.credentials.get({
      publicKey: {
        challenge,
        userVerification: 'required',
        timeout: 60_000,
        allowCredentials: [{ type: 'public-key', id }],
        extensions: prfExtensions(salt)
      }
    })
  );
  if (credential.id !== credentialId) throw new Error('Invalid platform credential');
  await verifyCredential(credential, authenticatorData(credential), challenge, origin, 'webauthn.get');
  const secret = readPrfSecret(credential);
  if (secret === null) throw new Error('Platform PRF unavailable');
  return { credentialId, prfSecret: secret };
}

export async function signalUnknownPlatformCredential(credentialId: string): Promise<void> {
  decodePlatformBytes(credentialId);
  if (typeof PublicKeyCredential === 'undefined') throw new Error('Platform cleanup unavailable');
  const signal: unknown = Reflect.get(PublicKeyCredential, 'signalUnknownCredential');
  if (typeof signal !== 'function') throw new Error('Platform cleanup unavailable');
  await signal.call(PublicKeyCredential, { rpId: await extensionOrigin(), credentialId });
}
