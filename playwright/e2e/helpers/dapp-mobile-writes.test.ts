/**
 * @jest-environment node
 */
import { deadlineIn, type CellContext } from './dapp-cells';
import { ownRowsBesides, pairNotes, timed } from './dapp-mobile-writes';
import type { OutputNoteView } from '../test-dapp/protocol';

jest.mock('@playwright/test', () => ({ expect: jest.fn() }));

describe('rows a write did not account for', () => {
  const rows = [
    { id: 'base', type: 'send', accountId: 'mtst1a' },
    { id: 'mine', type: 'send', accountId: 'mtst1a' },
    { id: 'stranger', type: 'consume', accountId: 'mtst1a', secondaryAccountId: 'mtst1stranger' },
    { id: 'from-b', type: 'consume', accountId: 'mtst1a', secondaryAccountId: 'mtst1b' },
    { id: 'other-account', type: 'send', accountId: 'mtst1other' }
  ];

  it("leaves out the baseline, the write itself, a stranger's consume and another account", () => {
    const left = ownRowsBesides('mtst1a', ['mtst1a', 'mtst1b'], { rowIds: ['base'], capturedAtSec: 0 }, ['mine'], rows);
    expect(left.map(row => row.id)).toEqual(['from-b']);
  });
});

describe('pairing output notes', () => {
  const note = (noteId: string, noteType: 'public' | 'private'): OutputNoteView => ({
    noteId,
    noteType,
    bytesB64: '',
    isSameSdkNote: true,
    script: 'p2id'
  });

  it('pairs a dApp-built note by id and a wallet-built one by type', () => {
    const pairs = pairNotes(
      [{ noteType: 'public' }, { noteId: '0xAB', noteType: 'private' }],
      [note('0xcd', 'public'), note('0xab', 'private')]
    );
    expect(pairs.map(([expected, actual]) => [expected.noteId ?? 'by type', actual.noteId])).toEqual([
      ['0xAB', '0xab'],
      ['by type', '0xcd']
    ]);
  });

  it('refuses an expected note no output matches', () => {
    expect(() => pairNotes([{ noteId: '0x01', noteType: 'public' }], [note('0x02', 'public')])).toThrow(
      'no output note left to pair'
    );
  });
});

describe('step durations', () => {
  it('records how long each step took, a failed one too, and keeps the steps before it', async () => {
    const ctx: CellContext = { deadline: deadlineIn(10_000, 'cell'), evidence: {}, softFail: () => undefined };
    await timed(ctx, 'first', async () => 1);
    await expect(
      timed(ctx, 'second', async () => {
        throw new Error('the step failed');
      })
    ).rejects.toThrow('the step failed');
    expect(Object.keys(ctx.evidence.stepDurationsMs ?? {})).toEqual(['first', 'second']);
    expect(Object.values(ctx.evidence.stepDurationsMs ?? {}).every(ms => ms >= 0)).toBe(true);
  });
});
