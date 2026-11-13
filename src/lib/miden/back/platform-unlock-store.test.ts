import type { Runtime } from 'webextension-polyfill';

import { getAccountsWriteQueue } from 'lib/miden/back/accounts-write-queue';
import { decryptVaultKeyWithPassword } from 'lib/miden/passworder';
import { encodePlatformBytes } from 'lib/platform-auth/crypto';
import { PLATFORM_CREDENTIALS_STORAGE_KEY, PLATFORM_UNLOCK_STORAGE_KEY } from 'lib/platform-auth/types';

import * as platform from './platform-unlock-store';

const mockData = new Map<string, unknown>();
let mockFailKey: string | null = null;
let mockCloseOnLedgerSave: Runtime.Port | undefined;
const clone = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const mockStorage = {
  get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, clone(mockData.get(key))])),
  set: async (items: Record<string, unknown>) => {
    if ('platform_credentials_to_signal' in items && mockCloseOnLedgerSave) {
      const port = mockCloseOnLedgerSave;
      mockCloseOnLedgerSave = undefined;
      port.disconnect();
    }
    if (mockFailKey !== null && mockFailKey in items) {
      mockFailKey = null;
      throw new Error('storage unavailable');
    }
    for (const [key, value] of Object.entries(items)) mockData.set(key, clone(value));
  },
  remove: async (keys: string[]) => {
    for (const key of keys) mockData.delete(key);
  }
};
jest.mock('lib/platform/storage-adapter', () => ({ getStorageProvider: () => mockStorage }));
jest.mock('lib/miden/passworder', () => ({
  ...jest.requireActual<typeof import('lib/miden/passworder')>('lib/miden/passworder'),
  decryptVaultKeyWithPassword: jest.fn()
}));

function makePort(): Runtime.Port {
  const disconnected = new Set<(port: Runtime.Port) => void>();
  const messages = new Set<(message: unknown, port: Runtime.Port) => void>();
  const port: Runtime.Port = {
    name: 'INTERCOM',
    sender: { id: 'extension', url: 'chrome-extension://extension/sidepanel.html' },
    postMessage: () => undefined,
    disconnect: () => {
      for (const fn of disconnected) fn(port);
    },
    onDisconnect: {
      addListener: fn => {
        disconnected.add(fn);
      },
      removeListener: fn => {
        disconnected.delete(fn);
      },
      hasListener: fn => disconnected.has(fn)
    },
    onMessage: {
      addListener: fn => {
        messages.add(fn);
      },
      removeListener: fn => {
        messages.delete(fn);
      },
      hasListener: fn => messages.has(fn)
    }
  };
  return port;
}
const owners: Runtime.Port[] = [];
const owner = () => {
  const port = makePort();
  owners.push(port);
  return port;
};
const turn = <T>(action: () => Promise<T>) => getAccountsWriteQueue().add(action);
const first = {
  credentialId: 'AQIDBA',
  prfSalt: encodePlatformBytes(new Uint8Array(32).fill(11)),
  backupEligible: true
};
const second = { ...first, credentialId: 'BQYHCA' };
const prfSecret = encodePlatformBytes(new Uint8Array(32).fill(19));
const decrypt = jest.mocked(decryptVaultKeyWithPassword);

beforeEach(() => {
  mockData.clear();
  mockFailKey = null;
  mockCloseOnLedgerSave = undefined;
  mockData.set('vault_key_password', 'primary-A');
  decrypt.mockImplementation(async (ciphertext, password) => {
    if (ciphertext !== 'primary-A' || password !== 'correct') throw new Error('wrong password');
    return new Uint8Array(32).fill(7);
  });
});
afterEach(async () => {
  for (const port of owners.splice(0)) port.disconnect();
  await getAccountsWriteQueue().onIdle();
});

async function begin(port: Runtime.Port, credential = first, previous: string | null = null) {
  const token = await turn(() => platform.beginPlatformEnrollment(port, previous));
  await turn(() => platform.trackPlatformEnrollment(port, token, credential));
  return token;
}

