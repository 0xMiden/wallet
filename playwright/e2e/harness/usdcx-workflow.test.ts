/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** The job's steps, each from its `      - ` to the next one; a comment above a step ends the step before it. */
const steps = workflow.slice(workflow.indexOf('\n    steps:\n') + '\n    steps:\n'.length).split(/\n(?= {6}- )/);
const isNamed = (step: string, name: string): boolean =>
  step.split('\n').some(line => line.trim().replace(/^- /, '') === `name: ${name}`);
const runOf = (step: string): string | undefined => /^ {6}(?:- | {2})run: (.+)$/m.exec(step)?.[1];
const stepNamed = (name: string): string => {
  const found = steps.filter(step => isNamed(step, name));
  if (found.length !== 1) throw new Error(`${found.length} steps named ${name}`);
  return found[0]!;
};
const isSuite = (step: string): boolean => runOf(step)?.startsWith(RUNNER) === true;

describe('E2E USDCx workflow', () => {
  it('runs after every push to main and by dispatch, and on nothing else', () => {
    expect(topLevel('on')).toEqual(['  push:', '    branches:', '      - main', '  workflow_dispatch:']);
  });

  it('queues every run, from any branch, on one fixed group and never cancels one in progress', () => {
    expect(topLevel('concurrency')).toEqual(['  group: usdcx-harness-arc-key', '  cancel-in-progress: false']);
  });

  it('is one job, so no other job can reach the key file', () => {
    expect(topLevel('jobs').filter(line => /^ {2}\S/.test(line))).toEqual(['  chrome-usdcx-testnet:']);
  });

  it('reads one secret, once, in the env of the step that writes the key file', () => {
    expect(workflow.match(/\bsecrets\./g)).toHaveLength(1);
    const step = stepNamed(WRITE_STEP);
    expect(step).toContain(`\n        env:\n          ${SECRET}: \${{ secrets.${SECRET} }}\n`);
    expect(runOf(step)).toBe('node scripts/write-ci-harness-arc-key.mjs');
    // No workflow or job env: every step would see it, the dependency install and the builds among them.
    expect(workflow).not.toMatch(/^ {0,4}env:/m);
  });

  it('writes the key file 0600 in a 0700 directory, as the runner reads it, when that step runs', () => {
    const home = mkdtempSync(join(tmpdir(), 'usdcx-ci-home-'));
    const key = generatePrivateKey();
    const command = runOf(stepNamed(WRITE_STEP));
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

  it('writes the key after the dependency install and before the first suite', () => {
    const installs = steps.flatMap((step, index) =>
      /yarn install|\.\/\.github\/actions\/yarn-install/.test(step) ? [index] : []
    );
    const write = steps.indexOf(stepNamed(WRITE_STEP));
    expect(installs).not.toHaveLength(0);
    expect(write).toBeGreaterThan(Math.max(...installs));
    expect(steps.findIndex(isSuite)).toBeGreaterThan(write);
  });

  it('runs the three suites through the runner in turn, with no key flag, no env and no if', () => {
    const suites = steps.filter(isSuite);
    expect(suites.map(runOf)).toEqual([
      `${RUNNER} --suite usdcx-in`,
      `${RUNNER} --suite usdcx-burn`,
      `${RUNNER} --suite usdcx`
    ]);
    // A red suite can leave a payout or a deposit landing on the key inside the next one's payout window.
    for (const step of suites) expect(step).not.toMatch(/^ {8}(env|if):/m);
  });

  it('uploads test-results after each suite that ran, whatever it did, and never the key or the lock', () => {
    const uploads = steps.filter(step => step.includes('uses: actions/upload-artifact@'));
    expect(uploads).toHaveLength(3);
    for (const upload of uploads) {
      const id = /^ {8}if: always\(\) && steps\.(\w+)\.outcome != 'skipped'$/m.exec(upload)?.[1];
      expect(steps[steps.indexOf(upload) - 1]).toMatch(new RegExp(`^ {8}id: ${id}$`, 'm'));
      expect(upload.match(/^ {10}path:.*$/gm)).toEqual(['          path: test-results/']);
      expect(upload).not.toMatch(/\.miden-e2e|arc-keys|harness\.json|~\/|\$HOME/);
    }
  });
});
