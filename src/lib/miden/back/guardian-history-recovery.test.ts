import {
  GuardianHttpClient,
  GuardianHttpError,
  type DeltaObject,
  type HistoryEntry,
  type HistoryPage
} from '@openzeppelin/guardian-client';

import { reportGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { ITransactionStatus } from '../db/types';
import { GUARDIAN_HISTORY_VERSION, historyCheckpointId } from '../guardian/history';
import {
  clearGuardianHistoryCheckpoints,
  readGuardianHistoryState,
  saveGuardianHistoryCheckpoint
} from '../guardian/history-storage';
import { exportDb, importDb, transactions } from '../repo';
import {
  classifyHistoryFailure,
  MAX_HISTORY_ENTRIES_PER_SOURCE,
  recoverGuardianHistory
} from './guardian-history-recovery';
import { midenClientProxy } from './miden-client-proxy';
import { GuardianHistoryFeeUnavailableError } from '../guardian/history-errors';

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    getDeltaHistory = jest.fn();
    getDelta = jest.fn();
  },
  GuardianHttpError: class extends Error {
    code: string | null;
    constructor(
      public status: number,
      public statusText: string,
      public body: string
    ) {
      super(body);
      this.code = body === 'account_not_found' ? body : null;
    }
  }
}));
jest.mock('lib/miden/front/storage', () => {
  const values = new Map<string, object | string>();
  return {
    fetchFromStorage: async (key: string) => values.get(key) ?? null,
    putToStorage: async (key: string, value: object | string) => {
      values.set(key, value);
    }
  };
});
jest.mock('lib/guardian-note-recovery-progress', () => ({ reportGuardianNoteRecoveryProgress: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({
  MIDEN_GUARDIAN_ENDPOINTS: new Map([['testnet', ['https://one/', 'https://two']]])
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: async () => 'https://one' }));
jest.mock('lib/miden/sdk/helpers', () => ({ canonicalWalletAccountId: (id: string) => id }));
jest.mock('./miden-client-proxy', () => ({
  midenClientProxy: {
    decodeGuardianHistory: jest.fn(),
    getGuardianResultCommitment: jest.fn()
  }
}));

const account: WalletAccount = {
  publicKey: 'account',
  name: 'account',
  isPublic: false,
  type: WalletType.Guardian,
  hdIndex: 0,
  authScheme: 'ecdsa',
  coldPublicKey: 'cold'
};
const timestamp = '2026-08-01T00:00:00Z';
const entry = (nonce: number): HistoryEntry => ({
  nonce,
  status: 'canonical',
  timestamp,
  newCommitment: `commitment-${nonce}`,
  inputNotes: [],
  outputNotes: [],
  decodeWarnings: []
});
const delta = (nonce: number): DeltaObject => ({
  accountId: 'account',
  nonce,
  prevCommitment: '',
  newCommitment: `commitment-${nonce}`,
  deltaPayload: { txSummary: { data: nonce.toString() }, signatures: [] },
  status: { status: 'canonical', timestamp },
  metadata: { proposal: { proposalType: 'swap' } }
});
let clients: Map<string, GuardianHttpClient>;
const shouldYield = jest.fn<Promise<string | null>, []>();
const createClient = jest.fn(async (_account: WalletAccount, endpoint: string) => {
  const guardian = clients.get(endpoint);
  if (!guardian) throw new Error(`Missing test source ${endpoint}`);
  return { guardian, guardianAccountId: 'account' };
});
const run = () => recoverGuardianHistory(account, { createClient, shouldYield });

function source(endpoint: string, pages: HistoryPage[]) {
  const client = new GuardianHttpClient(endpoint);
  const history = jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [] });
  for (const page of pages) history.mockResolvedValueOnce(page);
  jest.spyOn(client, 'getDelta').mockImplementation(async (_accountId, nonce) => delta(nonce));
  clients.set(endpoint, client);
  return client;
}

beforeEach(async () => {
  jest.clearAllMocks();
  await transactions.clear();
  await clearGuardianHistoryCheckpoints();
  clients = new Map();
  source('https://one', [{ entries: [entry(2)], nextCursor: 'next' }, { entries: [entry(1)] }]);
  source('https://two', [{ entries: [entry(2), entry(3)] }]);
  shouldYield.mockResolvedValue(null);
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementation(async encoded => ({
    accountId: 'account',
    inputNotes: [],
    outputNotes: [{ id: `note-${encoded}`, visibility: 'public', assets: [{ faucetId: 'asset', amount: '7' }] }]
  }));
  jest.mocked(midenClientProxy.getGuardianResultCommitment).mockResolvedValue('commitment-2');
});

