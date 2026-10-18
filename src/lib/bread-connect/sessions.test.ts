/* eslint-disable import/first */
let mockDApps: Record<string, unknown[]> = {};
jest.mock('lib/miden/back/dapp', () => ({
  getAllDApps: () => Promise.resolve(mockDApps)
}));

const mockStore = new Map<string, unknown>();
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) =>
      Object.fromEntries(keys.filter(key => mockStore.has(key)).map(key => [key, mockStore.get(key)])),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) mockStore.set(key, JSON.parse(JSON.stringify(value)));
    }
  })
}));

import { REQUEST_MAX_AGE_MS, REQUEST_MAX_CLOCK_AHEAD_MS, SESSION_IDLE_MS } from '@miden-sdk/bread-connect';

import { findSession, hasAnswered, keepSession, recordAnswered, type StoredSession } from './sessions';

const KEY = 'bread_connect_sessions';
const NOW = 1_800_000_000_000;
const ANSWERED_MS = REQUEST_MAX_AGE_MS + REQUEST_MAX_CLOCK_AHEAD_MS;
const SESSION = {
  session: 'session-1',
  callback: 'https://game.example/bread',
  origin: 'https://game.example',
  appPublicKey: 'app-public',
  walletSecretKey: 'wallet-secret',
  walletPublicKey: 'wallet-public'
};

beforeEach(() => {
  mockStore.clear();
  mockDApps = { [SESSION.origin]: [{ accountId: 'mtst1account' }] };
});

describe('findSession', () => {
  it('finds a kept session while its app keeps a permission in Bread', async () => {
    await keepSession(SESSION, NOW);

    expect(await findSession(SESSION.session, NOW)).toEqual({ ...SESSION, usedAt: NOW, answered: [] });
    expect(await findSession('another', NOW)).toBeNull();
  });

  it.each([
    ['a value that is not a record', 'sessions'],
    ['a session filed under another id', { other: { ...SESSION, usedAt: NOW, answered: [] } }],
    [
      'a session missing a key',
      { [SESSION.session]: { ...SESSION, walletSecretKey: undefined, usedAt: NOW, answered: [] } }
    ],
    ['a session with no use time', { [SESSION.session]: { ...SESSION, answered: [] } }],
    [
      'a session with a malformed answered id',
      { [SESSION.session]: { ...SESSION, usedAt: NOW, answered: [{ id: 7 }] } }
    ],
    ['a session whose answered ids are not a list', { [SESSION.session]: { ...SESSION, usedAt: NOW, answered: {} } }]
  ])('ignores %s', async (_name, stored) => {
    mockStore.set(KEY, stored);

    expect(await findSession(SESSION.session, NOW)).toBeNull();
  });

  it('drops sessions unused for thirty days whenever it writes', async () => {
    await keepSession({ ...SESSION, session: 'old' }, NOW);
    await keepSession(SESSION, NOW + SESSION_IDLE_MS + 1);

    expect(Object.keys(mockStore.get(KEY) as object)).toEqual([SESSION.session]);
  });
});

describe('answered request ids', () => {
  it('records an answered id and marks the session used', async () => {
    await keepSession(SESSION, NOW);

    await recordAnswered(SESSION.session, 'request-1', NOW + 5);

    const session = (await findSession(SESSION.session, NOW + 5)) as StoredSession;
    expect(session.usedAt).toBe(NOW + 5);
    expect(hasAnswered(session, 'request-1', NOW + 5)).toBe(true);
    expect(hasAnswered(session, 'request-2', NOW + 5)).toBe(false);
  });

  it('forgets an id once a replay of it would fail the age check anyway', async () => {
    await keepSession(SESSION, NOW);
    await recordAnswered(SESSION.session, 'request-1', NOW);
    const session = (await findSession(SESSION.session, NOW)) as StoredSession;
    expect(hasAnswered(session, 'request-1', NOW + ANSWERED_MS)).toBe(true);
    expect(hasAnswered(session, 'request-1', NOW + ANSWERED_MS + 1)).toBe(false);

    await recordAnswered(SESSION.session, 'request-2', NOW + ANSWERED_MS + 1);

    const later = (await findSession(SESSION.session, NOW + ANSWERED_MS + 1)) as StoredSession;
    expect(later.answered).toEqual([{ id: 'request-2', at: NOW + ANSWERED_MS + 1 }]);
  });

  it('keeps one record per id', async () => {
    await keepSession(SESSION, NOW);
    await recordAnswered(SESSION.session, 'request-1', NOW);
    await recordAnswered(SESSION.session, 'request-1', NOW + 1);

    const session = (await findSession(SESSION.session, NOW + 1)) as StoredSession;
    expect(session.answered).toEqual([{ id: 'request-1', at: NOW + 1 }]);
  });

  it('records nothing for a session it does not keep', async () => {
    await recordAnswered('missing', 'request-1', NOW);

    expect(mockStore.has(KEY)).toBe(false);
  });
});
