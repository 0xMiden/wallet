import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { listPlaywrightTests } from './playwright-list';

/**
 * The dedicated-suite configs spread `playwright.e2e.config`, whose `testIgnore`
 * excludes the very directories those suites exist to run (`**​/swap/**`,
 * `**​/resilience/**`). Inheriting it selects NOTHING — and a Playwright run that
 * matches no spec exits 0, so the job reads green while covering nothing. Each
 * config must therefore override `testIgnore` explicitly.
 *
 * Asserted on the config SOURCE rather than by importing it: `defineConfig`
 * returns the object unchanged, so the override is exactly this literal, and
 * reading the file keeps @playwright/test out of the jest module graph.
 */
const repoRoot = resolve(__dirname, '../../..');

const configSource = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

/** The json reports a real Playwright run leaves; listing tests must not rewrite them. */
const reportFiles = ['test-results/results.json', 'test-results-stress/results.json'];
const reportStamp = (file: string) => statSync(resolve(repoRoot, file), { throwIfNoEntry: false })?.mtimeMs ?? null;
let reportsBefore: (number | null)[];

beforeAll(() => {
  reportsBefore = reportFiles.map(reportStamp);
});

/** Configs whose testDir the base config ignores. */
const overridingConfigs = ['playwright.resilience.config.ts', 'playwright.swap.config.ts'];

describe('dedicated e2e configs override the base testIgnore', () => {
  it.each(overridingConfigs)('%s clears the inherited ignore list', file => {
    const testIgnore = /testIgnore:\s*(.+)/.exec(configSource(file))?.[1];
    expect(testIgnore).toMatch(/^undefined,?$/);
  });

  it('the base config is the reason the override is required', () => {
    const base = configSource('playwright.e2e.config.ts');
    const testIgnore = /testIgnore:\s*(.+)/.exec(base)?.[1];
    expect(testIgnore).toMatch(/resilience/);
    expect(testIgnore).toMatch(/swap/);
  });
});

function listGuardianTests(suite?: string): string {
  return listPlaywrightTests('playwright.guardian.config.ts', { GUARDIAN_E2E_SUITE: suite });
}

const MAIN_ONLY = [
  'guardian-fault.smoke.spec.ts',
  'guardian-recovery-stress.spec.ts',
  'guardian-switch-stress.spec.ts'
];

describe('guardian e2e suite split', () => {
  let prList: string;
  let fullList: string;
  let fullNamedList: string;

  beforeAll(() => {
    prList = listGuardianTests('pr');
    fullList = listGuardianTests();
    fullNamedList = listGuardianTests('full');
  });

  it('PR suite drops stress and fault.smoke', () => {
    for (const spec of MAIN_ONLY) {
      expect(prList).not.toContain(spec);
    }
    expect(prList).toContain('guardian-onboarding-create.spec.ts');
    expect(prList).toContain('guardian-send-consume.spec.ts');
    expect(prList).toContain('guardian-switch.spec.ts');
  });

  it('full suite (unset or GUARDIAN_E2E_SUITE=full) keeps stress and fault.smoke', () => {
    for (const spec of MAIN_ONLY) {
      expect(fullList).toContain(spec);
      expect(fullNamedList).toContain(spec);
    }
  });

  it('the on-disk guardian specs still include the main-only files', () => {
    const root = resolve(repoRoot, 'playwright/e2e/tests');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/^guardian-.*\.spec\.ts$/.test(ent.name)) files.push(ent.name);
      }
    };
    walk(root);
    expect(files.sort()).toEqual(expect.arrayContaining(MAIN_ONLY));
  });
});

