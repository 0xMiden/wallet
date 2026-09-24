import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'scripts/badge-data.mjs');

function run(...args: string[]) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'badge-data-'));
}

function writeJson(path: string, value: unknown): string {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function shardsDir(counts: number[]): string {
  const dir = join(tempDir(), 'coverage-shards');
  counts.forEach((n, i) => {
    mkdirSync(join(dir, `coverage-shard-${i + 1}`), { recursive: true });
    writeJson(join(dir, `coverage-shard-${i + 1}`, 'test-count.json'), { numTotalTests: n });
  });
  return dir;
}

function summary(pct: number): string {
  return writeJson(join(tempDir(), 'coverage-summary.json'), { total: { lines: { pct } } });
}

describe('badge-data count', () => {
  it('reduces a Jest results file to its test count', () => {
    const dir = tempDir();
    const results = writeJson(join(dir, 'jest-results.json'), {
      numTotalTests: 42,
      numPassedTests: 42,
      testResults: [{ name: '/abs/path/a.test.ts', message: 'x' }]
    });
    const out = join(dir, 'test-count.json');

    expect(run('count', results, out).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ numTotalTests: 42 });
  });

  it('rejects a results file without an integer count', () => {
    const dir = tempDir();
    const results = writeJson(join(dir, 'jest-results.json'), { numTotalTests: '42' });
    const res = run('count', results, join(dir, 'out.json'));

    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/numTotalTests/);
  });
});

describe('badge-data record', () => {
  it('sums three shards and records the merged line coverage', () => {
    const out = join(tempDir(), 'badge-data.json');

    expect(run('record', '3', summary(96.53), shardsDir([10, 20, 30]), out).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ lines: 96.53, tests: 60 });
  });

  it.each([
    ['two', [10, 20]],
    ['four', [10, 20, 30, 40]]
  ])('fails on %s shards when three are expected', (_label, counts) => {
    const res = run('record', '3', summary(96.53), shardsDir(counts), join(tempDir(), 'badge-data.json'));

    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/expected 3 shard/);
  });
});

describe('badge-data read', () => {
  it('prints fixed-format lines for a valid file', () => {
    const file = writeJson(join(tempDir(), 'badge-data.json'), { lines: 96.53, tests: 60 });
    const res = run('read', file);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('pct=96.5\ncount=60\n');
  });

  it.each([
    ['a command substitution in lines', { lines: '96"; $(touch /tmp/pwned); echo "', tests: 60 }, 'lines'],
    ['a command substitution in tests', { lines: 96.5, tests: '60"; $(touch /tmp/pwned); echo "' }, 'tests'],
    ['NaN lines', '{"lines": NaN, "tests": 60}', 'valid JSON'],
    ['a NaN string in lines', { lines: 'NaN', tests: 60 }, 'lines'],
    ['null lines', { lines: null, tests: 60 }, 'lines'],
    ['negative lines', { lines: -1, tests: 60 }, 'lines'],
    ['lines above 100', { lines: 101, tests: 60 }, 'lines'],
    ['a float test count', { lines: 96.5, tests: 1.5 }, 'tests'],
    ['a negative test count', { lines: 96.5, tests: -1 }, 'tests']
  ])('rejects %s and prints nothing', (_label, content, field) => {
    const res = run('read', writeJson(join(tempDir(), 'badge-data.json'), content));

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain(field);
  });
});

// Line-based, not a YAML parser: the repo declares no YAML dependency and these
// files use the plain block style this reads.
function workflowText(workflow: string): string {
  return readFileSync(resolve(repoRoot, '.github/workflows', workflow), 'utf8');
}

// The lines of one top-level job, from its `  <job>:` key to the next job key.
function jobText(workflow: string, job: string): string {
  const lines = workflowText(workflow).split('\n');
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) throw new Error(`no job ${job} in ${workflow}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function stepBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] | null = null;
  let indent = -1;
  for (const line of lines) {
    const start = /^(\s*)- /.exec(line);
    const lead = line.length - line.trimStart().length;
    if (start && current && start[1]!.length === indent) {
      blocks.push(current.join('\n'));
      current = null;
    } else if (current && line.trim() && lead < indent) {
      blocks.push(current.join('\n'));
      current = null;
    }
    if (!current && start && /^\s*- (name|uses|run|id):/.test(line)) {
      current = [];
      indent = start[1]!.length;
    }
    current?.push(line);
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

function runScripts(text: string): string[] {
  return stepBlocks(text).flatMap(block => {
    const lines = block.split('\n');
    const i = lines.findIndex(l => /^\s*(- )?run:/.test(l));
    if (i < 0) return [];
    const runIndent = lines[i]!.search(/run:/);
    const body = [lines[i]!];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() && l.length - l.trimStart().length <= runIndent) break;
      body.push(l);
    }
    return [body.join('\n')];
  });
}

describe('badge workflows', () => {
  it.each(['Record badge data', 'Upload badge data'])('pr.yml %s cannot fail the coverage gate', name => {
    const step = stepBlocks(workflowText('pr.yml')).find(b => new RegExp(`name: ${name}$`, 'm').test(b));

    expect(step).toBeDefined();
    expect(step).toMatch(/^\s*continue-on-error: true$/m);
  });

  // The exact count makes a step the line reader misses (and so never checks) fail here instead.
  it.each([
    ['coverage-badge.yml', 'coverage-badge.yml', null, 5],
    ['pr.yml job coverage', 'pr.yml', 'coverage', 1],
    ['pr.yml job coverage-gate', 'pr.yml', 'coverage-gate', 4]
  ])('%s interpolates no expression into its run scripts', (_label, workflow, job, count) => {
    const scripts = runScripts(job ? jobText(workflow, job) : workflowText(workflow));

    expect(scripts).toHaveLength(count);
    for (const body of scripts) expect(body).not.toContain('${{');
  });

  it('the coverage shards are exactly 1..N in the matrix, the gate and the merge step', () => {
    const matrix = /^\s*shard: \[([^\]]*)\]$/m.exec(jobText('pr.yml', 'coverage'));
    const gate = jobText('pr.yml', 'coverage-gate');
    const shardsEnv = /^\s*COVERAGE_SHARDS: (\d+)$/m.exec(gate);
    const merge = runScripts(gate).find(b => b.includes('scripts/merge-jest-coverage.mjs'));

    expect(matrix).not.toBeNull();
    expect(shardsEnv).not.toBeNull();
    expect(merge).toBeDefined();
    const shards = matrix![1]!.split(',').map(v => Number(v.trim()));
    const expected = Array.from({ length: shards.length }, (_, i) => i + 1);
    expect(shards).toEqual(expected);
    expect(Number(shardsEnv![1])).toBe(shards.length);
    expect([...merge!.matchAll(/coverage-shard-(\d+)\//g)].map(m => Number(m[1]))).toEqual(expected);
  });

  it('coverage-badge.yml records its source commit and skips with a notice when it has diverged', () => {
    const publish = stepBlocks(workflowText('coverage-badge.yml')).find(b => /name: Publish/.test(b));

    expect(publish).toBeDefined();
    expect(publish).toContain('--check-source');
    expect(publish).toMatch(/status=diverged\*?\)[^\n]*::notice::/);
    expect(publish).toMatch(/git add coverage\.json tests\.json source\.json$/m);
  });
});
