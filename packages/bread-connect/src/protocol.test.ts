import { gcm } from '@noble/ciphers/aes';
import { readFileSync } from 'fs';
import { join } from 'path';

import { fromBase64Url, toBase64Url } from './base64url.js';
import {
  APP_STORE_URL,
  BREAD_ANDROID_CERTIFICATES,
  BREAD_ANDROID_PACKAGE,
  BREAD_REQUEST_URL,
  MAX_MESSAGE_LENGTH,
  PLAY_STORE_MARKET_URL,
  PLAY_STORE_URL
} from './constants.js';
import {
  additionalData,
  decodeBytes,
  deriveSessionKeys,
  encodeBytes,
  generateKeyPair,
  open,
  ProtocolCryptoError,
  publicKeyOf,
  seal
} from './crypto.js';
import {
  callbackOrigin,
  ConnectedEnvelope,
  ConnectEnvelope,
  Envelope,
  parseEnvelope,
  readLink,
  RequestEnvelope,
  ResponseEnvelope,
  writeLink
} from './envelope.js';
import {
  answerConnect,
  answerRequest,
  AppConnection,
  AppSession,
  errorLink,
  finishConnect,
  openRequest,
  ProtocolMessageError,
  readResponse,
  sendRequest,
  startConnect,
  WalletSession
} from './messages.js';
import vectors from '../vectors/v1.json';

const CALLBACK = vectors.callback;

/** A URL parser that refuses every https link, as a WebView's may refuse a host the grammar allows. */
class RefusingURL extends URL {
  constructor(input: string | URL, base?: string | URL) {
    if (String(input).startsWith('https://')) throw new TypeError('Invalid URL');
    super(input, base);
  }
}
const utf8 = (text: string) => new TextEncoder().encode(text);

function bytes(text: string): Uint8Array {
  const decoded = fromBase64Url(text);
  if (!decoded) throw new Error(`not base64url: ${text}`);
  return decoded;
}

function envelopeOf(link: string, base: string): Envelope {
  const read = readLink(link, base);
  if (read?.kind !== 'envelope') throw new Error(`no envelope in ${link}`);
  return read.envelope;
}

function connectOf(link: string): ConnectEnvelope {
  const envelope = envelopeOf(link, BREAD_REQUEST_URL);
  if (envelope.type !== 'connect') throw new Error(`not a connect: ${envelope.type}`);
  return envelope;
}

function connectedOf(link: string, base = CALLBACK): ConnectedEnvelope {
  const envelope = envelopeOf(link, base);
  if (envelope.type !== 'connected') throw new Error(`not a connected: ${envelope.type}`);
  return envelope;
}

function requestOf(link: string): RequestEnvelope {
  const envelope = envelopeOf(link, BREAD_REQUEST_URL);
  if (envelope.type !== 'request') throw new Error(`not a request: ${envelope.type}`);
  return envelope;
}

function responseOf(link: string, base = CALLBACK): ResponseEnvelope {
  const envelope = envelopeOf(link, base);
  if (envelope.type !== 'response') throw new Error(`not a response: ${envelope.type}`);
  return envelope;
}

type Vector = (typeof vectors.messages)[number];

function vector(name: string): Vector {
  const found = vectors.messages.find(entry => entry.name === name);
  if (!found) throw new Error(`no vector named ${name}`);
  return found;
}

function isSealed(entry: Vector): entry is Vector & { plaintext: string; additionalData: string } {
  return typeof entry.plaintext === 'string' && typeof entry.additionalData === 'string';
}

const connection: AppConnection = {
  id: vectors.id,
  callback: CALLBACK,
  appSecretKey: vectors.app.secretKey,
  appPublicKey: vectors.app.publicKey
};

const appSession: AppSession = {
  session: vectors.session,
  callback: CALLBACK,
  appSecretKey: vectors.app.secretKey,
  appPublicKey: vectors.app.publicKey,
  walletPublicKey: vectors.wallet.publicKey
};

const walletSession: WalletSession = {
  session: vectors.session,
  callback: CALLBACK,
  origin: vectors.origin,
  appPublicKey: vectors.app.publicKey,
  walletSecretKey: vectors.wallet.secretKey,
  walletPublicKey: vectors.wallet.publicKey
};

