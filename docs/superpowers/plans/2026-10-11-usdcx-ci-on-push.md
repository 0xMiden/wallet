# USDCx Live Suites on Push to Main Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The extension's live USDCx suites (`usdcx-in`, `usdcx-burn`, `usdcx`) and the iOS live USDCx workflow run on every push to main, the extension suites spending from a CI Arc key of their own that only one step can read.

**Architecture:** A new workflow, `.github/workflows/e2e-usdcx.yml` (push to main, `workflow_dispatch`), installs like E2E Bridge, writes the repository secret `USDCX_HARNESS_ARC_KEY` to the runner's harness key file in one step (a new `scripts/write-ci-harness-arc-key.mjs` over a `writeHarnessArcKey` the runner now exports), then runs the three suites in turn through `node scripts/e2e-real.mjs --suite <name>`, uploading `test-results/` after each. One fixed concurrency group that never cancels a run in progress keeps two runs off the key. `.github/workflows/e2e-usdcx-live.yml` gains `push: main` and sets its own Arc key only on the two steps that read it. Guard tests pin all of it.

**Tech Stack:** GitHub Actions YAML, Node 22 ESM scripts (`viem/accounts`), Jest 30 with `@swc/jest` (`@jest-environment node`), actionlint.

**Spec:** the user's request of 2026-10-11 (the Chrome `usdcx`, `usdcx-in`, `usdcx-burn` suites and the iOS live USDCx workflow "should run on main pushes"), with the design rules restated under Global Constraints. For these suites it supersedes D4 ("local only") of `docs/superpowers/specs/2026-10-09-usdcx-live-e2e-design.md`. Background: `scripts/e2e-real.mjs` (harness key at :1431-1489, run lock at :1561-1638, suite table at :148-184), `playwright/e2e/docs/e2e-architecture.md` section 8.

## Global Constraints

- Worktree `/Users/celrisen/miden/wt-usdcx-ci`, branch `wiktor/usdcx-ci-on-push`, forked from origin/main `20949e612` (#1421, the Chrome USDCx harness).
- Every shell command starts with `cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. The Bash tool's shell is zsh: run a `$FILES` list inside `bash -c`.
- Never push, switch branches, amend, rebase, `git add -A`, `git add .` or `git commit -a`. Stage files by name. Never bypass hooks or signing (no `--no-verify`, `-n`, `core.hooksPath` or `gpgsign` overrides); a failing hook or signature means stop and report BLOCKED.
- Never touch another worktree (`~/miden/wt-usdcx-e2e`, `~/miden/wt-usdcx-ios-burn`, `~/wallet-e2e-research`, `~/miden/miden-wallet`) or `~/.miden-e2e`.
- Never run `yarn install`, a build, a simulator, a live E2E run or `node scripts/e2e-real.mjs --suite ...`. Run `scripts/write-ci-harness-arc-key.mjs` only through the tests, which point `HOME` at a temporary directory; run bare, it writes into the real `~/.miden-e2e`.
- Never print, log or commit a private key or a secret value. Tests generate keys at run time with `generatePrivateKey()`; the only key-shaped literals allowed are the synthetic refusal inputs in Task 1 (`'ab'.repeat(32)` and the like).
- Commit messages: exactly the one line each task gives, no trailers of any kind (no `Co-Authored-By`, no tool attribution).
- No em dash (U+2014) or en dash (U+2013) in any added text; a plain hyphen instead.
- Tests: `yarn test <paths> --maxWorkers=2`. No full jest run, no tsc, no lint gates beyond eslint and prettier on the changed `.ts`/`.mjs` files. Check `Test Suites:` as well as `Tests:`: a suite that throws while loading reports 0 failing tests. Prettier prints two `[warn] Ignored unknown option` lines (importOrder) on every run; they are expected.
- Code style: Prettier 120 columns, single quotes, semicolons; no `any`, no `as` in TypeScript.
- Comment density, measured: workflows about 33% comment lines, `scripts/e2e-real.mjs` 21%, harness tests 9%, script tests 4%. Comments say why, never what.
- The secret `USDCX_HARNESS_ARC_KEY` appears ONLY in the `env:` of the one step that writes the key file: never in workflow or job `env:`, never in an install, build or test step, never as `secrets.` text in a comment (the guard counts every `secrets.` in the file).
- The key file is the runner's own shape and place: `~/.miden-e2e/arc-keys/harness.json`, `{ role: 'harness', iso, address, privateKey, walletAddress: '' }` (the runner names its creation time `iso`, not `createdAt`), mode 0600 in 0700 directories, `privateKey` 0x and 64 lowercase hex, `address` the checksummed address viem derives.
- The suites run only as `node scripts/e2e-real.mjs --suite <name>`, no other argument: the runner refuses key flags, runs the usdcx suites headless and builds the extension itself (`--skip-build` is refused for them).
- New workflow: triggers exactly `push: branches: [main]` and `workflow_dispatch`; concurrency `group: usdcx-harness-arc-key`, `cancel-in-progress: false`; job `chrome-usdcx-testnet` on `warp-ubuntu-latest-x64-8x`; `timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}`.
- `e2e-usdcx-live.yml` keeps #1402's key-check step first and its ceilings (push 150, dispatch 235).
- CHANGELOG: one `[CHANGE][ci]` line under `## 1.17.2 (TBD)` > `### Changes` (latest release tag v1.17.1 after `git fetch --tags` on 2026-10-11; read CLAUDE.md's CHANGELOG rule before editing).
- Review is internal only: no review-council.

## Review Focus

- A stored secret in another form (upper-case hex, no `0x`, a trailing newline): the write step must take the newline and refuse the rest with a named error before anything is built or spent, never echoing it. Task 1 pins every form.
- The secret missing (a renamed secret, a fork): the job must fail at the write step, because the runner would otherwise create a fresh key on the runner whose payouts leave with it. Task 1 pins the failing step; Task 2 pins that the write precedes every suite and no suite step has an `if:`.
- Two pushes to main in a row, or a branch dispatch during a main run: never two runs on the key at once, whatever the ref. Task 2 pins the fixed group and `cancel-in-progress: false`.
- A red suite leaving a payout or a deposit in flight: later suites in the same run must not start, or they fail for a credit they cannot account for. Task 2 pins "no `if:` on a suite step"; Task 3 documents the cross-run case.
- A failed run's upload: it must carry `test-results/` only, never the key file, the lock or `~/.miden-e2e`. Task 2 pins every upload's single `path:`.

## Delivery (controller only, after Task 3 is committed and reviewed)

Implementers never run this section.

