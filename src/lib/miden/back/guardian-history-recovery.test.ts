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
import { GUARDIAN_HISTORY_VERSION, type GuardianHistoryCheckpoint, historyCheckpointId } from '../guardian/history';
import {
  clearGuardianHistoryCheckpoints,
  readGuardianHistoryState,
  saveGuardianHistoryCheckpoint
} from '../guardian/history-storage';
import { exportDb, importDb, transactions } from '../repo';
import {
  classifyHistoryFailure,
  forgetUnsupportedHistorySources,
  GUARDIAN_HISTORY_PROGRESS_REFRESH_MS,
  hasFailedGuardianHistory,
  MAX_HISTORY_CURSOR_LENGTH,
  MAX_HISTORY_ENTRIES_PER_SOURCE,
  MAX_HISTORY_SEEN_CURSORS,
  recoverGuardianHistory,
  terminalGuardianHistoryGeneration
} from './guardian-history-recovery';
import { midenClientProxy } from './miden-client-proxy';
import { OperationAbortedError } from './offscreen-codec';
import {
  GuardianHistoryDataError,
  GuardianHistoryFeeLookupError,
  GuardianHistoryFeeUnavailableError
} from '../guardian/history-errors';
import { WasmClientPoisonedError } from '../sdk/wasm-client-poison';

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
// The node a terminal fee answer came from: the effective RPC URL and network name.
let mockFeeScope = 'rpc-a|testnet';
jest.mock('lib/miden-chain/native-asset', () => ({ cacheScope: () => mockFeeScope }));
jest.mock('../guardian/history-storage', () => {
  const actual = jest.requireActual('../guardian/history-storage');
  return { ...actual, saveGuardianHistoryCheckpoint: jest.fn(actual.saveGuardianHistoryCheckpoint) };
});
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
const storedGeneration = async () => (await readGuardianHistoryState()).generation;
const run = async () =>
  recoverGuardianHistory(account, { createClient, shouldYield, generation: await storedGeneration() });

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
  forgetUnsupportedHistorySources();
  mockFeeScope = 'rpc-a|testnet';
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
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 3, deferredSources: 0 });
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
const saveCheckpoint = async (operator: string, fields: Partial<GuardianHistoryCheckpoint>) => {
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id: historyCheckpointId('testnet', 'account', operator),
    network: 'testnet',
    accountId: 'account',
    operator,
    version: GUARDIAN_HISTORY_VERSION,
    seenCursors: [],
    completed: false,
    restored: 0,
    ...fields
  });
};

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
  const id = historyCheckpointId('testnet', 'account', 'https://one');
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id,
    network: 'testnet',
    accountId: 'account',
    operator: 'https://one',
    version: GUARDIAN_HISTORY_VERSION,
    cursor: 'resume',
    seenCursors: [],
    completed: false,
    restored: 0,
    lowestNonce: 100,
    entryCount: MAX_HISTORY_ENTRIES_PER_SOURCE - 1
  });
  const client = source('https://one', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(50), entry(49)] });
  const oneCheckpoint = () => operatorCheckpoint('https://one');
  const first = await run();
  expect(first.sourceFailures).toBe(1);
  expect(first.failed).toBeUndefined();
  expect(client.getDeltaHistory).toHaveBeenCalledWith('account', { limit: 50, cursor: 'resume' });
  expect(client.getDelta).not.toHaveBeenCalled();
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  // A restart in the same session counts it as failed without asking it again.
  const restart = await run();
  expect(restart.sourceFailures).toBe(1);
  expect(restart.failed).toBeUndefined();
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  // The same overflow in every session is terminal once it has repeated up to the cap.
  forgetUnsupportedHistorySources();
  const second = await run();
  expect(second.sourceFailures).toBe(1);
  expect(second.failed).toBeUndefined();
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });

  forgetUnsupportedHistorySources();
  expect((await run()).failed).toBe(true);
  expect(client.getDelta).not.toHaveBeenCalled();
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3, terminal: true });
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

it('fails a source whose next cursor is longer than the bound, before reading any delta', async () => {
  const client = source('https://two', [
    { entries: [entry(3)], nextCursor: 'x'.repeat(MAX_HISTORY_CURSOR_LENGTH + 1) }
  ]);
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(client.getDelta).not.toHaveBeenCalled();
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('follows a next cursor exactly at the bound', async () => {
  const cursor = 'x'.repeat(MAX_HISTORY_CURSOR_LENGTH);
  const client = source('https://two', [{ entries: [entry(3)], nextCursor: cursor }, { entries: [] }]);
  expect((await run()).sourceFailures).toBe(0);
  expect(client.getDeltaHistory).toHaveBeenNthCalledWith(2, 'account', { limit: 50, cursor });
  expect(await twoCheckpoint()).toMatchObject({ completed: true });
});

it('fails a resumed source whose saved cursor is longer than the bound, without contacting it', async () => {
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id: historyCheckpointId('testnet', 'account', 'https://two'),
    network: 'testnet',
    accountId: 'account',
    operator: 'https://two',
    version: GUARDIAN_HISTORY_VERSION,
    cursor: 'x'.repeat(MAX_HISTORY_CURSOR_LENGTH + 1),
    seenCursors: [],
    completed: false,
    restored: 0
  });
  expect((await run()).sourceFailures).toBe(1);
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
  expect((await twoCheckpoint())?.failure).toBe('invalid-data');
});

it('keeps only the most recent cursors in the checkpoint', async () => {
  const pages: HistoryPage[] = Array.from({ length: MAX_HISTORY_SEEN_CURSORS + 5 }, (_, index) => ({
    entries: [entry(1_000 - index)],
    nextCursor: `cursor-${index}`
  }));
  source('https://two', [...pages, { entries: [] }]);
  expect((await run()).sourceFailures).toBe(0);
  const checkpoint = await twoCheckpoint();
  expect(checkpoint).toMatchObject({ completed: true });
  expect(checkpoint?.seenCursors).toHaveLength(MAX_HISTORY_SEEN_CURSORS);
  expect(checkpoint?.seenCursors.at(-1)).toBe(`cursor-${MAX_HISTORY_SEEN_CURSORS + 4}`);
});

it('retries a page request that never answers once, then files it as a network failure', async () => {
  await localSwitch('https://two');
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

it('defers an operator the account never used whose page request never answers, after one retry', async () => {
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
    expect(result?.deferredSources).toBe(1);
    expect(result?.sourceFailures).toBe(0);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'network', completed: false, deferredFailurePasses: 1 });
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
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2, deferredSources: 0 });
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
    sourcesClean: true,
    historyGeneration: await storedGeneration()
  });
  expect(createClient).not.toHaveBeenCalled();
});

const historyWrites = (operator: string) => {
  const report = jest.mocked(reportGuardianNoteRecoveryProgress).mock;
  return report.calls
    .map(([progress], index) => ({ progress, order: report.invocationCallOrder[index]! }))
    .filter(({ progress }) => progress.operator === operator);
};

function held() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

// Longer than six refresh intervals.
const WAIT_MS = 200_000;

// Dexie runs on the real microtask queue; advancing the clock also runs its zero-delay timers.
const fakeTimers = () => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

async function until(done: () => boolean) {
  for (let i = 0; i < 1_000 && !done(); i++) await jest.advanceTimersByTimeAsync(0);
  expect(done()).toBe(true);
}

