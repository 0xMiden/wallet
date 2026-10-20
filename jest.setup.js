// `setupFiles: ['dotenv/config']` loads the developer's local `.env`, so a
// `MIDEN_NETWORK=devnet` there would leak into `DEFAULT_NETWORK` and fail every
// test that asserts testnet behaviour (address prefixes, RPC endpoints). CI has
// no `.env` and therefore falls back to testnet — pin the same value here so a
// local run matches CI. Tests that need another network override it explicitly
// via `jest.isolateModules`.
process.env.MIDEN_NETWORK = 'testnet';

// Unit suites replace the external access boundary; dedicated policy tests unmock it.
jest.mock(
  'lib/remote-config/wallet-access',
  () => {
    class WalletAccessDeniedError extends Error {
      constructor() {
        super('Wallet access denied');
        this.code = 'WALLET_ACCESS_DENIED';
      }
    }
    const snapshot = { status: 'allowed', expiresAt: Number.MAX_SAFE_INTEGER };
    const actual = jest.requireActual('lib/remote-config/wallet-access');
    return {
      WalletAccessDeniedError,
      isWalletAccessDeniedError: actual.isWalletAccessDeniedError,
      assertWalletAccessAllowed: jest.fn(),
      ensureWalletAccessAllowed: jest.fn(async () => undefined),
      registerWalletAccessRuntime: jest.fn(),
      publishWalletAccessDecision: jest.fn(),
      invalidateWalletAccess: jest.fn(),
      getWalletAccessGeneration: () => 0,
      getWalletAccessSnapshot: jest.fn(() => snapshot),
      subscribeWalletAccess: jest.fn(() => () => {})
    };
  },
  { virtual: true }
);

beforeEach(() => {
  const access = jest.requireMock('lib/remote-config/wallet-access');
  if (jest.isMockFunction(access.assertWalletAccessAllowed)) access.assertWalletAccessAllowed.mockReset();
  if (jest.isMockFunction(access.ensureWalletAccessAllowed))
    access.ensureWalletAccessAllowed.mockReset().mockResolvedValue(undefined);
});

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
  // Some suites leave fake timers enabled. Dexie's IndexedDB cleanup relies on
  // real scheduling and otherwise waits until Jest's hook timeout.
  jest.useRealTimers();
  // clear fake indexeddb database
  await Promise.all(db.tables.map(t => t.clear()));
});
