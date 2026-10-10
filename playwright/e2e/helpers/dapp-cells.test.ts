/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DappCellRunner,
  HarnessFault,
  InfrastructureFault,
  deadlineIn,
  infraAborted,
  isInfrastructureFailure,
  judgeCell,
  markInfraAbort,
  ranClean,
  type CellRecord,
  type CellSpec,
  type CellVerdict,
  type Deadline,
  type JourneyRecord
} from './dapp-cells';
import type { KnownBug, KnownBugRegistry } from './dapp-known-bugs';

const KX: KnownBug = {
  id: 'KX',
  title: 'test bug',
  tracking: 'none',
  cells: { C1: ['offchain'] },
  signature: ({ source, evidence }) => source === 'hard' && evidence.stage === 'creating-proposal'
};
const KS: KnownBug = {
  id: 'KS',
  title: 'soft test bug',
  tracking: 'none',
  cells: { C1: ['offchain'] },
  signature: ({ source, evidence }) => source === 'soft' && evidence.previewSimulationFailed === true
};
const registry = (bugs: KnownBug[]): KnownBugRegistry => ({
  bugsFor: (cellId, axis) => bugs.filter(bug => bug.cells[cellId]?.includes(axis))
});

const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dapp-cells-'));
const read = (file: string): JourneyRecord => JSON.parse(fs.readFileSync(file, 'utf8'));
const cellOf = (id: string, run: CellSpec<string>['run'], extra: Partial<CellSpec<string>> = {}): CellSpec<string> => ({
  id,
  budget: 'read',
  run,
  ...extra
});

function makeRunner(dir: string, bugs: KnownBug[] = [], declared = ['C1', 'C2', 'C3'], hooks = quietHooks()) {
  return new DappCellRunner<string>({
    part: 'core',
    axis: 'offchain',
    journey: 'S',
    testTitle: 'dApp test - offchain account',
    outDir: dir,
    declared,
    registry: registry(bugs),
    hooks,
    budgets: { read: 200, write: 200, long: 200 }
  });
}
function quietHooks() {
  const calls: string[] = [];
  return {
    calls,
    quiesce: async (cell: CellSpec<string>) => void calls.push(`quiesce:${cell.id}`),
    restore: async (cell: CellSpec<string>) => void calls.push(`restore:${cell.id}`)
  };
}

describe('judgeCell', () => {
  const base = { cellId: 'C1', axis: 'offchain' as const, softFailures: [], evidence: {} };

  it('passes a clean cell with no registered bug', () => {
    expect(judgeCell({ ...base, registry: registry([]) }).verdict).toBe('pass');
  });

  it('calls a clean cell with a registered bug known-now-passing and names the stale entry', () => {
    expect(judgeCell({ ...base, registry: registry([KX]) })).toEqual({
      verdict: 'known-now-passing',
      knownBugs: [],
      staleKnownBugs: ['KX']
    });
  });

  it('matches a failure to the registered signature, and only that failure', () => {
    const matching = judgeCell({
      ...base,
      registry: registry([KX]),
      hardError: new Error('SummaryAnchorMismatchError'),
      evidence: { stage: 'creating-proposal' }
    });
    expect([matching.verdict, matching.knownBugs]).toEqual(['fail-known', ['KX']]);
    const other = judgeCell({
      ...base,
      registry: registry([KX]),
      hardError: new Error('a different failure'),
      evidence: { stage: 'sending' }
    });
    expect([other.verdict, other.knownBugs]).toEqual(['fail-new', []]);
  });

  it('keeps a soft signature from explaining a hard failure', () => {
    const judged = judgeCell({
      ...base,
      registry: registry([KS]),
      hardError: new Error('boom'),
      evidence: { previewSimulationFailed: true }
    });
    expect(judged.verdict).toBe('fail-new');
  });

  it('records both a soft and a hard known bug in one run', () => {
    const judged = judgeCell({
      ...base,
      registry: registry([KX, KS]),
      hardError: new Error('anchor'),
      softFailures: [{ check: 'preview-verified', detail: 'declared view' }],
      evidence: { stage: 'creating-proposal', previewSimulationFailed: true }
    });
    expect([judged.verdict, judged.knownBugs, judged.staleKnownBugs]).toEqual(['fail-known', ['KS', 'KX'], []]);
  });

  it('turns an unexplained soft failure into a new failure', () => {
    const judged = judgeCell({ ...base, registry: registry([]), softFailures: [{ check: 'x', detail: 'y' }] });
    expect(judged.verdict).toBe('fail-new');
  });

  it('separates harness faults and infrastructure from wallet verdicts', () => {
    expect(judgeCell({ ...base, registry: registry([KX]), hardError: new HarnessFault('page threw') }).verdict).toBe(
      'harness-fault'
    );
    expect(judgeCell({ ...base, registry: registry([]), hardError: new InfrastructureFault('faucet') }).verdict).toBe(
      'blocked-infra'
    );
  });
});

