#!/usr/bin/env node
/**
 * Finds the pr.yml run whose Coverage Check measured a commit pushed to main.
 *
 *   badge-source-run.mjs <owner/repo> <sha>               prints `run=<id>`, `pr=<n>` and `reason=`
 *   badge-source-run.mjs --check-tip <owner/repo> <sha>   prints `tip=true` or `tip=false`
 *
 * `reason` is empty on success, else `no-pr` (the commit came from no merged
 * pull request into main) or `no-artifact` (no run of that PR's head carries an
 * unexpired coverage-badge-data). Every key is printed, so the output can go
 * straight into $GITHUB_OUTPUT.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BADGE_ARTIFACT = 'coverage-badge-data';

// ghApi(path) resolves to every page of the response, as `gh api --paginate --slurp` gives them.
function items(pages, key) {
  return pages.flatMap(page => (key ? (page?.[key] ?? []) : (page ?? [])));
}

export async function findBadgeRun({ ghApi, repo, sha }) {
  const pulls = items(await ghApi(`repos/${repo}/commits/${sha}/pulls?per_page=100`));
  const pr = pulls.find(p => p?.merged_at && p?.base?.ref === 'main');
  if (!pr) return { reason: 'no-pr' };

  const runs = items(
    await ghApi(`repos/${repo}/actions/workflows/pr.yml/runs?head_sha=${pr.head.sha}&per_page=100`),
    'workflow_runs'
  )
    .filter(r => r?.event === 'pull_request')
    // A fork head's runs list no pull requests; any other run must name this one.
    .filter(r => !r.pull_requests?.length || r.pull_requests.some(p => p?.number === pr.number))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);

  for (const run of runs) {
    const artifacts = items(await ghApi(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`), 'artifacts');
    if (artifacts.some(a => a?.name === BADGE_ARTIFACT && a?.expired === false)) return { run: run.id, pr: pr.number };
  }
  return { reason: 'no-artifact', pr: pr.number };
}

export async function isMainTip({ ghApi, repo, sha }) {
  const [ref] = await ghApi(`repos/${repo}/git/ref/heads/main`);
  return ref?.object?.sha === sha;
}

function ghApiCli(path) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return Promise.resolve(JSON.parse(out));
}

function integerOrEmpty(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
}

async function main(argv) {
  const checkTip = argv[0] === '--check-tip';
  const [repo, sha] = checkTip ? argv.slice(1) : argv;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    console.error('usage: badge-source-run.mjs [--check-tip] <owner/repo> <40-hex sha>');
    process.exit(2);
  }
  if (checkTip) {
    process.stdout.write(`tip=${(await isMainTip({ ghApi: ghApiCli, repo, sha })) ? 'true' : 'false'}\n`);
    return;
  }
  const found = await findBadgeRun({ ghApi: ghApiCli, repo, sha });
  process.stdout.write(
    `run=${integerOrEmpty(found.run)}\npr=${integerOrEmpty(found.pr)}\nreason=${found.reason ?? ''}\n`
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`badge-source-run: ${err.message}`);
    process.exit(1);
  });
}