describe('PR workflows skip the heavy swap and earn jobs', () => {
  it('swap-e2e is skipped on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-swap.yml');
    expect(src).toMatch(/if: github\.event_name != 'pull_request'/);
  });

  it('earn-e2e is skipped on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-earn.yml');
    expect(src).toMatch(/if: github\.event_name != 'pull_request'/);
    expect(src).not.toMatch(/select-earn-e2e/);
  });

  it('local-e2e has no fast-blocks matrix and uses 500ms blocks', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).not.toMatch(/fast blocks/);
    expect(src).not.toMatch(/strategy:/);
    expect(src).toMatch(/'local-e2e \(chrome\)'/);
    expect(src).toMatch(/runs-on: warp-ubuntu-latest-x64-8x/);
    expect(src).toMatch(/MIDEN_NODE_BLOCK_INTERVAL: 500ms/);
  });

  it('coverage is sharded and gated under the required check name', () => {
    const src = configSource('.github/workflows/pr.yml');
    expect(src).toMatch(/shard: \[1, 2, 3\]/);
    expect(src).toMatch(/name: Coverage Check \(95% minimum\)/);
    expect(src).toMatch(/merge-jest-coverage\.mjs/);
  });
});

/** The `run: |` body of the step that follows `anchor` (a job or step name line), with its original indentation kept. */
const runBlockAfter = (file: string, anchor: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line.trim() === anchor);
  // A missing anchor (start === -1) would otherwise make `i > start` true for every
  // line, silently matching the file's first run: | block instead of failing loudly.
  if (start === -1) throw new Error(`no anchor ${JSON.stringify(anchor)} found in ${file}`);
  const runAt = lines.findIndex((line, i) => i > start && /^\s*(- )?run: \|$/.test(line));
  const runLine = lines[runAt];
  // noUncheckedIndexedAccess: findIndex's -1-not-found case reads as undefined here too.
  if (runLine === undefined) throw new Error(`no run: | found after ${anchor} in ${file}`);
  const indent = runLine.search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body.join('\n');
};

