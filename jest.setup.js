require('@testing-library/jest-dom');
const { Crypto, CryptoKey } = require('@peculiar/webcrypto');
const { TextEncoder, TextDecoder } = require('util');

// jsdom doesn't ship `TextEncoder`/`TextDecoder` on `global` so anything that
// calls `new TextEncoder()` at module scope blows up. Node's `util` has them.
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = TextDecoder;
}

let { db } = require('lib/miden/repo');

// jsdom installs its own `crypto` as a non-configurable getter on `globalThis`
// which only exposes `getRandomValues` / `randomUUID` — no `subtle`. We
// forcibly replace it with `@peculiar/webcrypto` so tests that exercise
// AES-GCM / PBKDF2 / SHA-256 can run. `Object.assign` silently no-ops against
// the jsdom getter, so we have to `defineProperty` with `configurable: true`.
const peculiarCrypto = new Crypto();
Object.defineProperty(globalThis, 'crypto', {
  value: peculiarCrypto,
  writable: true,
  configurable: true
});
Object.defineProperty(globalThis, 'CryptoKey', {
  value: CryptoKey,
  writable: true,
  configurable: true
});

global.afterEach(async () => {
  // clear fake indexeddb database
  await Promise.all(db.tables.map(t => t.clear()));
});
