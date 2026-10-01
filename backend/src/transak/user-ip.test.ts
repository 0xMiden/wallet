import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from './client.js';
import { createUserIpResolver, isPrivateIp, userIpResolverFor } from './user-ip.js';

function stubLookup(responses: Response[]): { fetch: FetchLike; calls: () => number } {
  let count = 0;
  const fetch: FetchLike = async () => {
    const response = responses[count];
    count += 1;
    assert.ok(response, 'unexpected lookup');
    return response;
  };
  return { fetch, calls: () => count };
}

const ok = (ip: string) => new Response(JSON.stringify({ ip }), { status: 200 });

describe('isPrivateIp', () => {
  it('finds loopback, private, link-local and CGNAT addresses', () => {
    const ipv4 = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '169.254.1.1', '100.64.0.1'];
    for (const ip of [...ipv4, '::1', 'fd12::1', 'fe80::1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
  });

  it('keeps public addresses public', () => {
    for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.7', '100.128.0.1', '2001:db8::1', 'not-an-ip']) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });
});

describe('createUserIpResolver', () => {
  it('sends a public caller IP unchanged, with no lookup', async () => {
    const { fetch, calls } = stubLookup([]);
    assert.equal(await createUserIpResolver(fetch)('8.8.8.8'), '8.8.8.8');
    assert.equal(calls(), 0);
  });

  it('replaces a private caller IP with the public IP, and looks it up once', async () => {
    const { fetch, calls } = stubLookup([ok('198.51.100.9')]);
    const resolve = createUserIpResolver(fetch);
    const both = await Promise.all([resolve('127.0.0.1'), resolve('192.168.1.5')]);
    assert.deepEqual(both, ['198.51.100.9', '198.51.100.9']);
    assert.equal(await resolve('::1'), '198.51.100.9');
    assert.equal(calls(), 1);
  });

  it('tries again after a failed lookup', async () => {
    const { fetch, calls } = stubLookup([new Response('', { status: 503 }), ok('198.51.100.9')]);
    const resolve = createUserIpResolver(fetch);
    await assert.rejects(resolve('127.0.0.1'));
    assert.equal(await resolve('127.0.0.1'), '198.51.100.9');
    assert.equal(calls(), 2);
  });

  it('refuses a lookup answer that is not an IP', async () => {
    const { fetch } = stubLookup([ok('nope')]);
    await assert.rejects(createUserIpResolver(fetch)('127.0.0.1'));
  });
});

describe('userIpResolverFor', () => {
  it('replaces a private caller IP in staging', async () => {
    const { fetch, calls } = stubLookup([ok('198.51.100.9')]);
    assert.equal(await userIpResolverFor('staging', fetch)('127.0.0.1'), '198.51.100.9');
    assert.equal(calls(), 1);
  });

  it('sends a private caller IP unchanged in production, with no lookup', async () => {
    const { fetch, calls } = stubLookup([]);
    assert.equal(await userIpResolverFor('production', fetch)('127.0.0.1'), '127.0.0.1');
    assert.equal(calls(), 0);
  });
});
