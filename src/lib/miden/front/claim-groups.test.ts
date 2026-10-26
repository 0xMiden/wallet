import { groupNotesForClaim } from './claim-groups';

const note = (id: string, faucetId: string) => ({ id, faucetId });

it('queues one batch per faucet, the native asset first and the rest in arrival order', () => {
  const notes = [
    note('usdc-1', 'usdc'),
    note('eth-1', 'eth'),
    note('miden-1', 'miden'),
    note('usdc-2', 'usdc'),
    note('miden-2', 'miden')
  ];
  expect(groupNotesForClaim(notes, 'miden')).toEqual([
    [note('miden-1', 'miden'), note('miden-2', 'miden')],
    [note('usdc-1', 'usdc'), note('usdc-2', 'usdc')],
    [note('eth-1', 'eth')]
  ]);
});

it('keeps arrival order while the native faucet is unknown', () => {
  expect(groupNotesForClaim([note('usdc-1', 'usdc'), note('miden-1', 'miden')], null)).toEqual([
    [note('usdc-1', 'usdc')],
    [note('miden-1', 'miden')]
  ]);
});

it('claims each note the predicate singles out on its own, after the native batch', () => {
  const notes = [note('eth-1', 'eth'), note('bridge-1', 'eth'), note('miden-1', 'miden'), note('bridge-2', 'eth')];
  expect(groupNotesForClaim(notes, 'miden', candidate => candidate.id.startsWith('bridge'))).toEqual([
    [note('miden-1', 'miden')],
    [note('eth-1', 'eth')],
    [note('bridge-1', 'eth')],
    [note('bridge-2', 'eth')]
  ]);
});