function startRun(context: Partial<Parameters<typeof recoverGuardianHistory>[1]> = {}) {
  const state: { resolved: boolean; result?: Awaited<ReturnType<typeof recoverGuardianHistory>> } = {
    resolved: false
  };
  const events: string[] = [];
  const done = storedGeneration()
    .then(generation => recoverGuardianHistory(account, { createClient, shouldYield, generation, ...context }))
    .then(result => {
      events.push('run');
      state.resolved = true;
      state.result = result;
    });
  return { state, events, done };
}

/** A createClient that waits on `built` for operator two. */
function slowOperatorTwo(built: { promise: Promise<void> }) {
  return jest.fn(async (walletAccount: WalletAccount, endpoint: string) => {
    if (endpoint === 'https://two') await built.promise;
    return createClient(walletAccount, endpoint);
  });
}

const liveWritesAfter = (operator: string, order: number) =>
  historyWrites(operator).filter(({ progress, order: written }) => progress.step === 'history' && written > order);

it('rewrites the live history record on the refresh interval while a delta request waits', async () => {
  fakeTimers();
  const answer = held();
  try {
    const client = source('https://one', []);
    // The page answers a second in, so the delta request's wait does not start on an interval boundary.
    jest
      .spyOn(client, 'getDeltaHistory')
      .mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ entries: [entry(4)] }), 1_000)));
    jest.spyOn(client, 'getDelta').mockImplementation(async (_account, nonce) => {
      await answer.promise;
      return delta(nonce);
    });
    const pass = startRun();
    await until(() => jest.mocked(client.getDeltaHistory).mock.calls.length > 0);
    await jest.advanceTimersByTimeAsync(1_000);
    await until(() => jest.mocked(client.getDelta).mock.calls.length > 0);
    const asked = jest.mocked(client.getDelta).mock.invocationCallOrder[0]!;
    await jest.advanceTimersByTimeAsync(WAIT_MS);
    // A delta request has a 15 s deadline and one retry, so its wait spans one interval, not six.
    const during = liveWritesAfter('https://one', asked);
    expect(during.length).toBeGreaterThanOrEqual(1);
    for (const { progress } of during) {
      expect(progress).toMatchObject({ sourcesClean: true, historyGeneration: await storedGeneration() });
    }
    answer.release();
    await until(() => pass.state.resolved);
    expect(pass.state.result?.sourceFailures).toBe(1);
  } finally {
    answer.release();
    jest.useRealTimers();
  }
});

it('writes the live history record per page, not per entry, while the refresh interval has not passed', async () => {
  source('https://one', [{ entries: [entry(4), entry(3), entry(2)] }]);
  await run();
  expect(historyWrites('https://one')).toHaveLength(2);
});

it('rewrites the live history record on the refresh interval while a decode waits', async () => {
  fakeTimers();
  const decoded = held();
  try {
    source('https://one', [{ entries: [entry(4)] }]);
    const decode = jest.mocked(midenClientProxy.decodeGuardianHistory);
    const decodeSummary = decode.getMockImplementation()!;
    decode.mockImplementation(async encoded => {
      await decoded.promise;
      return decodeSummary(encoded);
    });
    const pass = startRun();
    await until(() => decode.mock.calls.length > 0);
    const waiting = decode.mock.invocationCallOrder[0]!;
    await jest.advanceTimersByTimeAsync(WAIT_MS);
    expect(liveWritesAfter('https://one', waiting).length).toBeGreaterThanOrEqual(6);
    decoded.release();
    await until(() => pass.state.resolved);
  } finally {
    decoded.release();
    jest.useRealTimers();
  }
});

it("rewrites the live history record on the refresh interval while the next operator's createClient waits", async () => {
  fakeTimers();
  const built = held();
  try {
    const slowCreateClient = slowOperatorTwo(built);
    const pass = startRun({ createClient: slowCreateClient });
    await until(() => slowCreateClient.mock.calls.length > 1);
    const waiting = slowCreateClient.mock.invocationCallOrder[1]!;
    await jest.advanceTimersByTimeAsync(WAIT_MS);
    expect(liveWritesAfter('https://two', waiting).length).toBeGreaterThanOrEqual(6);
    built.release();
    await until(() => pass.state.resolved);
  } finally {
    built.release();
    jest.useRealTimers();
  }
});

it('writes nothing on the refresh interval once the pass has returned', async () => {
  fakeTimers();
  try {
    const pass = startRun();
    await until(() => pass.state.resolved);
    const calls = jest.mocked(reportGuardianNoteRecoveryProgress).mock.calls.length;
    await jest.advanceTimersByTimeAsync(WAIT_MS);
    expect(reportGuardianNoteRecoveryProgress).toHaveBeenCalledTimes(calls);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it('returns only after a refresh write in flight has settled', async () => {
  fakeTimers();
  const built = held();
  const write = held();
  let heldWrite = false;
  try {
    const slowCreateClient = slowOperatorTwo(built);
    const pass = startRun({ createClient: slowCreateClient });
    jest.mocked(reportGuardianNoteRecoveryProgress).mockImplementation(async progress => {
      if (heldWrite || progress.operator !== 'https://two' || slowCreateClient.mock.calls.length < 2) return;
      heldWrite = true;
      await write.promise;
      pass.events.push('refresh write');
    });
    await until(() => slowCreateClient.mock.calls.length > 1);
    await jest.advanceTimersByTimeAsync(GUARDIAN_HISTORY_PROGRESS_REFRESH_MS);
    expect(heldWrite).toBe(true);

    built.release();
    // The interval is the pass's only timer once its requests have settled, so none left means it has been cleared.
    await until(() => jest.getTimerCount() === 0);
    for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
    expect(pass.state.resolved).toBe(false);

    write.release();
    await until(() => pass.state.resolved);
    expect(pass.events).toEqual(['refresh write', 'run']);
  } finally {
    built.release();
    write.release();
    jest.mocked(reportGuardianNoteRecoveryProgress).mockReset();
    jest.useRealTimers();
  }
});

it.each([
  [
    'the wallet locks',
    async () => {
      shouldYield.mockResolvedValue('wallet locked');
    }
  ],
  [
    'the generation marker is removed',
    async () => {
      await putToStorage('guardian_history_generation_v1', null);
    }
  ]
])('writes nothing on the refresh interval once %s', async (_case, interrupt) => {
  fakeTimers();
  const built = held();
  try {
    const slowCreateClient = slowOperatorTwo(built);
    const pass = startRun({ createClient: slowCreateClient });
    await until(() => slowCreateClient.mock.calls.length > 1);
    await interrupt();
    const interrupted = jest.mocked(reportGuardianNoteRecoveryProgress).mock.invocationCallOrder.at(-1)!;
    await jest.advanceTimersByTimeAsync(WAIT_MS);
    expect(liveWritesAfter('https://two', interrupted)).toEqual([]);
    built.release();
    await until(() => pass.state.resolved);
    expect(pass.state.result?.deferred).toBe(true);
  } finally {
    built.release();
    jest.useRealTimers();
  }
});

it('defers a run whose generation was read before the key was removed', async () => {
  const generation = await storedGeneration();
  await putToStorage('guardian_history_generation_v1', null);
  expect((await recoverGuardianHistory(account, { createClient, shouldYield, generation })).deferred).toBe(true);
  expect(reportGuardianNoteRecoveryProgress).not.toHaveBeenCalled();
  expect(createClient).not.toHaveBeenCalled();
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
  expect(await transactions.count()).toBe(0);
});

it('defers an operator the account never used while it serves no history, once per session and up to a cap', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2, deferredSources: 1 });
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', unsupportedPasses: 1 });
  expect(jest.mocked(reportGuardianNoteRecoveryProgress).mock.calls.every(([progress]) => progress.sourcesClean)).toBe(
    true
  );

  // A deferral restart in the same session skips it without spending a pass.
  createClient.mockClear();
  expect((await run()).deferredSources).toBe(1);
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);

  forgetUnsupportedHistorySources();
  expect((await run()).deferredSources).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', unsupportedPasses: 2 });

  forgetUnsupportedHistorySources();
  expect((await run()).deferredSources).toBe(0);
  expect(await twoCheckpoint()).toMatchObject({ completed: true, failure: 'unsupported', unsupportedPasses: 3 });

  forgetUnsupportedHistorySources();
  createClient.mockClear();
  await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(3);
});

