import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRawMidenClient,
  setRawClientAdapter
} from '../node_modules/@openzeppelin/miden-multisig-client/dist/raw-client.js';

test('Guardian imports and the next operation use the supplied client and its tree cache', async () => {
  const entries = new Set([1, 2, 3]);
  const inner = {
    async newAccount(nextEntries) {
      entries.clear();
      for (const entry of nextEntries) entries.add(entry);
    },
    async executeForSummaryAt() {
      return [...entries];
    }
  };
  let holds = 0;
  const client = {
    accounts: {},
    sync() {},
    async _withInnerWebClient(operation) {
      holds++;
      return operation(inner);
    }
  };
  const raw = await getRawMidenClient(client);
  assert.equal(await getRawMidenClient(client), raw);
  await raw.newAccount([1, 2, 3, 4], true);
  assert.deepEqual(await raw.executeForSummaryAt(), [1, 2, 3, 4]);
  assert.equal(holds, 2);
});

test('the offscreen adapter owns state operations and can be replaced', async () => {
  const client = {
    accounts: {},
    sync() {},
    _withInnerWebClient() {
      throw new Error('State operation reached the service-worker client');
    }
  };
  const calls = [];
  const adapter = {
    async newAccount(account, overwrite) { calls.push(['insert', account, overwrite]); },
    async syncState() { calls.push(['sync']); },
    async executeForSummaryAt() { return 'offscreen-summary'; }
  };
  setRawClientAdapter(client, adapter);
  const raw = await getRawMidenClient(client);
  await raw.newAccount('published-account', true);
  await raw.syncState();
  assert.equal(await raw.executeForSummaryAt(), 'offscreen-summary');
  assert.deepEqual(calls, [['insert', 'published-account', true], ['sync']]);
  setRawClientAdapter(client, { async executeForSummaryAt() { return 'replacement-summary'; } });
  assert.equal(await raw.executeForSummaryAt(), 'replacement-summary');
});

test('raw callers retain their supplied client', async () => {
  const raw = { async getAccount() {} };
  assert.equal(await getRawMidenClient(raw), raw);
});
