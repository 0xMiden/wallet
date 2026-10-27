import { retireRecoveryNotes, type RecoveryRetirementContext } from './retirement';
import type { RecoveryEntry } from './types';

const note = { kind: 'note', id: 'note', provenance: 'input', noteFile: new Uint8Array([1]) } satisfies RecoveryEntry;
function context(): RecoveryRetirementContext & { saved: RecoveryEntry[][] } {
  const saved: RecoveryEntry[][] = [];
  return {
    saved,
    snapshot: {
      version: 1,
      sequence: 1,
      scope: { network: 'network', walletGeneration: 'wallet', sdkGeneration: 'sdk' },
      accounts: [{ accountId: 'account-a', nonce: '1', commitment: 'state' }],
      entries: [note]
    },
    reads: {
      identity: async () => ({ nullifier: 'exact', fromBlock: 10 }),
      header: async () => 'header',
      scan: async () => [{ nullifier: 'exact', block: 10 }]
    },
    deadline: Date.now() + 1000,
    assertCurrent: () => {},
    retain: async entries => {
      saved.push(entries);
    }
  };
}

it('Task4C1 retires a private body only after its exact positive canonical nullifier read', async () => {
  const input = context();
  expect(await retireRecoveryNotes(input)).toBe(1);
  expect(input.saved).toEqual([[]]);
});

it('Task4C3D primary consumption cannot discard an unresolved nested candidate', async () => {
  const input = context();
  const candidate = {
    id: 'expected-details',
    provenance: 'input',
    noteFile: new Uint8Array([2]),
    format: 'details'
  } satisfies import('./types').RecoveryNoteCandidate;
  input.snapshot.entries = [{ ...note, candidates: [candidate] }];
  let persisted = input.snapshot.entries;
  input.retain = async entries => {
    persisted = entries;
    input.saved.push(entries);
  };
  input.reads.identity = async material =>
    material.noteFile[0] === 1 ? { nullifier: 'exact', fromBlock: 10 } : undefined;
  expect(await retireRecoveryNotes(input)).toBe(0);
  expect(persisted).toContainEqual(expect.objectContaining({ noteFile: new Uint8Array([1]), candidates: [candidate] }));
});

it('Task4C3D canonical consumption may retire a family when every material proves the same nullifier', async () => {
  const input = context();
  input.snapshot.entries = [
    { ...note, candidates: [{ id: 'note', provenance: 'input', noteFile: new Uint8Array([2]) }] }
  ];
  expect(await retireRecoveryNotes(input)).toBe(1);
  expect(input.saved).toEqual([[]]);
});

it('Task4C1 retains private bodies for absence local consumed state and delivery acknowledgement', async () => {
  const input = context();
  input.reads.scan = async () => [];
  expect(await retireRecoveryNotes(input)).toBe(0);
  expect(input.saved[0]).toContainEqual(expect.objectContaining({ id: 'note', noteFile: new Uint8Array([1]) }));
});

it('Task4C1 rejects a wrong full nullifier or nonsensical committed block', async () => {
  for (const update of [
    { nullifier: 'wrong', block: 10 },
    { nullifier: 'exact', block: 11 }
  ]) {
    const input = context();
    input.reads.scan = async () => [update];
    expect(await retireRecoveryNotes(input)).toBe(0);
    expect(input.saved.flat().filter(entry => entry.kind === 'note')).toHaveLength(
      update.nullifier === 'wrong' ? 1 : 0
    );
  }
});

it('Task4C1 rejects retirement when the canonical header bracket changes', async () => {
  const input = context();
  let reads = 0;
  input.reads.header = async () => (++reads === 1 ? 'header' : 'changed');
  expect(await retireRecoveryNotes(input)).toBe(0);
  expect(input.saved).toEqual([]);
});

it('Task4C1 advances a negative scan cursor only after the bounded read fully verifies', async () => {
  const input = context();
  input.reads.scan = async () => [];
  await retireRecoveryNotes(input);
  expect(input.saved[0]?.[0]).toMatchObject({ scan: { nextBlock: 11, anchorBlock: 10, anchor: 'header' } });
  input.saved.length = 0;
  input.reads.scan = async () => {
    throw new Error('transport');
  };
  await retireRecoveryNotes(input).catch(() => {});
  expect(input.saved).toEqual([]);
});

it('Task4C1 prevents late writes and overlapping replacement scans after the read deadline', async () => {
  const input = context();
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let scans = 0;
  input.reads.scan = async () => {
    scans++;
    await gate;
    return [{ nullifier: 'exact', block: 10 }];
  };
  input.deadline = Date.now() + 30;
  const first = retireRecoveryNotes(input);
  await new Promise(resolve => setTimeout(resolve, 50));
  const replacement = context();
  replacement.reads.scan = async () => {
    scans++;
    return [{ nullifier: 'exact', block: 10 }];
  };
  const second = retireRecoveryNotes(replacement);
  release();
  await Promise.allSettled([first, second]);
  expect(scans).toBe(1);
  expect(input.saved).toEqual([]);
  expect(replacement.saved).toEqual([]);
});
