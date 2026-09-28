import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
const playwright = resolve(repoRoot, 'node_modules/.bin/playwright');

const configSource = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

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
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_NETWORK: 'localhost' };
  delete env.JEST_WORKER_ID;
  if (suite === undefined) delete env.GUARDIAN_E2E_SUITE;
  else env.GUARDIAN_E2E_SUITE = suite;
  return execFileSync(playwright, ['test', '--list', '--config', 'playwright.guardian.config.ts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
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
    expect(src).toMatch(/name: local-e2e \(chrome\)/);
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

/** Runs a gate's shell with its `${{ ... }}` expressions filled in; every expression must be given. */
const gateExit = (script: string, values: Record<string, string>): number | null => {
  const filled = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
    const value = values[expr];
    if (value === undefined) throw new Error(`no value for ${expr}`);
    return value;
  });
  return spawnSync('bash', ['-eo', 'pipefail', '-c', filled], { stdio: 'pipe' }).status;
};

describe('PR workflows run the heavy E2E jobs only on a main-based pull request', () => {
  it('local-e2e runs on push, dispatch and a main-based pull request, under its required name', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).toMatch(
      /name: local-e2e \(chrome\)\n\s+if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.base\.ref == 'main'/
    );
  });

  it('bridge-guardian-e2e runs on push, dispatch and a main-based pull request', () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    expect(src).toMatch(
      /name: bridge-guardian-e2e \(chrome\)\n\s+if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.base\.ref == 'main'/
    );
  });

  it.each<[string, string, string, number]>([
    ['pull_request', 'feature', 'skipped', 0],
    ['pull_request', 'main', 'skipped', 1],
    ['pull_request', 'main', 'failure', 1],
    ['pull_request', 'main', 'success', 0],
    ['push', '', 'skipped', 1],
    ['push', '', 'success', 0],
    ['workflow_dispatch', '', 'success', 0]
  ])(
    'bridge-guardian-e2e-gate passes a skipped suite only on a pull request based off main (event=%s base=%s result=%s)',
    (eventName, baseRef, result, expected) => {
      const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'name: bridge-guardian-e2e-gate');
      expect(
        gateExit(script, {
          'github.event_name': eventName,
          'github.event.pull_request.base.ref': baseRef,
          'needs.bridge-guardian-e2e.result': result
        })
      ).toBe(expected);
    }
  );

  it.each<[string, string, string, number]>([
    ['success', 'false', 'skipped', 0],
    ['success', 'true', 'skipped', 1],
    ['success', 'true', 'success', 0]
  ])(
    'guardian-lifecycle-e2e-gate passes a deselected suite and fails a selected one that did not succeed (select=%s run=%s e2e=%s)',
    (selectResult, selected, e2eResult, expected) => {
      const script = runBlockAfter(
        '.github/workflows/pr-e2e-guardian-lifecycle.yml',
        'name: guardian-lifecycle-e2e-gate'
      );
      expect(
        gateExit(script, {
          'needs.select-guardian-e2e.result': selectResult,
          'needs.select-guardian-e2e.outputs.run': selected,
          'needs.guardian-lifecycle-e2e.result': e2eResult
        })
      ).toBe(expected);
    }
  );

  it('the Guardian selector deselects a pull request based off main, marker or not', () => {
    const body = runBlockAfter('.github/workflows/pr-e2e-guardian-lifecycle.yml', '- name: Check changed paths');
    const arms = [
      { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'feature', PR_BODY: 'Guardian PR: #5', expected: 'run=false' },
      { GITHUB_EVENT_NAME: 'pull_request', BASE_REF: 'main', PR_BODY: 'Guardian PR: #5', expected: 'run=true' },
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

  it('the E2E workflows keep their event types, so no label re-runs a gate', () => {
    for (const file of [
      '.github/workflows/pr-e2e-local.yml',
      '.github/workflows/pr-e2e-guardian-lifecycle.yml',
      '.github/workflows/pr-e2e-bridge-guardian.yml'
    ]) {
      expect(configSource(file)).not.toMatch(/labeled/);
    }
  });

  it('runBlockAfter throws when the anchor is not found, instead of matching the first run block in the file', () => {
    expect(() => runBlockAfter('.github/workflows/pr-e2e-local.yml', 'this anchor does not exist anywhere')).toThrow(
      'no anchor "this anchor does not exist anywhere" found in .github/workflows/pr-e2e-local.yml'
    );
  });
});
