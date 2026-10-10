/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A workflow_dispatch on a pull request's branch builds against the web-sdk and Guardian PRs that pull
 * request links, but only in a job that runs both inject actions before it installs, web-sdk first as in
 * pr.yml. A job without them installs the published packages and goes green on code the pull request
 * does not use, so every job that installs the wallet's dependencies in a workflow a push or a dispatch
 * can start is checked here. Workflows are read as text in the plain shape every one of them uses; any
 * other shape throws rather than passing unread.
 */
const workflowsDir = resolve(__dirname, '../../../.github/workflows');
const WEB_SDK = './.github/actions/inject-linked-web-sdk-pr';
const GUARDIAN = './.github/actions/inject-linked-guardian-pr';
const GUARDED_EVENTS = ['push', 'workflow_dispatch'];
const NOT_INJECTED =
  "steps.inject-web-sdk.outputs.patched != 'true' && steps.inject-guardian.outputs.patched != 'true'";
const INJECTED = "steps.inject-web-sdk.outputs.patched == 'true' || steps.inject-guardian.outputs.patched == 'true'";

/** A step's content lines, trimmed, with the list item's `- ` removed from the first. */
type Step = { line: number; lines: string[] };
/** A job's own keys (indent 4) with their inline values, and its steps. */
type Job = { id: string; keys: Record<string, string>; steps: Step[] };

const isContent = (line: string): boolean => line.trim() !== '' && !line.trimStart().startsWith('#');
const indentOf = (line: string): number => line.search(/\S/);

/** The events of the top-level `on:`, in its block, flow-list or scalar form. */
const triggers = (file: string, text: string): string[] => {
  const lines = text.split('\n');
  const at = lines.findIndex(line => /^on:/.test(line));
  if (at === -1) throw new Error(`${file}: no top-level on:`);
  const inline = /^on:\s*([^\s#].*?)\s*$/.exec(lines[at]!)?.[1];
  if (inline !== undefined) return (/^\[(.*)\]$/.exec(inline)?.[1] ?? inline).split(',').map(event => event.trim());
  const events: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!isContent(line)) continue;
    if (indentOf(line) === 0) break;
    const key = /^ {2}([a-z_]+):/.exec(line)?.[1];
    if (key !== undefined) events.push(key);
  }
  if (events.length === 0) throw new Error(`${file}: an on: block with no events`);
  return events;
};