it('paginates current source first, removes duplicate operators, and merges duplicate deltas', async () => {
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 3 });
  expect(createClient.mock.calls.map(call => call[1])).toEqual(['https://one', 'https://two']);
  const rows = await transactions.toArray();
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.recovery?.nonce === 2)?.recovery?.operators).toEqual(['https://one', 'https://two']);
  expect(clients.get('https://one')?.getDeltaHistory).toHaveBeenNthCalledWith(2, 'account', {
    limit: 50,
    cursor: 'next'
  });
  createClient.mockClear();
  await run();
  expect(createClient).not.toHaveBeenCalled();
  expect(await transactions.count()).toBe(3);
});

it('preserves a richer local action matched through its execution commitment', async () => {
  await transactions.add({
    id: 'local-bridge',
    type: 'bridged-send',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'SEND',
    resultBytes: new Uint8Array([1]),
    extraInputs: { destinationAddress: 'evm-address' }
  });
  await run();
  expect(await transactions.count()).toBe(3);
  const local = await transactions.get('local-bridge');
  expect(local?.extraInputs.destinationAddress).toBe('evm-address');
  expect(local?.recovery).toBeUndefined();
});

it('gives a matched local consume only the retained recovery data, across a version upgrade', async () => {
  const localFields = {
    transactionId: '0xlocal',
    displayMessage: 'Claimed',
    displayIcon: 'RECEIVE' as const,
    extraInputs: { kept: 'local' }
  };
  await transactions.add({
    id: 'local-consume',
    type: 'consume',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    resultBytes: new Uint8Array([1]),
    ...localFields
  });
  // Both operators retain consume_notes deltas: nonces 2 and 1 on one, 2 and 3 on two.
  const serveConsumes = () => {
    const sources: Array<[string, HistoryPage[]]> = [
      ['https://one', [{ entries: [entry(2)], nextCursor: 'next' }, { entries: [entry(1)] }]],
      ['https://two', [{ entries: [entry(2), entry(3)] }]]
    ];
    for (const [endpoint, pages] of sources) {
      jest.spyOn(source(endpoint, pages), 'getDelta').mockImplementation(async (_account, nonce) => ({
        ...delta(nonce),
        metadata: { proposal: { proposalType: 'consume_notes' } }
      }));
    }
  };
  serveConsumes();
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementation(async encoded => ({
    accountId: 'account',
    inputNotes: [
      { id: `in-${encoded}`, visibility: 'public', sender: 'sender', assets: [{ faucetId: 'asset', amount: '7' }] }
    ],
    outputNotes: []
  }));
  await run();
  const first = await transactions.get('local-consume');
  expect(first).toMatchObject(localFields);
  expect(first?.recovery?.completeness).toBe('decoded');

  if (!first?.recovery) throw new Error('Missing recovery data');
  await transactions.update('local-consume', { recovery: { ...first.recovery, version: 1 } });
  await clearGuardianHistoryCheckpoints();
  serveConsumes();
  const second = await run();
  const upgraded = await transactions.get('local-consume');
  expect(upgraded).toMatchObject(localFields);
  expect(upgraded?.recovered).toBeUndefined();
  expect(upgraded?.restoredFromBackup).toBeUndefined();
  expect(upgraded?.recovery?.version).toBe(GUARDIAN_HISTORY_VERSION);
  expect(upgraded?.recovery?.operators).toEqual(['https://one', 'https://two']);
  // Only the two rows rebuilt from history count as restored.
  expect(second.restored).toBe(2);
});

it('keeps the cursor for an interrupted page and resumes without duplicate rows', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockResolvedValueOnce({ entries: [entry(2)], nextCursor: 'next' })
    .mockImplementationOnce(async () => {
      shouldYield.mockResolvedValue('wallet locked');
      return { entries: [entry(1)] };
    });
  expect((await run()).deferred).toBe(true);
  expect(await transactions.count()).toBe(1);
  expect(Object.values((await readGuardianHistoryState()).checkpoints)[0]?.cursor).toBe('next');
  shouldYield.mockResolvedValue(null);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(1)] });
  await run();
  expect(await transactions.count()).toBe(3);
});