it('does not record an unsupported answer that settles after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockImplementationOnce(async () => {
    forgetUnsupportedHistorySources();
    throw new GuardianHttpError(404, 'Not Found', '');
  });
  expect((await run()).deferredSources).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', unsupportedPasses: 1 });

  createClient.mockClear();
  expect((await run()).deferredSources).toBe(0);
  expect(createClient.mock.calls.map(call => call[1])).toContain('https://two');
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ completed: true });
});

it('records an unsupported answer to a request issued after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  // A lock and unlock land while operator one is read, before operator two is asked.
  const lockingCreateClient = jest.fn(async (walletAccount: WalletAccount, endpoint: string) => {
    if (endpoint === 'https://one') forgetUnsupportedHistorySources();
    return createClient(walletAccount, endpoint);
  });
  const generation = await storedGeneration();
  expect(
    (await recoverGuardianHistory(account, { createClient: lockingCreateClient, shouldYield, generation }))
      .deferredSources
  ).toBe(1);

  expect((await run()).deferredSources).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', unsupportedPasses: 1 });
});

it('records an unsupported answer to a retry issued after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  let attempts = 0;
  jest.spyOn(client, 'getDeltaHistory').mockImplementation(async () => {
    // A lock and unlock land while the first attempt is in flight, so its retry is issued in the new session.
    if (attempts++ === 0) {
      forgetUnsupportedHistorySources();
      throw new GuardianHttpError(503, 'Unavailable', 'network');
    }
    throw new GuardianHttpError(404, 'Not Found', '');
  });
  expect((await run()).deferredSources).toBe(1);

  expect((await run()).deferredSources).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', unsupportedPasses: 1 });
});

it('does not record invalid data that settles after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockResolvedValue({ entries: [], nextCursor: 'x' })
    .mockImplementationOnce(async () => {
      forgetUnsupportedHistorySources();
      return { entries: [], nextCursor: 'x' };
    });
  expect((await run()).sourceFailures).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });
});

it('records invalid data from a retry issued after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  let attempts = 0;
  jest.spyOn(client, 'getDeltaHistory').mockImplementation(async () => {
    if (attempts++ === 0) {
      forgetUnsupportedHistorySources();
      throw new GuardianHttpError(503, 'Unavailable', 'network');
    }
    return { entries: [], nextCursor: 'x' };
  });
  expect((await run()).sourceFailures).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
});

/** Makes the summary of one entry fail its decode with `error`, while the others decode as before. */
const failDecodeOf = (
  encoded: string,
  error: Error = new GuardianHistoryDataError('Guardian summary does not deserialize')
) => {
  const decode = jest.mocked(midenClientProxy.decodeGuardianHistory).getMockImplementation();
  if (!decode) throw new Error('Missing decode implementation');
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementation(async value => {
    if (value === encoded) throw error;
    return decode(value);
  });
};

/** As failDecodeOf, but every decode of that entry rejects with a fresh `make()`, after running `first` on the first. */
const abortDecodeOf = (encoded: string, make: () => Error, first: () => void) => {
  const decode = jest.mocked(midenClientProxy.decodeGuardianHistory).getMockImplementation();
  if (!decode) throw new Error('Missing decode implementation');
  let calls = 0;
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementation(async value => {
    if (value !== encoded) return decode(value);
    if (calls++ === 0) first();
    throw make();
  });
};

const aborts: Array<[string, () => Error]> = [
  ['an eviction', () => new WasmClientPoisonedError('realm-error')],
  ['an offscreen abort', () => new OperationAbortedError('op-1', 'deadline')]
];
const decodesOf = (value: string) =>
  jest.mocked(midenClientProxy.decodeGuardianHistory).mock.calls.filter(([encoded]) => encoded === value).length;

it('counts a summary that fails its decode as invalid data once per session, up to the cap', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  failDecodeOf('3');
  const first = await run();
  expect(first.sourceFailures).toBe(1);
  expect(first.failed).toBeUndefined();
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  forgetUnsupportedHistorySources();
  const second = await run();
  expect(second.sourceFailures).toBe(1);
  expect(second.failed).toBeUndefined();
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });

  forgetUnsupportedHistorySources();
  expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, failed: true, deferredSources: 0 });
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3, terminal: true });
});

it.each(aborts)(
  'charges %s of a summary decode to its source as a network failure, asked once per session',
  async (_kind, make) => {
    await localSwitch('https://two');
    const client = source('https://two', []);
    jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
    failDecodeOf('3', make());
    expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, deferredSources: 0 });
    expect(await twoCheckpoint()).toMatchObject({ failure: 'network', completed: false });
    expect((await twoCheckpoint())?.invalidDataPasses).toBeUndefined();

    expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, deferredSources: 0 });
    expect(decodesOf('3')).toBe(1);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(client.getDelta).toHaveBeenCalledTimes(1);

    forgetUnsupportedHistorySources();
    const third = await run();
    expect(decodesOf('3')).toBe(2);
    expect(third.sourceFailures).toBe(1);
    expect(third.failed).toBeUndefined();
    expect((await twoCheckpoint())?.invalidDataPasses).toBeUndefined();
  }
);

it.each(aborts)(
  'defers %s of a summary decode from an operator the account never used without counting it, asked once per session',
  async (_kind, make) => {
    const client = source('https://two', []);
    jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
    failDecodeOf('3', make());
    for (let restart = 0; restart < 2; restart++) {
      expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2, deferredSources: 1 });
      expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();
    }
    expect(decodesOf('3')).toBe(1);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(client.getDelta).toHaveBeenCalledTimes(1);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'network', completed: false });
    expect((await twoCheckpoint())?.invalidDataPasses).toBeUndefined();

    forgetUnsupportedHistorySources();
    await run();
    expect(decodesOf('3')).toBe(2);
    expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();
  }
);

it.each(aborts)('defers %s of a summary decode that lands after the pass was interrupted', async (_kind, make) => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  abortDecodeOf('3', make, () => shouldYield.mockResolvedValue('wallet locked'));
  const first = await run();
  expect(first.deferred).toBe(true);
  expect(first.sourceFailures).toBe(0);
  expect((await twoCheckpoint())?.failure).toBeUndefined();

  shouldYield.mockResolvedValue(null);
  await run();
  expect(decodesOf('3')).toBe(2);
});