describe('ranClean', () => {
  const recordOf = (verdict: CellVerdict): CellRecord => ({
    id: 'C1',
    verdict,
    knownBugs: [],
    staleKnownBugs: [],
    durationMs: 0,
    finishedAt: ''
  });

  it('holds only for a cell that ran without a failure', () => {
    expect(ranClean(recordOf('pass'))).toBe(true);
    expect(ranClean(recordOf('known-now-passing'))).toBe(true);
    expect(ranClean(recordOf('fail-known'))).toBe(false);
    expect(ranClean(recordOf('harness-fault'))).toBe(false);
    expect(ranClean(undefined)).toBe(false);
  });
});

describe('isInfrastructureFailure', () => {
  it('counts an infrastructure fault and a failure that names the public faucet, directly or as a cause', () => {
    const faucet = Object.assign(new Error('Public faucet grant failed: TypeError: fetch failed'), {
      name: 'PublicFaucetError'
    });
    expect(isInfrastructureFailure(new InfrastructureFault('operator settle timed out'))).toBe(true);
    expect(isInfrastructureFailure(faucet)).toBe(true);
    expect(isInfrastructureFailure(new Error('deploy_and_fund failed', { cause: faucet }))).toBe(true);
    expect(
      isInfrastructureFailure(
        new Error(
          'Faucet 0xabc never received its funding note from public faucet https://faucet-api.testnet.miden.io; ' +
            'its vault still holds none of the fee asset after 10 attempts.'
        )
      )
    ).toBe(true);
  });

  it('leaves a wallet claim failure and a harness fault to the cell verdicts', () => {
    expect(
      isInfrastructureFailure(
        new Error(
          'claimAllNotes: the Pending list did not drain within 180000ms after 3 lap(s); last sample: {"count":1}; ' +
            'Accept All clicked 2 time(s)'
        )
      )
    ).toBe(false);
    expect(isInfrastructureFailure(new HarnessFault('journey hooks ran before the journey started'))).toBe(false);
  });
});

describe('deadlineIn', () => {
  it('rejects work that outlives the budget and passes work that does not', async () => {
    await expect(deadlineIn(20, 'C1').race(new Promise(() => undefined), 'never settles')).rejects.toThrow(
      'C1: never settles outlived the cell budget'
    );
    await expect(deadlineIn(1_000, 'C1').race(Promise.resolve(7), 'quick')).resolves.toBe(7);
  });
});