/** An envelope sealed over any plaintext with the vectors' keys, for payloads no role function would write. */
function sealedOver<T extends ConnectedEnvelope | RequestEnvelope | ResponseEnvelope>(
  envelope: T,
  plaintext: string
): T {
  const key = bytes(envelope.type === 'request' ? vectors.keys.appKey : vectors.keys.walletKey);
  const nonce = bytes(envelope.nonce);
  const sealed = seal(key, nonce, additionalData(envelope.type, envelope.session, envelope.id), plaintext);
  return { ...envelope, sealed: encodeBytes(sealed) };
}

describe('base64url', () => {
  it('round-trips every length up to 40 bytes', () => {
    for (let length = 0; length <= 40; length++) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255);
      expect(fromBase64Url(toBase64Url(data))).toEqual(data);
    }
    expect(toBase64Url(utf8('\u00ff\u00fe'))).toBe('w7_Dvg');
  });

  it('refuses padding, the standard alphabet, a dangling character and nonzero spare bits', () => {
    expect(fromBase64Url('AA==')).toBeNull();
    expect(fromBase64Url('a+b/')).toBeNull();
    expect(fromBase64Url('AAAAA')).toBeNull();
    expect(fromBase64Url('AB')).toBeNull();
    expect(fromBase64Url('AAB')).toBeNull();
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
    expect(fromBase64Url('')).toEqual(new Uint8Array([]));
  });
});