const addLocalResult = () =>
  transactions.add({
    id: 'local-result',
    type: 'send',
    displayIcon: 'SEND',
    accountId: 'account',
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    resultBytes: new Uint8Array([1])
  });
const commitmentCalls = () => jest.mocked(midenClientProxy.getGuardianResultCommitment).mock.calls.length;
// Every pass of every source reads the same page with records, so each pass reaches the commitment decode.
const serveEveryPass = (endpoint: string, page: HistoryPage) => {
  const client = clients.get(endpoint);
  if (!client) throw new Error(`Missing test source ${endpoint}`);
  jest.spyOn(client, 'getDeltaHistory').mockReset().mockResolvedValue(page);
};

it.each(aborts)(
  'charges %s of a local result-commitment decode to its source, asked once per session',
  async (_kind, make) => {
    await localSwitch('https://two');
    await addLocalResult();
    serveEveryPass('https://one', { entries: [entry(2)] });
    serveEveryPass('https://two', { entries: [entry(2), entry(3)] });
    jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
      throw make();
    });
    const first = await run();
    expect(first.deferred).toBe(false);
    expect(first.sourceFailures).toBe(2);
    expect(commitmentCalls()).toBe(2);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'network', completed: false });

    await run();
    expect(commitmentCalls()).toBe(2);

    forgetUnsupportedHistorySources();
    await run();
    expect(commitmentCalls()).toBe(4);
  }
);

it.each(aborts)(
  'defers %s of a local result-commitment decode for an operator the account never used, asked once per session',
  async (_kind, make) => {
    await addLocalResult();
    serveEveryPass('https://one', { entries: [entry(2)] });
    serveEveryPass('https://two', { entries: [entry(2), entry(3)] });
    jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
      throw make();
    });
    const first = await run();
    expect(first).toMatchObject({ deferred: false, sourceFailures: 1, deferredSources: 1 });
    expect(commitmentCalls()).toBe(2);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'network', completed: false });
    expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();

    await run();
    expect(commitmentCalls()).toBe(2);
    expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();

    forgetUnsupportedHistorySources();
    await run();
    expect(commitmentCalls()).toBe(4);
    expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();
  }
);

it.each(aborts)(
  'defers %s of a local result-commitment decode that lands after the pass was interrupted',
  async (_kind, make) => {
    await addLocalResult();
    let calls = 0;
    jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
      if (calls++ === 0) shouldYield.mockResolvedValue('wallet locked');
      throw make();
    });
    const first = await run();
    expect(first.deferred).toBe(true);
    expect(first.sourceFailures).toBe(0);

    shouldYield.mockResolvedValue(null);
    await run();
    expect(commitmentCalls()).toBeGreaterThan(1);
  }
);

it('charges a commitment abort only to a source whose page has records', async () => {
  await localSwitch('https://two');
  await addLocalResult();
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
    throw new WasmClientPoisonedError('realm-error');
  });

  const result = await run();
  expect(result.sourceFailures).toBe(1);
  expect(commitmentCalls()).toBe(1);
  const one = await operatorCheckpoint('https://one');
  expect(one).toMatchObject({ completed: true });
  expect(one?.failure).toBeUndefined();
});

it('defers a commitment abort of an operator the account never used only when its page has records', async () => {
  await addLocalResult();
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
    throw new WasmClientPoisonedError('realm-error');
  });

  const result = await run();
  expect(result.sourceFailures).toBe(0);
  expect(result.deferredSources).toBe(1);
  expect(commitmentCalls()).toBe(1);
  const one = await operatorCheckpoint('https://one');
  expect(one).toMatchObject({ completed: true });
  expect(one?.failure).toBeUndefined();
  const two = await twoCheckpoint();
  expect(two).toMatchObject({ failure: 'network', completed: false });
  expect(two?.deferredFailurePasses).toBeUndefined();
});

it('leaves an operator the account never used deferred, not completed, after three sessions of local decode aborts', async () => {
  await addLocalResult();
  const one = clients.get('https://one');
  if (!one) throw new Error('Missing test source');
  jest
    .spyOn(one, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  serveEveryPass('https://two', { entries: [entry(3)] });
  jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
    throw new OperationAbortedError('op-1', 'deadline');
  });
  for (let session = 0; session < 3; session++) {
    if (session > 0) forgetUnsupportedHistorySources();
    expect(await run()).toMatchObject({ sourceFailures: 0, deferredSources: 1 });
    expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'network' });
  }
  expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();
  const two = clients.get('https://two');
  if (!two) throw new Error('Missing test source');
  expect(two.getDeltaHistory).toHaveBeenCalledTimes(3);

  forgetUnsupportedHistorySources();
  await run();
  expect(two.getDeltaHistory).toHaveBeenCalledTimes(4);
});

it('asks a source whose decode aborted again in the session a lock started while it ran', async () => {
  await localSwitch('https://two');
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  abortDecodeOf('3', () => new WasmClientPoisonedError('realm-error'), forgetUnsupportedHistorySources);
  const first = await run();
  expect(first.deferred).toBe(false);
  expect(first.sourceFailures).toBe(1);

  const second = await run();
  expect(decodesOf('3')).toBe(2);
  expect(second.sourceFailures).toBe(1);
});

it('asks an operator the account never used whose decode aborted again in the session a lock started while it ran', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  abortDecodeOf('3', () => new WasmClientPoisonedError('realm-error'), forgetUnsupportedHistorySources);
  const first = await run();
  expect(first).toMatchObject({ deferred: false, sourceFailures: 0, deferredSources: 1 });
  expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();

  await run();
  expect(decodesOf('3')).toBe(2);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBeUndefined();
});

it.each(aborts)(
  'asks a source whose commitment decode aborted again in the session a lock started while it ran (%s)',
  async (_kind, make) => {
    await addLocalResult();
    serveEveryPass('https://one', { entries: [entry(2)] });
    serveEveryPass('https://two', { entries: [entry(2), entry(3)] });
    let calls = 0;
    jest.mocked(midenClientProxy.getGuardianResultCommitment).mockImplementation(async () => {
      if (calls++ === 0) forgetUnsupportedHistorySources();
      throw make();
    });
    const first = await run();
    expect(first.deferred).toBe(false);
    expect(first.sourceFailures).toBeGreaterThanOrEqual(1);

    const before = commitmentCalls();
    await run();
    expect(commitmentCalls()).toBeGreaterThan(before);
  }
);

it.each<[string, DeltaObject]>([
  ['no summary', { ...delta(3), deltaPayload: {} } as unknown as DeltaObject],
  [
    'a null summary',
    { ...delta(3), deltaPayload: { txSummary: { data: null }, signatures: [] } } as unknown as DeltaObject
  ],
  [
    'an empty summary',
    { ...delta(3), deltaPayload: { txSummary: { data: '' }, signatures: [] } } as unknown as DeltaObject
  ],
  ['no payload', { ...delta(3), deltaPayload: undefined } as unknown as DeltaObject]
])(
  'counts a delta with %s as invalid data once per session, up to the cap, without decoding it',
  async (_kind, served) => {
    const client = source('https://two', []);
    jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
    jest.spyOn(client, 'getDelta').mockResolvedValue(served);
    const first = await run();
    expect(first.sourceFailures).toBe(1);
    expect(first.failed).toBeUndefined();
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

    forgetUnsupportedHistorySources();
    const second = await run();
    expect(second.sourceFailures).toBe(1);
    expect(second.failed).toBeUndefined();
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });

    forgetUnsupportedHistorySources();
    expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, failed: true, deferredSources: 0 });
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3, terminal: true });
    const decoded = jest.mocked(midenClientProxy.decodeGuardianHistory).mock.calls.map(([value]) => value);
    expect(decoded).toEqual(['2', '1']);
  }
);

