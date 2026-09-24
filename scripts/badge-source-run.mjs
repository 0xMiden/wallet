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
 * when it is missing, holds no valid sha, or names a commit GitHub cannot find.
 * Every key is printed, so the output can go straight into $GITHUB_OUTPUT. Any
 * gh API failure exits 1 with nothing on stdout; any other thrown error (a bug
 * in this script, or gh reporting success with a response it cannot use) exits
 * 3, so the workflow fails the job instead of quietly leaving the badges alone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BADGE_ARTIFACT = 'coverage-badge-data';

// ghApi(path, { paginate }) resolves to the response's pages, as `gh api --paginate --slurp` gives them; unpaginated
// it is one page. A failure rejects with the HTTP status on `status` when there is one, and `ghApiFailure: true`
// always, so main() can tell a real gh failure (exit 1) from a bug in this script (exit 3).
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
    // repository and branch: another fork, or another branch of it, can push the same head sha. Any other
    // run must name this PR.
    .filter(r => (r.pull_requests?.length ? r.pull_requests.some(p => p?.number === pr.number) : samePrHead(r, pr)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);

  for (const run of runs) {
    const artifacts = items(await ghApi(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`), 'artifacts');
    if (artifacts.some(a => a?.name === BADGE_ARTIFACT && a?.expired === false)) return { run: run.id, pr: pr.number };
  }
  return { reason: 'no-artifact', pr: pr.number };
}

function samePrHead(run, pr) {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a === b;
  return same(run?.head_repository?.full_name, pr?.head?.repo?.full_name) && same(run?.head_branch, pr?.head?.ref);
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

// GitHub's answers when the recorded sha is not a commit it knows, e.g. one force-pushed away.
function isUnknownCommit(err) {
  return err?.status === 404 || (err?.status === 422 && /no common ancestor|no commit found/i.test(err.message));
}

// Main only moves forward, so publish when this commit is ahead of the one the badges came from. A rerun for an
// older commit sees `behind` and leaves the newer numbers alone. Compare is unpaginated: every page repeats the
// status and only the commit list pages.
export async function shouldPublish({ ghApi, repo, sha, sourceFile }) {
  const recorded = recordedSha(sourceFile);
  if (!recorded) return { publish: true, status: 'none' };
  let pages;
  try {
    pages = await ghApi(`repos/${repo}/compare/${recorded}...${sha}?per_page=1`, { paginate: false });
  } catch (err) {
    if (isUnknownCommit(err)) return { publish: true, status: 'none' };
    throw err;
  }
  const status = String(pages[0]?.status ?? '');
  return { publish: status === 'ahead', status };
}

function ghApiCli(path, { paginate = true } = {}) {
  const args = paginate ? ['api', '--paginate', '--slurp', path] : ['api', path];
  let out;
  try {
    out = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    // gh prints the error body on stdout and `gh: <message> (HTTP <status>)` on stderr.
    const stderr = String(err.stderr ?? '').trim();
    const status = Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1]) || undefined;
    let message = stderr || err.message;
    try {
      message = JSON.parse(String(err.stdout)).message || message;
    } catch {
      // not a JSON body; keep gh's own message
    }
    return Promise.reject(Object.assign(new Error(`gh api ${path}: ${message}`), { status, ghApiFailure: true }));
  }
  const body = JSON.parse(out);
  return Promise.resolve(paginate ? body : [body]);
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
    process.exit(err?.ghApiFailure ? 1 : 3);
  });
}