- [ ] **D1: Local gates on the final tree**

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
yarn test scripts playwright/e2e/harness --maxWorkers=2
bash -c 'FILES="scripts/e2e-real.mjs scripts/write-ci-harness-arc-key.mjs scripts/write-ci-harness-arc-key.test.ts playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts playwright.usdcx.config.ts playwright.e2e.config.ts"; npx eslint $FILES && npx prettier --check $FILES'
actionlint -ignore 'label "warp-ubuntu-latest-x64-8x" is unknown' .github/workflows/e2e-usdcx.yml .github/workflows/e2e-usdcx-live.yml
git diff 20949e612..HEAD -U0 | grep '^+' | LC_ALL=C grep -c -e "$(printf '\xe2\x80\x94')" -e "$(printf '\xe2\x80\x93')"
printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c -e "$(printf '\xe2\x80\x94')"
git diff 20949e612..HEAD | grep '^+' | grep -c -E '0x[0-9a-fA-F]{64}'
```

Expected: jest `Test Suites: N passed, N total` with no failed suite; eslint and prettier silent; actionlint prints nothing; the dash count prints `0` and the positive control `1`; the key-literal count prints `0`.

- [ ] **D2: Push** `git push -u origin wiktor/usdcx-ci-on-push`.

- [ ] **D3: Pull request.** Write the body to `<sdd workspace>/pr-body.md`, then `gh pr create --repo 0xMiden/wallet --base main --head wiktor/usdcx-ci-on-push --title "Live USDCx E2E on every push to main" --body-file <that file>`, and read it back with `gh pr view <n> --repo 0xMiden/wallet --json body --jq .body`. Body (current state only, no tool attribution, no dashes):

```markdown
The live USDCx E2E now runs after every push to main: the extension's three suites in a new E2E USDCx workflow with a CI Arc key of its own, and the iOS live bridge-in beside its nightly.

- New `e2e-usdcx.yml` (push to main, dispatch): `usdcx-in`, `usdcx-burn` and `usdcx` in turn through `node scripts/e2e-real.mjs --suite <name>`, headless, each only after the one before passed, `test-results/` uploaded after each.
- The CI key is the `USDCX_HARNESS_ARC_KEY` secret (20 USDC; a green run nets about +2.9). Only the step that writes it 0600 to the runner's harness key file reads it (`scripts/write-ci-harness-arc-key.mjs`).
- One fixed concurrency group that never cancels a run in progress, so no two runs share the key.
- Ceiling 210 min (240 on a dispatch): the suites' 160 min of test budgets plus three builds and a cold setup.
- `e2e-usdcx-live.yml` also runs on push to main, and its `USDCX_LIVE_EVM_PRIVATE_KEY` moves from the job env to the two steps that read it.
- Guard tests pin the secret's single step, the key file's mode, the group, the triggers, the suite order and the uploads.

<details><summary>Verification</summary>

<jest suite and test counts, actionlint, the mutation checks and their results, the iOS dispatch run link>. GitHub dispatches only workflows already on the default branch, so E2E USDCx's first live run is its first push run on main.
</details>

**Reviewers:** the secret's one step and the concurrency group in `e2e-usdcx.yml` are the parts worth your time.
```

- [ ] **D4: CI on the pushed head, by SHA.** `gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.total_count, (.workflow_runs[] | "\(.name) | \(.status) | \(.conclusion)")'`. Expected: `total_count` above 0 and the PR gates (unit tests with the harness guards, coverage, the changelog check, `lint:e2e`) green. Fix anything red with a new commit, then repeat D1 and this step.

- [ ] **D5: Dispatches on the branch.** `gh workflow run e2e-usdcx-live.yml --repo 0xMiden/wallet --ref wiktor/usdcx-ci-on-push` runs the branch's iOS workflow, the moved key included; watch it with `gh run list --repo 0xMiden/wallet --workflow e2e-usdcx-live.yml --branch wiktor/usdcx-ci-on-push --limit 1`, and expect its key check and test step green. Then try `gh workflow run e2e-usdcx.yml --repo 0xMiden/wallet --ref wiktor/usdcx-ci-on-push`; GitHub refuses a workflow that is not on the default branch yet, and that refusal is expected. Note it in the PR body's Verification block.

- [ ] **D6: Admin squash-merge** once D4 is green and D5's iOS run is green: confirm the PR head is the local HEAD and the PR is mergeable, then `gh pr merge <n> --repo 0xMiden/wallet --squash --admin --subject "Live USDCx E2E on every push to main (#<n>)" --body "The extension's live USDCx suites run after every push to main with a CI Arc key of their own, and the iOS live USDCx bridge-in runs on every push too."`.

- [ ] **D7: The first live run on main.** `gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse origin/main)"` after `git fetch origin main` must list E2E USDCx and E2E USDCx Bridge-IN (live); if the push created no runs, `gh workflow run e2e-usdcx.yml --repo 0xMiden/wallet --ref main`. Watch E2E USDCx to completion. Green is the live proof. Red: read the failure first (a late Circle payout says so in its message and is not a harness defect); fix forward in a follow-up PR, never a revert.

---

### Task 1: The CI harness key writer