/** Runs three sessions and expects https://two counted as invalid data once in each, until the cap ends the pass. */
const expectInvalidDataUpToTheCap = async () => {
  for (const invalidDataPasses of [1, 2]) {
    const result = await run();
    expect(result.sourceFailures).toBe(1);
    expect(result.failed).toBeUndefined();
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses });
    forgetUnsupportedHistorySources();
  }
  expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, failed: true, deferredSources: 0 });
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3, terminal: true });
};

// eslint-disable-next-line jest/expect-expect -- assertions live in expectInvalidDataUpToTheCap
it.each<[string, DeltaObject]>([
  ['no status', { ...delta(3), status: undefined } as unknown as DeltaObject],
  [
    'a numeric canonical timestamp',
    { ...delta(3), status: { status: 'canonical', timestamp: 2024 } } as unknown as DeltaObject
  ]
])('counts a delta with %s as invalid data once per session, up to the cap', async (_kind, served) => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  jest.spyOn(client, 'getDelta').mockResolvedValue(served);
  await expectInvalidDataUpToTheCap();
});

it.each([undefined, 1.5])(
  'counts a page whose entry has the nonce %p as invalid data once per session, before any delta request',
  async nonce => {
    const client = source('https://two', []);
    const served = { ...entry(3), nonce } as unknown as HistoryEntry;
    jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [served] });
    await expectInvalidDataUpToTheCap();
    expect(client.getDelta).not.toHaveBeenCalled();
  }
);

it('counts a page whose next cursor is not a string as invalid data, without saving the cursor', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 7 } as unknown as HistoryPage)
    .mockResolvedValue({ entries: [] });
  const result = await run();
  expect(result.sourceFailures).toBe(1);
  expect(result.failed).toBeUndefined();
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
  expect((await twoCheckpoint())?.cursor).toBeUndefined();
  expect(client.getDelta).not.toHaveBeenCalled();
  expect(await operatorCheckpoint('https://one')).toMatchObject({ completed: true });
});

it.each<[string, (client: GuardianHttpClient) => void]>([
  [
    'the delta names another account',
    client => {
      jest.spyOn(client, 'getDelta').mockResolvedValue({ ...delta(3), accountId: 'other' });
    }
  ],
  ['its summary fails its decode', () => failDecodeOf('3')]
])(
  'records invalid data from an entry requested after a lock in the session the lock started, when %s',
  async (_kind, fail) => {
    const client = source('https://two', []);
    jest
      .spyOn(client, 'getDeltaHistory')
      .mockResolvedValue({ entries: [entry(3)] })
      .mockImplementationOnce(async () => {
        forgetUnsupportedHistorySources();
        return { entries: [entry(3)] };
      });
    fail(client);
    expect((await run()).sourceFailures).toBe(1);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

    expect((await run()).sourceFailures).toBe(1);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(client.getDelta).toHaveBeenCalledTimes(1);
    expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
  }
);

it('does not record invalid data from an entry that settles after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  jest
    .spyOn(client, 'getDelta')
    .mockResolvedValue({ ...delta(3), accountId: 'other' })
    .mockImplementationOnce(async () => {
      forgetUnsupportedHistorySources();
      return { ...delta(3), accountId: 'other' };
    });
  expect((await run()).sourceFailures).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });
});

it('records invalid data from an entry retry issued after a lock in the session the lock started', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  let attempts = 0;
  jest.spyOn(client, 'getDelta').mockImplementation(async () => {
    if (attempts++ === 0) {
      forgetUnsupportedHistorySources();
      throw new GuardianHttpError(503, 'Unavailable', 'network');
    }
    return { ...delta(3), accountId: 'other' };
  });
  expect((await run()).sourceFailures).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(client.getDelta).toHaveBeenCalledTimes(2);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
});

it('counts a saved cursor over the bound once per session', async () => {
  await saveCheckpoint('https://two', { cursor: 'x'.repeat(MAX_HISTORY_CURSOR_LENGTH + 1) });
  const client = clients.get('https://two');
  if (!client) throw new Error('Missing test source');
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).not.toHaveBeenCalled();
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });

  expect((await run()).sourceFailures).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
});

it('asks a deferred operator again in the next session and restores what it serves then', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockRejectedValueOnce(new GuardianHttpError(404, 'Not Found', ''))
    .mockResolvedValueOnce({ entries: [entry(3)] });
  expect((await run()).deferredSources).toBe(1);
  forgetUnsupportedHistorySources();
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 3, deferredSources: 0 });
  expect(await transactions.count()).toBe(3);
  expect(await twoCheckpoint()).toMatchObject({ completed: true });
  expect((await twoCheckpoint())?.failure).toBeUndefined();
});

it('counts the same answer from the current operator as a failed source', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  const result = await run();
  expect(result.sourceFailures).toBe(1);
  expect(result.deferredSources).toBe(0);
});

it('fails the current operator while it serves no history, once per session, and stops at the cap', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  const oneCheckpoint = () => operatorCheckpoint('https://one');
  const first = await run();
  expect(first.sourceFailures).toBe(1);
  expect(first.failed).toBeUndefined();
  expect(await oneCheckpoint()).toMatchObject({ failure: 'unsupported', unsupportedPasses: 1, completed: false });

  // A restart in the same session counts it as failed without asking it again.
  const restart = await run();
  expect(restart.sourceFailures).toBe(1);
  expect(restart.failed).toBeUndefined();
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(await oneCheckpoint()).toMatchObject({ unsupportedPasses: 1 });

  forgetUnsupportedHistorySources();
  expect((await run()).failed).toBeUndefined();
  expect(await oneCheckpoint()).toMatchObject({ unsupportedPasses: 2 });

  forgetUnsupportedHistorySources();
  expect((await run()).failed).toBe(true);
  expect(await oneCheckpoint()).toMatchObject({
    failure: 'unsupported',
    unsupportedPasses: 3,
    completed: false,
    terminal: true
  });

  // The marker stops the next session before it reads any operator or writes progress.
  forgetUnsupportedHistorySources();
  const writes = jest.mocked(reportGuardianNoteRecoveryProgress).mock.calls.length;
  expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 0, failed: true, deferredSources: 0 });
  expect(reportGuardianNoteRecoveryProgress).toHaveBeenCalledTimes(writes);
});

/** A createClient under which building operator two makes the rest of the run give way. */
const yieldingAtTwo = () =>
  jest.fn(async (walletAccount: WalletAccount, endpoint: string) => {
    if (endpoint === 'https://two') shouldYield.mockResolvedValue('transaction');
    return createClient(walletAccount, endpoint);
  });

const runWith = async (create: Parameters<typeof recoverGuardianHistory>[1]['createClient']) => {
  shouldYield.mockResolvedValue(null);
  return recoverGuardianHistory(account, { createClient: create, shouldYield, generation: await storedGeneration() });
};