it('does not save a credential after its owner closes during cleanup journaling', async () => {
  const port = owner();
  const token = await begin(port);
  mockCloseOnLedgerSave = port;
  await expect(turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret))).rejects.toThrow();
  expect(mockData.has(PLATFORM_UNLOCK_STORAGE_KEY)).toBe(false);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('publishes only public credential metadata and keeps the password protector beside the new wrapping', async () => {
  const port = owner();
  const token = await begin(port);
  await turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  expect(await platform.readPlatformUnlockState(true)).toEqual({
    available: true,
    hasPassword: true,
    credential: first
  });
  expect(mockData.get('vault_key_password')).toBe('primary-A');
  expect(mockData.get(PLATFORM_UNLOCK_STORAGE_KEY)).toMatchObject({ version: 1, ...first });
  expect(JSON.stringify([...mockData.values()])).not.toContain(prfSecret);
  await expect(platform.getStoredPlatformVaultKey(first.credentialId, prfSecret)).resolves.toHaveProperty(
    'extractable',
    false
  );
});

it('does not enable enrollment without a modern password protector', async () => {
  mockData.delete('vault_key_password');
  expect(await platform.readPlatformUnlockState(true)).toEqual({
    available: false,
    hasPassword: false,
    credential: null
  });
  await expect(turn(() => platform.beginPlatformEnrollment(owner(), null))).rejects.toThrow();
});

