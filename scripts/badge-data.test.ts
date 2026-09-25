import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BADGE_ARTIFACT } from './badge-source-run.mjs';

const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'scripts/badge-data.mjs');

function run(...args: string[]) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'badge-data-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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
    if (!current && start && /^\s*- [\w-]+:/.test(line)) {
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
    ['pr.yml job coverage', 'pr.yml', 'coverage', 2],
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
    expect(publish).toMatch(/^\s*printf '\{"sha":"%s"\}\\n' "\$SHA" > source\.json$/m);
    expect(publish).toMatch(/git add coverage\.json tests\.json source\.json$/m);
  });

  it('coverage-badge.yml runs one publish at a time and never cancels one', () => {
    expect(workflowText('coverage-badge.yml')).toMatch(
      /^concurrency:\n {2}group: badges\n {2}cancel-in-progress: false$/m
    );
  });

  // Every exit before the verdict line would also skip, so the order is what makes the skip unconditional.
  it('coverage-badge.yml reduces the source check to one verdict and exits unless it is true, before any checkout or push', () => {
    const publish = runScripts(workflowText('coverage-badge.yml')).find(b => b.includes('--check-source'));
    expect(publish).toBeDefined();
    const lines = publish!.split('\n').map(l => l.trim());
    const verdict = lines.findIndex(l => l === `verdict=$(printf '%s\\n' "$check" | sed -n 's/^publish=//p')`);
    const gate = lines.indexOf('if [ "$verdict" != true ]; then');
    const close = lines.findIndex((l, i) => i > gate && l === 'fi');
    const firstGit = lines.findIndex(l => /\bgit (checkout|push|commit)\b/.test(l));

    expect(lines.filter(l => l.includes('publish='))).toHaveLength(1);
    expect(verdict).toBeGreaterThan(-1);
    expect(gate).toBe(verdict + 1);
    expect(lines.slice(gate, close)).toContain('exit 0');
    expect(close).toBeLessThan(firstGit);
  });

  it.each([
    ['Find the pull request', 'badge-source-run.mjs "$REPO" "$SHA"'],
    ['Publish', 'badge-source-run.mjs --check-source "$REPO" "$SHA"']
  ])('coverage-badge.yml %s step turns an API failure into a warning with no publish', (name, call) => {
    const body = runScripts(workflowText('coverage-badge.yml')).find(b => b.includes(call));
    expect(body).toBeDefined();
    const lines = body!.split('\n').map(l => l.trim());
    const invoke = lines.findIndex(l => l.includes(call));
    const warn = lines.findIndex(l => /^if \[ "\$rc" -eq 1 \]; then echo "::warning::[^"]+"; exit 0; fi$/.test(l));
    const other = lines.indexOf('if [ "$rc" -ne 0 ]; then exit "$rc"; fi');
    const output = lines.findIndex(l => l.includes('$GITHUB_OUTPUT') || l.includes('verdict='));

    expect(lines[invoke]).toMatch(/\) \|\| rc=\$\?$/);
    expect(lines[invoke - 1]).toBe('rc=0');
    expect(warn).toBe(invoke + 1);
    expect(other).toBe(invoke + 2);
    expect(output).toBeGreaterThan(other);
  });

  it('pr.yml uploads only the badge data this run recorded, from the runner temp directory', () => {
    const steps = stepBlocks(jobText('pr.yml', 'coverage-gate'));
    const record = steps.find(b => /name: Record badge data$/m.test(b));
    const upload = steps.find(b => /name: Upload badge data$/m.test(b));

    expect(record).toMatch(/^\s*id: badge-data$/m);
    expect(record).toMatch(/ "\$RUNNER_TEMP\/badge-data\.json"$/m);
    expect(upload).toMatch(/^\s*if: steps\.badge-data\.outcome == 'success'$/m);
    expect(upload).toMatch(/^\s*path: \$\{\{ runner\.temp \}\}\/badge-data\.json$/m);
  });

  it('pr.yml counts shard tests in their own step, between the tests and the upload, that cannot fail the shard', () => {
    const coverage = jobText('pr.yml', 'coverage');
    const scripts = runScripts(coverage);
    const blocks = stepBlocks(coverage);
    const tests = blocks.findIndex(b => runScripts(b).some(r => r.includes('yarn test:coverage')));
    const count = blocks.findIndex(b => runScripts(b).some(r => r.includes('badge-data.mjs count')));
    const upload = blocks.findIndex(b => /uses: actions\/upload-artifact@/.test(b));

    expect(scripts.find(r => r.includes('yarn test:coverage'))).not.toContain('badge-data.mjs');
    expect(scripts.filter(r => r.includes('badge-data.mjs count'))).toHaveLength(1);
    expect(blocks[count]).toMatch(/^\s*continue-on-error: true$/m);
    expect(tests).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(tests);
    expect(upload).toBeGreaterThan(count);
  });

  // A failed-jobs rerun of the gate reads the shards from the earlier attempt, so they keep the default lifetime.
  it('pr.yml keeps the coverage shard artifacts for the default retention', () => {
    const upload = stepBlocks(jobText('pr.yml', 'coverage')).find(b => /uses: actions\/upload-artifact@/.test(b));

    expect(upload).toBeDefined();
    expect(upload).not.toMatch(/retention-days/);
  });

  it('coverage-badge.yml turns a failed download into a warning and gates validation on it', () => {
    const steps = stepBlocks(jobText('coverage-badge.yml', 'badge-data'));
    const index = steps.findIndex(b => /name: Download badge data$/m.test(b));
    expect(index).toBeGreaterThan(-1);
    const lines = runScripts(steps[index]!)[0]!
      .split('\n')
      .map(l => l.trim());
    const invoke = lines.findIndex(l => l.startsWith('gh run download '));

    expect(steps[index]).toMatch(/^\s*id: download$/m);
    expect(lines[invoke - 1]).toBe('rc=0');
    expect(lines[invoke]).toMatch(/ \|\| rc=\$\?$/);
    expect(lines[invoke + 1]).toMatch(/^if \[ "\$rc" -ne 0 \]; then echo "::warning::[^"]+"; exit 0; fi$/);
    expect(lines[invoke + 2]).toBe('echo "ok=true" >> "$GITHUB_OUTPUT"');
    const later = steps.slice(index + 1);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatch(/name: Validate badge data$/m);
    expect(later[0]).toMatch(/^\s*if: steps\.download\.outputs\.ok == 'true'$/m);
    expect(jobText('coverage-badge.yml', 'badge-data')).toMatch(
      /^ {6}ready: \$\{\{ steps\.data\.outcome == 'success' \}\}$/m
    );
  });

  // The artifact comes from the merged PR's own run, so the job that unpacks it holds no token that can push.
  it('coverage-badge.yml reads the artifact without write access and publishes without reading it', () => {
    const text = workflowText('coverage-badge.yml');
    const jobs = [...text.matchAll(/^ {2}([\w-]+):$/gm)].map(m => m[1]!);
    const reader = jobs.filter(j =>
      runScripts(jobText('coverage-badge.yml', j)).some(r => r.includes('gh run download'))
    );
    const writers = jobs.filter(j => /^ {6}contents: write$/m.test(jobText('coverage-badge.yml', j)));

    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(reader).toEqual(['badge-data']);
    expect(jobText('coverage-badge.yml', 'badge-data')).not.toMatch(/: write$/m);
    expect(stepBlocks(jobText('coverage-badge.yml', 'badge-data'))[0]).toMatch(
      /uses: actions\/checkout@v4\n\s*with:\n\s*persist-credentials: false$/
    );
    expect(writers).toEqual(['coverage-badge']);
    const publish = jobText('coverage-badge.yml', 'coverage-badge');
    for (const body of runScripts(publish)) expect(body).not.toMatch(/gh run download|badge-data\.mjs read/);
    expect(publish).toMatch(/^ {4}needs: badge-data$/m);
    expect(publish.match(/^\s*if: .*$/gm)).toEqual(["    if: needs.badge-data.outputs.ready == 'true'"]);
    expect(publish).not.toContain('steps.');
    expect(stepBlocks(publish)[0]).toMatch(/^\s*- uses: actions\/checkout@v4$/m);
    expect(stepBlocks(publish)[0]).not.toContain('persist-credentials');
    for (const name of ['PCT', 'COUNT']) {
      const values = publish.match(new RegExp(`^\\s*${name}: .*$`, 'gm'));
      expect(values).toHaveLength(2);
      for (const v of values!) expect(v.trim()).toBe(`${name}: \${{ needs.badge-data.outputs.${name.toLowerCase()} }}`);
    }
  });

  it('both workflows name the badge artifact as badge-source-run.mjs looks it up', () => {
    const upload = stepBlocks(jobText('pr.yml', 'coverage-gate')).find(b => /name: Upload badge data$/m.test(b));
    const download = runScripts(workflowText('coverage-badge.yml')).find(b => b.includes('gh run download'));

    expect(upload).toMatch(new RegExp(`^\\s*name: ${BADGE_ARTIFACT}$`, 'm'));
    expect(download).toContain(` --name ${BADGE_ARTIFACT} `);
  });

  it('the step reader opens a step on any key, so a step led by if: is checked too', () => {
    const expr = ['$', '{{ github.sha }}'].join('');
    const text = [
      '    steps:',
      '      - if: always()',
      `        run: echo ${expr}`,
      '      - env:',
      '          A: b',
      '        run: echo ok',
      '      - name: last',
      '        run: echo done'
    ].join('\n');

    expect(stepBlocks(text)).toHaveLength(3);
    expect(runScripts(text)).toEqual([`        run: echo ${expr}`, '        run: echo ok', '        run: echo done']);
  });
});