it('asks a source whose data failed a check once per session across deferral restarts', async () => {
  const one = source('https://one', []);
  jest.spyOn(one, 'getDeltaHistory').mockResolvedValue({ entries: [], nextCursor: 'x' });
  const deferring = yieldingAtTwo();
  const oneCheckpoint = () => operatorCheckpoint('https://one');
  for (let restart = 0; restart < 3; restart++) {
    const result = await runWith(deferring);
    expect(result.deferred).toBe(true);
    expect(result.failed).toBeUndefined();
    expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 1 });
  }
  expect(one.getDeltaHistory).toHaveBeenCalledTimes(1);

  forgetUnsupportedHistorySources();
  expect((await runWith(deferring)).deferred).toBe(true);
  expect(one.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 2 });
});

// The current operator one session short of the cap, how it fails again, and its checkpoint once at the cap.
const oneShortOfTheCap: Array<
  [string, Partial<GuardianHistoryCheckpoint>, (client: GuardianHttpClient) => void, Partial<GuardianHistoryCheckpoint>]
> = [
  [
    'invalid data',
    { failure: 'invalid-data', invalidDataPasses: 2 },
    client => {
      jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [], nextCursor: 'x' });
    },
    { failure: 'invalid-data', invalidDataPasses: 3 }
  ],
  [
    'an unsupported answer',
    { failure: 'unsupported', unsupportedPasses: 2 },
    client => {
      jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
    },
    { failure: 'unsupported', unsupportedPasses: 3, completed: false }
  ]
];

it.each(oneShortOfTheCap)(
  'fails the pass on %s at the cap only after reading the other operators',
  async (_kind, seeded, failAgain, capped) => {
    await saveCheckpoint('https://one', seeded);
    failAgain(source('https://one', []));
    const two = clients.get('https://two');
    if (!two) throw new Error('Missing test source');
    expect(await run()).toEqual({ deferred: false, sourceFailures: 1, restored: 2, failed: true, deferredSources: 0 });
    expect(two.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(await twoCheckpoint()).toMatchObject({ completed: true });
    expect(await operatorCheckpoint('https://one')).toMatchObject({ ...capped, terminal: true });
  }
);

it.each<[string, () => void]>([
  ['in the same session', () => {}],
  ['after the next lock', forgetUnsupportedHistorySources]
])('marks a source a deferred pass capped once a later pass has read the others, %s', async (_label, between) => {
  await saveCheckpoint('https://one', { failure: 'invalid-data', invalidDataPasses: 2 });
  const one = source('https://one', []);
  jest.spyOn(one, 'getDeltaHistory').mockResolvedValue({ entries: [], nextCursor: 'x' });
  const oneCheckpoint = () => operatorCheckpoint('https://one');
  expect((await runWith(yieldingAtTwo())).deferred).toBe(true);
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3 });
  expect((await oneCheckpoint())?.terminal).toBeUndefined();

  between();
  expect((await runWith(createClient)).failed).toBe(true);
  expect(clients.get('https://two')?.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(one.getDeltaHistory).toHaveBeenCalledTimes(1);
  expect(await oneCheckpoint()).toMatchObject({ failure: 'invalid-data', invalidDataPasses: 3, terminal: true });
});

it.each(oneShortOfTheCap)(
  'leaves %s at the cap unmarked while another source fails in that pass',
  async (_kind, seeded, failAgain, capped) => {
    await localSwitch('https://two');
    await saveCheckpoint('https://one', seeded);
    const one = source('https://one', []);
    failAgain(one);
    const two = source('https://two', []);
    jest.spyOn(two, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(503, 'Unavailable', 'network'));
    const first = await run();
    expect(first.failed).toBeUndefined();
    expect(first.sourceFailures).toBe(2);
    const unmarked = await operatorCheckpoint('https://one');
    expect(unmarked).toMatchObject(capped);
    expect(unmarked?.terminal).toBeUndefined();
    expect(await hasFailedGuardianHistory(account)).toBe(false);

    // Once the others complete, a later session marks it without asking it again.
    forgetUnsupportedHistorySources();
    jest.spyOn(two, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
    expect((await run()).failed).toBe(true);
    expect(one.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(await twoCheckpoint()).toMatchObject({ completed: true });
    expect(await operatorCheckpoint('https://one')).toMatchObject({ ...capped, terminal: true });
  }
);

it.each(oneShortOfTheCap)(
  'leaves %s at the cap unmarked while an operator the account never used defers in that pass',
  async (_kind, seeded, failAgain, capped) => {
    await saveCheckpoint('https://one', seeded);
    const one = source('https://one', []);
    failAgain(one);
    const two = source('https://two', []);
    jest.spyOn(two, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(503, 'Unavailable', 'network'));
    const first = await run();
    expect(first.failed).toBeUndefined();
    expect(first.sourceFailures).toBe(1);
    expect(first.deferredSources).toBe(1);
    const unmarked = await operatorCheckpoint('https://one');
    expect(unmarked).toMatchObject(capped);
    expect(unmarked?.terminal).toBeUndefined();
    expect(await hasFailedGuardianHistory(account)).toBe(false);

    forgetUnsupportedHistorySources();
    jest.spyOn(two, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
    expect((await run()).failed).toBe(true);
    expect(one.getDeltaHistory).toHaveBeenCalledTimes(1);
    expect(await twoCheckpoint()).toMatchObject({ completed: true });
    expect(await operatorCheckpoint('https://one')).toMatchObject({ ...capped, terminal: true });
  }
);

it('counts the same answer from an operator a local switch left as a failed source', async () => {
  await localSwitch('https://two');
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  const result = await run();
  expect(result.sourceFailures).toBe(1);
  expect(result.deferredSources).toBe(0);
  expect((await twoCheckpoint())?.failure).toBe('unsupported');
});

it('counts the same answer on a later page from an operator the account used as a failed source', async () => {
  await localSwitch('https://two');
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 'b' })
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  const result = await run();
  expect(result.sourceFailures).toBe(1);
  expect(result.deferredSources).toBe(0);
  expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'unsupported', cursor: 'b' });
});

it('defers the same answer on a later page from an operator the account never used', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 'b' })
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', ''));
  const result = await run();
  expect(result.sourceFailures).toBe(0);
  expect(result.deferredSources).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({
    completed: false,
    failure: 'unsupported',
    cursor: 'b',
    deferredFailurePasses: 1
  });
});

it('does not treat a missing delta for a listed entry as an empty source', async () => {
  await localSwitch('https://two');
  const client = clients.get('https://two');
  if (!client) throw new Error('Missing test source');
  jest.spyOn(client, 'getDelta').mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  expect((await run()).sourceFailures).toBe(1);
});

it('defers a missing delta for a listed entry from an operator the account never used', async () => {
  const client = clients.get('https://two');
  if (!client) throw new Error('Missing test source');
  jest.spyOn(client, 'getDelta').mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'account_not_found'));
  const result = await run();
  expect(result.sourceFailures).toBe(0);
  expect(result.deferredSources).toBe(1);
  expect(await twoCheckpoint()).toMatchObject({
    completed: false,
    failure: 'account-not-found',
    deferredFailurePasses: 1
  });
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
  expect(checkpoint?.feeScope).toBe('rpc-a|testnet');
  createClient.mockClear();
  expect((await run()).failed).toBe(true);
  expect(createClient).not.toHaveBeenCalled();
  expect(await transactions.count()).toBe(0);
});

