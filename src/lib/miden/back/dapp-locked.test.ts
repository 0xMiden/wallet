/**
 * Tests for `lib/miden/back/dapp-locked.ts` against the real store and its gate.
 */
import { MidenDAppErrorType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import {
  _resetLockedPromptCooldownsForTest,
  isWalletLockedError,
  LOCKED_PROMPT_COOLDOWN_MS,
  lockedRefusal,
  mayPromptToUnlock,
  noteLockedPromptEnded,
  onceAfterUnlock,
  WALLET_LOCKED_REFUSAL,
  waitForUnlock
} from './dapp-locked';
import { assertUnlocked, inited, locked, store, unlocked } from './store';
import type { Vault } from './vault';

jest.mock('lib/miden/back/vault', () => ({
  Vault: {}
}));

// What the store gate throws for the store's current state.
function gateError(): unknown {
  try {
    assertUnlocked(store.getState());
  } catch (error) {
    return error;
  }
  throw new Error('the gate let a locked store through');
}

describe('isWalletLockedError', () => {
  it('classifies the gate refusal of a locked wallet', () => {
    inited(true);
    expect(isWalletLockedError(gateError())).toBe(true);
  });

  it('keeps an Idle wallet out: it fails the same gate but has nothing to unlock', () => {
    inited(false);
    expect(isWalletLockedError(gateError())).toBe(false);
  });

  it('never classifies a kill as locked, whatever it carries', () => {
    inited(true);
    const kill = Object.assign(new WasmClientPoisonedError('watchdog', new Error('parked')), { reason: 'locked' });
    expect(isWalletLockedError(kill)).toBe(false);
  });

  it('reads the tag, not the text', () => {
    inited(true);
    expect(isWalletLockedError(new Error('Wallet is locked'))).toBe(false);
    expect(isWalletLockedError(undefined)).toBe(false);
  });
});

describe('lockedRefusal', () => {
  it('is the coded refusal the adapter maps to NotGrantedMidenWalletError', () => {
    expect(WALLET_LOCKED_REFUSAL).toBe(`${MidenDAppErrorType.NotGranted}: Wallet is locked`);
    expect(lockedRefusal().message).toBe('NOT_GRANTED: Wallet is locked');
  });
});

const unlockStore = () =>
  unlocked({
    vault: {} as Vault,
    accounts: [],
    settings: { contacts: [] } as never,
    currentAccount: { publicKey: 'pk' } as never,
    ownMnemonic: true
  });
const gateRefusal = () => Object.assign(new Error('Wallet is locked'), { reason: 'locked' });

describe('waitForUnlock', () => {
  afterEach(() => jest.useRealTimers());

  it('answers at once when the store is already unlocked', async () => {
    unlockStore();
    await expect(waitForUnlock(1_000)).resolves.toBe(true);
  });

  it('answers when the store unlocks during the wait', async () => {
    locked();
    const wait = waitForUnlock(1_000);
    unlockStore();
    await expect(wait).resolves.toBe(true);
  });

  it('gives up when the wait runs out', async () => {
    jest.useFakeTimers();
    locked();
    const wait = waitForUnlock(1_000);
    jest.advanceTimersByTime(1_000);
    await expect(wait).resolves.toBe(false);
  });

  it('gives up at once when its popup closes', async () => {
    jest.useFakeTimers();
    locked();
    const closed = new AbortController();
    const wait = waitForUnlock(1_000, closed.signal);
    closed.abort();
    // No timer has run, so only the close can end this wait.
    await expect(wait).resolves.toBe(false);
  });

  it('answers false to a popup that already closed, even once unlocked', async () => {
    unlockStore();
    const closed = new AbortController();
    closed.abort();
    await expect(waitForUnlock(1_000, closed.signal)).resolves.toBe(false);
  });
});

describe('onceAfterUnlock', () => {
  afterEach(() => jest.useRealTimers());

  it('builds once for every caller', async () => {
    unlockStore();
    const build = jest.fn(async () => 'data');
    const get = onceAfterUnlock(build, 1_000);
    await expect(Promise.all([get(), get()])).resolves.toEqual(['data', 'data']);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('waits out a locked build and builds again after the unlock', async () => {
    locked();
    const build = jest.fn().mockRejectedValueOnce(gateRefusal()).mockResolvedValueOnce('data');
    const result = onceAfterUnlock(build, 1_000)();
    await new Promise(r => setTimeout(r, 0));
    unlockStore();
    await expect(result).resolves.toBe('data');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('keeps no failure: the next caller builds again', async () => {
    unlockStore();
    const build = jest.fn().mockRejectedValueOnce(new Error('node down')).mockResolvedValueOnce('data');
    const get = onceAfterUnlock(build, 1_000);
    await expect(get()).rejects.toThrow('node down');
    await expect(get()).resolves.toBe('data');
  });

  it('refuses as locked when no unlock comes in time', async () => {
    jest.useFakeTimers();
    locked();
    const result = onceAfterUnlock(async () => Promise.reject(gateRefusal()), 1_000)();
    const settled = result.catch((error: Error) => error.message);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toBe('NOT_GRANTED: Wallet is locked');
  });
});

describe('the lock prompt cooldown', () => {
  let now = 1_000_000;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    _resetLockedPromptCooldownsForTest();
    now = 1_000_000;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => clock.mockRestore());

  it('holds an origin back for 30 s after its lock prompt ended still locked', () => {
    expect(mayPromptToUnlock('https://a.xyz')).toBe(true);
    noteLockedPromptEnded('https://a.xyz');
    now += LOCKED_PROMPT_COOLDOWN_MS - 1;
    expect(mayPromptToUnlock('https://a.xyz')).toBe(false);
    now += 1;
    expect(mayPromptToUnlock('https://a.xyz')).toBe(true);
  });

  it('holds back only the origin whose prompt ended', () => {
    noteLockedPromptEnded('https://a.xyz');
    expect(mayPromptToUnlock('https://b.xyz')).toBe(true);
  });
});
