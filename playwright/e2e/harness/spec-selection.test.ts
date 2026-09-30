import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/** The job-level `if:` line's value for the job that starts at `anchor` (a `key:` line). */
const jobIfAfter = (file: string, anchor: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line.trim() === anchor);
  if (start === -1) throw new Error(`no anchor ${JSON.stringify(anchor)} found in ${file}`);
  const ifAt = lines.findIndex((line, i) => i > start && /^\s*if:\s/.test(line));
  const ifLine = lines[ifAt];
  if (ifLine === undefined) throw new Error(`no if: found after ${anchor} in ${file}`);
  return ifLine.trim().replace(/^if:\s*/, '');
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

/**
 * The exact condition every stacked-name decision must read. Pinned literally (not just
 * compared for consistency between two jobs) so a mutation that keeps Local and Bridge
 * agreeing with EACH OTHER on a wrong or widened condition -- or that only ever touches
 * one workflow -- still fails: e.g. Guardian's gate accepting any non-empty base.ref, or
 * dropping `next` from Local's name AND its if: together.
 */
const FULL =
  "github.event_name != 'pull_request' || github.event.pull_request.base.ref == 'main' || github.event.pull_request.base.ref == 'next'";

/** Every `.yml`/`.yaml` file directly under `.github/workflows`, repo-root-relative. */
const allWorkflowFiles = (): string[] =>
  readdirSync(resolve(repoRoot, '.github/workflows'))
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => `.github/workflows/${name}`)
    .sort();

/** Strips a `name:` value's surrounding quotes, trailing comment and CR, in that order. */
const normalizeScalar = (raw: string): string => {
  const value = raw.replace(/\r$/, '').trim();
  if (value.startsWith("'") || value.startsWith('"')) {
    const quote = value[0]!;
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const commentAt = value.search(/\s#/);
  return (commentAt === -1 ? value : value.slice(0, commentAt)).trim();
};

type ParsedJob = { jobId: string; rawName: string | null; matrixCombos: string[] | null };

/**
 * Every job under a workflow file's `jobs:` key, parsed from its text: job ids at
 * two-space indent, each job's own `name:` (indent 4, the direct-child level -- never a
 * step's `- name:`) and its `strategy:`/`matrix:` axis values when it has one. No YAML
 * parser is a direct dependency, so this reads text the same way this file's other
 * helpers (`runBlockAfter`, `jobIfAfter`, `onBlock`) already do.
 */
const parseJobs = (text: string): ParsedJob[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const jobsAt = lines.findIndex(line => line === 'jobs:');
  if (jobsAt === -1) return [];
  // jobs: is always the last top-level key in this repo's workflows; the section ends
  // at the next 0-indent, non-blank line, or at EOF.
  let sectionEnd = lines.length;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (lines[i]!.trim() !== '' && /^\S/.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }
  const jobIdAt: number[] = [];
  for (let i = jobsAt + 1; i < sectionEnd; i++) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[i]!)) jobIdAt.push(i);
  }
  return jobIdAt.map((start, k) => {
    const jobId = /^ {2}([A-Za-z0-9_.-]+):/.exec(lines[start]!)![1]!;
    const end = jobIdAt[k + 1] ?? sectionEnd;
    const body = lines.slice(start + 1, end);
    const nameLine = body.find(line => /^ {4}name:\s?/.test(line));
    const rawName = nameLine ? normalizeScalar(nameLine.replace(/^ {4}name:\s?/, '')) : null;
    const matrixAt = body.findIndex(line => /^\s*matrix:\s*$/.test(line));
    let matrixCombos: string[] | null = null;
    if (matrixAt !== -1) {
      const matrixIndent = body[matrixAt]!.search(/\S/);
      const axes: string[][] = [];
      for (const line of body.slice(matrixAt + 1)) {
        const indent = line.search(/\S/);
        if (line.trim() !== '' && indent <= matrixIndent) break;
        const axis = /^\s+[A-Za-z0-9_-]+:\s*\[([^\]]*)\]\s*$/.exec(line);
        if (axis) {
          axes.push(
            axis[1]!
              .split(',')
              .map(v => normalizeScalar(v))
              .filter(v => v !== '')
          );
        }
      }
      if (axes.length > 0) {
        matrixCombos = axes.reduce<string[]>(
          (combos, values) => combos.flatMap(c => values.map(v => (c === '' ? v : `${c}, ${v}`))),
          ['']
        );
      }
    }
    return { jobId, rawName, matrixCombos };
  });
};