it('defers a fee-unavailable stop whose decode was interrupted', async () => {
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementationOnce(async () => {
    shouldYield.mockResolvedValue('wallet locked');
    throw new GuardianHistoryFeeUnavailableError();
  });
  expect((await run()).deferred).toBe(true);
  expect((await operatorCheckpoint('https://one'))?.failure).not.toBe('fee-metadata');
});

it('files a fee-unavailable stop against the node read before its decode', async () => {
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockImplementationOnce(async () => {
    mockFeeScope = 'rpc-b|testnet';
    throw new GuardianHistoryFeeUnavailableError();
  });
  expect((await run()).failed).toBe(true);
  expect((await operatorCheckpoint('https://one'))?.feeScope).toBe('rpc-a|testnet');
});

// A save the storage layer refuses (the generation moved under it) must not leave a terminal or failed source behind.
const actualSave =
  jest.requireActual<typeof import('../guardian/history-storage')>(
    '../guardian/history-storage'
  ).saveGuardianHistoryCheckpoint;
const refuseSavesOf = (failure: GuardianHistoryCheckpoint['failure']) => {
  const save = jest.mocked(saveGuardianHistoryCheckpoint);
  save.mockImplementation(async (generation, checkpoint) =>
    checkpoint.failure === failure ? false : actualSave(generation, checkpoint)
  );
  return { mockRestore: () => save.mockImplementation(actualSave) };
};

it('defers a fee-unavailable stop whose checkpoint save is refused', async () => {
  const save = refuseSavesOf('fee-metadata');
  try {
    jest.mocked(midenClientProxy.decodeGuardianHistory).mockRejectedValueOnce(new GuardianHistoryFeeUnavailableError());
    expect((await run()).deferred).toBe(true);
  } finally {
    save.mockRestore();
  }
});

it('defers a source failure whose checkpoint save is refused', async () => {
  const save = refuseSavesOf('network');
  try {
    const client = clients.get('https://two');
    if (!client) throw new Error('Missing test source');
    jest.spyOn(client, 'getDeltaHistory').mockReset().mockRejectedValue(new Error('offline'));
    expect((await run()).deferred).toBe(true);
  } finally {
    save.mockRestore();
  }
});

it('defers a failure of an operator the account used whose checkpoint save is refused', async () => {
  await localSwitch('https://two');
  const save = refuseSavesOf('network');
  try {
    const client = clients.get('https://two');
    if (!client) throw new Error('Missing test source');
    jest.spyOn(client, 'getDeltaHistory').mockReset().mockRejectedValue(new Error('offline'));
    expect((await run()).deferred).toBe(true);
  } finally {
    save.mockRestore();
  }
});

it('defers a built-in operator the account never used while it is unreachable, then completes it empty', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new Error('offline'));
  for (const deferredFailurePasses of [1, 2]) {
    expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 2, deferredSources: 1 });
    expect(await twoCheckpoint()).toMatchObject({ completed: false, failure: 'network', deferredFailurePasses });
    forgetUnsupportedHistorySources();
  }
  expect(await run()).toMatchObject({ deferred: false, sourceFailures: 0, deferredSources: 0 });
  expect(await twoCheckpoint()).toMatchObject({ completed: true, deferredFailurePasses: 3 });

  forgetUnsupportedHistorySources();
  createClient.mockClear();
  await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
});

it('asks such an operator once per session', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new Error('offline'));
  await run();
  createClient.mockClear();
  expect((await run()).deferredSources).toBe(1);
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(1);
});

it('keeps retrying the current operator every session', async () => {
  const client = source('https://one', []);
  jest.spyOn(client, 'getDeltaHistory').mockRejectedValue(new Error('offline'));
  for (let session = 1; session <= 3; session++) {
    const result = await run();
    expect(result.sourceFailures).toBe(1);
    expect(result.deferredSources).toBe(0);
    expect(client.getDeltaHistory).toHaveBeenCalledTimes(2 * session);
    const one = await operatorCheckpoint('https://one');
    expect(one).toMatchObject({ completed: false, failure: 'network' });
    expect(one?.deferredFailurePasses).toBeUndefined();
    forgetUnsupportedHistorySources();
  }
});

it('starts the count again after the operator answers', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ entries: [entry(3)] });
  expect((await run()).deferredSources).toBe(1);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(1);

  forgetUnsupportedHistorySources();
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 3, deferredSources: 0 });
  const two = await twoCheckpoint();
  expect(two).toMatchObject({ completed: true });
  expect(two?.failure).toBeUndefined();
  expect(two?.deferredFailurePasses).toBeUndefined();
});

it('counts again from a page that succeeds', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ entries: [entry(3)], nextCursor: 'b' })
    .mockRejectedValue(new Error('offline'));
  await run();
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(1);

  forgetUnsupportedHistorySources();
  expect((await run()).deferredSources).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(5);
  expect(await twoCheckpoint()).toMatchObject({ cursor: 'b', deferredFailurePasses: 1 });
});

it('charges a failure to the session its retry was issued in', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockImplementationOnce(async () => {
      forgetUnsupportedHistorySources();
      throw new GuardianHttpError(503, 'Unavailable', 'network');
    })
    .mockRejectedValue(new Error('offline'));
  expect((await run()).deferredSources).toBe(1);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(1);

  createClient.mockClear();
  expect((await run()).deferredSources).toBe(1);
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('https://two');
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(1);
});

