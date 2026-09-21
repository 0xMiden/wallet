import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'scripts/merge-jest-coverage.mjs');

function coverageFile(path: string, hits: number): Record<string, unknown> {
  return {
    [path]: {
      path,
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
      fnMap: {},
      branchMap: {},
      s: { '0': hits },
      f: {},
      b: {}
    }
  };
}

describe('merge-jest-coverage', () => {
  it('sums hits across shards and writes coverage-summary.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cov-merge-'));
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    writeFileSync(a, JSON.stringify(coverageFile('/tmp/one.ts', 1)));
    writeFileSync(b, JSON.stringify(coverageFile('/tmp/two.ts', 1)));

    execFileSync(process.execPath, [script, a, b], { cwd: repoRoot, encoding: 'utf8' });

    const summary = JSON.parse(readFileSync(resolve(repoRoot, 'coverage/coverage-summary.json'), 'utf8'));
    expect(summary.total.statements.covered).toBeGreaterThanOrEqual(2);
    expect(summary.total.statements.pct).toBe(100);
  });

  it('exits 2 when fewer than two shards are given', () => {
    try {
      execFileSync(process.execPath, [script, 'one.json'], { encoding: 'utf8' });
      throw new Error('expected exit 2');
    } catch (err) {
      expect((err as { status?: number }).status).toBe(2);
    }
  });
});
