#!/usr/bin/env node
/**
 * Finds the pr.yml run whose Coverage Check measured a commit pushed to main,
 * and decides whether that commit's numbers may replace the published badges.
 *
 *   badge-source-run.mjs <owner/repo> <sha>
 *     prints `run=<id>`, `pr=<n>` and `reason=`
 *   BADGE_SOURCE_FILE=<path> badge-source-run.mjs --check-source <owner/repo> <sha>
 *     prints `publish=true|false` and `status=none|ahead|behind|identical|diverged`
 *
 * `reason` is empty on success, else `no-pr` (the commit came from no merged
 * pull request into main) or `no-artifact` (no run of that PR's head carries an
 * unexpired coverage-badge-data). BADGE_SOURCE_FILE is the badges branch's
 * source.json, {"sha": "<main commit the badges came from>"}; `status` is `none`
 * when it is missing or holds no valid sha. Every key is printed, so the output
 * can go straight into $GITHUB_OUTPUT.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BADGE_ARTIFACT = 'coverage-badge-data';

// ghApi(path) resolves to every page of the response, as `gh api --paginate --slurp` gives them.
function items(pages, key) {
  return pages.flatMap(page => (key ? (page?.[key] ?? []) : (page ?? [])));
}

const SHA_RE = /^[0-9a-f]{40}$/;

export async function findBadgeRun({ ghApi, repo, sha }) {
  const pulls = items(await ghApi(`repos/${repo}/commits/${sha}/pulls?per_page=100`));
  const pr = pulls.find(p => p?.merged_at && p?.base?.ref === 'main');
  if (!pr) return { reason: 'no-pr' };

  const runs = items(
    await ghApi(`repos/${repo}/actions/workflows/pr.yml/runs?head_sha=${pr.head.sha}&per_page=100`),
    'workflow_runs'
  )
    .filter(r => r?.event === 'pull_request')
    // A fork head's runs list no pull requests, so such a run must at least come from the PR's own head
    // repository: another fork can push the same head sha. Any other run must name this PR.
    .filter(r => (r.pull_requests?.length ? r.pull_requests.some(p => p?.number === pr.number) : sameRepo(r, pr)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);

  for (const run of runs) {
    const artifacts = items(await ghApi(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`), 'artifacts');
    if (artifacts.some(a => a?.name === BADGE_ARTIFACT && a?.expired === false)) return { run: run.id, pr: pr.number };
  }
  return { reason: 'no-artifact', pr: pr.number };
}

function sameRepo(run, pr) {
  const runRepo = run?.head_repository?.full_name;
  const prRepo = pr?.head?.repo?.full_name;
  return typeof runRepo === 'string' && typeof prRepo === 'string' && runRepo === prRepo;
}

function recordedSha(sourceFile) {
  let text;
  try {
    text = readFileSync(sourceFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const sha = JSON.parse(text)?.sha;
    return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// Main only moves forward, so publish when this commit is ahead of the one the badges came from. A run for an
// older commit that finishes last sees `behind` and leaves the newer numbers alone.
export async function shouldPublish({ ghApi, repo, sha, sourceFile }) {
  const recorded = recordedSha(sourceFile);
  if (!recorded) return { publish: true, status: 'none' };
  const [page] = await ghApi(`repos/${repo}/compare/${recorded}...${sha}?per_page=100`);
  const status = String(page?.status ?? '');
  return { publish: status === 'ahead', status };
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

export function parseArgs(argv) {
  const checkSource = argv.length === 3 && argv[0] === '--check-source';
  if (!checkSource && argv.length !== 2) return null;
  const [repo, sha] = checkSource ? argv.slice(1) : argv;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !SHA_RE.test(sha)) return null;
  return { checkSource, repo, sha };
}

async function main(argv) {
  const args = parseArgs(argv);
  const sourceFile = process.env.BADGE_SOURCE_FILE;
  if (!args || (args.checkSource && !sourceFile)) {
    console.error(
      'usage: badge-source-run.mjs <owner/repo> <40-hex sha>\n' +
        '       BADGE_SOURCE_FILE=<path> badge-source-run.mjs --check-source <owner/repo> <40-hex sha>'
    );
    process.exit(2);
  }
  const { repo, sha } = args;
  if (args.checkSource) {
    const { publish, status } = await shouldPublish({ ghApi: ghApiCli, repo, sha, sourceFile });
    process.stdout.write(`publish=${publish ? 'true' : 'false'}\nstatus=${status}\n`);
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
