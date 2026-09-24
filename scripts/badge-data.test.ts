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
function stepBlocks(workflow: string): string[] {
  const lines = readFileSync(resolve(repoRoot, '.github/workflows', workflow), 'utf8').split('\n');
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

function runScripts(workflow: string): string[] {
  return stepBlocks(workflow).flatMap(block => {
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
    const step = stepBlocks('pr.yml').find(b => new RegExp(`name: ${name}$`, 'm').test(b));

    expect(step).toBeDefined();
    expect(step).toMatch(/^\s*continue-on-error: true$/m);
  });

  it('coverage-badge.yml interpolates no expression into a run script', () => {
    const scripts = runScripts('coverage-badge.yml');

    expect(scripts.length).toBeGreaterThan(3);
    for (const body of scripts) expect(body).not.toContain('${{');
  });
});