describe('the v1 vectors', () => {
  it("derives the session keys of RFC 7748's shared secret from either side", () => {
    const app = bytes(vectors.app.publicKey);
    const wallet = bytes(vectors.wallet.publicKey);
    expect(publicKeyOf(bytes(vectors.app.secretKey))).toEqual(app);
    expect(publicKeyOf(bytes(vectors.wallet.secretKey))).toEqual(wallet);
    const expected = { appKey: bytes(vectors.keys.appKey), walletKey: bytes(vectors.keys.walletKey) };
    expect(deriveSessionKeys(bytes(vectors.app.secretKey), wallet, app, wallet)).toEqual(expected);
    expect(deriveSessionKeys(bytes(vectors.wallet.secretKey), app, app, wallet)).toEqual(expected);
  });

  it.each(vectors.messages.map(entry => [entry.name, entry] as const))(
    'reads the %s link and writes it back byte for byte',
    (_, entry) => {
      expect(readLink(entry.link, entry.base)).toEqual({ kind: 'envelope', envelope: entry.envelope });
      expect(writeLink(entry.base, envelopeOf(entry.link, entry.base))).toBe(entry.link);
    }
  );

  it.each(vectors.messages.filter(isSealed).map(entry => [entry.name, entry] as const))(
    'seals the %s payload to the vector bytes and opens it',
    (_, entry) => {
      const envelope = envelopeOf(entry.link, entry.base);
      if (envelope.type !== 'connected' && envelope.type !== 'request' && envelope.type !== 'response') {
        throw new Error(`unsealed vector ${entry.name}`);
      }
      const key = bytes(envelope.type === 'request' ? vectors.keys.appKey : vectors.keys.walletKey);
      const aad = additionalData(envelope.type, envelope.session, envelope.id);
      expect(aad).toEqual(utf8(entry.additionalData));
      expect(seal(key, bytes(envelope.nonce), aad, entry.plaintext)).toEqual(bytes(envelope.sealed));
      expect(open(key, bytes(envelope.nonce), aad, bytes(envelope.sealed))).toBe(entry.plaintext);
    }
  );

  it('opens the approved and the refused connection', () => {
    const approved = vector('connected');
    if (!isSealed(approved)) throw new Error('the connected vector is not sealed');
    expect(finishConnect(connectedOf(approved.link), connection)).toEqual({
      session: appSession,
      answer: JSON.parse(approved.plaintext)
    });
    const refused = finishConnect(connectedOf(vector('connected, refused').link), connection);
    expect(refused.answer).toEqual({ error: { code: 'NOT_GRANTED', message: 'The user declined' } });
  });

  it('opens the requests in Bread and their answers in the app', () => {
    const sign = requestOf(vector('sign request').link);
    expect(openRequest(sign, walletSession)).toEqual({
      request: expect.objectContaining({ type: 'SIGN_REQUEST', kind: 'word' }),
      sentAt: vectors.sentAt
    });
    expect(readResponse(responseOf(vector('sign response').link), appSession)).toEqual({
      response: { type: 'SIGN_RESPONSE', signature: 'c2lnbmF0dXJlIGJ5dGVz' }
    });
    expect(openRequest(requestOf(vector('send request').link), walletSession).request.type).toBe(
      'SEND_TRANSACTION_REQUEST'
    );
    expect(readResponse(responseOf(vector('send response with its outcome').link), appSession)).toEqual({
      response: { type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-7f3e' },
      transaction: { output: { txHash: '0x5f1c9e', outputNotes: [] } }
    });
  });

  it.each(vectors.invalid.map(entry => [entry.name, entry] as const))('reads the %s link as refused', (_, entry) => {
    expect(readLink(entry.link, entry.base)).toEqual(entry.read);
  });

  it.each(vectors.callbacks.map(entry => [entry.callback.slice(0, 60), entry] as const))(
    'reads the callback %s as its vector says',
    (_, entry) => {
      expect(callbackOrigin(entry.callback)).toBe(entry.origin);
    }
  );

  it('reads a callback by the grammar alone, whatever URL parser the engine has', () => {
    const realURL = globalThis.URL;
    globalThis.URL = RefusingURL;
    try {
      expect(callbackOrigin('https://xn--.example/bread')).toBe('https://xn--.example');
    } finally {
      globalThis.URL = realURL;
    }
  });

  it.each(vectors.unopenable.map(entry => [entry.name, entry] as const))('refuses to open the %s', (_, entry) => {
    const envelope = parseEnvelope(entry.envelope);
    const attempt = () => {
      if (envelope?.type === 'connected') return finishConnect(envelope, connection);
      if (envelope?.type === 'response') return readResponse(envelope, appSession);
      if (envelope?.type === 'request') return openRequest(envelope, walletSession);
      return undefined;
    };
    expect(envelope?.type).toMatch(/^(connected|response|request)$/);
    expect(attempt).toThrow();
  });
});

describe('a round trip with fresh keys', () => {
  const callback = 'https://game.example/bread';
  const permission = { type: 'PERMISSION_REQUEST', appMeta: { name: 'Game' }, network: 'testnet' };

  function connected() {
    const started = startConnect(callback, permission);
    const approved = answerConnect(connectOf(started.link), {
      response: { type: 'PERMISSION_RESPONSE', accountId: 'acc' }
    });
    return { started, approved, finished: finishConnect(connectedOf(approved.link, callback), started.connection) };
  }

  it('connects, then carries a request to Bread and its answer back', () => {
    const { started, approved, finished } = connected();
    expect(connectOf(started.link).request).toEqual(permission);
    expect(approved.session.origin).toBe('https://game.example');
    expect(finished.answer).toEqual({ response: { type: 'PERMISSION_RESPONSE', accountId: 'acc' } });

    const sent = sendRequest(finished.session, { type: 'SIGN_REQUEST', payload: 'AA' }, 1000);
    const request = requestOf(sent.link);
    expect(request.callback).toBe(callback);
    expect(openRequest(request, approved.session)).toEqual({
      request: { type: 'SIGN_REQUEST', payload: 'AA' },
      sentAt: 1000
    });

    const answer = { response: { type: 'SIGN_RESPONSE', signature: 'BB' } };
    const response = responseOf(answerRequest(request, approved.session, answer), callback);
    expect(response.id).toBe(sent.id);
    expect(readResponse(response, finished.session)).toEqual(answer);
  });

  it('carries a refusal and a failed transaction outcome', () => {
    const { approved, finished } = connected();
    const request = requestOf(sendRequest(finished.session, { type: 'TRANSACTION_REQUEST' }).link);
    const refusal = { error: { code: 'NOT_GRANTED' as const, message: 'declined' } };
    expect(
      readResponse(responseOf(answerRequest(request, approved.session, refusal), callback), finished.session)
    ).toEqual(refusal);
    const failed = {
      response: { type: 'TRANSACTION_RESPONSE', transactionId: 'tx' },
      transaction: { error: { code: 'TRANSACTION_FAILED' as const, message: 'out of gas' } }
    };
    expect(
      readResponse(responseOf(answerRequest(request, approved.session, failed), callback), finished.session)
    ).toEqual(failed);
  });

  it('refuses an answer for another connection or session', () => {
    const { approved, finished } = connected();
    const other = startConnect(callback, permission).connection;
    expect(() => finishConnect(connectedOf(approved.link, callback), other)).toThrow(ProtocolMessageError);
    const request = requestOf(sendRequest(finished.session, { type: 'SIGN_REQUEST' }).link);
    const response = responseOf(
      answerRequest(request, approved.session, { response: { type: 'SIGN_RESPONSE' } }),
      callback
    );
    expect(() => readResponse(response, { ...finished.session, session: vectors.session })).toThrow(
      ProtocolMessageError
    );
    expect(() => openRequest(request, { ...approved.session, session: vectors.session })).toThrow(ProtocolMessageError);
  });
});

describe('the rules', () => {
  it('refuses to start a connection that breaks the rules', () => {
    expect(() => startConnect('http://game.example/bread', { type: 'PERMISSION_REQUEST' })).toThrow(
      ProtocolMessageError
    );
    expect(() => startConnect(CALLBACK, { type: 'SIGN_REQUEST' })).toThrow(ProtocolMessageError);
    expect(() => sendRequest(appSession, { type: 'SIGN_REQUEST', payload: 'A'.repeat(MAX_MESSAGE_LENGTH) })).toThrow(
      ProtocolMessageError
    );
  });

  it('refuses to answer a connection whose callback or key is malformed', () => {
    const connect = connectOf(vector('connect').link);
    const answer = { response: { type: 'PERMISSION_RESPONSE' } };
    expect(() => answerConnect({ ...connect, callback: 'https://localhost/bread' }, answer)).toThrow(
      ProtocolMessageError
    );
    expect(() => answerConnect({ ...connect, appPublicKey: 'AAAA' }, answer)).toThrow(ProtocolMessageError);
  });

  it('writes an unsealed error with and without a request id', () => {
    const error = { code: 'SESSION_NOT_FOUND' as const, message: 'gone' };
    expect(envelopeOf(errorLink(CALLBACK, error, vectors.id), CALLBACK)).toEqual({
      type: 'error',
      id: vectors.id,
      error
    });
    expect(envelopeOf(errorLink(CALLBACK, error), CALLBACK)).toEqual({ type: 'error', error });
  });

  it('reads only links under its base, with exactly v and m', () => {
    const link = vector('connect').link;
    expect(readLink(link, CALLBACK)).toBeNull();
    expect(readLink(BREAD_REQUEST_URL, BREAD_REQUEST_URL)).toBeNull();
    expect(readLink(`${BREAD_REQUEST_URL}#v=1&m`, BREAD_REQUEST_URL)).toEqual({ kind: 'invalid' });
    expect(readLink(`${BREAD_REQUEST_URL}#v=1`, BREAD_REQUEST_URL)).toEqual({ kind: 'invalid' });
    expect(readLink(`${BREAD_REQUEST_URL}#v=1&m=${'A'.repeat(MAX_MESSAGE_LENGTH + 1)}`, BREAD_REQUEST_URL)).toEqual({
      kind: 'invalid'
    });
    expect(readLink(`${BREAD_REQUEST_URL}#v=1&m=${toBase64Url(new Uint8Array([0xff]))}`, BREAD_REQUEST_URL)).toEqual({
      kind: 'invalid'
    });
    expect(readLink(`${BREAD_REQUEST_URL}#v=1&m=${toBase64Url(utf8('{'))}`, BREAD_REQUEST_URL)).toEqual({
      kind: 'invalid'
    });
    expect(readLink(`${BREAD_REQUEST_URL}#v=1&m=${toBase64Url(utf8('[]'))}`, BREAD_REQUEST_URL)).toEqual({
      kind: 'invalid'
    });
    expect(readLink(`${BREAD_REQUEST_URL}#v=2&m=AAAA`, BREAD_REQUEST_URL)).toEqual({ kind: 'unsupported-version' });
  });

  it('parses only the five envelopes with well-formed fields', () => {
    const error = { code: 'SESSION_NOT_FOUND', message: 'gone' };
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope([])).toBeNull();
    expect(parseEnvelope({ type: 'hello' })).toBeNull();
    expect(parseEnvelope({ type: 'error', error: { code: 'TEAPOT', message: 'x' } })).toBeNull();
    expect(parseEnvelope({ type: 'error', id: 'short', error })).toBeNull();
    expect(parseEnvelope({ type: 'error', error })).toEqual({ type: 'error', error });
    const connected = connectedOf(vector('connected').link);
    expect(parseEnvelope({ ...connected, sealed: 'AAAA' })).toBeNull();
    expect(parseEnvelope({ ...connected, sealed: 7 })).toBeNull();
    expect(parseEnvelope({ ...connected, nonce: 'AAAA' })).toBeNull();
    const request = requestOf(vector('sign request').link);
    expect(parseEnvelope({ ...request, session: 'AAAA' })).toBeNull();
    expect(parseEnvelope({ ...request, callback: 42 })).toBeNull();
    const response = responseOf(vector('sign response').link);
    expect(parseEnvelope({ ...response, id: undefined })).toBeNull();
    expect(parseEnvelope({ ...connectOf(vector('connect').link), request: 'PERMISSION_REQUEST' })).toBeNull();
  });

  it('refuses a key that is not 32 bytes and a low-order public key', () => {
    const app = bytes(vectors.app.publicKey);
    const secret = bytes(vectors.app.secretKey);
    expect(() => deriveSessionKeys(secret, app.slice(1), app, app)).toThrow(ProtocolCryptoError);
    expect(() => deriveSessionKeys(secret, new Uint8Array(32), app, new Uint8Array(32))).toThrow(ProtocolCryptoError);
  });

  it('refuses a payload that does not open or is not UTF-8', () => {
    const key = generateKeyPair().secretKey;
    const nonce = new Uint8Array(12);
    const aad = additionalData('response', vectors.session, vectors.id);
    const sealed = seal(key, nonce, aad, 'hello');
    expect(open(key, nonce, aad, sealed)).toBe('hello');
    expect(() => open(new Uint8Array(32), nonce, aad, sealed)).toThrow(ProtocolCryptoError);
    expect(() => open(key, nonce, aad, gcm(key, nonce, aad).encrypt(new Uint8Array([0xff])))).toThrow(
      'The sealed payload is not UTF-8'
    );
    expect(decodeBytes('AAAA', 2)).toBeNull();
    expect(decodeBytes('AAAA')).toEqual(new Uint8Array(3));
  });

  it('refuses sealed payloads of the wrong shape', () => {
    const connected = connectedOf(vector('connected').link);
    for (const plaintext of [
      'not json',
      '[]',
      '{}',
      '{"response":{"type":1}}',
      '{"response":{"type":"PERMISSION_RESPONSE"},"error":{"code":"NOT_GRANTED","message":"x"}}'
    ]) {
      expect(() => finishConnect(sealedOver(connected, plaintext), connection)).toThrow(ProtocolMessageError);
    }

    const request = requestOf(vector('sign request').link);
    for (const plaintext of [
      '[]',
      '{"request":{"type":"SIGN_REQUEST"}}',
      '{"request":{"type":"SIGN_REQUEST"},"sentAt":-1}',
      '{"request":{"type":"SIGN_REQUEST"},"sentAt":1.5}',
      '{"request":"SIGN_REQUEST","sentAt":1}'
    ]) {
      expect(() => openRequest(sealedOver(request, plaintext), walletSession)).toThrow(ProtocolMessageError);
    }

    const response = responseOf(vector('sign response').link);
    const error = '{"code":"NOT_GRANTED","message":"x"}';
    for (const plaintext of [
      '[]',
      `{"error":${error},"response":{"type":"SIGN_RESPONSE"}}`,
      `{"error":${error},"transaction":{"output":1}}`,
      '{"response":{"type":"SIGN_RESPONSE"},"transaction":[]}',
      `{"response":{"type":"SIGN_RESPONSE"},"transaction":{"error":${error},"output":1}}`,
      '{"response":{"type":"SIGN_RESPONSE"},"transaction":{}}'
    ]) {
      expect(() => readResponse(sealedOver(response, plaintext), appSession)).toThrow(ProtocolMessageError);
    }
    expect(readResponse(sealedOver(response, `{"error":${error}}`), appSession)).toEqual({
      error: { code: 'NOT_GRANTED', message: 'x' }
    });
  });

  it('refuses a stored session or connection whose keys are malformed', () => {
    const connected = connectedOf(vector('connected').link);
    expect(() => finishConnect(connected, { ...connection, appSecretKey: 'AAAA' })).toThrow(ProtocolMessageError);
    expect(() => sendRequest({ ...appSession, walletPublicKey: 'AAAA' }, { type: 'SIGN_REQUEST' })).toThrow(
      ProtocolMessageError
    );
    const request = requestOf(vector('sign request').link);
    expect(() => openRequest(request, { ...walletSession, appPublicKey: 'AAAA' })).toThrow(ProtocolMessageError);
    expect(() => openRequest({ ...request, sealed: '!' }, walletSession)).toThrow(ProtocolMessageError);
  });
});