it('defers a pass whose storage is wiped while a page is in flight', async () => {
  // A wallet that never imported a file has no generation key until the first read stores one.
  await putToStorage('guardian_history_generation_v1', null);
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  let release: (() => void) | undefined;
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise<HistoryPage>(resolve => {
          release = () => resolve({ entries: [entry(2)], nextCursor: 'next' });
        })
    );
  const pending = run();
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0));
  if (!release) throw new Error('The page request never started');
  await putToStorage('guardian_history_generation_v1', null);
  release();
  expect((await pending).deferred).toBe(true);
  const stored = await fetchFromStorage<{ checkpoints: Record<string, { cursor?: string }> }>(
    'guardian_history_recovery_v1'
  );
  expect(Object.values(stored?.checkpoints ?? {}).some(value => value.cursor === 'next')).toBe(false);
  expect(await transactions.count()).toBe(0);
});

it('continues after an authentication failure and retries that source on the next run', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(401, 'Unauthorized', 'auth'));
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(await transactions.count()).toBe(2);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(1)] });
  expect((await run()).sourceFailures).toBe(0);
  expect(await transactions.count()).toBe(3);
});

it('retries a transient failure only once and stops repeated cursors', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValueOnce(new GuardianHttpError(503, 'Unavailable', 'network'))
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 'loop' })
    .mockResolvedValue({ entries: [entry(2)], nextCursor: 'loop' });
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(3);
  expect(client.getDelta).toHaveBeenCalledTimes(1);
  expect((await operatorCheckpoint('https://one'))?.failure).toBe('invalid-data');
});

const operatorCheckpoint = async (operator: string) =>
  Object.values((await readGuardianHistoryState()).checkpoints).find(value => value.operator === operator);
const twoCheckpoint = () => operatorCheckpoint('https://two');