const jobs = (file: string, text: string): Job[] => {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  if (start === -1) throw new Error(`${file}: no top-level jobs:`);
  const found: Job[] = [];
  let stepsIndent = -1;
  let itemIndent = -1;
  let jobOpened = false;
  for (let at = start + 1; at < lines.length; at++) {
    const line = lines[at]!;
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    const job = found[found.length - 1];
    if (indent === 2) {
      const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
      if (id === undefined) throw new Error(`${file}:${at + 1}: not a job id: ${line.trim()}`);
      found.push({ id, keys: {}, steps: [] });
      stepsIndent = -1;
      jobOpened = true;
      continue;
    }
    if (job === undefined) throw new Error(`${file}:${at + 1}: a line before the first job id`);
    if (jobOpened && indent !== 4) throw new Error(`${file}:${at + 1}: not job keys indented 4: ${line.trim()}`);
    jobOpened = false;
    // YAML lets a list's `- ` items sit at the same indent as its key, so only a non-item line there ends the steps.
    const isItem = /^\s*- /.test(line);
    if (stepsIndent !== -1 && (indent < stepsIndent || (indent === stepsIndent && !isItem))) stepsIndent = -1;
    if (stepsIndent === -1) {
      if (indent !== 4) continue;
      const [, key, raw] = /^ {4}([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line) ?? [];
      if (key === undefined || raw === undefined) throw new Error(`${file}:${at + 1}: not a job key: ${line.trim()}`);
      const value = raw.replace(/(^|\s+)#.*$/, '');
      if (key === 'steps' && value !== '') throw new Error(`${file}:${at + 1}: steps: with an inline value: ${value}`);
      if (key === 'steps') {
        stepsIndent = indent;
        itemIndent = -1;
      }
      job.keys[key] = value;
      continue;
    }
    if (itemIndent === -1) itemIndent = indent;
    const item = /^\s*- (.*)$/.exec(line)?.[1];
    if (item !== undefined && indent === itemIndent) {
      job.steps.push({ line: at + 1, lines: [item.trim()] });
      continue;
    }
    const step = job.steps[job.steps.length - 1];
    if (step === undefined || indent <= itemIndent)
      throw new Error(`${file}:${at + 1}: not a step line: ${line.trim()}`);
    step.lines.push(line.trim());
  }
  return found;
};

const keyOf = (step: Step, key: string): string | undefined =>
  step.lines.map(line => new RegExp(`^${key}:\\s*(.*?)\\s*$`).exec(line)?.[1]).find(value => value !== undefined);
const usesOf = (step: Step): string | undefined => keyOf(step, 'uses')?.replace(/^['"]|['"]$/g, '');
/** The wallet's dependency install: the shared retrying action, or `yarn install` in a run script. */
const installs = (step: Step): boolean =>
  usesOf(step) === './.github/actions/yarn-install' ||
  step.lines.some(line => !/^name:/.test(line) && /(^|[\s;&|(])yarn install\b/.test(line.replace(/^run:/, ' ')));

const guarded = (file: string, text: string): boolean => triggers(file, text).some(e => GUARDED_EVENTS.includes(e));

/** Why a job breaks the rule, or undefined when it installs nothing or injects both, web-sdk first, before. */
const violation = (job: Job): string | undefined => {
  const install = job.steps.findIndex(installs);
  if (install === -1) return undefined;
  const webSdk = job.steps.findIndex(step => usesOf(step) === WEB_SDK);
  const guardian = job.steps.findIndex(step => usesOf(step) === GUARDIAN);
  const at = `installs at line ${job.steps[install]!.line}`;
  if (webSdk === -1 || webSdk > install) return `${at} without injecting the linked web-sdk PR first`;
  if (guardian === -1 || guardian > install) return `${at} without injecting the linked Guardian PR first`;
  if (guardian < webSdk) return 'injects the linked Guardian PR before the web-sdk PR, the reverse of pr.yml';
  return undefined;
};

/**
 * Minutes a dispatch adds to a push ceiling for the injections' from-source builds, by runner: pr-compile-surfaces
 * records about 26 for both on ubuntu-latest and 73 for the web-sdk one on macos-26, and pr-e2e-bridge-guardian runs
 * record the web-sdk one at 9 on x64-8x and still unfinished at 33 on arm64-2x.
 */
const INJECTION_MINUTES = { linux: 30, macos: 75, 'arm64-2x': 60 };
const DISPATCH_CEILING = /^\$\{\{ github\.event_name == 'workflow_dispatch' && (\d+) \|\| (\d+) \}\}$/;
const EVENT_TEST = /^github\.event_name\s*(==|!=)\s*'([^']*)'$/;
const PLAIN_TERM = /^[A-Za-z_][\w.-]*(\s*(==|!=)\s*('[^']*'|[A-Za-z_][\w.-]*|\d+))?$/;

const runnerOf = (file: string, job: Job): keyof typeof INJECTION_MINUTES => {
  const runsOn = job.keys['runs-on'] ?? '';
  if (/macos/.test(runsOn)) return 'macos';
  if (runsOn === 'warp-ubuntu-latest-arm64-2x') return 'arm64-2x';
  if (/ubuntu/.test(runsOn) && !/arm/.test(runsOn)) return 'linux';
  throw new Error(`${file} ${job.id}: no recorded injection time for runs-on: ${runsOn}`);
};

/**
 * False when a job `if:` fails on every pull_request event: each `||` alternative has an `&&` term comparing the
 * event name to a literal that rules pull_request out, without case as GitHub compares. Any other form throws.
 */
const ifCanHoldOnPullRequest = (where: string, raw: string): boolean => {
  const expression = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(raw)?.[1] ?? raw;
  const alternatives = expression.split('||').map(alternative => alternative.split('&&').map(term => term.trim()));
  if (alternatives.flat().some(term => !PLAIN_TERM.test(term)))
    throw new Error(`${where}: cannot read the job if: ${raw}`);
  return alternatives.some(terms =>
    terms.every(term => {
      const [, op, event] = EVENT_TEST.exec(term) ?? [];
      return op === undefined || (event?.toLowerCase() === 'pull_request') === (op === '==');
    })
  );
};

/** Whether a pull request run can reach a job: its own `if:` and that of every job it needs can hold. */
const runsOnPullRequest = (file: string, all: Job[], job: Job): boolean => {
  const where = `${file} ${job.id}`;
  const condition = job.keys['if'];
  if (condition !== undefined && !ifCanHoldOnPullRequest(where, condition)) return false;
  const needs = job.keys['needs'];
  if (needs === undefined) return true;
  const ids = (/^\[(.*)\]$/.exec(needs)?.[1] ?? needs).split(',').map(id => id.trim());
  return ids.every(id => {
    const needed = all.find(candidate => candidate.id === id);
    if (needed === undefined) throw new Error(`${where}: cannot read the job needs: ${needs}`);
    return runsOnPullRequest(file, all, needed);
  });
};

/** Why a job's ceiling cuts off a dispatch that builds a linked web-sdk PR first, or undefined. */
const ceilingViolation = (file: string, text: string, job: Job): string | undefined => {
  const ceiling = job.keys['timeout-minutes'];
  const injects = job.steps.filter(step => [WEB_SDK, GUARDIAN].includes(usesOf(step) ?? ''));
  const on = triggers(file, text);
  // No ceiling is GitHub's 360 minutes. One the job's own pull request runs inject under already holds the builds.
  if (ceiling === undefined || injects.length === 0 || !on.includes('workflow_dispatch')) return undefined;
  const injectsOnPullRequests =
    on.includes('pull_request') &&
    injects.every(step => keyOf(step, 'if') === undefined) &&
    runsOnPullRequest(file, jobs(file, text), job);
  if (injectsOnPullRequests) return undefined;
  const [, dispatch, push] = DISPATCH_CEILING.exec(ceiling) ?? [];
  if (dispatch === undefined || push === undefined)
    return `timeout-minutes ${ceiling} gives a dispatch no more than a push`;
  const needed = Number(push) + INJECTION_MINUTES[runnerOf(file, job)];
  return Number(dispatch) < needed ? `a dispatch gets ${dispatch} minutes, under the ${needed} it needs` : undefined;
};

const workflowViolations = (file: string, text: string): string[] =>
  guarded(file, text)
    ? jobs(file, text).flatMap(job => {
        const why = violation(job);
        return why === undefined ? [] : [`${file} ${job.id}: ${why}`];
      })
    : [];

const workflowFiles = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .sort();
const source = (file: string): string => readFileSync(resolve(workflowsDir, file), 'utf8');
/** Every job the rule checks, and each as `<file> <job>`. */
const guardedJobs = workflowFiles.flatMap(file =>
  guarded(file, source(file))
    ? jobs(file, source(file))
        .filter(job => job.steps.some(installs))
        .map(job => ({ file, job }))
    : []
);
const guardedNames = guardedJobs.map(({ file, job }) => `${file} ${job.id}`);
const jobOf = (file: string, id: string): Job => {
  const job = jobs(file, source(file)).find(candidate => candidate.id === id);
  if (job === undefined) throw new Error(`${file}: no job ${id}`);
  return job;
};

describe('every install a push or a dispatch can run injects the linked PRs first', () => {
  it('injects the linked web-sdk and Guardian PRs, in that order, before installing, in every such job', () => {
    expect(workflowFiles.flatMap(file => workflowViolations(file, source(file)))).toEqual([]);
  });

  it('reads the jobs it guards, Chrome, Android, iOS and desktop builds among them', () => {
    expect(guardedNames).toEqual(
      expect.arrayContaining([
        'build-chrome.yml build',
        'build-desktop.yml build',
        'build-mobile.yml build-android',
        'build-mobile.yml build-ios',
        'e2e-android.yml android-e2e',
        'e2e-blockchain.yml chrome-testnet',
        'e2e-blockchain.yml chrome-guardian-devnet',
        'e2e-blockchain.yml mobile-guardian-testnet',
        'e2e-bridge.yml chrome-bridge-testnet',
        'e2e-bridge-in.yml mobile-bridge-in-testnet',
        'e2e-dapp.yml dapp-e2e',
        'e2e-dapp-browser.yml ios-dapp-browser',
        'e2e-dapp-browser.yml android-dapp-browser',
        'e2e-resilience.yml resilience-chrome',
        'e2e-stress.yml stress-conservation',
        'e2e-telemetry.yml telemetry-egress',
        'pr-compile-surfaces.yml ios',
        'pr-e2e-local.yml chrome-local'
      ])
    );
  });

  it('leaves pull-request-only workflows to pr.yml and reusable ones to their push-only callers', () => {
    expect(guardedNames).not.toContain('pr.yml unit');
    expect(guardedNames).not.toContain('ci.yml ci');
    expect(guardedNames).not.toContain('cd.yml cd');
  });

  it('keeps --frozen-lockfile for every run that injected nothing, so a push to main or next installs as before', () => {
    const frozen = guardedJobs.flatMap(({ file, job }) =>
      job.steps
        .filter(step => step.lines.some(line => /yarn install --frozen-lockfile/.test(line)))
        .map(step => ({ entry: `${file} ${job.id}`, step, job }))
    );
    expect(frozen.map(({ entry }) => entry)).toEqual(expect.arrayContaining(['build-chrome.yml build']));
    for (const { entry, step, job } of frozen) {
      expect([entry, keyOf(step, 'if')]).toEqual([entry, NOT_INJECTED]);
      expect([entry, job.steps.some(other => keyOf(other, 'if') === INJECTED && installs(other))]).toEqual([
        entry,
        true
      ]);
    }
  });

  it('keeps every release build on the published packages: the build workflows inject only on a dispatch', () => {
    const gates = ['build-chrome.yml', 'build-desktop.yml', 'build-mobile.yml'].flatMap(file =>
      jobs(file, source(file)).flatMap(job =>
        job.steps
          .filter(step => [WEB_SDK, GUARDIAN].includes(usesOf(step) ?? ''))
          .map(step => `${file} ${job.id}: ${keyOf(step, 'if')}`)
      )
    );
    const dispatchOnly = (entry: string): string[] =>
      [0, 1].map(() => `${entry}: github.event_name == 'workflow_dispatch'`);
    expect(gates).toEqual([
      ...dispatchOnly('build-chrome.yml build'),
      ...dispatchOnly('build-desktop.yml build'),
      ...dispatchOnly('build-mobile.yml build-android'),
      ...dispatchOnly('build-mobile.yml build-ios')
    ]);
  });

  it('gives a dispatch the time to build a linked web-sdk PR on top of the push ceiling, which stays as it was', () => {
    expect(
      workflowFiles.flatMap(file =>
        jobs(file, source(file)).flatMap(job => {
          const why = ceilingViolation(file, source(file), job);
          return why === undefined ? [] : [`${file} ${job.id}: ${why}`];
        })
      )
    ).toEqual([]);
    const ceilings = guardedJobs.flatMap(({ file, job }) => {
      const [, dispatch, push] = DISPATCH_CEILING.exec(job.keys['timeout-minutes'] ?? '') ?? [];
      return dispatch === undefined ? [] : [`${file} ${job.id}: push ${push}, dispatch ${dispatch}`];
    });
    expect(ceilings).toEqual([
      'e2e-android.yml android-e2e: push 60, dispatch 90',
      'e2e-blockchain.yml chrome-devnet: push 60, dispatch 90',
      'e2e-blockchain.yml chrome-testnet: push 60, dispatch 90',
      'e2e-blockchain.yml chrome-guardian-devnet: push 60, dispatch 90',
      'e2e-blockchain.yml chrome-guardian-testnet: push 60, dispatch 90',
      'e2e-blockchain.yml mobile-devnet: push 130, dispatch 205',
      'e2e-blockchain.yml mobile-testnet: push 130, dispatch 205',
      'e2e-blockchain.yml mobile-guardian-devnet: push 130, dispatch 205',
      'e2e-blockchain.yml mobile-guardian-testnet: push 130, dispatch 205',
      'e2e-bridge-in.yml mobile-bridge-in-testnet: push 110, dispatch 185',
      'e2e-bridge.yml chrome-bridge-testnet: push 70, dispatch 100',
      'e2e-dapp-browser.yml ios-dapp-browser: push 60, dispatch 135',
      'e2e-dapp-browser.yml android-dapp-browser: push 60, dispatch 90',
      'e2e-dapp.yml dapp-e2e: push 190, dispatch 220',
      'e2e-resilience.yml resilience-chrome: push 60, dispatch 90',
      'e2e-stress.yml stress-conservation: push 90, dispatch 120',
      'e2e-telemetry.yml telemetry-egress: push 30, dispatch 60',
      'pr-e2e-earn.yml earn-e2e: push 120, dispatch 180',
      'pr-e2e-swap.yml swap-e2e: push 120, dispatch 180'
    ]);
  });

  it("keeps the telemetry suite's own pull request runs on the published packages, as they were", () => {
    const steps = jobOf('e2e-telemetry.yml', 'telemetry-egress').steps.filter(step =>
      [WEB_SDK, GUARDIAN].includes(usesOf(step) ?? '')
    );
    expect(steps.map(step => keyOf(step, 'if'))).toEqual([
      "github.event_name != 'pull_request'",
      "github.event_name != 'pull_request'"
    ]);
  });
});

describe('the rule itself', () => {
  const workflow = (on: string, steps: string[]): string =>
    `name: x\non:\n${on}\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps
      .map(step => `      - ${step}\n`)
      .join('')}`;
  const checkout = 'uses: actions/checkout@v4';
  const webSdk = `name: Inject linked web-sdk PR\n        uses: ${WEB_SDK}`;
  const guardian = `uses: ${GUARDIAN}`;
  const frozen = 'run: yarn install --frozen-lockfile';

  it('flags a dispatchable job that installs without injecting', () => {
    expect(workflowViolations('x.yml', workflow('  workflow_dispatch:', [checkout, frozen]))).toEqual([
      'x.yml build: installs at line 11 without injecting the linked web-sdk PR first'
    ]);
  });

  it('flags injections placed after the install, or in the reverse order', () => {
    expect(workflowViolations('x.yml', workflow('  push:', [frozen, webSdk, guardian]))).toHaveLength(1);
    expect(workflowViolations('x.yml', workflow('  push:', [webSdk, frozen, guardian]))).toEqual([
      expect.stringContaining('without injecting the linked Guardian PR first')
    ]);
    expect(workflowViolations('x.yml', workflow('  push:', [guardian, webSdk, frozen]))).toEqual([
      expect.stringContaining('the reverse of pr.yml')
    ]);
  });

  it('passes both injections before the install, and the shared install action counts as one', () => {
    expect(workflowViolations('x.yml', workflow('  push:', [checkout, webSdk, guardian, frozen]))).toEqual([]);
    expect(workflowViolations('x.yml', workflow('  push:', ['uses: ./.github/actions/yarn-install']))).toHaveLength(1);
    expect(
      workflowViolations('x.yml', workflow('  push:', ['run: |\n          set -e\n          yarn install']))
    ).toHaveLength(1);
  });

  it('reads the flow-list form of on:, and leaves a pull-request-only workflow alone', () => {
    expect(workflowViolations('x.yml', workflow('', [frozen]).replace('on:\n\n', 'on: [push]\n'))).toHaveLength(1);
    expect(workflowViolations('x.yml', workflow('  pull_request:', [frozen]))).toEqual([]);
  });

  it('counts neither a comment nor a step name as an install', () => {
    const named = 'name: Run yarn install later\n        uses: actions/setup-node@v4';
    expect(
      workflowViolations(
        'x.yml',
        workflow('  push:', [named]).replace('    steps:\n', '    steps:\n      # yarn install\n')
      )
    ).toEqual([]);
  });

  it('reads a steps list written at the same indent as steps:, up to the next job key', () => {
    const flush = (steps: string[], after = ''): string =>
      workflow('  workflow_dispatch:', []) + steps.map(step => `    - ${step}\n`).join('') + after;
    expect(workflowViolations('x.yml', flush([checkout, frozen, 'run: yarn build:chrome']))).toEqual([
      'x.yml build: installs at line 11 without injecting the linked web-sdk PR first'
    ]);
    expect(
      workflowViolations(
        'x.yml',
        flush([webSdk.replace('\n        ', '\n      '), guardian, frozen], '    timeout-minutes: 5\n')
      )
    ).toEqual([]);
    expect(jobs('x.yml', flush([checkout, frozen], '    timeout-minutes: 5\n'))[0]!.steps).toHaveLength(2);
  });

  it('gives a dispatch that may inject more time than a push, enough for its runner', () => {
    const at = (
      on: string,
      ceiling: string,
      runsOn = 'ubuntu-latest',
      steps = [webSdk, guardian, frozen]
    ): string[] => {
      const text = workflow(on, steps).replace(
        '    runs-on: ubuntu-latest\n',
        `    runs-on: ${runsOn}\n    timeout-minutes: ${ceiling}\n`
      );
      return jobs('x.yml', text).flatMap(job => ceilingViolation('x.yml', text, job) ?? []);
    };
    const dispatch = (d: number, p: number): string =>
      `\${{ github.event_name == 'workflow_dispatch' && ${d} || ${p} }}`;
    expect(at('  workflow_dispatch:', '60')).toEqual(['timeout-minutes 60 gives a dispatch no more than a push']);
    expect(at('  workflow_dispatch:', dispatch(90, 60))).toEqual([]);
    expect(at('  workflow_dispatch:', dispatch(89, 60))).toEqual(['a dispatch gets 89 minutes, under the 90 it needs']);
    expect(at('  workflow_dispatch:', dispatch(120, 60), 'macos-26')).toEqual([
      'a dispatch gets 120 minutes, under the 135 it needs'
    ]);
    expect(at('  workflow_dispatch:', `${dispatch(90, 60)} # why`)).toEqual([]);
    expect(at('  push:', '60')).toEqual([]);
    expect(at('  workflow_dispatch:', '60', 'ubuntu-latest', [frozen])).toEqual([]);
    expect(at('  pull_request:\n  workflow_dispatch:', '60')).toEqual([]);
    const prGated = `${guardian}\n        if: github.event_name != 'pull_request'`;
    expect(at('  pull_request:\n  workflow_dispatch:', '60', 'ubuntu-latest', [webSdk, prGated, frozen])).toHaveLength(
      1
    );
    expect(at('  workflow_dispatch:', dispatch(119, 60), 'warp-ubuntu-latest-arm64-2x')).toEqual([
      'a dispatch gets 119 minutes, under the 120 it needs'
    ]);
    expect(at('  workflow_dispatch:', dispatch(120, 60), 'warp-ubuntu-latest-arm64-2x')).toEqual([]);
    for (const runner of ['self-hosted', 'ubuntu-24.04-arm', 'warp-ubuntu-latest-arm64-4x'])
      expect(() => at('  workflow_dispatch:', dispatch(200, 60), runner)).toThrow('no recorded injection time');
  });

  it('exempts only a job its pull request runs reach, through its own if: and every job it needs', () => {
    const ceilings = (text: string): string[] =>
      jobs('x.yml', text).flatMap(job => {
        const why = ceilingViolation('x.yml', text, job);
        return why === undefined ? [] : [`${job.id}: ${why}`];
      });
    const both = '  pull_request:\n  workflow_dispatch:';
    const gated = (condition: string): string =>
      workflow(both, [webSdk, guardian, frozen]).replace(
        '    runs-on: ubuntu-latest\n',
        `    if: ${condition}\n    runs-on: ubuntu-latest\n    timeout-minutes: 60\n`
      );
    const chained = (needs: string, selectIf: string): string =>
      `name: x\non:\n${both}\njobs:\n  select:\n    if: ${selectIf}\n    runs-on: ubuntu-slim\n    steps:\n` +
      `      - run: echo\n  build:\n    needs: ${needs}\n    runs-on: ubuntu-latest\n    timeout-minutes: 60\n` +
      `    steps:\n${[webSdk, guardian, frozen].map(step => `      - ${step}\n`).join('')}`;
    const flagged = ['build: timeout-minutes 60 gives a dispatch no more than a push'];
    const skipsPullRequests = "github.event_name != 'pull_request'";
    const reachesMain = `${skipsPullRequests} || github.event.pull_request.base.ref == 'main'`;
    expect(ceilings(gated(skipsPullRequests))).toEqual(flagged);
    expect(ceilings(gated(`\${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}`))).toEqual(
      flagged
    );
    expect(ceilings(gated("needs.a.outputs.run == 'true' && github.event_name != 'Pull_Request'"))).toEqual(flagged);
    expect(ceilings(gated(reachesMain))).toEqual([]);
    expect(ceilings(gated(`\${{ ${reachesMain} }}`))).toEqual([]);
    expect(ceilings(gated("github.event_name == 'pull_request' && needs.a.outputs.run == 'true'"))).toEqual([]);
    expect(ceilings(chained('select', skipsPullRequests))).toEqual(flagged);
    expect(ceilings(chained('[select]', skipsPullRequests))).toEqual(flagged);
    expect(ceilings(chained('[select]', reachesMain))).toEqual([]);
    for (const unread of [`\${{ !cancelled() }}`, `"${skipsPullRequests}"`, `>-\n      ${skipsPullRequests}`])
      expect(() => ceilings(gated(unread))).toThrow('cannot read the job if:');
    expect(() => ceilings(chained('\n      - select', reachesMain))).toThrow('cannot read the job needs:');
  });

  it('throws on a shape it does not read instead of passing it', () => {
    expect(() => workflowViolations('x.yml', 'name: x\njobs:\n  a:\n    steps: []\n')).toThrow('no top-level on:');
    expect(() => workflowViolations('x.yml', workflow('  push:', [frozen]).replace('  build:', '  "build":'))).toThrow(
      'not a job id'
    );
    expect(() => workflowViolations('x.yml', workflow('  push:', []).replace('steps:\n', 'steps: []\n'))).toThrow(
      'steps: with an inline value'
    );
    expect(() => jobs('x.yml', workflow('  push:', [frozen]).replace(/^ {4}(?=\S)/gm, '      '))).toThrow(
      'not job keys indented 4'
    );
  });
});

describe('both injections read the pull request the resolver picks', () => {
  // A merge that keeps an older copy of an action drops the resolver and quietly turns every dispatch into a no-op.
  it.each([WEB_SDK, GUARDIAN])('%s resolves the number first and reads the event only through it', action => {
    const text = readFileSync(resolve(__dirname, '../../..', action, 'action.yml'), 'utf8');
    const heads = [...text.matchAll(/^ {4}- (.*)$/gm)].map(match => match[1]);
    expect(heads.slice(0, 2)).toEqual(['id: pr', 'id: parse']);
    const pr = text.slice(text.indexOf('    - id: pr\n'), text.indexOf('    - id: parse\n'));
    expect(pr).toContain(`scripts/resolve-linked-pr-number.sh" ${action.split('/').pop()}\n`);
    expect(text.match(/github\.event\.pull_request\.number/g)).toHaveLength(1);
    expect(pr).toMatch(/PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
    expect(text).toMatch(/\n {8}PR_NUMBER: \$\{\{ steps\.pr\.outputs\.number \}\}\n/);
  });
});

describe('the Guardian injection on a Windows runner', () => {
  it("keeps a Windows RUNNER_TEMP's backslashes in the file: dependency it writes", () => {
    const action = readFileSync(
      resolve(__dirname, '../../../.github/actions/inject-linked-guardian-pr/action.yml'),
      'utf8'
    ).split('\n');
    // The package.json rewrite, from its `cd` to the heredoc's end, dedented as YAML hands it to bash.
    const start = action.findIndex(line => line.trim() === 'cd "$GITHUB_WORKSPACE"');
    const end = action.findIndex((line, at) => at > start && line.trim() === 'EOF');
    expect([start > 0, end > start]).toEqual([true, true]);
    const script = action
      .slice(start, end + 1)
      .map(line => line.replace(/^ {8}/, ''))
      .join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'guardian-rewrite-'));
    try {
      const pinned = { '@openzeppelin/miden-multisig-client': '0.18.0', '@openzeppelin/guardian-client': '0.18.0' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: pinned }));
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_WORKSPACE: dir,
          GUARDIAN_DIR: 'D:\\a\\_temp/guardian-pr',
          PKG_SUBDIR: 'packages/miden-multisig-client'
        }
      });
      expect([result.status, result.stderr]).toEqual([0, '']);
      const written: { dependencies: Record<string, string> } = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8')
      );
      expect(written.dependencies['@openzeppelin/miden-multisig-client']).toBe(
        'file:D:\\a\\_temp/guardian-pr/packages/miden-multisig-client'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