describe("the clients' copies of Bread's identity", () => {
  // The Capacitor plugin's native code and the Swift and Kotlin SDKs cannot import these constants, so each keeps a
  // copy, and a copy that drifts sends requests elsewhere or refuses the real Bread only on a device.
  const read = (file: string) => readFileSync(join(__dirname, '../..', file), 'utf8');
  const CAPACITOR_IOS = 'bread-connect-capacitor/ios/Sources/BreadConnectPlugin/BreadConnectPlugin.swift';
  const CAPACITOR_ANDROID =
    'bread-connect-capacitor/android/src/main/java/com/miden/breadconnect/BreadConnectPlugin.java';
  const SWIFT = 'bread-connect-swift/Sources/BreadConnect/Envelope.swift';
  const KOTLIN = 'bread-connect-kotlin/src/main/kotlin/com/miden/breadconnect/Envelope.kt';

  it.each([
    [CAPACITOR_IOS, 'requestPrefix', `${BREAD_REQUEST_URL}#`],
    [CAPACITOR_IOS, 'appStoreURL', APP_STORE_URL],
    [CAPACITOR_ANDROID, 'BREAD_PACKAGE', BREAD_ANDROID_PACKAGE],
    [CAPACITOR_ANDROID, 'REQUEST_PREFIX', `${BREAD_REQUEST_URL}#`],
    [CAPACITOR_ANDROID, 'MARKET_URL', PLAY_STORE_MARKET_URL],
    [CAPACITOR_ANDROID, 'PLAY_URL', PLAY_STORE_URL],
    [SWIFT, 'requestURL', BREAD_REQUEST_URL],
    [SWIFT, 'appStoreURL', APP_STORE_URL],
    [KOTLIN, 'REQUEST_URL', BREAD_REQUEST_URL],
    [KOTLIN, 'BREAD_PACKAGE', BREAD_ANDROID_PACKAGE],
    [KOTLIN, 'PLAY_STORE_MARKET_URL', PLAY_STORE_MARKET_URL],
    [KOTLIN, 'PLAY_STORE_URL', PLAY_STORE_URL]
  ])('%s sets %s as the protocol package does', (file, name, value) => {
    expect(read(file).match(new RegExp(`\\b${name} = (?:URL\\(string: )?"([^"]*)"`))?.[1]).toBe(value);
  });

  it('has both Android clients query only the package they hand requests to', () => {
    for (const manifest of [
      'bread-connect-capacitor/android/src/main/AndroidManifest.xml',
      'bread-connect-kotlin/src/main/AndroidManifest.xml'
    ]) {
      expect([...read(manifest).matchAll(/<package android:name="([^"]+)"/g)].map(match => match[1])).toEqual([
        BREAD_ANDROID_PACKAGE
      ]);
    }
  });

  it('has both Android clients accept exactly the certificates Bread is signed with', () => {
    expect(BREAD_ANDROID_CERTIFICATES).not.toHaveLength(0);
    for (const fingerprint of BREAD_ANDROID_CERTIFICATES) {
      expect(fingerprint).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    const listed = (file: string, list: RegExp) =>
      [...(read(file).match(list)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
    expect(listed(CAPACITOR_ANDROID, /BREAD_CERTIFICATES = \{([^}]*)\}/)).toEqual(BREAD_ANDROID_CERTIFICATES);
    expect(
      listed(
        'bread-connect-kotlin/src/main/kotlin/com/miden/breadconnect/Android.kt',
        /BREAD_CERTIFICATES = listOf\(([^)]*)\)/
      )
    ).toEqual(BREAD_ANDROID_CERTIFICATES);
  });
});