/** A token no legitimate name text contains, standing in for a `matrix.` interpolation while the rest of the name is escaped for regex use. */
const MATRIX_WILDCARD_TOKEN = '\u0000';

/** The pattern of everything `name` could render to once its `matrix.` interpolations are substituted with real values. */
const wildcardFromName = (name: string): RegExp => {
  const withToken = name.replace(/\$\{\{[^}]*\bmatrix\.[^}]*\}\}/g, MATRIX_WILDCARD_TOKEN);
  const escaped = withToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.split(MATRIX_WILDCARD_TOKEN).join('.*')}$`);
};

/** The one safe shape: `${{ (FULL) && '<required>' || '<required> (stacked)' }}`, FULL exactly the constant. */
const TERNARY_NAME = /^\$\{\{\s*\(([\s\S]+?)\)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/;

type NameViolation = { file: string; jobId: string; name: string };

/**
 * Every required name one job could report to GitHub other than through the computed
 * FULL form: its `name:` under a condition other than FULL, a matrix-suffixed job id or
 * literal name, or a name whose `matrix.` interpolation could render one.
 */
const jobViolations = (file: string, job: ParsedJob, required: string[]): NameViolation[] => {
  if (job.rawName) {
    const ternary = TERNARY_NAME.exec(job.rawName);
    if (ternary) {
      const condition = ternary[1]!.trim();
      const trueBranch = ternary[2]!;
      const falseBranch = ternary[3]!;
      if (condition === FULL && falseBranch === `${trueBranch} (stacked)`) return [];
      return required.includes(trueBranch) ? [{ file, jobId: job.jobId, name: trueBranch }] : [];
    }
    if (/\$\{\{[^}]*\bmatrix\.[^}]*\}\}/.test(job.rawName)) {
      const pattern = wildcardFromName(job.rawName);
      return required.filter(name => pattern.test(name)).map(name => ({ file, jobId: job.jobId, name }));
    }
  }
  const base = job.rawName ?? job.jobId;
  const candidates = job.matrixCombos ? job.matrixCombos.map(combo => `${base} (${combo})`) : [base];
  return candidates.filter(name => required.includes(name)).map(name => ({ file, jobId: job.jobId, name }));
};

/** Every C-06 violation in one workflow file's text, taking (file, text) so the real tree and synthetic cases share this one code path. */
const workflowViolations = (file: string, text: string): NameViolation[] =>
  parseJobs(text).flatMap(job => jobViolations(file, job, REQUIRED_NAMES));

describe('a stacked pull request reports its E2E checks under names no branch requires', () => {
  it.each(REQUIRED_NAMES)('%s is reported as itself or as (stacked), never as a bare literal name', required => {
    const src = combinedWorkflowSource();
    const escaped = required.replace(/[()]/g, '\\$&');
    expect(src).toMatch(
      new RegExp(
        `name:\\s*\\$\\{\\{\\s*\\([\\s\\S]+?\\)\\s*&&\\s*'${escaped}'\\s*\\|\\|\\s*'${escaped} \\(stacked\\)'\\s*\\}\\}`
      )
    );
  });

  it.each(WORKFLOW_FILES)(
    'the required-name job in %s computes its name from FULL literally, not just some condition',
    file => {
      expect(fullFromName(file)).toBe(FULL);
    }
  );

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

/**
 * Each case is a workflow file name and its full text; every one must be flagged by
 * `workflowViolations`, and none is caught by the narrow, three-file, unquoted-only
 * regex this checker replaces (F-012, F-017).
 */
const nameViolationCases: Array<[string, string, string]> = [
  [
    'a quoted literal equal to a required name',
    'synthetic-quoted.yml',
    "jobs:\n  some-job:\n    name: 'local-e2e (chrome)'\n    runs-on: ubuntu-latest\n"
  ],
  [
    'a required name with a trailing comment',
    'synthetic-commented.yml',
    'jobs:\n  some-job:\n    name: bridge-guardian-e2e-gate # x\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a required name terminated by CRLF',
    'synthetic-crlf.yml',
    'jobs:\r\n  some-job:\r\n    name: bridge-guardian-e2e-gate\r\n    runs-on: ubuntu-latest\r\n'
  ],
  [
    'a guardian-lifecycle-e2e-gate job with no name, reporting via its job id',
    'synthetic-jobid-a.yml',
    'jobs:\n  guardian-lifecycle-e2e-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
  ],
  [
    'a bridge-guardian-e2e-gate job with no name, reporting via its job id',
    'synthetic-jobid-b.yml',
    'jobs:\n  bridge-guardian-e2e-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
  ],
  [
    'a local-e2e job with a browser matrix and no name',
    'synthetic-matrix-id.yml',
    'jobs:\n  local-e2e:\n    strategy:\n      matrix:\n        browser: [chrome]\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a name that interpolates matrix.browser',
    'synthetic-matrix-name.yml',
    'jobs:\n  some-job:\n    name: local-e2e (${{ matrix.browser }})\n    strategy:\n      matrix:\n        browser: [chrome]\n    runs-on: ubuntu-latest\n'
  ],
  [
    'a computed name under a condition other than FULL, in a fourth file',
    'synthetic-wrong-condition.yml',
    "jobs:\n  some-job:\n    name: ${{ (github.event_name == 'pull_request') && 'local-e2e (chrome)' || 'local-e2e (chrome) (stacked)' }}\n    runs-on: ubuntu-latest\n"
  ]
];

describe('no workflow can report a required E2E check name except through the computed full-run form', () => {
  it('the checker passes on every file in .github/workflows today', () => {
    const violations = allWorkflowFiles().flatMap(file => workflowViolations(file, configSource(file)));
    expect(violations).toEqual([]);
  });

  it.each(nameViolationCases)('%s is caught by the broadened checker', (_title, file, text) => {
    expect(workflowViolations(file, text).length).toBeGreaterThan(0);
  });
});

describe('a stacked-named gate skips instead of computing a pass on a stacked pull request', () => {
  it.each([
    ['.github/workflows/pr-e2e-bridge-guardian.yml', 'bridge-guardian-e2e-gate:'],
    ['.github/workflows/pr-e2e-guardian-lifecycle.yml', 'guardian-lifecycle-e2e-gate:']
  ])('%s %s runs only under !cancelled() && (FULL)', (file, anchor) => {
    expect(jobIfAfter(file, anchor)).toBe(`\${{ !cancelled() && (${FULL}) }}`);
  });

  it('the Bridge gate step env holds RESULT from needs.bridge-guardian-e2e.result, with no EVENT_NAME or BASE_REF', () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    const gateSrc = src.slice(src.indexOf('bridge-guardian-e2e-gate:'));
    expect(gateSrc).toMatch(/RESULT: \$\{\{ needs\.bridge-guardian-e2e\.result \}\}/);
    expect(gateSrc).not.toMatch(/EVENT_NAME/);
    expect(gateSrc).not.toMatch(/BASE_REF/);
  });

  it.each<[string, string, string, number]>([
    ['pull_request', 'feature', 'success', 0],
    ['pull_request', 'feature', 'skipped', 1],
    ['pull_request', 'feature', 'failure', 1],
    ['pull_request', 'feature', 'cancelled', 1],
    ['pull_request', 'main', 'success', 0],
    ['pull_request', 'main', 'skipped', 1],
    ['pull_request', 'main', 'failure', 1],
    ['pull_request', 'main', 'cancelled', 1],
    ['pull_request', 'next', 'success', 0],
    ['pull_request', 'next', 'skipped', 1],
    ['pull_request', 'next', 'failure', 1],
    ['pull_request', 'next', 'cancelled', 1],
    ['push', '', 'success', 0],
    ['push', '', 'skipped', 1],
    ['push', '', 'failure', 1],
    ['push', '', 'cancelled', 1]
  ])('the Bridge gate script: event=%s base=%s result=%s -> exit %i', (eventName, base, result, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'bridge-guardian-e2e-gate:');
    const status = gateExit(script, { EVENT_NAME: eventName, BASE_REF: base, RESULT: result });
    expect(status).toBe(expected);
  });
});

describe('guardian-lifecycle-e2e-gate keeps its selector and run logic', () => {
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
  it("select-guardian-e2e's job-level if: pins FULL, so a stacked pull request skips its full-history checkout and pull request read along with it", () => {
    expect(jobIfAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', 'select-guardian-e2e:')).toBe(
      `\${{ ${FULL} }}`
    );
  });

  it('the Guardian selector runs for a pull request into main or next and for push and dispatch', () => {
    const body = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', '- name: Check changed paths');
    const arms = [
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