it('charges a failure that settles after a lock to the session it was asked in', async () => {
  const client = source('https://two', []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockImplementationOnce(async () => {
      forgetUnsupportedHistorySources();
      throw new GuardianHttpError(401, 'Unauthorized', 'auth');
    })
    .mockRejectedValue(new GuardianHttpError(401, 'Unauthorized', 'auth'));
  await run();
  expect(await twoCheckpoint()).toMatchObject({ failure: 'authentication', deferredFailurePasses: 1 });

  await run();
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(2);

  await run();
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(2);
  expect((await twoCheckpoint())?.deferredFailurePasses).toBe(2);
});

it('defers an operator the account never used without spending its count when the fee lookup fails', async () => {
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  failDecodeOf('3', new GuardianHistoryFeeLookupError());
  for (let session = 0; session < 3; session++) {
    expect(await run()).toMatchObject({ deferred: false, sourceFailures: 0, deferredSources: 1 });
    const two = await twoCheckpoint();
    expect(two).toMatchObject({ completed: false, failure: 'network' });
    expect(two?.deferredFailurePasses).toBeUndefined();
    forgetUnsupportedHistorySources();
  }
});

it('keeps a failed fee lookup a source failure for an operator the account used', async () => {
  await localSwitch('https://two');
  const client = source('https://two', []);
  jest.spyOn(client, 'getDeltaHistory').mockResolvedValue({ entries: [entry(3)] });
  failDecodeOf('3', new GuardianHistoryFeeLookupError());
  for (let session = 0; session < 3; session++) {
    expect(await run()).toMatchObject({ deferred: false, sourceFailures: 1, deferredSources: 0 });
    forgetUnsupportedHistorySources();
  }
});

it('asks for the fee again once the wallet points at another node', async () => {
  jest.mocked(midenClientProxy.decodeGuardianHistory).mockRejectedValueOnce(new GuardianHistoryFeeUnavailableError());
  expect((await run()).failed).toBe(true);
  expect(await hasFailedGuardianHistory(account)).toBe(true);
  expect(await terminalGuardianHistoryGeneration(account)).toBe((await readGuardianHistoryState()).generation);

  mockFeeScope = 'rpc-b|testnet';
  expect(await hasFailedGuardianHistory(account)).toBe(false);
  expect(await terminalGuardianHistoryGeneration(account)).toBeNull();
  source('https://one', [{ entries: [entry(2)], nextCursor: 'next' }, { entries: [entry(1)] }]);
  createClient.mockClear();
  const result = await run();
  expect(result.failed).toBeUndefined();
  expect(result.sourceFailures).toBe(0);
  expect(createClient.mock.calls.map(call => call[1])).toContain('https://one');
  expect(await transactions.count()).toBe(3);
  const checkpoint = await operatorCheckpoint('https://one');
  expect(checkpoint).toMatchObject({ completed: true });
  expect(checkpoint?.failure).toBeUndefined();
  expect(checkpoint?.feeScope).toBeUndefined();
});

it.each<[string, Partial<GuardianHistoryCheckpoint>]>([
  ['saved before fee answers recorded their node', {}],
  ['saved by another history version', { feeScope: 'rpc-a|testnet', version: GUARDIAN_HISTORY_VERSION - 1 }]
])('does not stop on a fee checkpoint %s', async (_label, fields) => {
  const { generation } = await readGuardianHistoryState();
  await saveGuardianHistoryCheckpoint(generation, {
    id: historyCheckpointId('testnet', 'account', 'https://one'),
    network: 'testnet',
    accountId: 'account',
    operator: 'https://one',
    version: GUARDIAN_HISTORY_VERSION,
    seenCursors: [],
    completed: false,
    restored: 0,
    failure: 'fee-metadata',
    ...fields
  });
  expect(await hasFailedGuardianHistory(account)).toBe(false);
});

it.each<[string, Partial<GuardianHistoryCheckpoint>]>([
  ['an unsupported answer', { failure: 'unsupported', unsupportedPasses: 3, completed: false }],
  ['invalid data', { failure: 'invalid-data', invalidDataPasses: 3 }]
])('stops on %s at the cap only once a pass has marked it terminal', async (_kind, capped) => {
  await saveCheckpoint('https://one', { ...capped, terminal: true });
  expect(await hasFailedGuardianHistory(account)).toBe(true);
  expect(await terminalGuardianHistoryGeneration(account)).toBe((await readGuardianHistoryState()).generation);
  await saveCheckpoint('https://one', capped);
  expect(await hasFailedGuardianHistory(account)).toBe(false);
  expect(await terminalGuardianHistoryGeneration(account)).toBeNull();
  await saveOlderVersionCheckpoint('https://one', { ...capped, terminal: true });
  expect(await hasFailedGuardianHistory(account)).toBe(false);
  expect(await terminalGuardianHistoryGeneration(account)).toBeNull();
});

const saveOlderVersionCheckpoint = (operator: string, fields: Partial<GuardianHistoryCheckpoint>) =>
  saveCheckpoint(operator, { version: GUARDIAN_HISTORY_VERSION - 1, ...fields });

it('starts fresh over a checkpoint of another history version, so a fee failure saves one the stop matches', async () => {
  await saveOlderVersionCheckpoint('https://one', { failure: 'fee-metadata', feeScope: 'rpc-a|testnet' });
  const decode = jest.mocked(midenClientProxy.decodeGuardianHistory);
  decode.mockRejectedValueOnce(new GuardianHistoryFeeUnavailableError());
  try {
    expect((await run()).failed).toBe(true);
    expect(await hasFailedGuardianHistory(account)).toBe(true);
    expect((await operatorCheckpoint('https://one'))?.version).toBe(GUARDIAN_HISTORY_VERSION);
    createClient.mockClear();
    expect((await run()).failed).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
  } finally {
    // An unconsumed one-shot would answer the next test's decode.
    decode.mockReset();
  }
});

it('reads a completed checkpoint of another history version again', async () => {
  await saveOlderVersionCheckpoint('https://two', { completed: true });
  expect((await run()).restored).toBe(3);
  expect(createClient.mock.calls.map(call => call[1])).toContain('https://two');
  expect(await transactions.count()).toBe(3);
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

const switchRow = (
  status: ITransactionStatus,
  previousGuardianEndpoint: string,
  newGuardianEndpoint: string,
  extra: Record<string, unknown> = {}
) =>
  transactions.add({
    id: 'switch-row',
    type: 'switch-guardian',
    accountId: 'account',
    status,
    initiatedAt: 1,
    displayIcon: 'DEFAULT',
    extraInputs: { previousGuardianEndpoint, newGuardianEndpoint, ...extra }
  });
const failedSwitch = (previousGuardianEndpoint: string, newGuardianEndpoint: string) =>
  switchRow(ITransactionStatus.Failed, previousGuardianEndpoint, newGuardianEndpoint);
// Its first history read answers that it serves no history: unsupported, a failure for an own operator.
const servesNoHistory = (endpoint: string) => {
  const client = source(endpoint, []);
  jest
    .spyOn(client, 'getDeltaHistory')
    .mockReset()
    .mockRejectedValue(new GuardianHttpError(404, 'Not Found', 'no history'));
};

it('does not visit the target of a switch that never committed', async () => {
  const target = source('http://localhost:3002', []);
  jest.spyOn(target, 'getDeltaHistory').mockReset().mockRejectedValue(new Error('offline'));
  await failedSwitch('https://one', 'http://localhost:3002');
  const result = await run();
  expect(createClient.mock.calls.map(call => call[1])).not.toContain('http://localhost:3002');
  expect(result.sourceFailures).toBe(0);
});

it('visits the previous operator of a switch whose row ended Failed', async () => {
  source('http://localhost:3001', []);
  source('http://localhost:3002', []);
  await failedSwitch('http://localhost:3001', 'http://localhost:3002');
  await run();
  const visited = createClient.mock.calls.map(call => call[1]);
  expect(visited).toContain('http://localhost:3001');
  expect(visited).not.toContain('http://localhost:3002');
});

it('visits the target of a completed switch as an operator the account used', async () => {
  servesNoHistory('http://localhost:3002');
  await switchRow(ITransactionStatus.Completed, 'https://one', 'http://localhost:3002', {
    endpointPersistFailed: true
  });
  const result = await run();
  expect(createClient.mock.calls.map(call => call[1])).toContain('http://localhost:3002');
  expect(result.sourceFailures).toBe(1);
  expect(result.deferredSources).toBe(0);
});

// Production defers the whole pass while a switch is in flight; with shouldYield at null this pins line 183's arm.
it.each([
  ['queued', ITransactionStatus.Queued],
  ['generating', ITransactionStatus.GeneratingTransaction]
])('visits the origin but not the target of a switch still %s', async (_name, status) => {
  servesNoHistory('http://localhost:3001');
  source('http://localhost:3002', []);
  await switchRow(status, 'http://localhost:3001', 'http://localhost:3002');
  const result = await run();
  const visited = createClient.mock.calls.map(call => call[1]);
  expect(visited).toContain('http://localhost:3001');
  expect(visited).not.toContain('http://localhost:3002');
  expect(result.sourceFailures).toBe(1);
  expect(result.deferredSources).toBe(0);
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
