/**
 * Tests for `lib/miden/back/dapp-locked.ts` against the real store and its gate.
 */
import { MidenDAppErrorType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { isWalletLockedError, lockedRefusal, WALLET_LOCKED_REFUSAL } from './dapp-locked';
import { assertUnlocked, inited, store } from './store';

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
