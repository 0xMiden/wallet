import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import { createApp } from '../app.js';
import { FakeChain, memoryStore, MIDEN_ACCOUNT, TOKEN } from '../test/support.js';
import { passCallerIp } from '../transak/user-ip.js';

async function fixture(trustedProxies: string[]) {
  const userIps: string[] = [];
  const app = createApp({
    config: {
      trustedProxies,
      allowedOrigins: '*',
      referrerDomain: 'wallet.miden.xyz',
      maxFiatAmountUsd: 1000,
      onrampTokenAddress: TOKEN,
      onrampTokenDecimals: 18
    },
    transak: {
      createWidgetSession: async (_params, ip) => {
        userIps.push(ip);
        return 'https://global-stg.transak.com/';
      },
      getOrderByPartnerId: async () => null
    },
    resolveUserIp: passCallerIp,
    orders: memoryStore(Date.now),
    chain: new FakeChain(),
    now: Date.now,
    onOrderCreated: () => {}
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    userIps,
    post: (path: string, body: object, forwarded: string) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded },
        body: JSON.stringify(body)
      }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  };
}

const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const body = { evmAddress: account.address, fiatAmount: '10', midenAccountHex: MIDEN_ACCOUNT };
const challengeSchema = z.object({ nonce: z.string(), message: z.string() });

describe('trusted proxy configuration', () => {
  for (const trusted of [false, true]) {
    it(`uses the ${trusted ? 'forwarded' : 'socket'} IP for sessions and rate limits`, async () => {
      const app = await fixture(trusted ? ['127.0.0.1'] : []);
      try {
        const first = await app.post('/transak/challenge', body, '203.0.113.7');
        const challenge = challengeSchema.parse(await first.json());
        const signature = await account.signMessage({ message: challenge.message });
        assert.equal(
          (await app.post('/transak/session', { nonce: challenge.nonce, signature }, '203.0.113.7')).status,
          200
        );
        assert.deepEqual(app.userIps, [trusted ? '203.0.113.7' : '127.0.0.1']);
        for (let i = 0; i < 9; i += 1) {
          assert.equal((await app.post('/transak/challenge', body, '203.0.113.7')).status, 200);
        }
        assert.equal((await app.post('/transak/challenge', body, '203.0.113.7')).status, 429);
        assert.equal((await app.post('/transak/challenge', body, '203.0.113.8')).status, trusted ? 200 : 429);
      } finally {
        await app.close();
      }
    });
  }

  it('does not trust a forged address before an untrusted forwarding hop', async () => {
    const app = await fixture(['127.0.0.1']);
    try {
      const response = await app.post('/transak/challenge', body, '198.51.100.99, 203.0.113.7');
      const challenge = challengeSchema.parse(await response.json());
      const signature = await account.signMessage({ message: challenge.message });
      assert.equal(
        (await app.post('/transak/session', { nonce: challenge.nonce, signature }, '198.51.100.99, 203.0.113.7'))
          .status,
        200
      );
      assert.deepEqual(app.userIps, ['203.0.113.7']);
    } finally {
      await app.close();
    }
  });
});
