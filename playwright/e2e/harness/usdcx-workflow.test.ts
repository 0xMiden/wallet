/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * E2E USDCx spends from one funded Arc key, the repository secret USDCX_HARNESS_ARC_KEY. These pin what keeps that key
 * safe and single-use: which step reads the secret, the file it writes, which runs may overlap, which suites run after
 * a red one and what is uploaded. The workflow is read as text in the plain shape it is written in.
 */
const REPO_ROOT = resolve(__dirname, '../../..');
const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/e2e-usdcx.yml'), 'utf8');
const SECRET = 'USDCX_HARNESS_ARC_KEY';
const WRITE_STEP = 'Write the CI harness Arc key';
const RUNNER = 'node scripts/e2e-real.mjs';

/** A top-level key's block: its content lines, comments left out. */
function topLevel(key: string): string[] {
  const lines = workflow.split('\n');
  const at = lines.indexOf(`${key}:`);
  if (at === -1) throw new Error(`no top-level ${key}:`);
  const next = lines.findIndex((line, index) => index > at && /^\S/.test(line));
  return lines
    .slice(at + 1, next === -1 ? lines.length : next)
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

const ARC_JOB = 'chrome-usdcx-arc';
const L2_JOB = 'chrome-usdcx-l2';

/** A job's lines, from its `  <id>:` line to the next line at that indent (a job or a comment above one). */
function jobBlock(id: string): string {
  const lines = workflow.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) throw new Error(`no job ${id}`);
  const next = lines.findIndex((line, index) => index > at && /^ {2}\S/.test(line));
  return lines.slice(at, next === -1 ? lines.length : next).join('\n');
}
/** A job's own key, read from the lines above its steps. */
const jobKey = (id: string, key: string): string | undefined =>
  new RegExp(`^ {4}${key}: (.+)$`, 'm').exec(jobBlock(id).split('\n    steps:\n')[0] ?? '')?.[1];
/** A job's steps, each from its `      - ` to the next one; a comment above a step ends the step before it. */
const stepsOf = (id: string): string[] => {
  const block = jobBlock(id);
  return block.slice(block.indexOf('\n    steps:\n') + '\n    steps:\n'.length).split(/\n(?= {6}- )/);
};
const steps = [...stepsOf(ARC_JOB), ...stepsOf(L2_JOB)];
const isNamed = (step: string, name: string): boolean =>
  step.split('\n').some(line => line.trim().replace(/^- /, '') === `name: ${name}`);
const runOf = (step: string): string | undefined => /^ {6}(?:- | {2})run: (.+)$/m.exec(step)?.[1];
const stepNamed = (id: string, name: string): string => {
  const found = stepsOf(id).filter(step => isNamed(step, name));
  if (found.length !== 1) throw new Error(`${found.length} steps named ${name} in ${id}`);
  return found[0]!;
};
const isSuite = (step: string): boolean => runOf(step)?.startsWith(RUNNER) === true;
/** A step without its comment lines, which belong to the step after it. */
const bare = (step: string): string =>
  step
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');

/** GitHub's Ubuntu runner: `~` is its home, and a relative path starts in the workspace. */
const RUNNER_HOME = '/home/runner';
const WORKSPACE = `${RUNNER_HOME}/work/wallet/wallet`;
const KEY_FILE = `${RUNNER_HOME}/.miden-e2e/arc-keys/harness.json`;
const GLOB = new Map([
  ['**', '.*'],
  ['*', '[^/]*'],
  ['?', '[^/]']
]);

/** Every entry of every `path:` input in a step, one per line of a block value. */
function pathEntries(step: string): string[] {
  const lines = step.split('\n');
  return lines.flatMap((line, at) => {
    const input = /^( +)path:(.*)$/.exec(line);
    if (input === null) return [];
    const indent = input[1] ?? '';
    const value = (input[2] ?? '').trim();
    if (!/^(?:[|>][+-]?)?$/.test(value)) return [value];
    const rest = lines.slice(at + 1);
    const end = rest.findIndex(next => next.trim() !== '' && !next.startsWith(`${indent} `));
    return rest
      .slice(0, end === -1 ? rest.length : end)
      .map(next => next.trim())
      .filter(Boolean);
  });
}

/**
 * Whether a path entry holds the key file: names it or a directory above it, the runner home and `/` among them, or is
 * a glob that matches one. Any `$` left after `~` and the workspace could name either, so it counts.
 */
