import type { GuardianHistoryCheckpoint } from './history';
import {
  clearGuardianHistoryCheckpoints,
  GUARDIAN_HISTORY_STORAGE_KEY,
  readGuardianHistoryGeneration,
  readGuardianHistoryState,
  saveGuardianHistoryCheckpoint
} from './history-storage';

const mockValues = new Map<string, object | string>();
const mockTurnTails = new Map<string, Promise<void>>();
let mockBeforeGenerationWrite: (() => Promise<void>) | undefined;
jest.mock('lib/miden/front/storage', () => ({
  fetchFromStorage: async (key: string) => mockValues.get(key) ?? null,
  inStorageTurn: (name: string, operation: () => Promise<unknown>) => {
    const turn = (mockTurnTails.get(name) ?? Promise.resolve()).then(operation);
    mockTurnTails.set(
      name,
      turn.then(
        () => undefined,
        () => undefined
      )
    );
    return turn;
  },
  putToStorage: async (key: string, value: object | string) => {
    if (key === 'guardian_history_generation_v1' && mockBeforeGenerationWrite) {
      const callback = mockBeforeGenerationWrite;
      mockBeforeGenerationWrite = undefined;
      await callback();
    }
    mockValues.set(key, value);
  }
}));
const checkpoint: GuardianHistoryCheckpoint = {
  id: 'test',
  accountId: 'account',
  network: 'testnet',
  operator: 'https://one',
  version: 1,
  completed: false,
  restored: 4,
  cursor: 'next',
  seenCursors: []
};

beforeEach(() => {
  mockValues.clear();
  mockTurnTails.clear();
  mockBeforeGenerationWrite = undefined;
});

it('retains the page cursor across reads', async () => {
  const state = await readGuardianHistoryState();
  expect(await saveGuardianHistoryCheckpoint(state.generation, checkpoint)).toBe(true);
  expect((await readGuardianHistoryState()).checkpoints.test).toEqual(checkpoint);
});

it('retains the terminal marker across reads', async () => {
  const state = await readGuardianHistoryState();
  const terminal = { ...checkpoint, failure: 'invalid-data' as const, invalidDataPasses: 3, terminal: true };
  expect(await saveGuardianHistoryCheckpoint(state.generation, terminal)).toBe(true);
  expect((await readGuardianHistoryState()).checkpoints.test).toEqual(terminal);
});

it('retains the deferred failure count across reads', async () => {
  const state = await readGuardianHistoryState();
  const deferred = { ...checkpoint, failure: 'network' as const, deferredFailurePasses: 2 };
  expect(await saveGuardianHistoryCheckpoint(state.generation, deferred)).toBe(true);
  expect((await readGuardianHistoryState()).checkpoints.test).toEqual(deferred);
});

it('retains the aborted decode count across reads', async () => {
  const state = await readGuardianHistoryState();
  const aborted = { ...checkpoint, failure: 'network' as const, abortedDecodePasses: 4 };
  expect(await saveGuardianHistoryCheckpoint(state.generation, aborted)).toBe(true);
  expect((await readGuardianHistoryState()).checkpoints.test).toEqual(aborted);
});

it('rejects a checkpoint from a pass that predates an import', async () => {
  const state = await readGuardianHistoryState();
  await clearGuardianHistoryCheckpoints();
  expect(await saveGuardianHistoryCheckpoint(state.generation, checkpoint)).toBe(false);
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
});

it('serializes generation initialization and checkpoint reset in separate turns', async () => {
  let beginWrite!: () => void;
  let releaseWrite!: () => void;
  const writing = new Promise<void>(resolve => {
    beginWrite = resolve;
  });
  const writeGate = new Promise<void>(resolve => {
    releaseWrite = resolve;
  });
  mockBeforeGenerationWrite = async () => {
    beginWrite();
    await writeGate;
  };

  const initial = readGuardianHistoryGeneration();
  await writing;
  const reset = clearGuardianHistoryCheckpoints();
  releaseWrite();
  const [initialGeneration] = await Promise.all([initial, reset]);
  const after = await readGuardianHistoryState();
  expect(after.generation).not.toBe(initialGeneration);
  expect(after.checkpoints).toEqual({});
});

it('treats a missing generation as a wipe and keeps the fresh one it stores', async () => {
  const first = await readGuardianHistoryState();
  expect(first.generation).not.toBe('initial');
  expect((await readGuardianHistoryState()).generation).toBe(first.generation);
  mockValues.delete('guardian_history_generation_v1');
  expect((await readGuardianHistoryState()).generation).not.toBe(first.generation);
  expect(await saveGuardianHistoryCheckpoint(first.generation, checkpoint)).toBe(false);
});

it('reads the stored generation, storing a fresh one when the key is missing', async () => {
  mockValues.set('guardian_history_generation_v1', 'stored');
  expect(await readGuardianHistoryGeneration()).toBe('stored');
  mockValues.delete('guardian_history_generation_v1');
  const fresh = await readGuardianHistoryGeneration();
  expect(fresh).not.toBe('stored');
  expect(mockValues.get('guardian_history_generation_v1')).toBe(fresh);
  expect((await readGuardianHistoryState()).generation).toBe(fresh);
  expect(await readGuardianHistoryGeneration()).toBe(fresh);
});

it('starts again when a saved checkpoint is malformed', async () => {
  mockValues.set(GUARDIAN_HISTORY_STORAGE_KEY, { generation: 'initial', checkpoints: { test: { cursor: 12 } } });
  expect((await readGuardianHistoryState()).checkpoints).toEqual({});
});
