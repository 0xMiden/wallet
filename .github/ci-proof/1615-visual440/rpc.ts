import { USDCX_MIN_BURN_SLOT } from '../../../src/lib/usdcx/protocol';

interface Proof {
  getStorageSlotValue: (slot: string) => { toFelts: () => { asInt: () => bigint }[] };
}

interface Attempt {
  account: string;
  state: 'pending' | 'resolved' | 'rejected';
}

const attempts: Attempt[] = [];
const slotReads: string[] = [];
const forbiddenCalls: string[] = [];
let resolvePending: ((proof: Proof) => void) | undefined;
const rejectReads = new URLSearchParams(location.hash.split('?')[1]).get('fixtureRead') === 'reject';

export function forbidden(name: string): never {
  forbiddenCalls.push(name);
  throw new Error(`Forbidden visual fixture action: ${name}`);
}

export function readWithOwnRpcClient<T>(
  read: (rpc: { getAccountProof: (account: { toString: () => string }) => Promise<Proof> }) => Promise<T>
): Promise<T> {
  return read({
    getAccountProof: account => {
      const attempt: Attempt = { account: account.toString(), state: 'pending' };
      attempts.push(attempt);
      if (rejectReads) {
        attempt.state = 'rejected';
        return Promise.reject(new Error('fixture minimum proof rejected'));
      }
      if (resolvePending) return Promise.reject(new Error('Unexpected duplicate pending proof'));
      return new Promise<Proof>(resolve => {
        resolvePending = proof => {
          attempt.state = 'resolved';
          resolve(proof);
        };
      });
    }
  });
}

const api = {
  snapshot: () => ({
    attempts: attempts.map(attempt => ({ ...attempt })),
    slotReads: [...slotReads],
    forbiddenCalls: [...forbiddenCalls]
  }),
  resolveEight: () => {
    if (!resolvePending || attempts.length !== 1 || attempts[0]?.state !== 'pending') {
      throw new Error('Expected exactly one unresolved real minimum read');
    }
    resolvePending({
      getStorageSlotValue: slot => {
        slotReads.push(slot);
        if (slot !== USDCX_MIN_BURN_SLOT) throw new Error(`Unexpected proof slot: ${slot}`);
        return { toFelts: () => [{ asInt: () => 8_000_000n }] };
      }
    });
  }
};

declare global {
  interface Window {
    __MINIMUM_VISUAL__: typeof api;
    __MINIMUM_SDK_READY__?: boolean;
  }
}

window.__MINIMUM_VISUAL__ = api;
