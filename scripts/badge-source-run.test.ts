import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { findBadgeRun, parseArgs, shouldPublish } from './badge-source-run.mjs';

const REPO = 'org/wallet';
const SHA = 'mergesha';
const HEAD_REPO = 'contrib/wallet';
const HEAD_REF = 'feature';
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
    head: { sha: `head${number}`, ref: HEAD_REF, repo: { full_name: HEAD_REPO } }
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

// ghApi returns every page, as `gh api --paginate --slurp` does; routes match by path prefix. A route
// holding an Error rejects with it.
function ghApi(routes: Record<string, Pages | Error>) {
  const calls: string[] = [];
  const options: unknown[] = [];
  const fn = async (path: string, opts?: unknown): Promise<Pages> => {
    calls.push(path);
    options.push(opts);
    const key = Object.keys(routes).find(k => path.startsWith(k));
    const value = key ? routes[key]! : [];
    if (value instanceof Error) throw value;
    return value;
  };
  return Object.assign(fn, { calls, options });
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

// A run of the PR head that lists no pull request, as a fork head's runs do.
const forkRun = (id: number, extra: Record<string, unknown> = {}) =>
  prRun(id, null, { head_repository: { full_name: HEAD_REPO }, head_branch: HEAD_REF, ...extra });

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
      // The push run matches the PR head repository and branch, so only the event filter rejects it.
      [runsOf('head7')]: [{ workflow_runs: [prRun(14, 99), forkRun(13, { event: 'push' }), prRun(11, 7)] }],
      [artifactsOf(14)]: [{ artifacts: [badge] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('accepts a run that lists no PR when it comes from the PR head repository and branch (a fork head)', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [forkRun(11)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it.each([
    ['the base repository', { head_repository: { full_name: REPO } }, {}],
    ['another repository', { head_repository: { full_name: 'mallory/wallet' } }, {}],
    ['another branch of the same fork', { head_branch: 'other' }, {}],
    ['no run head_repository', { head_repository: undefined }, {}],
    ['a null run head_repository', { head_repository: null }, {}],
    ['a run head_repository without a name', { head_repository: {} }, {}],
    ['no run head_branch', { head_branch: undefined }, {}],
    ['no PR head ref', {}, { ref: undefined }],
    ['no PR head repo', {}, { repo: undefined }],
    ['a null PR head repo (a deleted fork)', {}, { repo: null }]
  ])('skips a run that lists no PR and has %s', async (_label, runExtra, headExtra) => {
    const merged = pr(7, 'main');
    const api = ghApi({
      [pulls]: [[{ ...merged, head: { ...merged.head, ...headExtra } }]],
      [runsOf('head7')]: [{ workflow_runs: [forkRun(11, runExtra)] }],
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
    expect(api.calls).toEqual([`${compareOf(RECORDED, NEW)}?per_page=1`]);
    expect(api.options).toEqual([{ paginate: false }]);
  });

  it.each([
    ['HTTP 404', httpError(404, 'Not Found')],
    ['HTTP 422 with no common ancestor', httpError(422, `No common ancestor between ${RECORDED} and ${NEW}.`)],
    ['HTTP 422 with no commit for the sha', httpError(422, `No commit found for SHA: ${RECORDED}`)]
  ])('publishes when the recorded sha is not found: %s', async (_label, error) => {
    const api = ghApi({ [compareOf(RECORDED, NEW)]: error });

    await expect(
      shouldPublish({ ghApi: api, repo: REPO, sha: NEW, sourceFile: sourceFile(JSON.stringify({ sha: RECORDED })) })
    ).resolves.toEqual({ publish: true, status: 'none' });
  });

  it.each([
    ['HTTP 500', httpError(500, 'Server Error')],
    ['HTTP 422 for another reason', httpError(422, 'Validation Failed')],
    ['an error with no status', new Error('socket hang up')]
  ])('rejects on any other compare failure: %s', async (_label, error) => {
    const api = ghApi({ [compareOf(RECORDED, NEW)]: error });

    await expect(
      shouldPublish({ ghApi: api, repo: REPO, sha: NEW, sourceFile: sourceFile(JSON.stringify({ sha: RECORDED })) })
    ).rejects.toBe(error);
  });
});

// The CLI's gh adapter, run against a fake `gh` on PATH that answers the compare call from FAKE_GH_* variables.
describe('the CLI gh adapter', () => {
  function fakeGh(): string {
    const dir = tempDir();
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
        'printf \'%s\' "$FAKE_GH_STDOUT"',
        '[ -n "$FAKE_GH_STDERR" ] && printf \'%s\\n\' "$FAKE_GH_STDERR" >&2',
        'exit "$FAKE_GH_EXIT"',
        ''
      ].join('\n')
    );
    chmodSync(gh, 0o755);
    return dir;
  }

  function checkSource(fake: { stdout: string; stderr?: string; exit?: number }) {
    const dir = fakeGh();
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const res = spawnSync(process.execPath, [script, '--check-source', REPO, NEW], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
        BADGE_SOURCE_FILE: sourceFile(JSON.stringify({ sha: RECORDED })),
        FAKE_GH_LOG: log,
        FAKE_GH_STDOUT: fake.stdout,
        FAKE_GH_STDERR: fake.stderr ?? '',
        FAKE_GH_EXIT: String(fake.exit ?? 0)
      }
    });
    return { ...res, calls: readFileSync(log, 'utf8') };
  }

  it('reads compare unpaginated, as the single object gh returns', () => {
    const res = checkSource({ stdout: '{"status":"ahead"}' });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('publish=true\nstatus=ahead\n');
    expect(res.calls).toBe(`api ${compareOf(RECORDED, NEW)}?per_page=1\n`);
  });

  it('publishes when gh reports the recorded sha not found', () => {
    const res = checkSource({
      stdout: '{"message":"Not Found","status":"404"}',
      stderr: 'gh: Not Found (HTTP 404)',
      exit: 1
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('publish=true\nstatus=none\n');
  });

  it('exits 1 with the message and prints nothing on any other API failure', () => {
    const res = checkSource({ stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)', exit: 1 });

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: .*Server Error/);
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
