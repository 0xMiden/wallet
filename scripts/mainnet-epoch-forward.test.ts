/** @jest-environment node */
import { runGuardedEpochForward, type EpochForwardHooks } from '../playwright/e2e/helpers/mainnet-epoch-ui';

function scenario() {
  const observed = { persisted: false, released: false, unspent: false, uncertain: false, cancelled: false };
  const hooks: EpochForwardHooks<string> = {
    enqueue: async () => {},
    inspect: async () => ({ rowId: 'row', noteId: 'note', reclaimHeight: 7200 }),
    persist: async () => {
      observed.persisted = true;
    },
    release: async () => {
      if (!observed.persisted) throw new Error('authorization evidence was not saved');
      observed.released = true;
    },
    settle: async () => 'settled',
    cancelQueued: async () => {
      observed.cancelled = true;
      return true;
    },
    unspent: async () => {
      observed.unspent = true;
    },
    uncertain: async () => {
      observed.uncertain = true;
    }
  };
  return { hooks, observed };
}

it('persists inspected collateral before releasing processing and returns actual settlement', async () => {
  const { hooks, observed } = scenario();
  await expect(runGuardedEpochForward(hooks)).resolves.toBe('settled');
  expect(observed).toEqual({ persisted: true, released: true, unspent: false, uncertain: false, cancelled: false });
});
it('never releases an unsafe request and clears authorization only after confirmed cancellation', async () => {
  const { hooks, observed } = scenario();
  hooks.inspect = async () => {
    throw new Error('unsafe collateral');
  };
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow('unsafe collateral');
  expect(observed).toEqual({ persisted: false, released: false, unspent: true, uncertain: false, cancelled: true });
});
it('does not declare non-submission when cancellation is ambiguous', async () => {
  const { hooks, observed } = scenario();
  hooks.inspect = async () => {
    throw new Error('unsafe collateral');
  };
  hooks.cancelQueued = async () => false;
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow();
  expect(observed.unspent).toBe(false);
  expect(observed.uncertain).toBe(true);
  expect(observed.released).toBe(false);
});
it('retains recovery authorization when cancelling a queued row itself fails', async () => {
  const { hooks, observed } = scenario();
  hooks.inspect = async () => {
    throw new Error('inspection failed');
  };
  hooks.cancelQueued = async () => {
    throw new Error('cancellation failed');
  };
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow();
  expect(observed.unspent).toBe(false);
  expect(observed.uncertain).toBe(true);
  expect(observed.released).toBe(false);
});
it('never releases a valid request when its checkpoint cannot be persisted', async () => {
  const { hooks, observed } = scenario();
  hooks.persist = async () => {
    throw new Error('disk full');
  };
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow('disk full');
  expect(observed.unspent).toBe(true);
  expect(observed.released).toBe(false);
});
it('treats a release error as potentially submitted rather than retrying or clearing authorization', async () => {
  const { hooks, observed } = scenario();
  hooks.release = async () => {
    observed.released = true;
    throw new Error('response lost');
  };
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow('response lost');
  expect(observed.uncertain).toBe(true);
  expect(observed.unspent).toBe(false);
  expect(observed.cancelled).toBe(false);
});
it('keeps the original authorization when settlement fails after release', async () => {
  const { hooks, observed } = scenario();
  hooks.settle = async () => {
    throw new Error('settlement pending');
  };
  await expect(runGuardedEpochForward(hooks)).rejects.toThrow('settlement pending');
  expect(observed.uncertain).toBe(true);
  expect(observed.unspent).toBe(false);
  expect(observed.cancelled).toBe(false);
});
