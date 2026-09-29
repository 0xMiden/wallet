import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { buildChallengeMessage, ChallengeStore, verifyChallenge } from './challenge.js';

describe('buildChallengeMessage', () => {
  it('builds the exact text', () => {
    const message = buildChallengeMessage({
      fiatAmount: '50.5',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      nonce: '00112233445566778899aabbccddeeff',
      expiresAt: 1767225600
    });
    assert.equal(
      message,
      'Buy 50.5 USD of USDC on Ethereum to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 via Transak. ' +
        'Nonce 00112233445566778899aabbccddeeff, expires 2026-01-01T00:00:00.000Z.'
    );
  });
});

describe('ChallengeStore', () => {
  const address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

  it('issues a 32-char hex nonce that expires in 300 s', () => {
    const store = new ChallengeStore(() => 1_000_000);
    const issued = store.issue(address, '10');
    assert.match(issued.nonce, /^[0-9a-f]{32}$/);
    assert.equal(issued.expiresAt, 1000 + 300);
  });

  it('gives a nonce only once', () => {
    const store = new ChallengeStore(() => 0);
    const { nonce } = store.issue(address, '10');
    assert.deepEqual(store.take(nonce), { address, fiatAmount: '10', expiresAt: 300 });
    assert.equal(store.take(nonce), null);
  });

  it('refuses and removes an expired nonce', () => {
    let now = 0;
    const store = new ChallengeStore(() => now);
    const { nonce } = store.issue(address, '10');
    now = 300_000;
    assert.equal(store.take(nonce), null);
    assert.equal(store.size, 0);
  });

  it('prunes expired entries on issue', () => {
    let now = 0;
    const store = new ChallengeStore(() => now);
    store.issue(address, '10');
    store.issue(address, '20');
    now = 301_000;
    store.issue(address, '30');
    assert.equal(store.size, 1);
  });
});

describe('verifyChallenge', () => {
  it('accepts the owner signature and refuses a changed amount or another key', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const store = new ChallengeStore(() => 0);
    const issued = store.issue(account.address, '25');
    const entry = store.take(issued.nonce);
    assert.ok(entry);

    const signature = await account.signMessage({ message: issued.message });
    assert.equal(await verifyChallenge(entry, issued.nonce, signature), true);
    assert.equal(await verifyChallenge({ ...entry, fiatAmount: '2500' }, issued.nonce, signature), false);

    const otherSignature = await other.signMessage({ message: issued.message });
    assert.equal(await verifyChallenge(entry, issued.nonce, otherSignature), false);
    assert.equal(await verifyChallenge(entry, issued.nonce, '0x1234'), false);
  });
});
