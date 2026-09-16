import { GuardianHttpClient, GuardianHttpError, type DeltaObject, type HistoryEntry, type HistoryPage } from '@openzeppelin/guardian-client';

import { ITransactionStatus } from '../db/types';
import { clearGuardianHistoryCheckpoints, readGuardianHistoryState } from '../guardian/history-storage';
import { exportDb, importDb, transactions } from '../repo';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { classifyHistoryFailure, recoverGuardianHistory } from './guardian-history-recovery';
import { midenClientProxy } from './miden-client-proxy';

jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: class {
    getDeltaHistory = jest.fn();
    getDelta = jest.fn();
  },
  GuardianHttpError: class extends Error {
    code: string | null;
    constructor(public status: number, public statusText: string, public body: string) {
      super(body);
      this.code = body === 'account_not_found' ? body : null;
    }
  }
}));
jest.mock('lib/miden/front/storage', () => {
  const values = new Map<string, object | string>();
  return {
    fetchFromStorage: async (key: string) => values.get(key) ?? null,
    putToStorage: async (key: string, value: object | string) => { values.set(key, value); }
  };
});
jest.mock('lib/guardian-note-recovery-progress', () => ({ reportGuardianNoteRecoveryProgress: jest.fn() }));
jest.mock('lib/miden-chain/constants', () => ({ MIDEN_GUARDIAN_ENDPOINTS: new Map([['testnet', ['https://one/', 'https://two']]]) }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => 'testnet' }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: async () => 'https://one' }));
jest.mock('lib/miden/sdk/helpers', () => ({ canonicalWalletAccountId: (id: string) => id }));
jest.mock('./miden-client-proxy', () => ({ midenClientProxy: {
  decodeGuardianHistory: jest.fn(), getGuardianResultCommitment: jest.fn()
} }));

const account: WalletAccount = {
  publicKey: 'account', name: 'account', isPublic: false, type: WalletType.Guardian,
  hdIndex: 0, authScheme: 'ecdsa', coldPublicKey: 'cold'
};
const timestamp = '2026-08-01T00:00:00Z';
const entry = (nonce: number): HistoryEntry => ({
  nonce, status: 'canonical', timestamp, newCommitment: `commitment-${nonce}`,
  inputNotes: [], outputNotes: [], decodeWarnings: []
});
const delta = (nonce: number): DeltaObject => ({
  accountId: 'account', nonce, prevCommitment: '', newCommitment: `commitment-${nonce}`,
  deltaPayload: { txSummary: { data: nonce.toString() }, signatures: [] },
  status: { status: 'canonical', timestamp }, metadata: { proposal: { proposalType: 'swap' } }
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
    accountId: 'account', inputNotes: [], outputNotes: [{ id: `note-${encoded}`, visibility: 'public', assets: [{ faucetId: 'asset', amount: '7' }] }]
  }));
  jest.mocked(midenClientProxy.getGuardianResultCommitment).mockResolvedValue('commitment-2');
});

it('paginates current source first, removes duplicate operators, and merges duplicate deltas', async () => {
  expect(await run()).toEqual({ deferred: false, sourceFailures: 0, restored: 3 });
  expect(createClient.mock.calls.map(call => call[1])).toEqual(['https://one', 'https://two']);
  const rows = await transactions.toArray();
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.recovery?.nonce === 2)?.recovery?.operators).toEqual(['https://one', 'https://two']);
  expect(clients.get('https://one')?.getDeltaHistory).toHaveBeenNthCalledWith(2, 'account', { limit: 50, cursor: 'next' });
  createClient.mockClear();
  await run();
  expect(createClient).not.toHaveBeenCalled();
  expect(await transactions.count()).toBe(3);
});

it('preserves a richer local action matched through its execution commitment', async () => {
  await transactions.add({
    id: 'local-bridge', type: 'bridged-send', accountId: 'account', status: ITransactionStatus.Completed,
    initiatedAt: 1, displayIcon: 'SEND', resultBytes: new Uint8Array([1]), extraInputs: { destinationAddress: 'evm-address' }
  });
  await run();
  expect(await transactions.count()).toBe(3);
  const local = await transactions.get('local-bridge');
  expect(local?.extraInputs.destinationAddress).toBe('evm-address');
  expect(local?.recovery).toBeUndefined();
});

it('keeps the cursor for an interrupted page and resumes without duplicate rows', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest.spyOn(client, 'getDeltaHistory').mockReset()
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

it('continues after an authentication failure and retries that source on the next run', async () => {
  const client = clients.get('https://one');
  if (!client) throw new Error('Missing test source');
  jest.spyOn(client, 'getDeltaHistory').mockReset().mockRejectedValue(new GuardianHttpError(401, 'Unauthorized', 'auth'));
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
  jest.spyOn(client, 'getDeltaHistory').mockReset()
    .mockRejectedValueOnce(new GuardianHttpError(503, 'Unavailable', 'network'))
    .mockResolvedValueOnce({ entries: [entry(1)], nextCursor: 'loop' })
    .mockResolvedValue({ entries: [entry(2)], nextCursor: 'loop' });
  expect((await run()).sourceFailures).toBe(1);
  expect(client.getDeltaHistory).toHaveBeenCalledTimes(3);
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
  [404, 'account_not_found', 'account-not-found'], [404, '', 'unsupported'],
  [401, '', 'authentication'], [403, '', 'authentication'], [503, '', 'network']
])('classifies HTTP %s with body %s', (status, body, failure) => {
  if (typeof status !== 'number' || typeof body !== 'string') throw new Error('Invalid test case');
  expect(classifyHistoryFailure(new GuardianHttpError(status, '', body))).toBe(failure);
});