it('refuses a wrong password without installing any new wrapping', async () => {
  const port = owner();
  const token = await begin(port);
  await expect(turn(() => platform.commitPlatformEnrollment(port, token, 'wrong', prfSecret))).rejects.toThrow();
  expect(mockData.has(PLATFORM_UNLOCK_STORAGE_KEY)).toBe(false);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('allows only the original owner to commit a token', async () => {
  const port = owner();
  const token = await begin(port);
  await expect(turn(() => platform.commitPlatformEnrollment(owner(), token, 'correct', prfSecret))).rejects.toThrow();
  await turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([]);
});

it('rejects the losing concurrent enrollment and queues only its returned credential', async () => {
  const a = owner();
  const b = owner();
  const aToken = await begin(a);
  const bToken = await begin(b, second);
  await turn(() => platform.commitPlatformEnrollment(a, aToken, 'correct', prfSecret));
  await expect(turn(() => platform.commitPlatformEnrollment(b, bToken, 'correct', prfSecret))).rejects.toThrow();
  expect((await platform.readPlatformUnlockState(true)).credential).toEqual(first);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([second.credentialId]);
});

it('refuses a save after wallet replacement even when the user reused their password', async () => {
  const port = owner();
  const token = await begin(port);
  mockData.set('vault_key_password', 'primary-B');
  await expect(turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret))).rejects.toThrow();
  expect(mockData.has(PLATFORM_UNLOCK_STORAGE_KEY)).toBe(false);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('retires an abandoned enrollment and cannot resurrect its token', async () => {
  const port = owner();
  const token = await begin(port);
  await turn(() => platform.abandonPlatformEnrollments(port, token));
  await expect(turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret))).rejects.toThrow();
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('preserves a returned credential when tracking arrives after the pending token was abandoned', async () => {
  const port = owner();
  const token = await turn(() => platform.beginPlatformEnrollment(port, null));
  await turn(() => platform.abandonPlatformEnrollments(port, token));
  await expect(turn(() => platform.trackPlatformEnrollment(port, token, first))).rejects.toThrow();
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('moves disconnected owners into durable cleanup without signaling another live enrollment', async () => {
  const a = owner();
  const b = owner();
  await begin(a);
  await begin(b, second);
  a.disconnect();
  await getAccountsWriteQueue().onIdle();
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
  expect(JSON.stringify(mockData.get(PLATFORM_CREDENTIALS_STORAGE_KEY))).toContain(second.credentialId);
});

it('queues the old record before removal and does not require the provider to answer first', async () => {
  const port = owner();
  const token = await begin(port);
  await turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  await turn(() => platform.removePlatformUnlock(first.credentialId));
  expect(mockData.has(PLATFORM_UNLOCK_STORAGE_KEY)).toBe(false);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
  await turn(() => platform.acknowledgePlatformSignal(first.credentialId));
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([]);
});

it('queues both saved and in-flight credentials before a setup wipe', async () => {
  const a = owner();
  const token = await begin(a);
  await turn(() => platform.commitPlatformEnrollment(a, token, 'correct', prfSecret));
  await begin(owner(), second, first.credentialId);
  await turn(() => platform.preparePlatformCredentialWipeInTurn());
  mockData.delete(PLATFORM_UNLOCK_STORAGE_KEY);
  expect((await turn(() => platform.getPendingPlatformSignals())).sort()).toEqual(
    [first.credentialId, second.credentialId].sort()
  );
});

it('recovers persisted enrollments that no live port owns after a worker restart', async () => {
  mockData.set(PLATFORM_CREDENTIALS_STORAGE_KEY, {
    pending: [{ enrollmentId: 'old-token', binding: 'old-binding', credential: first }],
    toSignal: []
  });
  await turn(() => platform.recoverPlatformEnrollmentsInTurn());
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('gate not initialized');
  };
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['replace', 'disconnect'])('rechecks ownership and wrapping after async password work (%s)', async change => {
  const port = owner();
  const token = await begin(port);
  const started = deferred<void>();
  const gate = deferred<Uint8Array>();
  decrypt.mockImplementationOnce(async () => {
    started.resolve();
    return gate.promise;
  });
  const saving = turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  await started.promise;
  if (change === 'replace') mockData.set('vault_key_password', 'primary-B');
  else port.disconnect();
  gate.resolve(new Uint8Array(32).fill(7));
  await expect(saving).rejects.toThrow();
  await getAccountsWriteQueue().onIdle();
  expect(mockData.has(PLATFORM_UNLOCK_STORAGE_KEY)).toBe(false);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('does not lose a returned ID when metadata is refused', async () => {
  const port = owner();
  const token = await turn(() => platform.beginPlatformEnrollment(port, null));
  await expect(
    turn(() =>
      platform.trackPlatformEnrollment(port, token, {
        ...first,
        prfSalt: encodePlatformBytes(new Uint8Array(31))
      })
    )
  ).rejects.toThrow();
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([first.credentialId]);
});

it('does not expose a committed credential to cleanup after a duplicate commit', async () => {
  const port = owner();
  const token = await begin(port);
  await turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  await expect(turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret))).rejects.toThrow();
  await expect(turn(() => platform.acknowledgePlatformSignal(first.credentialId))).rejects.toThrow();
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([]);
});

it('refuses a key for another credential or incorrect PRF', async () => {
  const port = owner();
  const token = await begin(port);
  await turn(() => platform.commitPlatformEnrollment(port, token, 'correct', prfSecret));
  await expect(platform.getStoredPlatformVaultKey(second.credentialId, prfSecret)).rejects.toThrow();
  await expect(
    platform.getStoredPlatformVaultKey(first.credentialId, encodePlatformBytes(new Uint8Array(32).fill(18)))
  ).rejects.toThrow();
});

it('retains the previous working record if replacement storage fails', async () => {
  const a = owner();
  const token = await begin(a);
  await turn(() => platform.commitPlatformEnrollment(a, token, 'correct', prfSecret));
  const b = owner();
  const bToken = await begin(b, second, first.credentialId);
  mockFailKey = PLATFORM_UNLOCK_STORAGE_KEY;
  await expect(turn(() => platform.commitPlatformEnrollment(b, bToken, 'correct', prfSecret))).rejects.toThrow();
  expect((await platform.readPlatformUnlockState(true)).credential).toEqual(first);
  expect(await turn(() => platform.getPendingPlatformSignals())).toEqual([second.credentialId]);
});
