import { findBadgeRun, isMainTip } from './badge-source-run.mjs';

const REPO = 'org/wallet';
const SHA = 'mergesha';

type Pages = unknown[];

function pr(number: number, base: string, merged = true) {
  return {
    number,
    merged_at: merged ? '2026-09-24T00:00:00Z' : null,
    base: { ref: base },
    head: { sha: `head${number}` }
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

  it('accepts a run that lists no PR (a fork head)', async () => {
    const api = ghApi({
      [pulls]: [[pr(7, 'main')]],
      [runsOf('head7')]: [{ workflow_runs: [prRun(11, null)] }],
      [artifactsOf(11)]: [{ artifacts: [badge] }]
    });

    await expect(findBadgeRun({ ghApi: api, repo: REPO, sha: SHA })).resolves.toEqual({ run: 11, pr: 7 });
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

describe('isMainTip', () => {
  const api = ghApi({ [`repos/${REPO}/git/ref/heads/main`]: [{ object: { sha: 'tipsha' } }] });

  it('is true for the tip of main', async () => {
    await expect(isMainTip({ ghApi: api, repo: REPO, sha: 'tipsha' })).resolves.toBe(true);
  });

  it('is false for an older sha', async () => {
    await expect(isMainTip({ ghApi: api, repo: REPO, sha: 'oldsha' })).resolves.toBe(false);
  });
});
