import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.js';

const env = {
  TRANSAK_API_KEY: 'test-key',
  TRANSAK_API_SECRET: 'test-secret',
  RELAYER_PRIVATE_KEY: `0x${'01'.repeat(32)}`
};

describe('backend configuration', () => {
  it('rejects live purchases while the bridge uses testnet', () => {
    assert.throws(() => loadConfig({ ...env, TRANSAK_ENV: 'production' }), /bridge uses Sepolia testnet/);
    assert.equal(loadConfig(env).transakEnv, 'staging');
  });

  it('trusts no proxies by default and accepts explicit IP ranges', () => {
    assert.deepEqual(loadConfig(env).trustedProxies, []);
    assert.deepEqual(loadConfig({ ...env, TRUSTED_PROXIES: '127.0.0.1, 10.1.0.0/16, ::1' }).trustedProxies, [
      '127.0.0.1',
      '10.1.0.0/16',
      '::1'
    ]);
  });

  it('rejects blanket trust, invalid IP addresses and invalid prefixes', () => {
    for (const value of ['true', '*', '1', '0.0.0.0/0', '::/0', '10.0.0.1/33', '::1/129', '127.0.0.1/no']) {
      assert.throws(() => loadConfig({ ...env, TRUSTED_PROXIES: value }), /TRUSTED_PROXIES/);
    }
  });
});
