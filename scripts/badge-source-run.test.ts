import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { findBadgeRun, parseArgs, shouldPublish } from './badge-source-run.mjs';

const REPO = 'org/wallet';
const SHA = 'mergesha';
const HEAD_REPO = 'org/wallet';
const repoRoot = resolve(__dirname, '..');
const script = resolve(repoRoot, 'scripts/badge-source-run.mjs');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'badge-source-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

type Pages = unknown[];

function pr(number: number, base: string, merged = true) {
  return {
    number,
    merged_at: merged ? '2026-09-24T00:00:00Z' : null,
    base: { ref: base },
    head: { sha: `head${number}`, repo: { full_name: HEAD_REPO } }
  };
}

function prRun(id: number, prNumber: number | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    event: 'pull_request',
    created_at: `2026-09-24T00:00:${String(id).padStart(2, '0')}Z`,
    pull_requests: prNumber === null ? [] : [{ number: prNumber }],
    ...extra
  };
}

const badge = { name: 'coverage-badge-data', expired: false };

// ghApi returns every page, as `gh api --paginate --slurp` does; routes match by path prefix.
function ghApi(routes: Record<string, Pages>) {
  const calls: string[] = [];
  const fn = async (path: string): Promise<Pages> => {
    calls.push(path);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    return key ? routes[key]! : [];
  };
  return Object.assign(fn, { calls });
}

const pulls = `repos/${REPO}/commits/${SHA}/pulls`;
const runsOf = (head: string) => `repos/${REPO}/actions/workflows/pr.yml/runs?head_sha=${head}`;
const artifactsOf = (id: number) => `repos/${REPO}/actions/runs/${id}/artifacts`;

describe('findBadgeRun', () => {
  it('finds the main PR on page two of the commit pulls', async () => {
    const api = ghApi({
      [pulls]: [[pr(1, 'main', false)], [pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('ignores a merged PR into another base', async () => {
    const api = ghApi({
      [pulls]: [[pr(3, 'dev'), pr(7, 'main')]],
      [runsOf('head3')]: [{ workflow_runs: [prRun(13, 3)] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('gives no-pr when the only merged PR went into dev', async () => {
    const api = ghApi({
      [pulls]: [[pr(3, 'dev')]],
      [runsOf('head3')]: [{ workflow_runs: [prRun(13, 3)] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ reason: 'no-pr' });
  });

  it('finds the eligible run on page two of the runs', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(12, 7)] }, { workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(12)]: [{ artifacts: [] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('skips a run that lists another PR, and a run of another event', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(14, 99), prRun(13, null, { event: 'push' }), prRun(11, 7)] }],
      [artifactsOf(14)]: [{ artifacts: [badge] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('accepts a run that lists no PR when it comes from the PR head repository (a fork head)', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, null, { head_repository: { full_name: HEAD_REPO } })] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it.each([
    ['another repository', { head_repository: { full_name: 'mallory/wallet' } }, {}],
    ['no run head_repository', {}, {}],
    ['a null run head_repository', { head_repository: null }, {}],
    ['a run head_repository without a name', { head_repository: {} }, {}],
    ['no PR head repo', { head_repository: { full_name: HEAD_REPO } }, { repo: undefined }],
    ['a null PR head repo (a deleted fork)', { head_repository: { full_name: HEAD_REPO } }, { repo: null }]
  ])('skips a run that lists no PR and has %s', async (_label, runExtra, headExtra) => {
    const merged = pr(7, 'main');
    const api = ghApi({
      [pulls]: [[{ ...merged, head: { ...merged.head, ...headExtra } }]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, null, runExtra)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({
      reason: 'no-artifact',
      pr: 7
    });
  });

  it('counts the artifact on page two', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [{ name: 'other', expired: false }] }, { artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('does not count an expired artifact', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [{ ...badge, expired: true }] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({
      reason: 'no-artifact',
      pr: 7
    });
  });

  it('gives no-pr when the commit came from no PR', async () => {
    const api = ghApi({ [pulls]: [[]] });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ reason: 'no-pr' });
  });

  it('gives no-artifact when no run carries the badge data', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({
      reason: 'no-artifact',
      pr: 7
    });
  });
});

const RECORDED = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const compareOf = (base: string, head: string) => `repos/${REPO}/compare/${base}...${head}`;

function sourceFile(content: string | null): string {
  const path = join(tempDir(), 'source.json');
  if (content !== null) writeFileSync(path, content);
  return path;
}

describe('shouldPublish', () => {
  it.each([
    ['a missing source file', null],
    ['malformed JSON', '{"sha": '],
    ['no sha', '{}'],
    ['a short sha', '{"sha": "abc123"}'],
    ['a non-string sha', '{"sha": 12}'],
    ['an uppercase sha', JSON.stringify({ sha: 'A'.repeat(40) })]
  ])('publishes without comparing on %s', async (_label, content) => {
    const api = ghApi({});

    await expect(shouldPublish({ ghApi: api, repo: REPO, sha: NEW, sourceFile: sourceFile(content) })).resolves.toEqual(
      { publish: true, status: 'none' }
    );
    expect(api.calls).toEqual([]);
  });

  it.each([
    ['ahead', true],
    ['behind', false],
    ['identical', false],
    ['diverged', false]
  ])('compares the recorded sha to this one: %s publishes %s', async (status, publish) => {
    const api = ghApi({ [compareOf(RECORDED, NEW)]: [{ status }] });

    await expect(
      shouldPublish({ ghApi: api, repo: REPO, sha: NEW, sourceFile: sourceFile(JSON.stringify({ sha: RECORDED })) })
    ).resolves.toEqual({ publish, status });
    expect(api.calls).toEqual([expect.stringMatching(new RegExp(`^${compareOf(RECORDED, NEW)}`))]);
  });
});

describe('parseArgs', () => {
  const repoSha = [REPO, NEW];

  it('accepts <owner/repo> <sha>', () => {
    expect(parseArgs(repoSha)).toEqual({ checkSource: false, repo: REPO, sha: NEW });
  });

  it('accepts --check-source <owner/repo> <sha>', () => {
    expect(parseArgs(['--check-source', ...repoSha])).toEqual({ checkSource: true, repo: REPO, sha: NEW });
  });

  it.each([
    ['no operands', []],
    ['one operand', [REPO]],
    ['a trailing operand', [...repoSha, 'extra']],
    ['the flag last', [...repoSha, '--check-source']],
    ['the flag between operands', [REPO, '--check-source', NEW]],
    ['an unknown flag', ['--check-other', ...repoSha]],
    ['a flag with a trailing operand', ['--check-source', ...repoSha, 'extra']],
    ['a bad repo', ['org', NEW]],
    ['a short sha', [REPO, 'abc123']]
  ])('rejects %s', (_label, argv) => {
    expect(parseArgs(argv)).toBeNull();
  });

  it.each([
    ['a trailing operand', [REPO, NEW, 'extra']],
    ['the flag last', [REPO, NEW, '--check-source']]
  ])('the CLI prints usage and exits 2 on %s', (_label, argv) => {
    const res = spawnSync(process.execPath, [script, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent' }
    });

    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^usage: /);
  });
});

describe('the retired main-tip check', () => {
  it.each([
    'scripts/badge-source-run.mjs',
    'scripts/badge-source-run.test.ts',
    'scripts/badge-data.test.ts',
    '.github/workflows/coverage-badge.yml'
  ])('%s no longer names it', file => {
    const text = readFileSync(resolve(repoRoot, file), 'utf8');

    expect(text).not.toContain(['--check', 'tip'].join('-'));
    expect(text).not.toContain(['tip', ''].join('='));
  });
});