function holdsKeyFile(entry: string): boolean {
  const value = entry.replace(/^(['"])(.*)\1$/, '$2');
  if (value.startsWith('!')) return false;
  const expanded = value
    .replace(/^~(?=\/|$)/, RUNNER_HOME)
    .replace(/^\$\{\{ *github\.workspace *\}\}(?=\/|$)/, WORKSPACE);
  if (expanded.includes('$')) return true;
  const absolute = posix.resolve(WORKSPACE, expanded).replace(/^\/(?:root|home\/[^/]+)(?=\/|$)/, RUNNER_HOME);
  const pattern = (absolute === '/' ? '' : absolute)
    .split(/(\*\*|\*|\?)/)
    .map(part => GLOB.get(part) ?? part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('');
  return new RegExp(`^${pattern}(?:/.*)?$`).test(KEY_FILE);
}

describe('E2E USDCx workflow', () => {
  it('runs after every push to main and by dispatch, and on nothing else', () => {
    expect(topLevel('on')).toEqual(['  push:', '    branches:', '      - main', '  workflow_dispatch:']);
  });

  it('queues every run, from any branch, on one fixed group and never cancels one in progress', () => {
    expect(topLevel('concurrency')).toEqual(['  group: usdcx-harness-arc-key', '  cancel-in-progress: false']);
  });

  it('is two jobs, the Arc suites then the L2 suites, each on a runner of its own', () => {
    expect(topLevel('jobs').filter(line => /^ {2}\S/.test(line))).toEqual([`  ${ARC_JOB}:`, `  ${L2_JOB}:`]);
  });

  it('reads one secret, once in each job, in the env of the step that writes the key file', () => {
    expect(workflow.match(/\bsecrets\./g)).toHaveLength(2);
    for (const job of [ARC_JOB, L2_JOB]) {
      const step = stepNamed(job, WRITE_STEP);
      expect(step).toContain(`\n        env:\n          ${SECRET}: \${{ secrets.${SECRET} }}\n`);
      expect(runOf(step)).toBe('node scripts/write-ci-harness-arc-key.mjs');
    }
    // No workflow or job env: every step would see it, the dependency install and the builds among them.
    expect(workflow).not.toMatch(/^ {0,4}env:/m);
  });

  it("gives the L2 job the Arc job's setup, step for step, through the key write", () => {
    const setup = (job: string) => {
      const list = stepsOf(job).map(bare);
      return list.slice(0, list.findIndex(step => isNamed(step, WRITE_STEP)) + 1);
    };
    expect(setup(L2_JOB)).toEqual(setup(ARC_JOB));
  });

  it('writes the key file 0600 in a 0700 directory, as the runner reads it, when that step runs', () => {
    const home = mkdtempSync(join(tmpdir(), 'usdcx-ci-home-'));
    const key = generatePrivateKey();
    const command = runOf(stepNamed(ARC_JOB, WRITE_STEP));
    if (command === undefined) throw new Error(`${WRITE_STEP} has no run line`);
    // stdin is /dev/null: Debian's bash sources /etc/bash.bashrc for a socket stdin (see linked-pr-injection.test.ts).
    const res = spawnSync('bash', ['-c', command], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, [SECRET]: key },
      timeout: 30_000
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).not.toContain(key.slice(2));
    const dir = join(home, '.miden-e2e', 'arc-keys');
    expect([statSync(join(dir, 'harness.json')).mode & 0o777, statSync(dir).mode & 0o777]).toEqual([0o600, 0o700]);
    expect(JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8'))).toEqual({
      role: 'harness',
      iso: expect.any(String),
      address: privateKeyToAccount(key).address,
      privateKey: key,
      walletAddress: ''
    });
  });

  it.each([ARC_JOB, L2_JOB])('writes the key after the dependency install and before the first suite, in %s', job => {
    const list = stepsOf(job);
    const installs = list.flatMap((step, index) =>
      /yarn install|\.\/\.github\/actions\/yarn-install/.test(step) ? [index] : []
    );
    const write = list.indexOf(stepNamed(job, WRITE_STEP));
    expect(installs).not.toHaveLength(0);
    expect(write).toBeGreaterThan(Math.max(...installs));
    expect(list.findIndex(isSuite)).toBeGreaterThan(write);
  });

  it('runs the three Arc suites in the Arc job in turn, with no key flag, no env, no if and no continue-on-error', () => {
    const suites = stepsOf(ARC_JOB).filter(isSuite);
    expect(suites.map(runOf)).toEqual([
      `${RUNNER} --suite usdcx-in`,
      `${RUNNER} --suite usdcx-burn`,
      `${RUNNER} --suite usdcx`
    ]);
    // A red suite can leave a payout or a deposit landing on the key inside the next one's payout window.
    for (const step of suites) expect(step).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
    expect(suites[0]).toMatch(/^ {8}id: usdcx_in$/m);
  });

  // usdcx-in-l2 spends from the key on all three chains and usdcx-burn-l2 proves each payout as the rise of that
  // balance from a read right before its burn: every deposit is mined before usdcx-in-l2's step ends, so order inside
  // the job suffices.
  it('runs usdcx-in-l2 then usdcx-burn-l2 in the L2 job, usdcx-burn-l2 after a red usdcx-in-l2 too but never after a failed setup step', () => {
    const [inL2, burnL2, ...rest] = stepsOf(L2_JOB).filter(isSuite);
    expect([runOf(inL2 ?? ''), runOf(burnL2 ?? ''), rest]).toEqual([
      `${RUNNER} --suite usdcx-in-l2`,
      `${RUNNER} --suite usdcx-burn-l2`,
      []
    ]);
    expect(inL2).not.toMatch(/^ {8}(env|if|continue-on-error):/m);
    expect(inL2).toMatch(/^ {8}id: usdcx_in_l2$/m);
    expect(burnL2?.match(/^ {8}(env|if|continue-on-error):.*$/gm)).toEqual([
      `        if: \${{ !cancelled() && steps.usdcx_in_l2.outcome != 'skipped' }}`
    ]);
  });

  // Its suites read Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia, where nothing an Arc suite leaves pending lands,
  // so it runs after a red Arc job, never in a cancelled run. Its own setup guards the key: a failed step there skips
  // usdcx-in-l2, which has no condition, and with it usdcx-burn-l2, so no L2 suite runs on a missing key file.
  it('starts the L2 job after the Arc job, red or green, but never in a cancelled run', () => {
    expect(jobKey(L2_JOB, 'needs')).toBe(ARC_JOB);
    expect(jobKey(L2_JOB, 'if')).toBe(`\${{ !cancelled() }}`);
    expect(jobBlock(ARC_JOB)).not.toMatch(/^ {4}outputs:/m);
  });

  it.each([
    [ARC_JOB, `\${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}`],
    [L2_JOB, `\${{ github.event_name == 'workflow_dispatch' && 355 || 325 }}`]
  ])('gives %s its own ceiling', (job, ceiling) => {
    expect(jobKey(job, 'timeout-minutes')).toBe(ceiling);
  });

  // A ceiling the repository sets itself: no E2E USDCx job gets more than 6 hours.
  it.each([ARC_JOB, L2_JOB])('keeps both of the ceilings of %s within the 360 minutes any E2E USDCx job gets', job => {
    const minutes = /&& (\d+) \|\| (\d+) \}\}$/
      .exec(jobKey(job, 'timeout-minutes') ?? '')
      ?.slice(1)
      .map(Number);
    expect(minutes).toHaveLength(2);
    for (const ceiling of minutes ?? []) expect(ceiling).toBeLessThanOrEqual(360);
  });

  it('uploads test-results after each suite that ran, whatever it did, failing no step after it, and never the key or the lock', () => {
    const uploads = steps.filter(step => step.includes('uses: actions/upload-artifact@'));
    expect(uploads).toHaveLength(5);
    for (const upload of uploads) {
      const id = /^ {8}if: always\(\) && steps\.(\w+)\.outcome != 'skipped'$/m.exec(upload)?.[1];
      expect(steps[steps.indexOf(upload) - 1]).toMatch(new RegExp(`^ {8}id: ${id}$`, 'm'));
      // The next suite runs only when every step before it passed, so a failed upload would skip it.
      expect(upload).toMatch(/^ {8}continue-on-error: true$/m);
      expect(upload.match(/^ {10}path:.*$/gm)).toEqual(['          path: test-results/']);
      expect(upload).not.toMatch(/\.miden-e2e|arc-keys|harness\.json|~\/|\$HOME/);
    }
  });

  it('caches, uploads and checks out no path that holds the key file', () => {
    const entries = steps.flatMap(pathEntries);
    // actions/cache saves its path when the job ends, after the key file is written, and PR runs restore main's caches.
    expect(entries).toContain('~/.cargo/bin/miden-client');
    expect(entries.filter(holdsKeyFile)).toEqual([]);
  });

  it.each(['~', '~/', '$HOME', '/home/runner', '../../..', '/', '~/.*', '~/.miden-e2e', "'~/.miden-e2e/arc-keys/'"])(
    'counts the path %s as holding the key file',
    entry => expect(holdsKeyFile(entry)).toBe(true)
  );
});