/** The `on:` block (event triggers), by indentation, as a single string. */
const onBlock = (file: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line === 'on:');
  if (start === -1) throw new Error(`no on: block found in ${file}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= 0) break;
    body.push(line);
  }
  return body.join('\n');
};

/**
 * Runs a gate's shell with `values` supplied as env vars, the way a step's own `env:`
 * block would. Any `${{ ... }}` GitHub Actions expression still left in the script text
 * (a gate that has not moved its data through `env:`) is filled from `values` too, so
 * every such expression must have a matching value or this throws.
 */
const gateExit = (script: string, values: Record<string, string>): number | null => {
  const filled = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value = values[expr];
    if (value === undefined) throw new Error(`no value for ${expr}`);
    return value;
  });
  return spawnSync('bash', ['-eo', 'pipefail', '-c', filled], {
    stdio: 'pipe',
    env: { ...process.env, ...values }
  }).status;
};

const REQUIRED_NAMES = ['local-e2e (chrome)', 'guardian-lifecycle-e2e-gate', 'bridge-guardian-e2e-gate'];
const WORKFLOW_FILES = [
  '.github/workflows/pr-e2e-local.yml',
  '.github/workflows/pr-e2e-guardian-lifecycle.yml',
  '.github/workflows/pr-e2e-bridge-guardian.yml'
];
const combinedWorkflowSource = (): string => WORKFLOW_FILES.map(configSource).join('\n');

/** The FULL condition guarding a job's computed `name: ${{ (FULL) && '<required>' || '<required> (stacked)' }}`. */
const fullFromName = (file: string): string => {
  const match = /name:\s*\$\{\{\s*\(([\s\S]+?)\)\s*&&/.exec(configSource(file));
  if (!match) throw new Error(`no computed name found in ${file}`);
  return match[1]!.trim();
};

describe('a stacked pull request reports its E2E checks under names no branch requires', () => {
  const baseChangeFile = '.github/workflows/pr-e2e-base-change.yml';

  it('pr-e2e-base-change.yml does not exist', () => {
    expect(existsSync(resolve(repoRoot, baseChangeFile))).toBe(false);
  });

  it('no gh api read of a pull request, no judged_base output, and no local-e2e-base job', () => {
    const src = combinedWorkflowSource();
    expect(src).not.toMatch(/gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER"/);
    expect(src).not.toMatch(/judged_base/);
    expect(src).not.toMatch(/local-e2e-base/);
  });

  it('chrome-local has no needs: the removed pre-job left nothing to depend on', () => {
    expect(configSource('.github/workflows/pr-e2e-local.yml')).not.toMatch(/\n\s+needs:/);
  });

  it.each(REQUIRED_NAMES)('%s is reported as itself or as (stacked), never as a bare literal name', required => {
    const src = combinedWorkflowSource();
    const escaped = required.replace(/[()]/g, '\\$&');
    expect(src).toMatch(
      new RegExp(
        `name:\\s*\\$\\{\\{\\s*\\([\\s\\S]+?\\)\\s*&&\\s*'${escaped}'\\s*\\|\\|\\s*'${escaped} \\(stacked\\)'\\s*\\}\\}`
      )
    );
    expect(src).not.toMatch(new RegExp(`\\n\\s+name: ${escaped}\\n`));
  });

  it("chrome-local's if: matches the FULL condition inside its own computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    const ifMatch = /\n\s+if: \$\{\{ (github\.event_name[\s\S]+?) \}\}\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(fullFromName('.github/workflows/pr-e2e-local.yml'));
  });

  it("bridge-guardian-e2e's if: matches the FULL condition inside its gate's computed name", () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    const ifMatch = /\n\s+if: (github\.event_name[\s\S]+?)\n/.exec(src);
    expect(ifMatch).not.toBeNull();
    expect(ifMatch![1]!.trim()).toBe(fullFromName('.github/workflows/pr-e2e-bridge-guardian.yml'));
  });
});

describe('bridge-guardian-e2e-gate reads BASE_REF from the event payload, with no live read', () => {
  it('the step env reads EVENT_NAME, BASE_REF and RESULT, all from the event or needs', () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    expect(src).toMatch(/EVENT_NAME: \$\{\{ github\.event_name \}\}/);
    expect(src).toMatch(/BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
    expect(src).toMatch(/RESULT: \$\{\{ needs\.bridge-guardian-e2e\.result \}\}/);
  });

  it.each<[string, string | undefined, string, number]>([
    ['pull_request', 'feature', 'skipped', 0],
    ['pull_request', 'feature', 'success', 1],
    ['pull_request', 'feature', 'failure', 1],
    ['pull_request', 'main', 'success', 0],
    ['pull_request', 'main', 'skipped', 1],
    ['pull_request', 'main', 'failure', 1],
    ['pull_request', 'next', 'success', 0],
    ['pull_request', 'next', 'skipped', 1],
    ['pull_request', 'next', 'failure', 1],
    ['push', undefined, 'success', 0],
    ['push', undefined, 'skipped', 1],
    ['workflow_dispatch', undefined, 'success', 0]
  ])('event=%s base=%s result=%s -> exit %i', (eventName, base, result, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'bridge-guardian-e2e-gate:');
    const status = gateExit(script, {
      EVENT_NAME: eventName,
      BASE_REF: base ?? '',
      RESULT: result
    });
    expect(status).toBe(expected);
  });
});

describe('guardian-lifecycle-e2e-gate keeps its selector and run logic, with no live-base arm', () => {
  it('the gate script contains no live base read', () => {
    const script = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', 'guardian-lifecycle-e2e-gate:');
    expect(script).not.toMatch(/gh api/);
    expect(script).not.toMatch(/JUDGED_BASE/);
    expect(script).not.toMatch(/LIVE_BASE/);
  });

  it.each<[string, string, string, number]>([
    ['success', 'false', 'skipped', 0],
    ['success', 'true', 'skipped', 1],
    ['success', 'true', 'success', 0],
    ['failure', 'true', 'success', 1]
  ])('select=%s run=%s e2e=%s -> exit %i', (selectResult, selected, e2eResult, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', 'guardian-lifecycle-e2e-gate:');
    const status = gateExit(script, {
      'needs.select-guardian-e2e.result': selectResult,
      'needs.select-guardian-e2e.outputs.run': selected,
      'needs.guardian-lifecycle-e2e.result': e2eResult
    });
    expect(status).toBe(expected);
  });
});

describe('PR workflows run the heavy E2E jobs only on a pull request based on main or next', () => {
  it("the Guardian selector's BASE_REF and BASE_SHA come from the event payload, and select outputs no judged_base", () => {
    const src = configSource('.github/workflows/pr-e2e-guardian-lifecycle.yml');
    expect(src).toMatch(/BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
    expect(src).toMatch(/BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    expect(src).not.toMatch(/judged_base/);
  });

  it('the pull-request step outputs only the body: no base_ref or base_sha', () => {
    const src = configSource('.github/workflows/pr-e2e-guardian-lifecycle.yml');
    expect(src).toMatch(/core\.setOutput\('body', data\.body \?\? ''\);/);
    expect(src).not.toMatch(/core\.setOutput\('base_ref'/);
    expect(src).not.toMatch(/core\.setOutput\('base_sha'/);
  });

  it('the Guardian selector keeps a pull request based on main or next, and deselects any other branch, marker or not', () => {
    const body = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', '- name: Check changed paths');
    const arms = [
      { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'feature', PR_BODY: 'Guardian PR: #5', expected: 'run=false' },
      { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'main', PR_BODY: 'Guardian PR: #5', expected: 'run=true' },
      { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'next', PR_BODY: 'Guardian PR: #5', expected: 'run=true' },
      { GITHUB_EVENT_NAME: 'push', BASE_REF: '', PR_BODY: '', expected: 'run=true' }
    ];
    for (const { GITHUB_EVENT_NAME, BASE_REF, PR_BODY, expected } of arms) {
      const dir = mkdtempSync(join(tmpdir(), 'guardian-select-'));
      const outputFile = join(dir, 'output');
      try {
        const result = spawnSync('bash', ['-eo', 'pipefail', '-c', body], {
          cwd: repoRoot,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME,
            BASE_REF,
            PR_BODY,
            BASE_SHA: '',
            HEAD_SHA: '',
            GITHUB_OUTPUT: outputFile
          }
        });
        expect(result.status).toBe(0);
        expect(readFileSync(outputFile, 'utf8')).toContain(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('the E2E workflows trigger on exactly their intended events, so no label re-runs a gate', () => {
    expect(onBlock('.github/workflows/pr-e2e-local.yml')).toBe('  pull_request:\n  workflow_dispatch: {}');
    expect(onBlock('.github/workflows/pr-e2e-guardian-lifecycle.yml')).toBe(
      '  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch: {}'
    );
    expect(onBlock('.github/workflows/pr-e2e-bridge-guardian.yml')).toBe(
      '  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch: {}'
    );
  });

  it('runBlockAfter throws when the anchor is not found, instead of matching the first run block in the file', () => {
    expect(() => runBlockAfter('.github/workflows/pr-e2e-local.yml', 'this anchor does not exist anywhere')).toThrow(
      'no anchor "this anchor does not exist anywhere" found in .github/workflows/pr-e2e-local.yml'
    );
  });
});

/** Configs whose testDir also holds Jest suites, which Playwright's default testMatch would load and fail on. */
const jestSharingConfigs = [
  { config: 'playwright.stress.config.ts', spec: 'stress.spec.ts' },
  { config: 'playwright.store-listing.config.ts', spec: 'store-listing.capture.spec.ts' }
];

describe('configs whose testDir holds Jest suites load only their Playwright specs', () => {
  it.each(jestSharingConfigs)('$config', ({ config, spec }) => {
    const list = listPlaywrightTests(config);
    expect(list).toContain(spec);
    expect(list).not.toMatch(/\.test\.ts/);
  });
});

// Declared last: Jest runs this file's tests in order, so the check sees every list run above.
describe('list runs write no report files', () => {
  it('leaves every json report as it was', () => {
    expect(reportFiles.map(reportStamp)).toEqual(reportsBefore);
  });
});
