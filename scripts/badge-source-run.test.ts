import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { BADGE_ARTIFACT, findBadgeRun, parseArgs, shouldPublish } from './badge-source-run.mjs';

const REPO = 'org/wallet';
// A PR head sha, 40 hex digits as GitHub gives them.
const headSha = (n: number) => n.toString(16).padStart(40, '0');
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
    head: { sha: headSha(number), ref: HEAD_REF, repo: { full_name: HEAD_REPO } }
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

const badge = { name: BADGE_ARTIFACT, expired: false };

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
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('ignores a merged PR into another base', async () => {
    const api = ghApi({
      [pulls]: [[pr(3, 'dev'), pr(7, 'main')]],
      [runsOf(headSha(3))]: [{ workflow_runs: [prRun(13, 3)] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }],
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('gives no-pr when the only merged PR went into dev', async () => {
    const api = ghApi({
      [pulls]: [[pr(3, 'dev')]],
      [runsOf(headSha(3))]: [{ workflow_runs: [prRun(13, 3)] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ reason: 'no-pr' });
  });

  it('finds the eligible run on page two of the runs', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(12, 7)] }, { workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(12)]: [{ artifacts: [] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('skips a run that lists another PR, and a run of another event', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      // The push run matches the PR head repository and branch, so only the event filter rejects it.
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(14, 99), forkRun(13, { event: 'push' }), prRun(11, 7)] }],
      [artifactsOf(14)]: [{ artifacts: [badge] }],
      [artifactsOf(13)]: [{ artifacts: [badge] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('accepts a run that lists no PR when it comes from the PR head repository and branch (a fork head)', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf(headSha(7))]: [{ workflow_runs: [forkRun(11)] }],
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
    ['a null PR head repo (a deleted fork)', {}, { repo: null }],
    // Both sides missing: equal to each other, so only the string check rejects them.
    ['a null head repository on both sides', { head_repository: null }, { repo: null }],
    ['a nameless head repository on both sides', { head_repository: {} }, { repo: {} }],
    ['no head branch on either side', { head_branch: undefined }, { ref: undefined }]
  ])('skips a run that lists no PR and has %s', async (_label, runExtra, headExtra) => {
    const merged = pr(7, 'main');
    const api = ghApi({
      [pulls]: [[{ ...merged, head: { ...merged.head, ...headExtra } }]],
      [runsOf(headSha(7))]: [{ workflow_runs: [forkRun(11, runExtra)] }],
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
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
      [artifactsOf(11)]: [{ artifacts: [{ name: 'other', expired: false }] }, { artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
  });

  it('does not count an expired artifact', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
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
      [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
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

describe('findBadgeRun rejects a successful response it cannot use', () => {
  it.each([
    ['a string PR number', { number: '7' }],
    ['a PR head without a sha', { head: { ref: HEAD_REF, repo: { full_name: HEAD_REPO } } }]
  ])('rejects %s before listing runs', async (_label, extra) => {
    const api = ghApi({ [pulls]: [[{ ...pr(7, 'main'), ...extra }]] });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).rejects.toThrow();
    expect(api.calls).toHaveLength(1);
  });

  it('rejects a candidate run with no id before listing its artifacts', async () => {
    const { id: _id, ...run } = prRun(11, 7);
    const api = ghApi({ [pulls]: [[pr(7, 'main')]], [runsOf(headSha(7))]: [{ workflow_runs: [run] }] });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).rejects.toThrow();
    expect(api.calls).toHaveLength(2);
  });

  it.each([
    ['a pulls page that is not a list', { [pulls]: [{}] }],
    ['a runs page without workflow_runs', { [pulls]: [[pr(7, 'main')]], [runsOf(headSha(7))]: [{}] }],
    [
      'an artifacts page without artifacts',
      {
        [pulls]: [[pr(7, 'main')]],
        [runsOf(headSha(7))]: [{ workflow_runs: [prRun(11, 7)] }],
        [artifactsOf(11)]: [{}]
      }
    ]
  ])('rejects %s', async (_label, routes) => {
    await expect(findBadgeRun({ ghApi: ghApi(routes), repo: REPO, sha: SHA })).rejects.toThrow();
  });
});

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

  it('exits 1 with the message when gh fails with no HTTP status in its stderr', () => {
    const res = checkSource({ stdout: '', stderr: 'gh: socket hang up', exit: 1 });

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: .*socket hang up/);
  });

  it.each([
    ['no status', '{}'],
    ['an unknown status', '{"status":"weird"}']
  ])('exits 3 when gh succeeds with a compare body carrying %s', (_label, stdout) => {
    const res = checkSource({ stdout });

    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: /);
  });

  it('exits 3 when gh succeeds but the response is not valid JSON', () => {
    const res = checkSource({ stdout: 'not json' });

    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: /);
  });
});

// The CLI's gh adapter in lookup mode (no --check-source), against a sequenced fake `gh`: call N of the
// process reads its answer from FAKE_GH_STDOUT_N / _STDERR_N / _EXIT_N, so the up-to-three list calls
// (pulls, runs, artifacts) can each be scripted, and the fake records every call it received.
describe('the lookup CLI gh adapter', () => {
  const PR_NUMBER = 42;
  const RUN_ID = 555;
  const HEAD_SHA = 'c'.repeat(40);

  const mergedPr = {
    number: PR_NUMBER,
    merged_at: '2026-09-24T00:00:00Z',
    base: { ref: 'main' },
    head: { sha: HEAD_SHA, ref: HEAD_REF, repo: { full_name: HEAD_REPO } }
  };
  const badgeRun = {
    id: RUN_ID,
    event: 'pull_request',
    created_at: '2026-09-24T00:00:01Z',
    pull_requests: [{ number: PR_NUMBER }]
  };

  function sequencedFakeGh(): string {
    const dir = tempDir();
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
        // macOS wc -l pads its count with spaces, which would break the variable name below.
        'n=$(wc -l < "$FAKE_GH_LOG" | tr -d \' \')',
        'eval "out=\\$FAKE_GH_STDOUT_$n"',
        'eval "err=\\$FAKE_GH_STDERR_$n"',
        'eval "ec=\\$FAKE_GH_EXIT_$n"',
        'printf \'%s\' "$out"',
        '[ -n "$err" ] && printf \'%s\\n\' "$err" >&2',
        '[ -z "$ec" ] && ec=0',
        'exit "$ec"',
        ''
      ].join('\n')
    );
    chmodSync(gh, 0o755);
    return dir;
  }

  function lookup(responses: Array<{ stdout: string; stderr?: string; exit?: number }>) {
    const dir = sequencedFakeGh();
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const env: Record<string, string> = {
      PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_GH_LOG: log
    };
    responses.forEach((r, i) => {
      env[`FAKE_GH_STDOUT_${i + 1}`] = r.stdout;
      env[`FAKE_GH_STDERR_${i + 1}`] = r.stderr ?? '';
      env[`FAKE_GH_EXIT_${i + 1}`] = String(r.exit ?? 0);
    });
    const res = spawnSync(process.execPath, [script, REPO, NEW], { encoding: 'utf8', env });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return { ...res, calls };
  }

  it('paginates every list call and prints the run and PR it finds', () => {
    const res = lookup([
      { stdout: JSON.stringify([[mergedPr]]) },
      { stdout: JSON.stringify([{ workflow_runs: [badgeRun] }]) },
      { stdout: JSON.stringify([{ artifacts: [badge] }]) }
    ]);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`run=${RUN_ID}\npr=${PR_NUMBER}\nreason=\n`);
    expect(res.calls).toHaveLength(3);
    for (const call of res.calls) expect(call).toMatch(/^api --paginate --slurp /);
  });

  it('prints reason=no-pr when the commit came from no merged pull request', () => {
    const res = lookup([{ stdout: JSON.stringify([[]]) }]);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe('run=\npr=\nreason=no-pr\n');
  });

  it('prints reason=no-artifact when no run carries the badge data', () => {
    const res = lookup([
      { stdout: JSON.stringify([[mergedPr]]) },
      { stdout: JSON.stringify([{ workflow_runs: [badgeRun] }]) },
      { stdout: JSON.stringify([{ artifacts: [] }]) }
    ]);

    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`run=\npr=${PR_NUMBER}\nreason=no-artifact\n`);
  });

  it('exits 1 with the message when gh fails with no HTTP status in its stderr', () => {
    const res = lookup([{ stdout: '', stderr: 'gh: socket hang up', exit: 1 }]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: .*socket hang up/);
  });

  it('exits 1 with the message on an HTTP 500', () => {
    const res = lookup([{ stdout: '{"message":"Server Error"}', stderr: 'gh: Server Error (HTTP 500)', exit: 1 }]);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: .*Server Error/);
  });

  it.each([
    ['a pulls page that is not a list', [{ stdout: '[{}]' }]],
    ['a runs page without workflow_runs', [{ stdout: JSON.stringify([[mergedPr]]) }, { stdout: '[{}]' }]],
    [
      'an artifacts page without artifacts',
      [
        { stdout: JSON.stringify([[mergedPr]]) },
        { stdout: JSON.stringify([{ workflow_runs: [badgeRun] }]) },
        { stdout: '[{}]' }
      ]
    ]
  ])('exits 3 when gh succeeds with %s', (_label, responses) => {
    const res = lookup(responses);

    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: /);
  });

  it('exits 3 when gh succeeds but the pulls response is not the expected shape', () => {
    const res = lookup([{ stdout: '{}' }]);

    expect(res.status).toBe(3);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/^badge-source-run: /);
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
