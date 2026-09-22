import type { GuardianHistoryCheckpoint } from './history';
import {
  clearGuardianHistoryCheckpoints,
  GUARDIAN_HISTORY_STORAGE_KEY,
  readGuardianHistoryState,
  saveGuardianHistoryCheckpoint
} from './history-storage';

const mockValues = new Map<string, object | string>();
let mockBeforeWrite: (() => Promise<void>) | undefined;
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockValues.get(key) ?? null,
  putToStorage: async (key: string, value: object | string) => {
    if (key === 'guardian_history_recovery_v1' && mockBeforeWrite) {
      const callback = mockBeforeWrite;
      mockBeforeWrite = undefined;
      await callback();
    }
    mockValues.set(key, value);
  }
}));
const checkpoint: GuardianHistoryCheckpoint = {
  id: 'test', accountId: 'account', network: 'testnet', operator: 'https://one',
  version: 1, completed: false, restored: 4, cursor: 'next', seenCursors: []
};

beforeEach(() => {
  mockValues.clear();
  mockBeforeWrite = undefined;
});

it('retains the page cursor across reads', async () => {
  const state = await readGuardianHistoryState();
  expect(await saveGuardianHistoryCheckpoint(state.generation, checkpoint)).toBe(true);
  expect((await readGuardianHistoryState()).checkpoints.test).toEqual(checkpoint);
});

it('rejects a checkpoint from a pass that predates an import', async () => {
  const state = await readGuardianHistoryState();
  await clearGuardianHistoryCheckpoints();
  expect(await saveGuardianHistoryCheckpoint(state.generation, checkpoint)).toBe(false);
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
});

it('does not undo an import marker when a late cursor write races the reset', async () => {
  const state = await readGuardianHistoryState();
  mockBeforeWrite = clearGuardianHistoryCheckpoints;
  await saveGuardianHistoryCheckpoint(state.generation, checkpoint);
  const after = await readGuardianHistoryState();
  expect(after.generation).not.toBe(state.generation);
  expect(after.checkpoints).toEqual({});
});

it('starts again when a saved checkpoint is malformed', async () => {
  mockValues.set(GUARDIAN_HISTORY_STORAGE_KEY, { generation: 'initial', checkpoints: { test: { cursor: 12 } } });
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
});