**Files:**
- Modify: `scripts/e2e-real.mjs:1451-1475` (extract `writeHarnessArcKey` from `harnessArcKey`'s create branch)
- Create: `scripts/write-ci-harness-arc-key.mjs`
- Test: `scripts/write-ci-harness-arc-key.test.ts`

**Interfaces:**
- Consumes: `HARNESS_ARC_KEY_FILE` and `harnessArcKey(file, { create })` from `scripts/e2e-real.mjs` (unchanged).
- Produces:
  - `scripts/e2e-real.mjs`: `export async function writeHarnessArcKey(file: string, privateKey: string): Promise<string>`, the checksummed address. Writes the entry with flag `wx`, so an existing file throws `EEXIST`.
  - `scripts/write-ci-harness-arc-key.mjs`: `export const SECRET_NAME = 'USDCX_HARNESS_ARC_KEY'` and `export async function writeCiHarnessArcKey(file: string, secret: string | undefined): Promise<{ address: string } | { error: string }>`. As a command, `node scripts/write-ci-harness-arc-key.mjs` reads `USDCX_HARNESS_ARC_KEY`, writes `$HOME/.miden-e2e/arc-keys/harness.json`, prints `CI harness Arc key <address> written to <file>` and exits 0; on a refusal it prints `::error title=CI harness Arc key::<message>` to stderr and exits 1. Task 2's workflow step runs exactly `node scripts/write-ci-harness-arc-key.mjs`.

- [ ] **Step 1: Write the failing test**

Create `scripts/write-ci-harness-arc-key.test.ts`:

```ts
/**
 * The step that hands E2E USDCx its Arc key. A key the runner would refuse, or none, must fail the job before anything
 * is built or spent, and nothing it prints may carry the key.
 *
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { harnessArcKey } from './e2e-real.mjs';
import { writeCiHarnessArcKey } from './write-ci-harness-arc-key.mjs';

const REPO_ROOT = path.resolve(__dirname, '..');
const NOT_SET = 'USDCX_HARNESS_ARC_KEY is not set: store the CI harness Arc key as that repository secret';
const NOT_HEX = 'USDCX_HARNESS_ARC_KEY is not 0x and 64 lowercase hex';
const NOT_A_KEY = 'USDCX_HARNESS_ARC_KEY is not a valid secp256k1 private key';

const freshHome = (): string => mkdtempSync(path.join(os.tmpdir(), 'ci-harness-key-'));
const keyFileIn = (home: string): string => path.join(home, '.miden-e2e', 'arc-keys', 'harness.json');
const modeOf = (file: string): number => statSync(file).mode & 0o777;

describe('writeCiHarnessArcKey', () => {
  it('writes the secret as the harness key the runner reads, 0600 in 0700 directories', async () => {
    const home = freshHome();
    const file = keyFileIn(home);
    const key = generatePrivateKey();
    const { address } = privateKeyToAccount(key);
    await expect(writeCiHarnessArcKey(file, key)).resolves.toEqual({ address });
    expect([modeOf(file), modeOf(path.dirname(file)), modeOf(path.join(home, '.miden-e2e'))]).toEqual([
      0o600, 0o700, 0o700
    ]);
    await expect(harnessArcKey(file, { create: false })).resolves.toEqual({ address, privateKey: key, created: false });
  });

  it('takes a secret stored with a trailing newline', async () => {
    const file = keyFileIn(freshHome());
    const key = generatePrivateKey();
    await expect(writeCiHarnessArcKey(file, `${key}\n`)).resolves.toEqual({ address: privateKeyToAccount(key).address });
    await expect(harnessArcKey(file, { create: false })).resolves.toMatchObject({ privateKey: key });
  });

  it.each<[string, string | undefined, string]>([
    ['unset', undefined, NOT_SET],
    ['empty', '', NOT_SET],
    ['blank', ' \n', NOT_SET],
    ['without 0x', 'ab'.repeat(32), NOT_HEX],
    ['in upper case', `0x${'AB'.repeat(32)}`, NOT_HEX],
    ['a byte short', `0x${'ab'.repeat(31)}`, NOT_HEX],
    ['zero', `0x${'0'.repeat(64)}`, NOT_A_KEY],
    ['past the curve order', `0x${'f'.repeat(64)}`, NOT_A_KEY]
  ])('refuses a secret that is %s, writing nothing', async (_, secret, message) => {
    const home = freshHome();
    await expect(writeCiHarnessArcKey(keyFileIn(home), secret)).resolves.toEqual({ error: message });
    expect(existsSync(path.join(home, '.miden-e2e'))).toBe(false);
  });

  it('never replaces a key file that is already there', async () => {
    const file = keyFileIn(freshHome());
    await writeCiHarnessArcKey(file, generatePrivateKey());
    const written = readFileSync(file, 'utf8');
    await expect(writeCiHarnessArcKey(file, generatePrivateKey())).resolves.toEqual({
      error: `${file} already exists; it may hold USDC, so it is never replaced`
    });
    expect(readFileSync(file, 'utf8')).toBe(written);
  });
});

describe('the script, as the workflow step runs it', () => {
  const run = (home: string, secret?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.USDCX_HARNESS_ARC_KEY;
    if (secret !== undefined) env.USDCX_HARNESS_ARC_KEY = secret;
    return spawnSync(process.execPath, ['scripts/write-ci-harness-arc-key.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: 30_000
    });
  };

  it('prints the address and the file, never the key', () => {
    const home = freshHome();
    const key = generatePrivateKey();
    const res = run(home, key);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`CI harness Arc key ${privateKeyToAccount(key).address} written to ${keyFileIn(home)}\n`);
    expect(res.stderr).not.toContain(key.slice(2));
    expect(modeOf(keyFileIn(home))).toBe(0o600);
  });

  it('fails the step with an annotation when the secret is not set, writing nothing', () => {
    const home = freshHome();
    const res = run(home);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe(`::error title=CI harness Arc key::${NOT_SET}\n`);
    expect(existsSync(path.join(home, '.miden-e2e'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test scripts/write-ci-harness-arc-key.test.ts --maxWorkers=2`
Expected: FAIL, `Test Suites: 1 failed, 1 total`, with `Cannot find module './write-ci-harness-arc-key.mjs'`.

- [ ] **Step 3: Extract `writeHarnessArcKey` in the runner**

In `scripts/e2e-real.mjs`, insert this function directly above the `harnessArcKey` docblock (above the line `/**` that opens "The harness Arc key (R21): the one key every usdcx run burns to"):

```js
/**
 * Writes `privateKey` to `file` as a harness key entry, 0600 in a 0700 directory, and returns its address. Never
 * replaces a file (`wx` throws EEXIST): one that exists may hold USDC. harnessArcKey creates the local key through it,
 * and scripts/write-ci-harness-arc-key.mjs writes E2E USDCx's CI key.
 *
 * Exported for that script and for test.
 */
export async function writeHarnessArcKey(file, privateKey) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { address } = privateKeyToAccount(privateKey);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const entry = { role: 'harness', iso: new Date().toISOString(), address, privateKey, walletAddress: '' };
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return address;
}

```

Then, inside `harnessArcKey`, replace:

```js
    if (!create) return { missing: true };
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const privateKey = generatePrivateKey();
    const { address } = privateKeyToAccount(privateKey);
    const entry = { role: 'harness', iso: new Date().toISOString(), address, privateKey, walletAddress: '' };
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { address, privateKey, created: true };
```

with:

```js
    if (!create) return { missing: true };
    const privateKey = generatePrivateKey();
    return { address: await writeHarnessArcKey(file, privateKey), privateKey, created: true };
```

`harnessArcKey` still destructures `generatePrivateKey, privateKeyToAccount` from its own import: `privateKeyToAccount` is still used by `harnessEntryProblem` further down.

- [ ] **Step 4: Write the script**

Create `scripts/write-ci-harness-arc-key.mjs`:

```js
#!/usr/bin/env node
/**
 * E2E USDCx (.github/workflows/e2e-usdcx.yml) only: writes the repository secret USDCX_HARNESS_ARC_KEY as the runner's
 * harness Arc key file before any usdcx suite runs. Without that file the runner creates a fresh key, and the payouts
 * it collects would leave with the runner. Prints the address, never the key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import { HARNESS_ARC_KEY_FILE, writeHarnessArcKey } from './e2e-real.mjs';

export const SECRET_NAME = 'USDCX_HARNESS_ARC_KEY';

/**
 * Writes `secret` to `file` as a harness key entry. Returns `{ address }`, or `{ error }` with nothing written. No
 * message carries the key.
 */
export async function writeCiHarnessArcKey(file, secret) {
  const privateKey = (secret ?? '').trim();
  if (privateKey === '') {
    return { error: `${SECRET_NAME} is not set: store the CI harness Arc key as that repository secret` };
  }
  // The one form the runner reads. GitHub masks the secret as stored, so a lowercased copy would reach logs unmasked.
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) return { error: `${SECRET_NAME} is not 0x and 64 lowercase hex` };
  try {
    privateKeyToAccount(privateKey);
  } catch {
    // viem's own message can carry the key's value.
    return { error: `${SECRET_NAME} is not a valid secp256k1 private key` };
  }
  try {
    return { address: await writeHarnessArcKey(file, privateKey) };
  } catch (err) {
    if (err?.code === 'EEXIST') return { error: `${file} already exists; it may hold USDC, so it is never replaced` };
    return { error: `cannot write ${file}: ${err?.code ?? 'unknown error'}` };
  }
}

// Only when run as a command, as scripts/e2e-real.mjs guards its own main.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  writeCiHarnessArcKey(HARNESS_ARC_KEY_FILE, process.env[SECRET_NAME]).then(result => {
    if (result.error !== undefined) {
      console.error(`::error title=CI harness Arc key::${result.error}`);
      process.exit(1);
    }
    console.log(`CI harness Arc key ${result.address} written to ${HARNESS_ARC_KEY_FILE}`);
  });
}
```

No top-level `await`: `@swc/jest` emits it into a CommonJS wrapper that will not load.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn test scripts/write-ci-harness-arc-key.test.ts scripts/e2e-real.test.ts --maxWorkers=2`
Expected: PASS, `Test Suites: 2 passed, 2 total`; the new file's 13 tests pass, and the `harnessArcKey` describe in `scripts/e2e-real.test.ts` (its create, missing, mode and bad-entry cases) still passes on the extracted writer.

Then every test file in the directory: `yarn test scripts --maxWorkers=2`. Expected: no failed suite.

- [ ] **Step 6: Mutation checks, each with its prediction, restoring in the same command**

M1, drop `wx`. Prediction: only "never replaces a key file that is already there" fails (the second write overwrites the file).

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; bak=$(mktemp -d) && cp scripts/e2e-real.mjs "$bak/" && sed -i '' "s/{ mode: 0o600, flag: 'wx' }/{ mode: 0o600 }/" scripts/e2e-real.mjs && yarn test scripts/write-ci-harness-arc-key.test.ts --maxWorkers=2 2>&1 | grep -E '✕|Tests:'; cp "$bak/e2e-real.mjs" scripts/e2e-real.mjs && echo restored
```

M2, accept upper case. Prediction: only the "in upper case" refusal fails (it writes the key and returns an address).

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; bak=$(mktemp -d) && cp scripts/write-ci-harness-arc-key.mjs "$bak/" && sed -i '' 's/\[0-9a-f\]{64}/[0-9a-fA-F]{64}/' scripts/write-ci-harness-arc-key.mjs && yarn test scripts/write-ci-harness-arc-key.test.ts --maxWorkers=2 2>&1 | grep -E '✕|Tests:'; cp "$bak/write-ci-harness-arc-key.mjs" scripts/write-ci-harness-arc-key.mjs && echo restored
```

M3, a world-readable file. Prediction: exactly three tests fail, "writes the secret as the harness key the runner reads" (the mode), "takes a secret stored with a trailing newline" (the runner refuses a 0644 file) and "prints the address and the file, never the key" (the mode).

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; bak=$(mktemp -d) && cp scripts/e2e-real.mjs "$bak/" && sed -i '' "s/{ mode: 0o600, flag: 'wx' }/{ mode: 0o644, flag: 'wx' }/" scripts/e2e-real.mjs && yarn test scripts/write-ci-harness-arc-key.test.ts --maxWorkers=2 2>&1 | grep -E '✕|Tests:'; cp "$bak/e2e-real.mjs" scripts/e2e-real.mjs && echo restored
```

After all three: `git diff --stat` shows only `scripts/e2e-real.mjs` (the extraction) and the two new files untracked. Record each prediction and result in the task report.

- [ ] **Step 7: Lint and format the changed files**

Run: `bash -c 'FILES="scripts/e2e-real.mjs scripts/write-ci-harness-arc-key.mjs scripts/write-ci-harness-arc-key.test.ts"; npx eslint $FILES && npx prettier --check $FILES'`
Expected: no output from eslint, `All matched files use Prettier code style!`. Fix with `npx prettier --write` on those files only if needed.

- [ ] **Step 8: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; git add scripts/e2e-real.mjs scripts/write-ci-harness-arc-key.mjs scripts/write-ci-harness-arc-key.test.ts && git commit -m "ci(e2e): write the CI harness Arc key from its repository secret"
```

### Task 2: The E2E USDCx workflow and its guards

**Files:**
- Create: `.github/workflows/e2e-usdcx.yml`
- Create (test): `playwright/e2e/harness/usdcx-workflow.test.ts`
- Modify (test): `playwright/e2e/harness/linked-pr-injection.test.ts:276-277` (guarded job names) and `:355-356` (ceilings)

**Interfaces:**
- Consumes: Task 1's command `node scripts/write-ci-harness-arc-key.mjs`, which reads the env var `USDCX_HARNESS_ARC_KEY`, writes `$HOME/.miden-e2e/arc-keys/harness.json` (0600, directories 0700, the runner's entry shape) and exits 1 with an `::error` annotation when the secret is unset or malformed. The runner `scripts/e2e-real.mjs` takes `MIDEN_CLIENT_BIN` from the environment when set (`.github/actions/install-miden-client-cli` exports it to `GITHUB_ENV` on the kernel-pin path main takes) and otherwise installs the CLI itself.
- Produces: workflow name `E2E USDCx`, file `e2e-usdcx.yml`, job `chrome-usdcx-testnet`, concurrency group `usdcx-harness-arc-key`, step `Write the CI harness Arc key`, suite order `usdcx-in`, `usdcx-burn`, `usdcx`, ceilings push 210 and dispatch 240. Task 3's docs and CHANGELOG name these.

- [ ] **Step 1: Write the failing guard test**

Create `playwright/e2e/harness/usdcx-workflow.test.ts`:

```ts
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
    expect(installs.length).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(Math.max(...installs));
    expect(steps.findIndex(isSuite)).toBeGreaterThan(write);
  });

  it('runs the three suites through the runner in turn, with no key flag, no env and no if', () => {
    const suites = steps.filter(isSuite);
    expect(suites.map(runOf)).toEqual([`${RUNNER} --suite usdcx-in`, `${RUNNER} --suite usdcx-burn`, `${RUNNER} --suite usdcx`]);
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
```

Prettier may rewrap the long `toEqual([...])` line in the suites test; let it (Step 7).

Then edit `playwright/e2e/harness/linked-pr-injection.test.ts`. In the test 'reads the jobs it guards, Chrome, Android, iOS and desktop builds among them', replace:

```ts
        'e2e-telemetry.yml telemetry-egress',
        'pr-compile-surfaces.yml ios',
```

with:

```ts
        'e2e-telemetry.yml telemetry-egress',
        'e2e-usdcx.yml chrome-usdcx-testnet',
        'pr-compile-surfaces.yml ios',
```

In the test 'gives a dispatch the time to build its linked PRs from source on top of an unchanged push ceiling', replace:

```ts
      'e2e-usdcx-live.yml mobile-usdcx-live: push 150, dispatch 235',
      'pr-e2e-earn.yml earn-e2e: push 120, dispatch 270',
```

with:

```ts
      'e2e-usdcx-live.yml mobile-usdcx-live: push 150, dispatch 235',
      'e2e-usdcx.yml chrome-usdcx-testnet: push 210, dispatch 240',
      'pr-e2e-earn.yml earn-e2e: push 120, dispatch 270',
```

(The list follows the sorted file names, and `e2e-usdcx-live.yml` sorts before `e2e-usdcx.yml` because `-` comes before `.`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2`
Expected: FAIL. `usdcx-workflow.test.ts` fails to load with `ENOENT: no such file or directory, open '.../.github/workflows/e2e-usdcx.yml'`; in `linked-pr-injection.test.ts` exactly two tests fail, 'reads the jobs it guards...' (the new name is missing) and 'gives a dispatch the time...' (the ceiling line is missing). `Test Suites: 2 failed, 2 total`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/e2e-usdcx.yml`:

```yaml
name: E2E USDCx

# Runs the live USDCx suites on the extension after every push to main, through the runner `yarn e2e:real` uses
# (scripts/e2e-real.mjs): usdcx-in (a deposit from the CI Arc key into a fresh Guardian wallet), usdcx-burn (a Send
# burn to that key from a fresh standard and a fresh Guardian wallet, each waiting for Circle's payout) and usdcx (the
# round trip: burn, payout, deposit back). Nothing is a double: public Miden testnet and its faucet, the hosted
# Guardian, Arc Testnet and Circle's xReserve, attestation service and Gateway. A red payout step can be Circle's
# doing rather than the wallet's, and its message says so. The runner probes every service before it builds, builds
# the extension itself for each suite and runs the browser headless.
#
# The suites burn to and deposit from ONE Arc key, so each burn's payout refills what the deposits spend; a green run
# leaves the key about 2.9 USDC richer. CI has its own, the repository secret USDCX_HARNESS_ARC_KEY: never a
# developer's harness key and never the iOS job's. Only the step that writes it to the runner's key file reads the
# secret; the suites read the file through the runner, and no upload includes it.
#
# Not a per-PR gate: it spends public testnet funds and depends on services the project does not run.

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  # The linked-PR injections list a dispatched branch's open pull request and read its description.
  pull-requests: read

# Two runs would pay into and spend from the one key, which breaks each run's payout proof, so every run, from any
# branch, queues on this one group and none is cancelled once it started: a cancelled run can leave a payout that
# lands in the next run's window. GitHub keeps one waiting run per group, so a run still waiting when a newer one
# queues is cancelled before it starts.
concurrency:
  group: usdcx-harness-arc-key
  cancel-in-progress: false

jobs:
  chrome-usdcx-testnet:
    name: USDCx E2E (Chrome, live testnet)
    runs-on: warp-ubuntu-latest-x64-8x
    # The suites' own budgets come to 160 min: usdcx 60 (playwright.usdcx.config.ts), usdcx-in 30 and usdcx-burn two
    # tests of 35 (their describes). Each suite's preflight and build add about 5, and a cold setup about 30 (the CLI
    # compile, the Playwright browsers' 12 and apt's 6), so 205, rounded up to 210.
    # A dispatch may first build a linked web-sdk PR from source, and its CLI cold, on this runner (30 more).
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 240 || 210 }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # cargo builds the pinned miden-client CLI the wallet fixtures use.
      - uses: dtolnay/rust-toolchain@stable

      - name: Cache miden-client-cli
        # Key follows package.json so an SDK/CLI-pin bump invalidates naturally.
        uses: actions/cache@v4
        with:
          path: ~/.cargo/bin/miden-client
          key: miden-client-cli-${{ runner.os }}-${{ hashFiles('package.json') }}

      # On a dispatch from a pull request's branch these build against that pull request's linked
      # web-sdk and Guardian PRs, as its own CI does; on any other run both are no-ops.
      - name: Inject linked web-sdk PR
        id: inject-web-sdk
        uses: ./.github/actions/inject-linked-web-sdk-pr
      - name: Inject linked guardian PR
        id: inject-guardian
        uses: ./.github/actions/inject-linked-guardian-pr

      - name: Install dependencies
        if: steps.inject-web-sdk.outputs.patched != 'true' && steps.inject-guardian.outputs.patched != 'true'
        run: yarn install --frozen-lockfile
      # Not frozen: an injection rewrites package.json to `file:` deps the committed lockfile cannot match.
      - name: Install dependencies (linked PRs injected)
        if: steps.inject-web-sdk.outputs.patched == 'true' || steps.inject-guardian.outputs.patched == 'true'
        uses: ./.github/actions/yarn-install

      # With package.json's kernel pin, or a linked client or Protocol PR, this exports MIDEN_CLIENT_BIN, and the
      # runner then uses that CLI instead of installing its own.
      - name: Install miden-client-cli
        uses: ./.github/actions/install-miden-client-cli

      - name: Drop apt repositories this repo never installs from
        uses: ./.github/actions/apt-drop-unused-repos

      # No xvfb: the runner runs these suites headless. The azure apt mirror intermittently blackholes (E2E Bridge
      # has stalled ~57 min in apt-get update), so the browsers' system deps come from the canonical mirror.
      - name: Prefer the canonical Ubuntu mirror
        timeout-minutes: 6
        run: |
          sudo sed -i 's|http://azure.archive.ubuntu.com|http://archive.ubuntu.com|g' \
            /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
          sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update

      - name: Install Playwright browsers
        # `--with-deps` shells out to apt, and the browser download has wedged for 2h18m in E2E Bridge. Headless runs
        # the full Chromium build, which this installs.
        timeout-minutes: 12
        run: npx playwright install --with-deps chromium

      # The runner creates a fresh key when this file is missing, whose payouts would leave with the runner, so the
      # step fails the job when the secret is not set.
      - name: Write the CI harness Arc key
        env:
          USDCX_HARNESS_ARC_KEY: ${{ secrets.USDCX_HARNESS_ARC_KEY }}
        run: node scripts/write-ci-harness-arc-key.mjs

      # In turn, narrowest first, and each only once the one before passed: a red suite can leave a payout or a
      # deposit still landing on the key, inside the next suite's payout window. Each Playwright run empties
      # test-results/, so each suite's results upload before the next suite starts.
      - name: Run usdcx-in
        id: usdcx_in
        run: node scripts/e2e-real.mjs --suite usdcx-in
      - name: Upload usdcx-in results
        if: always() && steps.usdcx_in.outcome != 'skipped'
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-in-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore

      - name: Run usdcx-burn
        id: usdcx_burn
        run: node scripts/e2e-real.mjs --suite usdcx-burn
      - name: Upload usdcx-burn results
        if: always() && steps.usdcx_burn.outcome != 'skipped'
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-burn-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore

      - name: Run usdcx (round trip)
        id: usdcx_round_trip
        run: node scripts/e2e-real.mjs --suite usdcx
      - name: Upload usdcx results
        if: always() && steps.usdcx_round_trip.outcome != 'skipped'
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-round-trip-e2e-${{ github.run_id }}
          path: test-results/
          retention-days: 7
          if-no-files-found: ignore
```

No `secrets.` anywhere but the write step, comments included: the guard counts every occurrence in the file.

- [ ] **Step 4: Run the tests to verify they pass, and lint the workflow**

Run: `yarn test playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2`
Expected: PASS, `Test Suites: 2 passed, 2 total`, the 8 new tests among them.

Run: `actionlint -ignore 'label "warp-ubuntu-latest-x64-8x" is unknown' .github/workflows/e2e-usdcx.yml`
Expected: no output (the ignored runner label is the same one actionlint reports for e2e-bridge.yml).

Then every test file in the directory: `yarn test playwright/e2e/harness --maxWorkers=2`. Expected: no failed suite.

- [ ] **Step 5: Mutation checks, each with its prediction, restoring in the same command**

Each runs `bak=$(mktemp -d) && cp .github/workflows/e2e-usdcx.yml "$bak/" && <mutation> && yarn test playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2 2>&1 | grep -E '✕|Tests:'; cp "$bak/e2e-usdcx.yml" .github/workflows/e2e-usdcx.yml && echo restored`, after the usual `cd ... && export PATH=...;` prefix. Mutations and predictions:

- M1 `sed -i '' 's/cancel-in-progress: false/cancel-in-progress: true/' .github/workflows/e2e-usdcx.yml`: only 'queues every run...' fails.
- M2 `sed -i '' 's/group: usdcx-harness-arc-key/group: usdcx-harness-arc-key-${{ github.ref }}/' .github/workflows/e2e-usdcx.yml`: only 'queues every run...' fails.
- M3 `perl -0pi -e 's/(    runs-on: warp-ubuntu-latest-x64-8x\n)/$1    env:\n      USDCX_HARNESS_ARC_KEY: \x24{{ secrets.USDCX_HARNESS_ARC_KEY }}\n/' .github/workflows/e2e-usdcx.yml`: 'reads one secret, once...' fails (two `secrets.` and a job `env:`); linked-pr-injection stays green.
- M4 `sed -i '' 's|path: test-results/|path: ~/.miden-e2e|' .github/workflows/e2e-usdcx.yml`: only 'uploads test-results...' fails.
- M5 `sed -i '' 's/--suite usdcx-in$/--suite usdcx-in --headed/' .github/workflows/e2e-usdcx.yml`: only 'runs the three suites...' fails.
- M6 `sed -i '' 's/|| 210 }}/|| 200 }}/' .github/workflows/e2e-usdcx.yml`: only linked-pr-injection's 'gives a dispatch the time...' fails (the line reads push 200).
- M7 `sed -i '' 's|run: node scripts/write-ci-harness-arc-key.mjs|run: "true"|' .github/workflows/e2e-usdcx.yml`: 'reads one secret, once...' (the run line) and 'writes the key file 0600...' (no file) fail.

After all seven, `git status --short` shows the three Task 2 paths and nothing else changed. Record each prediction and result in the task report.

- [ ] **Step 6: Lint and format the changed test files**

Run: `bash -c 'FILES="playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts"; npx eslint $FILES && npx prettier --check $FILES'`
Expected: silent eslint, prettier clean (run `npx prettier --write` on these two files if not, then re-run Step 4's tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; git add .github/workflows/e2e-usdcx.yml playwright/e2e/harness/usdcx-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts && git commit -m "ci(e2e): run the live USDCx Chrome suites on every push to main"
```

### Task 3: The iOS live workflow on push, docs and changelog

**Files:**
- Modify: `.github/workflows/e2e-usdcx-live.yml:18-19` (header), `:35-37` (`on:`), `:69-73` (job env), `:83-84` (key check), `:265-266` (test step)
- Modify (test): `playwright/e2e/harness/usdcx-live-workflow.test.ts`
- Modify: `playwright/e2e/docs/e2e-architecture.md:186`, `:366`, after `:372`, after `:396`
- Modify: `playwright.usdcx.config.ts:6-7`, `playwright.e2e.config.ts:23-25`
- Modify: `CHANGELOG.md:39-41` (first bullet under `## 1.17.2 (TBD)` > `### Changes`)

**Interfaces:**
- Consumes: Task 2's names: workflow `E2E USDCx` (`e2e-usdcx.yml`), step `Write the CI harness Arc key`, suite order `usdcx-in`, `usdcx-burn`, `usdcx`, concurrency group `usdcx-harness-arc-key`; Task 1's `scripts/write-ci-harness-arc-key.mjs`.
- Produces: nothing a later task reads.

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/harness/usdcx-live-workflow.test.ts`, add inside the `describe` block, after the existing test:

```ts
  // Every push to main runs it as well as the nightly and a dispatch, and runs queue: a cancelled run can leave a
  // deposit that no relayer mints.
  it('runs after every push to main, nightly and by dispatch, one run at a time', () => {
    expect(workflow).toMatch(
      /\non:\n {2}push:\n {4}branches:\n {6}- main\n {2}schedule:\n {4}- cron: '17 3 \* \* \*'\n {2}workflow_dispatch:\n/
    );
    expect(workflow).toMatch(
      /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n(?: {2}#.*\n)* {2}cancel-in-progress: false\n/
    );
  });

  // Every step sees a job variable, the dependency install and the app build among them.
  it('sets the live Arc key only on the key check and the test step', () => {
    const code = workflow
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    const reading = code.split(/\n(?= {6}- )/).filter(chunk => chunk.includes('secrets.USDCX_LIVE_EVM_PRIVATE_KEY'));
    expect(reading.map(chunk => /^ {6}- name: (.+)$/m.exec(chunk)?.[1])).toEqual([
      'Require the live Arc Testnet key',
      'Run USDCx bridge-IN E2E (mobile, live testnets)'
    ]);
    for (const chunk of reading)
      expect(chunk).toContain('\n        env:\n          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}\n');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test playwright/e2e/harness/usdcx-live-workflow.test.ts --maxWorkers=2`
Expected: FAIL, `Tests: 2 failed, 1 passed, 3 total`: the trigger regex finds no `push:`, and the key test reads `[undefined]` (the job env chunk, before the first step) instead of the two step names. #1402's test still passes.

- [ ] **Step 3: Edit the iOS workflow**

In `.github/workflows/e2e-usdcx-live.yml`, replace:

```yaml
# It spends real Arc Testnet USDC on each run, and it depends on Circle's service
# and the relayer, so it is a nightly and on-demand signal, never a per-PR gate.
```

with:

```yaml
# It spends real Arc Testnet USDC on each run, and it depends on Circle's service
# and the relayer, so it runs after every push to main, nightly and on demand,
# and is never a per-PR gate.
```

Replace:

```yaml
on:
  schedule:
    - cron: '17 3 * * *'
```

with:

```yaml
on:
  push:
    branches:
      - main
  schedule:
    - cron: '17 3 * * *'
```

Replace:

```yaml
      # Anvil, and this job needs the real Arc Testnet RPC.
      USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
      # 0.01 USDC: Circle takes no deposit fee, a testnet claim's fee is about 0.0002 USDCx, and Arc gas for the
      # approve and the deposit is about 0.006 USDC, so a nightly spends about 0.016 of the faucet's 20 USDC drip.
```

with:

```yaml
      # Anvil, and this job needs the real Arc Testnet RPC.
      # NO USDCX_LIVE_EVM_PRIVATE_KEY here either: every step sees a job variable, the dependency install and the app
      # build among them, so the key is set only on the two steps that read it.
      # 0.01 USDC: Circle takes no deposit fee, a testnet claim's fee is about 0.0002 USDCx, and Arc gas for the
      # approve and the deposit is about 0.006 USDC, so a run spends about 0.016 USDC and a 20 USDC faucet drip
      # lasts about 1,200 runs.
```

Replace:

```yaml
      - name: Require the live Arc Testnet key
        run: |
```

with:

```yaml
      - name: Require the live Arc Testnet key
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
        run: |
```

Replace:

```yaml
        # NO retries: a retry sends a second real deposit. A failed run is read, not repeated.
        run: yarn test:e2e:mobile:usdcx-live:run
```

with:

```yaml
        # NO retries: a retry sends a second real deposit. A failed run is read, not repeated.
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
        run: yarn test:e2e:mobile:usdcx-live:run
```

Nothing else changes: the key check stays the first step, the injections, permissions, concurrency and `timeout-minutes` (150 on a push or the schedule, 235 on a dispatch) stay as they are. Only `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` reads the key, and it runs in the test step.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2`
Expected: PASS, `Test Suites: 2 passed, 2 total`; the ceiling list still reads `e2e-usdcx-live.yml mobile-usdcx-live: push 150, dispatch 235`.

Run: `actionlint .github/workflows/e2e-usdcx-live.yml`
Expected: no output.

- [ ] **Step 5: Mutation checks, each with its prediction, restoring in the same command**

Each runs `bak=$(mktemp -d) && cp .github/workflows/e2e-usdcx-live.yml "$bak/" && <mutation> && yarn test playwright/e2e/harness/usdcx-live-workflow.test.ts --maxWorkers=2 2>&1 | grep -E '✕|Tests:'; cp "$bak/e2e-usdcx-live.yml" .github/workflows/e2e-usdcx-live.yml && echo restored`, after the usual prefix.

- M1 `perl -0pi -e 's/  push:\n    branches:\n      - main\n//' .github/workflows/e2e-usdcx-live.yml`: only 'runs after every push to main...' fails.
- M2 `perl -0pi -e 's/(      E2E_NETWORK: testnet\n)/$1      USDCX_LIVE_EVM_PRIVATE_KEY: \x24{{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}\n/' .github/workflows/e2e-usdcx-live.yml`: only 'sets the live Arc key only...' fails (three chunks read the key, the first unnamed).
- M3 `sed -i '' 's/cancel-in-progress: false/cancel-in-progress: true/' .github/workflows/e2e-usdcx-live.yml`: only 'runs after every push to main...' fails.

Record each prediction and result in the task report.

- [ ] **Step 6: Docs**

In `playwright/e2e/docs/e2e-architecture.md`, section 3, replace the line:

```markdown
- **On demand (`yarn e2e:real --suite usdcx-burn`, and with the deposit back `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway and Circle's payout of it, on live testnet; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
```

with:

```markdown
- **After every push to main, and on demand (`yarn e2e:real --suite usdcx-burn`, and with the deposit back `--suite usdcx`):** a USDCx burn to Arc Testnet through Circle's Gateway and Circle's payout of it, on live testnet; see [section 8](#8--usdcx-on-live-testnet---out-to-arc-and-back).
```

In section 8, replace the sentence:

```markdown
The suites need no secret but spend public testnet funds and depend on services the project does not run, so no workflow runs them: each is started by hand with `yarn e2e:real`, and a lock lets one run go at a time.
```

with:

```markdown
The suites spend public testnet funds and depend on services the project does not run, so no pull request runs them; where they do run is below the table.
```

Directly after the suite table (after the `usdcx-burn` row, before the `> #### Circle's payout is a hard gate` block), insert:

```markdown

Where each USDCx suite runs:

| Suites | Runs | Arc key |
|---|---|---|
| `usdcx-in`, `usdcx-burn`, `usdcx` (extension) | E2E USDCx (`e2e-usdcx.yml`) after every push to main, in that order, each only once the one before passed, and on a branch by dispatch; by hand, `yarn e2e:real --suite <name>` | In CI, its own key ([below](#the-ci-key)); by hand, the harness key |
| The iOS live bridge-in (`usdcx-live-deposit.ios.spec.ts`), the deposit leg only | E2E USDCx Bridge-IN (live) (`e2e-usdcx-live.yml`) after every push to main, nightly at 03:17 UTC and by dispatch | The repository secret `USDCX_LIVE_EVM_PRIVATE_KEY`, set only on the steps that check it and run the spec; a run spends about 0.016 USDC of it |
```

After the paragraph that begins "Only one usdcx run may go at a time." (the last paragraph of "The harness Arc key", before the `---`), insert:

```markdown

### The CI key

E2E USDCx burns to and deposits from a key of its own, never a developer's harness key and never the iOS job's: the repository secret `USDCX_HARNESS_ARC_KEY`, 0x and 64 lowercase hex. The step after the install, and no other step, reads the secret and writes it to the runner's `~/.miden-e2e/arc-keys/harness.json` (0600 in a 0700 directory, through `scripts/write-ci-harness-arc-key.mjs`), printing only the address; the suites then read the file through the runner as a local run does, and the uploads hold `test-results/` alone. Without the secret the job fails at that step, before anything is built, because the runner would otherwise create a key whose payouts leave with the runner.

The key started with 20 USDC, and a green run leaves it about 2.9 USDC richer (the three runs above: about +0.98, +1.97 and -0.007), so it needs no refill while main is green. A red run spends at most a deposit and its gas; fund the key when `usdcx-in`'s preflight reports it below 0.021 USDC.

Runs queue on one concurrency group, `usdcx-harness-arc-key`, and none is cancelled once it started, so two runs never share the key; this group plays the lock's part in CI. GitHub keeps one waiting run per group, so a run still waiting when a newer one queues is cancelled before it starts. A payout that lands after its run went red can still fail the next run, as it can locally.

- **Its address and balance:** the `Write the CI harness Arc key` step prints the address, and each suite's banner repeats it (`Arc key  harness 0x...`); read the balance with the `cast call` above.
- **Fund it:** send Arc Testnet USDC to that address, from Circle's faucet or another key, while no E2E USDCx run is going.
- **Recover it:** GitHub never shows a secret again, so the key and its USDC are only as recoverable as the copy kept by whoever stored the secret. Import that copy into an EVM wallet on Arc Testnet (chain 5042002) to move the USDC, while no run is going. If the copy is lost, so is the USDC on the key: create a new key (`cast wallet new`), keep a copy, send it at least 0.021 USDC and store its private key, lowercase, with `gh secret set USDCX_HARNESS_ARC_KEY --repo 0xMiden/wallet`.
```

In `playwright.usdcx.config.ts`, replace:

```ts
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` is its only caller; no workflow runs it. An hour per test because
// Playwright charges test-scoped fixture setup (wallet A and the CLI it depends on) to the test's own budget.
```

with:

```ts
// `yarn e2e:real --suite usdcx|usdcx-in|usdcx-burn` is its only caller, by hand and in E2E USDCx (e2e-usdcx.yml). An
// hour per test because Playwright charges test-scoped fixture setup (wallet A and the CLI it depends on) to the
// test's own budget.
```

In `playwright.e2e.config.ts`, replace:

```ts
  // need a Guardian on one axis and run via playwright.dapp.config.ts. USDCx
  // live specs spend public testnet funds and run only through `yarn e2e:real`
  // (playwright.usdcx.config.ts), never in CI.
```

with:

```ts
  // need a Guardian on one axis and run via playwright.dapp.config.ts. USDCx
  // live specs spend public testnet funds and run only through the `yarn
  // e2e:real` runner (playwright.usdcx.config.ts), which E2E USDCx calls after
  // every push to main.
```

- [ ] **Step 7: CHANGELOG**

Read CLAUDE.md's CHANGELOG section, then `git fetch --tags -q origin && git tag --list 'v*' | grep -v -- -rc | sort -V | tail -1` (expected `v1.17.1`, so `## 1.17.2 (TBD)` is the section). In `CHANGELOG.md`, replace:

```markdown
### Changes

- [CHANGE][ci] The live USDCx bridge-IN E2E deposits into and claims with a Guardian account
```

with:

```markdown
### Changes

- [CHANGE][ci] The live USDCx E2E runs after every push to main: E2E USDCx (`e2e-usdcx.yml`, also dispatchable) runs the extension's `usdcx-in`, `usdcx-burn` and `usdcx` suites in turn through the `yarn e2e:real` runner with a CI Arc key of its own (the `USDCX_HARNESS_ARC_KEY` secret, which only the step writing it 0600 to the runner's harness key file reads, its runs queued so none shares the key), and E2E USDCx Bridge-IN (live) runs on every push as well as nightly, its Arc key set only on the two steps that read it.
- [CHANGE][ci] The live USDCx bridge-IN E2E deposits into and claims with a Guardian account
```

(The old string is the start of the existing first bullet; the edit leaves the rest of that bullet as it is.)

- [ ] **Step 8: Checks on the changed text**

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
git diff -U0 | grep '^+' | LC_ALL=C grep -c -e "$(printf '\xe2\x80\x94')" -e "$(printf '\xe2\x80\x93')"
printf 'a\xe2\x80\x94b\n' | LC_ALL=C grep -c -e "$(printf '\xe2\x80\x94')"
bash -c 'FILES="playwright/e2e/harness/usdcx-live-workflow.test.ts playwright.usdcx.config.ts playwright.e2e.config.ts"; npx eslint $FILES && npx prettier --check $FILES'
yarn test playwright/e2e/harness --maxWorkers=2
```

Expected: `0`, then the control `1`; eslint silent and prettier clean; no failed suite.

- [ ] **Step 9: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ci && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"; git add .github/workflows/e2e-usdcx-live.yml playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/docs/e2e-architecture.md playwright.usdcx.config.ts playwright.e2e.config.ts CHANGELOG.md && git commit -m "ci(e2e): run the iOS live USDCx workflow on every push to main with a step-scoped key, docs and changelog"
```