describe('DappCellRunner', () => {
  it('records every declared cell as not-run before anything runs', () => {
    const dir = outDir();
    const runner = makeRunner(dir);
    expect(read(runner.file).cells.map(cell => [cell.id, cell.verdict])).toEqual([
      ['C1', 'not-run'],
      ['C2', 'not-run'],
      ['C3', 'not-run']
    ]);
  });

  it('quiesces before and restores after each cell, and records the verdict at once', async () => {
    const dir = outDir();
    const hooks = quietHooks();
    const runner = makeRunner(dir, [], ['C1', 'C2'], hooks);
    await runner.run(cellOf('C1', async () => undefined));
    expect(hooks.calls).toEqual(['quiesce:C1', 'restore:C1']);
    expect(read(runner.file).cells.map(cell => cell.verdict)).toEqual(['pass', 'not-run']);
  });

  it('fails a cell that outlives its budget and still restores', async () => {
    const dir = outDir();
    const hooks = quietHooks();
    const runner = makeRunner(dir, [], ['C1'], hooks);
    const record = await runner.run(cellOf('C1', ctx => ctx.deadline.race(new Promise<void>(() => undefined), 'wait')));
    expect([record.verdict, record.error]).toEqual([
      'fail-new',
      'CellDeadlineExceeded: C1: wait outlived the cell budget'
    ]);
    expect(hooks.calls).toContain('restore:C1');
  });

  it('blocks every later cell once the state cannot be restored', async () => {
    const dir = outDir();
    const hooks = quietHooks();
    hooks.restore = async (cell: CellSpec<string>) => {
      hooks.calls.push(`restore:${cell.id}`);
      throw new Error('wallet stayed locked');
    };
    const runner = makeRunner(dir, [], ['C1', 'C2'], hooks);
    await runner.run(cellOf('C1', async () => undefined));
    const second = await runner.run(cellOf('C2', async () => undefined));
    expect(second.verdict).toBe('blocked-state');
    expect(hooks.calls).not.toContain('quiesce:C2');
  });

  it('blocks a cell whose prerequisite did not pass', async () => {
    const dir = outDir();
    const runner = makeRunner(dir);
    await runner.run(
      cellOf('C1', async () => {
        throw new Error('broken');
      })
    );
    const needsCell = await runner.run(cellOf('C2', async () => undefined, { needs: ['C1'] }));
    expect([needsCell.verdict, needsCell.needs]).toEqual(['blocked-needs', 'C1']);
  });

  it('records an infrastructure fault in the quiesce as blocked by infrastructure, not by state', async () => {
    const dir = outDir();
    const hooks = quietHooks();
    hooks.quiesce = async () => {
      throw new InfrastructureFault('Guardian settle timed out against a hosted operator');
    };
    const runner = makeRunner(dir, [], ['C1', 'C2'], hooks);
    expect((await runner.run(cellOf('C1', async () => undefined))).verdict).toBe('blocked-infra');
    expect(infraAborted(dir)).toContain('Guardian settle timed out');
  });

  it('writes INFRA_ABORT on an infrastructure fault and blocks every later cell', async () => {
    const dir = outDir();
    const runner = makeRunner(dir);
    await runner.run(
      cellOf('C1', async () => {
        throw new InfrastructureFault('Public faucet answered 502');
      })
    );
    expect(infraAborted(dir)).toContain('Public faucet answered 502');
    expect((await runner.run(cellOf('C2', async () => undefined))).verdict).toBe('blocked-infra');
  });

  it('blocks a whole journey that starts after an INFRA_ABORT', () => {
    const dir = outDir();
    markInfraAbort(dir, 'faucet down');
    const runner = makeRunner(dir);
    runner.blockAll('faucet down');
    expect(new Set(read(runner.file).cells.map(cell => cell.verdict))).toEqual(new Set(['blocked-infra']));
  });

  it('finishes quietly when every cell passed and loudly otherwise', async () => {
    const passing = makeRunner(outDir(), [], ['C1']);
    await passing.run(cellOf('C1', async () => undefined));
    expect(() => passing.finish()).not.toThrow();
    const failing = makeRunner(outDir(), [], ['C1', 'C2']);
    await failing.run(cellOf('C1', async () => undefined));
    expect(() => failing.finish()).toThrow('1 of 2 cells did not pass:\n  C2 not-run');
  });

  it('hands each quiesce the record of the last cell whose body ran', async () => {
    const seen: string[] = [];
    const hooks = {
      ...quietHooks(),
      quiesce: async (cell: CellSpec<string>, _deadline?: Deadline, previous?: CellRecord) =>
        void seen.push(`${cell.id} after ${previous === undefined ? 'nothing' : `${previous.id} ${previous.verdict}`}`)
    };
    const runner = makeRunner(outDir(), [], ['C1', 'C2', 'C3', 'C4'], hooks);
    await runner.run(cellOf('C1', async () => undefined));
    await runner.run(cellOf('C2', async () => undefined, { needs: ['C4'] }));
    await runner.run(
      cellOf('C3', async () => {
        throw new Error('boom');
      })
    );
    await runner.run(cellOf('C4', async () => undefined));
    expect(seen).toEqual(['C1 after nothing', 'C3 after C1 pass', 'C4 after C3 fail-new']);
  });

  it('refuses a cell that was not declared', async () => {
    const runner = makeRunner(outDir(), [], ['C1']);
    await expect(runner.run(cellOf('C9', async () => undefined))).rejects.toThrow('cell C9 was not declared');
  });
});