it('stops a cursor that returns after another one', async () => {
  const client = source('https://two', [
    { entries: [entry(6)], nextCursor: 'a' },
    { entries: [entry(5)], nextCursor: 'b' },
    { entries: [entry(4)], nextCursor: 'a' }
  ]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(3);
  expect(client.getDelta).toHaveBeenCalledTimes(2);
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('fails a source whose empty page still carries a cursor', async () => {
  const client = source('https://two', [
    { entries: [], nextCursor: 'c1' },
    { entries: [], nextCursor: 'c2' },
    { entries: [], nextCursor: 'c3' },
    { entries: [], nextCursor: 'c4' },
    { entries: [], nextCursor: 'c5' },
    { entries: [] }
  ]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('fails a source whose later page does not fall below the nonces it already returned', async () => {
  const client = source('https://two', [
    { entries: [entry(3)], nextCursor: 'a' },
    { entries: [entry(3)], nextCursor: 'b' }
  ]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(client.getDelta).toHaveBeenCalledTimes(1);
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('keeps the entry cap across a resumed pass', async () => {
  const id = historyCheckpointId('testnet', 'account', 'https://two');
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id,
    network: 'testnet',
    accountId: 'account',
    operator: 'https://two',
    version: GUARDIAN_HISTORY_VERSION,
    cursor: 'resume',
    seenCursors: [],
    completed: false,
    restored: 0,
    lowestNonce: 100,
    entryCount: MAX_HISTORY_ENTRIES_PER_SOURCE - 1
  });
  const client = source('https://two', [{ entries: [entry(50), entry(49)] }]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledWith('account', { limit: 50, cursor: 'resume' });
  expect(client.getDelta).not.toHaveBeenCalled();
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('keeps the nonce bound across a resumed pass', async () => {
  const id = historyCheckpointId('testnet', 'account', 'https://two');
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id,
    network: 'testnet',
    accountId: 'account',
    operator: 'https://two',
    version: GUARDIAN_HISTORY_VERSION,
    cursor: 'resume',
    seenCursors: [],
    completed: false,
    restored: 0,
    lowestNonce: 100,
    entryCount: 0
  });
  const client = source('https://two', [{ entries: [entry(150)] }]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledWith('account', { limit: 50, cursor: 'resume' });
  expect(client.getDelta).not.toHaveBeenCalled();
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('retries a page request that never answers once, then files it as a network failure', async () => {
  // Dexie runs on the real microtask queue; advancing the clock also runs its zero-delay timers.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  try {
    const client = source('https://two', []);
    jest.spyOn(client, 'getDeltaHistory').mockImplementation(() => new Promise<HistoryPage>(() => {}));
    let result: Awaited<ReturnType<typeof run>> | undefined;
    const pending = run().then(value => {
      result = value;
    });
    for (let i = 0; i < 1_000 && !result; i++) await jest.advanceTimersByTimeAsync(100);
    await pending;
    expect(result?.sourceFailures).toBe(1);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
    expect((await twoCheckpoint())?.failure).toBe('network');
  } finally {
    jest.useRealTimers();
  }
});

it('reads a retried page from the retry, not from the attempt that timed out and answered late', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  try {
    const client = source('https://two', []);
    jest
      .spyOn(client, 'getDeltaHistory')
      .mockImplementationOnce(
        () =>
          new Promise<HistoryPage>((_resolve, reject) => {
            setTimeout(() => reject(new GuardianHttpError(404, 'Not Found', '')), 15_500);
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<HistoryPage>(resolve => {
            setTimeout(() => resolve({ entries: [entry(3)] }), 1_000);
          })
      );
    let result: Awaited<ReturnType<typeof run>> | undefined;
    const pending = run().then(value => {
      result = value;
    });
    for (let i = 0; i < 1_000 && !result; i++) await jest.advanceTimersByTimeAsync(100);
    await pending;
    expect(result?.restored).toBe(3);
    expect(await transactions.count()).toBe(3);
    const checkpoint = await twoCheckpoint();
    expect(checkpoint).toMatchObject({ completed: true });
    expect(checkpoint?.failure).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});

it('clears checkpoints on import and retains recovered records in backups', async () => {
  await run();
  const before = await transactions.toArray();
  await importDb(await exportDb());
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
  expect(await transactions.toArray()).toEqual(before);
  await run();
  expect(await transactions.count()).toBe(3);
});

it.each([
  [404, 'account_not_found', 'account-not-found'],
  [404, '', 'unsupported'],
  [401, '', 'authentication'],
  [403, '', 'authentication'],
  [503, '', 'network']
])('classifies HTTP %s with body %s', (status, body, failure) => {
  if (typeof status !== 'number' || typeof body !== 'string') throw new Error('Invalid test case');
  expect(classifyHistoryFailure(new GuardianHttpError(status, '', body))).toBe(failure);
});

it('treats an absent account on another Guardian as an empty completed source', async () => {
  const client = clients.get('https://two');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2 });
  const checkpoint = Object.values((await readGuardianHistoryState()).checkpoints).find(
    value => value.operator === 'https://two'
  );
  expect(checkpoint).toMatchObject({ completed: true });
  expect(checkpoint?.failure).toBeUndefined();
  createClient.mockClear();
  await run();
  expect(createClient).not.toHaveBeenCalled();
});

it('records the history step before its first yield check', async () => {
  shouldYield.mockResolvedValue('transaction in flight');
  expect((await run()).deferred).toBe(true);
  expect(reportGuardianNoteRecoveryProgress).toHaveBeenCalledWith({
    accountId: 'account',
    step: 'history',
    operator: 'https://one',
    restored: 0,
    sourcesClean: true
  });
  expect(createClient).not.toHaveBeenCalled();
});

it('asks an operator the account never used again when it does not serve history yet', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockRejectedValueOnce(new GuardianHttpError(404, 'Not Found', ''))
    .mockResolvedValueOnce({ entries: [entry(3)] });
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2 });
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported' });
  expect(jest.mocked(reportGuardianNoteRecoveryProgress).mock.calls.every(([progress]) => progress.sourcesClean)).toBe(
    true
  );
  createClient.mockClear();
  expect((await run()).sourceFailures).toBe(0);
  expect(createClient.mock.calls.map(call => call[1])).toEqual(['https://two']);
  expect(await transactions.count()).toBe(3);
  expect(await twoCheckpoint()).toMatchObject({ completed: true });
});

it('counts the same answer from the current operator as a failed source', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  expect((await run()).sourceFailures).toBe(1);
});

it('counts the same answer from an operator a local switch left as a failed source', async () => {
  await localSwitch('https://two');
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  expect((await run()).sourceFailures).toBe(1);
  expect((await twoCheckpoint())?.failure).toBe('unsupported');
});

it('does not treat a missing delta for a listed entry as an empty source', async () => {
  const client = clients.get('https://two');
  if (!client) throw new Error('Missing test source');
  jest.spyOn(client, 'getDelta').mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  expect((await run()).sourceFailures).toBe(1);
});

it('upgrades existing decoded rows and links a payback imported before its swap', async () => {
  await run();
  const oldRows = await transactions.toArray();
  for (const row of oldRows) {
    if (row.recovery) await transactions.update(row.id, { recovery: { ...row.recovery, version: 1 } });
  }
  await clearGuardianHistoryCheckpoints();
  const client = source('https://one', [{ entries: [entry(3)] }, { entries: [entry(2)] }]);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 'swap' })
    .mockResolvedValueOnce({ entries: [entry(2)] });
  jest.spyOn(client, 'getDelta').mockImplementation(async (_account, nonce) => ({
    ...delta(nonce),
    metadata: { proposal: { proposalType: nonce === 3 ? 'consume_notes' : 'swap' } }
  }));
  source('https://two', []);
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementation(async encoded => ({
    accountId: 'account',
    inputNotes:
      encoded === '3'
        ? [
            {
              id: 'payback',
              visibility: 'public',
              recipient: 'account',
              assets: [{ faucetId: 'ieth', amount: '30' }],
              swap: { orderId: '42' }
            }
          ]
        : [],
    outputNotes:
      encoded === '2'
        ? [
            {
              id: 'order',
              visibility: 'public',
              assets: [{ faucetId: 'miden', amount: '70' }],
              swap: { orderId: '42', requestedAsset: { faucetId: 'ieth', amount: '30' } }
            }
          ]
        : []
  }));
  await run();
  const rows = await transactions.toArray();
  const swap = rows.find(row => row.recovery?.nonce === 2);
  const consume = rows.find(row => row.recovery?.nonce === 3);
  expect(swap?.extraInputs).toMatchObject({ requestedFaucetId: 'ieth', requestedAmount: 30n, autoConsume: false });
  expect(swap?.extraInputs.settledAt).toBeDefined();
  expect(consume?.extraInputs).toMatchObject({ swapOrderTxId: swap?.id, swapSettleKind: 'settle' });
  expect(rows).toHaveLength(3);
  expect(swap?.id).toBe(oldRows.find(row => row.recovery?.nonce === 2)?.id);
});

it('stops recovery and retains the failure when fee metadata is unavailable', async () => {
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockRejectedValueOnce(new GuardianHistoryFeeUnavailableError());
  expect((await run()).sourceFailures).toBe(1);
  const checkpoint = Object.values((await readGuardianHistoryState()).checkpoints).find(
    value => value.operator === 'https://one'
  );
  expect(checkpoint?.completed).toBe(false);
  expect(checkpoint?.failure).toBe('fee-metadata');
  createClient.mockClear();
  expect((await run()).failed).toBe(true);
  expect(createClient).not.toHaveBeenCalled();
  expect(await transactions.count()).toBe(0);
});

it('fills missing Guardian-switch endpoints from a richer copy on another source', async () => {
  const first = source('https://one', [{ entries: [entry(2)] }]);
  const second = source('https://two', [{ entries: [entry(2)] }]);
  jest.spyOn(first, 'getDelta').mockResolvedValue({
    ...delta(2),
    metadata: { proposal: { proposalType: 'switch_guardian' } }
  });
  jest.spyOn(second, 'getDelta').mockResolvedValue({
    ...delta(2),
    metadata: {
      proposal: { proposalType: 'switch_guardian', newGuardianEndpoint: 'https://new' }
    }
  });
  await run();
  const rows = await transactions.toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.extraInputs).toEqual({
    previousGuardianEndpoint: 'https://two',
    newGuardianEndpoint: 'https://new'
  });
  expect(rows[0]?.recovery?.operators).toEqual(['https://one', 'https://two']);
  // An endpoint a Guardian reported is data, not an operator to contact.
  createClient.mockClear();
  await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://new');
});

it('ignores a saved checkpoint for an operator outside the list without deleting it', async () => {
  const id = historyCheckpointId('testnet', 'account', 'https://attacker');
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id,
    network: 'testnet',
    accountId: 'account',
    operator: 'https://attacker',
    version: GUARDIAN_HISTORY_VERSION,
    seenCursors: [],
    completed: false,
    restored: 0
  });
  expect((await run()).sourceFailures).toBe(0);
  expect(createClient.mock.calls.map(call => call[1])).toEqual(['https://one', 'https://two']);
  expect((await readGuardianHistoryState()).checkpoints[id]?.operator).toBe('https://attacker');
});

const localSwitch = (previousGuardianEndpoint: string, restoredFromBackup?: boolean) =>
  transactions.add({
    id: 'local-switch',
    type: 'switch-guardian',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    restoredFromBackup,
    extraInputs: { previousGuardianEndpoint, newGuardianEndpoint: 'https://one' }
  });

it('visits the previous operator of a switch the wallet made itself', async () => {
  source('http://localhost:3001', []);
  await localSwitch('http://localhost:3001');
  await run();
  expect(createClient.mock.calls.map(call => call[1])).toContain('http://localhost:3001');
});

it('does not visit an operator named by a row restored from a backup file', async () => {
  source('http://localhost:3001', []);
  await localSwitch('http://localhost:3001', true);
  await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('http://localhost:3001');
});

it('does not visit a plain http operator on a remote host', async () => {
  source('http://plain.example', []);
  await localSwitch('http://plain.example');
  await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('http://plain.example');
});
