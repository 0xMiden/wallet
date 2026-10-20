/* global globalThis */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.WALLET_SOURCE_ROOT ?? process.cwd();
const guardianRoot = path.join(root, 'node_modules/@openzeppelin/guardian-client');
const multisigRoot = path.join(root, 'node_modules/@openzeppelin/miden-multisig-client');
for (const packageRoot of [guardianRoot, multisigRoot]) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '0.18.1', 'The proof must exercise the lock-pinned installed SDK');
}
const { GuardianHttpClient } = await import(pathToFileURL(path.join(guardianRoot, 'dist/http.js')).href);
const { Multisig } = await import(pathToFileURL(path.join(multisigRoot, 'dist/multisig.js')).href);
const endpoint = 'https://guardian.example.test';
const accountId = 'account-geo019';
const makeBarrier = () => {
  let enter;
  let release;
  const ready = new Promise(resolve => {
    enter = resolve;
  });
  const pending = new Promise(resolve => {
    release = resolve;
  });
  return {
    ready,
    release,
    wait: async () => {
      enter();
      await pending;
    }
  };
};
const makeFixture = (entry, pauseAtSignature, replay) => {
  const barrier = makeBarrier();
  const requests = [];
  const originalFetch = globalThis.fetch;
  const state = { generation: 7, endpoint, signatures: 0, guards: 0 };
  const refused = new Error('Guardian pass is no longer current');
  const client = new GuardianHttpClient(endpoint);
  client.setSigner({
    publicKey: 'test-public-key',
    commitment: 'test-commitment',
    scheme: 'ecdsa',
    signAccountIdWithTimestamp: async () => {
      throw new Error('Expected request-bound authentication');
    },
    signRequest: async () => {
      state.signatures += 1;
      if (state.signatures === pauseAtSignature) await barrier.wait();
      return 'test-signature';
    }
  });
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (replay && requests.length === 1) {
      return new Response(
        JSON.stringify({
          code: 'authentication_replay',
          message: 'Replay rejected',
          meta: { retryable: true }
        }),
        { status: 401, statusText: 'Unauthorized' }
      );
    }
    return new Response(JSON.stringify({ success: true, message: 'Configured' }), { status: 200 });
  };
  const assertCurrent = () => {
    state.guards += 1;
    if (state.generation !== 7 || new URL(state.endpoint).origin !== new URL(endpoint).origin) throw refused;
  };
  const request = beforeSend => {
    if (entry === 'configure') {
      return client.configure(
        {
          accountId,
          auth: { MidenEcdsa: { cosigner_commitments: ['test-commitment'] } },
          initialState: { data: 'account-bytes', accountId }
        },
        beforeSend
      );
    }
    return Reflect.apply(
      Multisig.prototype.registerOnGuardian,
      {
        _accountId: accountId,
        signer: { scheme: 'ecdsa' },
        signerCommitments: ['test-commitment'],
        guardian: client
      },
      ['account-bytes', beforeSend]
    );
  };
  return {
    barrier,
    requests,
    state,
    refused,
    assertCurrent,
    request,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
};

const waitForAuthentication = async (fixture, outcome) => {
  const entered = await Promise.race([fixture.barrier.ready.then(() => true), outcome.then(() => false)]);
  assert.equal(entered, true, 'The installed SDK must reach the deferred authentication call');
};

for (const entry of ['configure', 'registerOnGuardian']) {
  for (const change of ['retirement', 'endpoint replacement']) {
    test(
      `GEO019 installed ${entry} refuses ${change} during authentication before fetch`,
      { timeout: 5_000, concurrency: false },
      async () => {
        const fixture = makeFixture(entry, 1, false);
        const outcome = fixture.request(fixture.assertCurrent).then(
          () => undefined,
          error => error
        );
        try {
          await waitForAuthentication(fixture, outcome);
          assert.equal(fixture.requests.length, 0, 'Authentication must still be pending before the first POST');
          if (change === 'retirement') fixture.state.generation += 1;
          else fixture.state.endpoint = 'https://different.guardian.test';
          fixture.barrier.release();
          const result = await outcome;
          assert.equal(fixture.requests.length, 0, 'A pass retired during authentication must not POST configure');
          assert.equal(result, fixture.refused, 'The pass refusal must retain its identity');
          assert.equal(fixture.state.signatures, 1);
        } finally {
          fixture.barrier.release();
          await outcome;
          fixture.restore();
        }
      }
    );
  }

  test(
    `GEO019 installed ${entry} admits canonical equivalence after authentication`,
    { timeout: 5_000, concurrency: false },
    async () => {
      const fixture = makeFixture(entry, 1, false);
      const request = fixture.request(fixture.assertCurrent);
      const outcome = request.catch(error => error);
      try {
        await waitForAuthentication(fixture, outcome);
        fixture.state.endpoint = 'https://GUARDIAN.EXAMPLE.TEST:443/';
        fixture.barrier.release();
        await request;
        assert.equal(fixture.requests.length, 1, 'A still-current operator must receive exactly one configure');
        assert.equal(fixture.requests[0].url, `${endpoint}/configure`);
        assert.equal(fixture.requests[0].init.method, 'POST');
        assert.equal(fixture.state.guards, 1);
      } finally {
        fixture.barrier.release();
        await outcome;
        fixture.restore();
      }
    }
  );

  test(
    `GEO019 installed ${entry} refuses retirement during replay authentication before a second fetch`,
    { timeout: 5_000, concurrency: false },
    async () => {
      const fixture = makeFixture(entry, 2, true);
      const outcome = fixture.request(fixture.assertCurrent).then(
        () => undefined,
        error => error
      );
      try {
        await waitForAuthentication(fixture, outcome);
        assert.equal(fixture.requests.length, 1, 'The original configure must be the only submitted attempt');
        fixture.state.generation += 1;
        fixture.barrier.release();
        const result = await outcome;
        assert.equal(fixture.requests.length, 1, 'A retired replay must not POST a second configure');
        assert.equal(result, fixture.refused);
        assert.equal(fixture.state.signatures, 2);
        assert.equal(fixture.state.guards, 2, 'Every authenticated replay must run the final-send guard');
      } finally {
        fixture.barrier.release();
        await outcome;
        fixture.restore();
      }
    }
  );

  test(
    `GEO019 installed ${entry} preserves a live authenticated replay`,
    { timeout: 5_000, concurrency: false },
    async () => {
      const fixture = makeFixture(entry, 0, true);
      try {
        await fixture.request(fixture.assertCurrent);
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.state.signatures, 2);
        assert.equal(fixture.state.guards, 2);
      } finally {
        fixture.restore();
      }
    }
  );

  test(
    `GEO019 installed ${entry} preserves optional-hook default callers`,
    { timeout: 5_000, concurrency: false },
    async () => {
      const fixture = makeFixture(entry, 0, true);
      try {
        await fixture.request();
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.state.signatures, 2);
        assert.equal(fixture.state.guards, 0);
      } finally {
        fixture.restore();
      }
    }
  );
}
