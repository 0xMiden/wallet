/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, 'render-dapp-matrix.mjs');
const TITLE = 'dApp custom requests - guardian account';

type Cell = {
  id: string;
  verdict: string;
  knownBugs?: string[];
  staleKnownBugs?: string[];
  needs?: string;
  error?: string;
};

function records(cells: Cell[], extra: { infra?: string; title?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dapp-cells-'));
  writeFileSync(
    join(dir, 'writes-guardian-X.json'),
    JSON.stringify({
      part: 'writes',
      axis: 'guardian',
      journey: 'X',
      testTitle: extra.title ?? TITLE,
      cells: cells.map(cell => ({
        knownBugs: [],
        staleKnownBugs: [],
        durationMs: 1_000,
        finishedAt: '2026-10-09T00:00:00Z',
        ...cell
      }))
    })
  );
  if (extra.infra) writeFileSync(join(dir, 'INFRA_ABORT'), extra.infra);
  return dir;
}

function results(titles: string[], errors: Array<{ message: string }> = []): string {
  const file = join(mkdtempSync(join(tmpdir(), 'dapp-results-')), 'results.json');
  const suites =
    titles.length === 0
      ? []
      : [
          {
            title: 'custom-requests.spec.ts',
            specs: titles.map(title => ({ title, tests: [{ results: [{ status: 'failed' }] }] })),
            suites: []
          }
        ];
  writeFileSync(file, JSON.stringify({ suites, errors }));
  return file;
}

const gate = (dir: string, resultsFile: string) =>
  spawnSync(process.execPath, [script, '--gate', dir, resultsFile], { encoding: 'utf8' });

describe('render-dapp-matrix', () => {
  it('renders each cell with the spec verdict text', () => {
    const out = spawnSync(
      process.execPath,
      [
        script,
        records([
          { id: 'X1', verdict: 'fail-known', knownBugs: ['K3', 'K4'] },
          { id: 'X7', verdict: 'pass' },
          { id: 'X11', verdict: 'blocked-needs', needs: 'X1' }
        ])
      ],
      { encoding: 'utf8' }
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('| X1 | fail (K3, K4) |');
    expect(out.stdout).toContain('| X7 | pass |');
    expect(out.stdout).toContain('| X11 | blocked (needs X1) |');
  });

  it('passes the gate when every failure is a registered known bug, or blocked behind one', () => {
    const dir = records([
      { id: 'W3', verdict: 'fail-known', knownBugs: ['K2'] },
      { id: 'N6', verdict: 'blocked-needs', needs: 'W3' },
      { id: 'X7', verdict: 'pass' }
    ]);
    const run = gate(dir, results([TITLE]));
    expect([run.status, run.stderr]).toEqual([0, '']);
  });

  it.each([
    ['fail-new', { id: 'X1', verdict: 'fail-new', error: 'boom' }, 'X1: fail (new): boom'],
    ['harness-fault', { id: 'X1', verdict: 'harness-fault' }, 'X1: harness-fault'],
    ['not-run', { id: 'X1', verdict: 'not-run' }, 'X1: not-run'],
    ['blocked-state', { id: 'X1', verdict: 'blocked-state' }, 'X1: blocked (state)'],
    [
      'blocked-infra from a failed node request, which writes no INFRA_ABORT',
      { id: 'X1', verdict: 'blocked-infra', error: 'ChainUnavailable: chainNote failed 3 times' },
      'X1: blocked (infrastructure): ChainUnavailable'
    ],
    ['known-now-passing', { id: 'X1', verdict: 'known-now-passing', staleKnownBugs: ['K3'] }, 'X1: known-now-passing'],
    [
      'a stale entry on a failing cell',
      { id: 'X1', verdict: 'fail-known', knownBugs: ['K4'], staleKnownBugs: ['K3'] },
      'registry lists K3'
    ]
  ])('fails the gate on %s', (_name, cell, problem) => {
    const run = gate(records([cell]), results([TITLE]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(problem);
  });

  it('fails the gate on a cell blocked behind something that is not a known bug', () => {
    const run = gate(
      records([
        { id: 'W3', verdict: 'fail-new' },
        { id: 'N6', verdict: 'blocked-needs', needs: 'W3' }
      ]),
      results([TITLE])
    );
    expect(run.stderr).toContain('N6: blocked behind W3, which is not a known bug');
  });

  it('fails the gate on a test that left no records', () => {
    const run = gate(
      records([{ id: 'X1', verdict: 'pass' }]),
      results([TITLE, 'dApp custom requests - offchain account'])
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no cell records for "dApp custom requests - offchain account"');
  });

  it('fails the gate when Playwright wrote no report', () => {
    const run = gate(records([{ id: 'X1', verdict: 'pass' }]), '/nonexistent/results.json');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no Playwright results.json');
  });

  // Both are Playwright 1.61.0's reports of a run that stopped before any test: no suites, one top-level error.
  it.each([
    [
      'a spec that fails to load',
      "Error: Cannot find module './dapp-writes'\nRequire stack:\n- custom-requests.spec.ts",
      "Playwright: Error: Cannot find module './dapp-writes'"
    ],
    ['a --grep that selects no test', 'Error: No tests found', 'Playwright: Error: No tests found']
  ])('fails the gate on %s', (_name, message, problem) => {
    const run = gate(records([]), results([], [{ message }]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(problem);
    expect(run.stderr).not.toContain('Require stack');
  });

  it('fails the gate with one infrastructure line after a failed faucet grant', () => {
    const run = gate(
      records([{ id: 'X1', verdict: 'blocked-infra' }], { infra: 'Public faucet answered 502' }),
      results([TITLE])
    );
    expect(run.status).toBe(1);
    expect(run.stderr.split('\n')[0]).toBe('infrastructure: Public faucet answered 502');
  });
});
