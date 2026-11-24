// Writes v1.json from fixed inputs with Node's own crypto (OpenSSL), so the vectors do not come from any
// implementation they check. Run: node packages/bread-connect/vectors/generate.mjs
import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const b64u = bytes => Buffer.from(bytes).toString('base64url');
const hex = text => Buffer.from(text, 'hex');
const bytes = (from, length) => Buffer.from(Array.from({ length }, (_, i) => (from + i) & 255));

const PKCS8_X25519 = hex('302e020100300506032b656e04220420');
const SPKI_X25519 = hex('302a300506032b656e032100');

function keyPair(secretHex) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, hex(secretHex)]),
    format: 'der',
    type: 'pkcs8'
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, secretKey: hex(secretHex), publicKey };
}

function publicKeyObject(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}

// RFC 7748 section 6.1: the app is Alice and Bread is Bob.
const app = keyPair('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const wallet = keyPair('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
const shared = diffieHellman({ privateKey: app.privateKey, publicKey: publicKeyObject(wallet.publicKey) });
const sharedFromWallet = diffieHellman({ privateKey: wallet.privateKey, publicKey: publicKeyObject(app.publicKey) });
if (!shared.equals(sharedFromWallet)) throw new Error('X25519 disagrees');

const info = Buffer.concat([Buffer.from('session'), app.publicKey, wallet.publicKey]);
const keys = Buffer.from(hkdfSync('sha256', shared, Buffer.from('bread-connect/v1'), info, 64));
const appKey = keys.subarray(0, 32);
const walletKey = keys.subarray(32);

const callback = 'https://wherelegendsgrow.com/bread';
const breadBase = 'https://bread.miden.xyz/request';
const id = b64u(bytes(0, 16));
const secondId = b64u(bytes(32, 16));
const session = b64u(bytes(16, 16));
const sentAt = 1792000000000;

const link = (base, envelope, version = '1') =>
  `${base}#v=${version}&m=${b64u(Buffer.from(JSON.stringify(envelope), 'utf8'))}`;

function sealed(key, nonce, type, sessionId, requestId, payload) {
  const additionalData = `bread-connect/v1|${type}|${sessionId}|${requestId}`;
  const plaintext = JSON.stringify(payload);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(additionalData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64u(nonce), sealed: b64u(body), additionalData, plaintext };
}

const permissionRequest = {
  type: 'PERMISSION_REQUEST',
  appMeta: { name: 'Where Legends Grow' },
  network: 'testnet',
  force: false,
  privateDataPermission: 'UPON_REQUEST'
};
const permissionResponse = {
  type: 'PERMISSION_RESPONSE',
  accountId: 'mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3',
  network: 'testnet',
  privateDataPermission: 'UPON_REQUEST',
  allowedPrivateData: 0,
  publicKey: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='
};
const signRequest = {
  type: 'SIGN_REQUEST',
  sourceAccountId: 'mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3',
  sourcePublicKey: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  payload: 'aGVsbG8gZnJvbSBXTEc=',
  kind: 'word'
};
const signResponse = { type: 'SIGN_RESPONSE', signature: 'c2lnbmF0dXJlIGJ5dGVz' };
const sendRequest = {
  type: 'SEND_TRANSACTION_REQUEST',
  sourcePublicKey: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  transaction: {
    senderAddress: 'mtst1qy35q7ar3h0cgyqqqx2gs3nzxrgu7hz5xz3',
    recipientAddress: 'mtst1qzmlp0vxd4w9vgqqqrw3dz3lh5jx2nk7c5n',
    faucetId: 'mtst1qppen8yngje35gr223jwe6ptjy7gedn9',
    noteType: 'private',
    amount: '1000000'
  }
};
const sendResponse = { type: 'SEND_TRANSACTION_RESPONSE', transactionId: 'tx-7f3e' };
const transactionOutput = { txHash: '0x5f1c9e', outputNotes: [] };

const connectEnvelope = {
  type: 'connect',
  id,
  callback,
  appPublicKey: b64u(app.publicKey),
  request: permissionRequest
};

function connected(nonceFrom, answer, requestId = id) {
  const s = sealed(walletKey, bytes(nonceFrom, 12), 'connected', session, requestId, answer);
  const envelope = {
    type: 'connected',
    id: requestId,
    session,
    walletPublicKey: b64u(wallet.publicKey),
    nonce: s.nonce,
    sealed: s.sealed
  };
  return { envelope, additionalData: s.additionalData, plaintext: s.plaintext };
}

function request(nonceFrom, payload, requestId) {
  const s = sealed(appKey, bytes(nonceFrom, 12), 'request', session, requestId, payload);
  const envelope = { type: 'request', id: requestId, session, callback, nonce: s.nonce, sealed: s.sealed };
  return { envelope, additionalData: s.additionalData, plaintext: s.plaintext };
}

function response(nonceFrom, payload, requestId) {
  const s = sealed(walletKey, bytes(nonceFrom, 12), 'response', session, requestId, payload);
  const envelope = { type: 'response', id: requestId, session, nonce: s.nonce, sealed: s.sealed };
  return { envelope, additionalData: s.additionalData, plaintext: s.plaintext };
}

const approved = connected(64, { response: permissionResponse });
const refused = connected(80, { error: { code: 'NOT_GRANTED', message: 'The user declined' } });
const sign = request(96, { request: signRequest, sentAt }, id);
const signed = response(112, { response: signResponse }, id);
const send = request(128, { request: sendRequest, sentAt }, secondId);
const sent = response(144, { response: sendResponse, transaction: { output: transactionOutput } }, secondId);
const errorEnvelope = { type: 'error', id, error: { code: 'SESSION_NOT_FOUND', message: 'Bread has no such session' } };

const messages = [
  { name: 'connect', base: breadBase, link: link(breadBase, connectEnvelope), envelope: connectEnvelope },
  { name: 'connected', base: callback, link: link(callback, approved.envelope), ...approved },
  { name: 'connected, refused', base: callback, link: link(callback, refused.envelope), ...refused },
  { name: 'sign request', base: breadBase, link: link(breadBase, sign.envelope), ...sign },
  { name: 'sign response', base: callback, link: link(callback, signed.envelope), ...signed },
  { name: 'send request', base: breadBase, link: link(breadBase, send.envelope), ...send },
  { name: 'send response with its outcome', base: callback, link: link(callback, sent.envelope), ...sent },
  { name: 'unsealed error', base: callback, link: link(callback, errorEnvelope), envelope: errorEnvelope }
];

const flip = text => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
const zeroKey = b64u(Buffer.alloc(32));

const invalid = [
  {
    name: 'version 2',
    base: breadBase,
    link: link(breadBase, connectEnvelope, '2'),
    read: { kind: 'unsupported-version', callback, id }
  },
  {
    name: 'no version',
    base: breadBase,
    link: `${breadBase}#m=${b64u(Buffer.from(JSON.stringify(connectEnvelope)))}`,
    read: { kind: 'invalid' }
  },
  {
    name: 'version twice',
    base: breadBase,
    link: link(breadBase, connectEnvelope).replace('#v=1', '#v=1&v=1'),
    read: { kind: 'invalid' }
  },
  {
    name: 'padded base64url',
    base: breadBase,
    link: `${breadBase}#v=1&m=${Buffer.from(JSON.stringify(connectEnvelope)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')}${'='.repeat(2)}`,
    read: { kind: 'invalid' }
  },
  {
    name: 'callback with a query',
    base: breadBase,
    link: link(breadBase, { ...connectEnvelope, callback: `${callback}?from=game` }),
    read: { kind: 'invalid', id }
  },
  {
    name: 'http callback',
    base: breadBase,
    link: link(breadBase, { ...connectEnvelope, callback: 'http://wherelegendsgrow.com/bread' }),
    read: { kind: 'invalid', id }
  },
  {
    name: 'connect without a permission request',
    base: breadBase,
    link: link(breadBase, { ...connectEnvelope, request: signRequest }),
    read: { kind: 'invalid', callback, id }
  },
  {
    name: 'public key of 31 bytes',
    base: breadBase,
    link: link(breadBase, { ...connectEnvelope, appPublicKey: b64u(app.publicKey.subarray(1)) }),
    read: { kind: 'invalid', callback, id }
  },
  {
    name: 'unsealed error with a code Bread seals',
    base: callback,
    link: link(callback, {
      ...errorEnvelope,
      error: { code: 'TRANSACTION_FAILED', message: 'The transaction failed' }
    }),
    read: { kind: 'invalid', id }
  }
];

// Callbacks with the origin every implementation reads from them; a null origin is a callback each refuses.
const longPath = 'b'.repeat(512 - 'https://wherelegendsgrow.com/'.length);
const callbacks = [
  { callback, origin: 'https://wherelegendsgrow.com' },
  { callback: 'https://xn--bcher-kva.example/a/B%20c/', origin: 'https://xn--bcher-kva.example' },
  { callback: 'https://xn--.example/bread', origin: 'https://xn--.example' },
  { callback: 'https://game.example/', origin: 'https://game.example' },
  { callback: "https://a-1.game.example/x;y=1/@z:~/(a)!$&'*+,", origin: 'https://a-1.game.example' },
  { callback: `https://wherelegendsgrow.com/${longPath}`, origin: 'https://wherelegendsgrow.com' },
  ...[
    'https://wherelegendsgrow.com',
    'https://WhereLegendsGrow.com/bread',
    'https://wherelegendsgrow.com:8443/bread',
    'https://user@wherelegendsgrow.com/bread',
    'https://user:pass@wherelegendsgrow.com/bread',
    'https://127.0.0.1/bread',
    'https://1.2.3/bread',
    'https://0x7f.1/bread',
    'https://[::1]/bread',
    'https://localhost/bread',
    'https://game.localhost/bread',
    'https://wherelegendsgrow.com./bread',
    'https://wherelegendsgrow..com/bread',
    'https://.wherelegendsgrow.com/bread',
    'https://my_game.example/bread',
    'https://game$.example/bread',
    'https://wherelegendsgrow.com/bread#x',
    'https://wherelegendsgrow.com/bread?x=1',
    'https://wherelegendsgrow.com/./bread',
    'https://wherelegendsgrow.com/a/../bread',
    'https://wherelegendsgrow.com/a/%2E%2e/bread',
    'https://wherelegendsgrow.com/a\\bread',
    'https://wherelegendsgrow.com/br ead',
    'https://wherelegendsgrow.com/bréad',
    'https://wherelegendsgrow.com/a|b',
    'https://wherelegendsgrow.com/[x]',
    'https://wherelegendsgrow.com/bread%zz',
    'https://wherelegendsgrow.com/bread%2',
    'https://bücher.example/bread',
    'http://wherelegendsgrow.com/bread',
    'not a link',
    `https://wherelegendsgrow.com/${longPath}b`
  ].map(refused => ({ callback: refused, origin: null }))
];

// Envelopes that read but must not open: the receiver refuses each.
const unopenable = [
  {
    name: 'tampered ciphertext',
    role: 'app',
    envelope: { ...approved.envelope, sealed: flip(approved.envelope.sealed) }
  },
  { name: 'answer moved to another request id', role: 'app', envelope: { ...signed.envelope, id: secondId } },
  {
    name: 'request sealed with the wallet key',
    role: 'wallet',
    envelope: { ...sign.envelope, sealed: response(96, { request: signRequest, sentAt }, id).envelope.sealed }
  },
  { name: 'all-zero wallet public key', role: 'app', envelope: { ...approved.envelope, walletPublicKey: zeroKey } }
];

const vectors = {
  description:
    'Bread Connect protocol version 1 test vectors. Keys are RFC 7748 section 6.1 (the app is Alice, Bread is Bob). Generated by generate.mjs with Node crypto.',
  app: { secretKey: b64u(app.secretKey), publicKey: b64u(app.publicKey) },
  wallet: { secretKey: b64u(wallet.secretKey), publicKey: b64u(wallet.publicKey) },
  shared: b64u(shared),
  keys: { appKey: b64u(appKey), walletKey: b64u(walletKey) },
  callback,
  origin: 'https://wherelegendsgrow.com',
  id,
  secondId,
  session,
  sentAt,
  messages,
  invalid,
  unopenable,
  callbacks
};

writeFileSync(new URL('./v1.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
