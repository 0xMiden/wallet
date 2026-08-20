import { clearGuardianNoteRecoveryProgress } from 'lib/guardian-note-recovery-progress';
import { getAllUncompletedTransactions } from 'lib/miden/transaction/get';
import type { WalletAccount } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { maybeStartGuardianRecovery } from './guardian-recovery';
import { midenClientProxy } from './miden-client-proxy';
import { accountsUpdated, store } from './store';

// The orchestrator's own decisions are what these tests are about — the gating,
// the queue and the terminal flag write — so every source it drives is stubbed.
jest.mock('lib/miden/transaction/get', () => ({ getAllUncompletedTransactions: jest.fn() }));
jest.mock('./sync-manager', () => ({ doSync: jest.fn() }));
jest.mock('./miden-client-proxy', () => ({
  midenClientProxy: {
    getAccount: jest.fn(),
    drainPrivateNoteTransport: jest.fn(),
    importRecoveryNoteBytes: jest.fn(),
    resolveRecoveryScanRange: jest.fn(),
    recoverPublicNotesRange: jest.fn()
  }
}));
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown) => fn()
}));
jest.mock('lib/miden/guardian/account', () => ({
  getSignerDetailsFromAccount: jest.fn().mockResolvedValue({ commitment: 'commitment' }),
  resolveGuardianEndpoint: jest.fn().mockResolvedValue('https://guardian.test')
}));
jest.mock('lib/miden/guardian/native-http', () => ({ registerGuardianOrigin: jest.fn() }));
jest.mock('lib/miden/guardian/signer', () => ({ WalletSigner: jest.fn() }));
jest.mock('@openzeppelin/guardian-client', () => ({
  GuardianHttpClient: jest.fn().mockImplementation(() => ({
    setSigner: jest.fn(),
    getDeltaProposals: jest.fn().mockResolvedValue([]),
    getState: jest.fn().mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z' })
  }))
}));
jest.mock('lib/guardian-note-recovery-progress', () => ({
  reportGuardianNoteRecoveryProgress: jest.fn(),
  clearGuardianNoteRecoveryProgress: jest.fn()
}));
jest.mock('./store', () => ({
  store: { getState: jest.fn() },
  accountsUpdated: jest.fn()
}));

const mockUncompleted = jest.mocked(getAllUncompletedTransactions);
const mockGetState = jest.mocked(store.getState);
const mockAccountsUpdated = jest.mocked(accountsUpdated);
const mockClearProgress = jest.mocked(clearGuardianNoteRecoveryProgress);
const mockProxy = jest.mocked(midenClientProxy);

// `startedRecoveries` and the queue are module state, so each test gets a fresh
// account id rather than a fresh module.
let accountSeq = 0;

function pendingAccount(overrides: Partial<WalletAccount> = {}): WalletAccount {
  accountSeq++;
  return {
    publicKey: `account-${accountSeq}`,
    name: `Account ${accountSeq}`,
    isPublic: false,
    type: WalletType.Guardian,
    hdIndex: 0,
    authScheme: 'ecdsa',
    guardianNoteRecoveryPending: true,
    ...overrides
  };
}

let setPendingFlag: jest.Mock;

function unlocked() {
  mockGetState.mockReturnValue({ vault: { setGuardianNoteRecoveryPending: setPendingFlag } } as never);
}

function locked() {
  mockGetState.mockReturnValue({ vault: null } as never);
}

/** Lets the detached run (queued, then several awaits deep) reach its end. */
async function drainDetachedRun() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  setPendingFlag = jest.fn().mockResolvedValue([]);
  unlocked();
  mockUncompleted.mockResolvedValue([]);
  mockProxy.getAccount.mockResolvedValue({} as never);
  mockProxy.drainPrivateNoteTransport.mockResolvedValue(undefined as never);
  mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 0 } as never);
  mockProxy.recoverPublicNotesRange.mockResolvedValue({ imported: 0, failures: 0 } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('maybeStartGuardianRecovery gating', () => {
  it('does not start recovery for an account without the pending marker', async () => {
    await expect(maybeStartGuardianRecovery(pendingAccount({ guardianNoteRecoveryPending: false }))).resolves.toBe(
      false
    );
    expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
  });

  it('waits for the mandatory hot-key rotation to land', async () => {
    await expect(maybeStartGuardianRecovery(pendingAccount({ requiresHotKeyRotation: true }))).resolves.toBe(false);
    expect(mockProxy.drainPrivateNoteTransport).not.toHaveBeenCalled();
  });

  it('defers while any account has a transaction in flight, and stays startable after', async () => {
    const account = pendingAccount();
    mockUncompleted.mockResolvedValue([{ id: 'tx-1' }] as never);

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(false);

    // The reservation must have been released, or the provider's poll could
    // never start this account again for the rest of the backend's life.
    mockUncompleted.mockResolvedValue([]);
    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('releases the reservation when the eligibility query itself rejects', async () => {
    const account = pendingAccount();
    mockUncompleted.mockRejectedValueOnce(new Error('dexie is gone'));

    await expect(maybeStartGuardianRecovery(account)).rejects.toThrow('dexie is gone');

    await expect(maybeStartGuardianRecovery(account)).resolves.toBe(true);
  });

  it('starts an account only once, even when two provider instances ask at the same time', async () => {
    const account = pendingAccount();

    const [first, second] = await Promise.all([
      maybeStartGuardianRecovery(account),
      maybeStartGuardianRecovery(account)
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe('detached recovery run', () => {
  it('clears the pending flag and broadcasts once every source succeeded', async () => {
    const account = pendingAccount({ coldPublicKey: '0xcold' });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).toHaveBeenCalledWith(account.publicKey, false);
    expect(mockAccountsUpdated).toHaveBeenCalledTimes(1);
    expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
  });

  it('keeps the flag set when the Guardian client cannot be built', async () => {
    const account = pendingAccount({ coldPublicKey: undefined });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockClearProgress).toHaveBeenCalledWith(account.publicKey);
  });

  it('keeps the flag set when a source failed, so the next backend start retries', async () => {
    const account = pendingAccount();
    mockProxy.recoverPublicNotesRange.mockRejectedValue(new Error('node unavailable'));
    mockProxy.resolveRecoveryScanRange.mockResolvedValue({ startBlock: 0, latestBlock: 10 } as never);

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
  });

  it('never touches the vault or front state once the wallet locks mid-run', async () => {
    const account = pendingAccount();
    mockProxy.drainPrivateNoteTransport.mockImplementation(async () => {
      locked();
    });

    await maybeStartGuardianRecovery(account);
    await drainDetachedRun();

    expect(setPendingFlag).not.toHaveBeenCalled();
    expect(mockAccountsUpdated).not.toHaveBeenCalled();
  });

  it('runs one account at a time', async () => {
    const first = pendingAccount();
    const second = pendingAccount();
    let concurrent = 0;
    let peak = 0;
    mockProxy.drainPrivateNoteTransport.mockImplementation(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent--;
    });

    await maybeStartGuardianRecovery(first);
    await maybeStartGuardianRecovery(second);
    await drainDetachedRun();

    expect(peak).toBe(1);
  });
});
