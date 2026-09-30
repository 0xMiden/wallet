import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The `permissions:` block, by indentation, as a single string. */
const permissionsBlock = (file: string): string => {
  const lines = configSource(file).split('\n');
  const start = lines.findIndex(line => line === 'permissions:');
  if (start === -1) throw new Error(`no permissions: block found in ${file}`);
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

/**
 * Writes a stub `gh` on PATH that answers `gh api .../pulls/<n> --jq .base.ref` (a live pull
 * request base) with the STUB_BASE env var on stdout, logging each invocation like the
 * base-change stub (\x1f-joined args, one call per line) so a caller can assert whether it was
 * invoked at all. Exits 1 -- a failed live-base read -- when FAIL_GH is set.
 */
function writeGhBaseStub(dir: string, logFile: string): void {
  writeFileSync(logFile, '');
  const ghPath = join(dir, 'gh');
  writeFileSync(
    ghPath,
    '#!/usr/bin/env bash\n' +
      'printf \'%s\\x1f\' "$@" >> "$LOG_FILE"\n' +
      'printf \'\\n\' >> "$LOG_FILE"\n' +
      'if [ -n "$FAIL_GH" ]; then exit 1; fi\n' +
      'printf \'%s\\n\' "$STUB_BASE"\n'
  );
  chmodSync(ghPath, 0o755);
}

describe('PR workflows run the heavy E2E jobs only on a pull request based on main or next', () => {
  it('chrome-local needs local-e2e-base and fails closed on its fresh read, under its required name', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).toMatch(/\n\s+name: local-e2e \(chrome\)\n/);
    expect(src).toMatch(/\n\s+needs: local-e2e-base\n/);
    expect(src).toMatch(
      /\n\s+if: \$\{\{ !cancelled\(\) && \(needs\.local-e2e-base\.result != 'success' \|\| needs\.local-e2e-base\.outputs\.full == 'true'\) \}\}\n/
    );
  });

  it.each<[string, string | undefined, string]>([
    ['pull_request', 'main', 'full=true'],
    ['pull_request', 'next', 'full=true'],
    ['pull_request', 'feature', 'full=false'],
    ['push', undefined, 'full=true'],
    ['workflow_dispatch', undefined, 'full=true']
  ])('local-e2e-base reads the live pull request base (event=%s base=%s) -> %s', (eventName, base, expected) => {
    const script = runBlockAfter('.github/workflows/pr-e2e-local.yml', 'name: Read pull request base');
    const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
    const logFile = join(dir, 'calls.log');
    const outputFile = join(dir, 'output');
    writeGhBaseStub(dir, logFile);
    writeFileSync(outputFile, '');
    try {
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          STUB_BASE: base ?? '',
          EVENT_NAME: eventName,
          PR_NUMBER: '5',
          REPO: '0xMiden/wallet',
          GH_TOKEN: 'stub-token',
          GITHUB_OUTPUT: outputFile
        }
      });
      expect(result.status).toBe(0);
      expect(readFileSync(outputFile, 'utf8')).toContain(expected);
      expect(readFileSync(logFile, 'utf8').length > 0).toBe(eventName === 'pull_request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local-e2e-base exits non-zero when the live base cannot be read', () => {
    const script = runBlockAfter('.github/workflows/pr-e2e-local.yml', 'name: Read pull request base');
    const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
    const logFile = join(dir, 'calls.log');
    const outputFile = join(dir, 'output');
    writeGhBaseStub(dir, logFile);
    writeFileSync(outputFile, '');
    try {
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          FAIL_GH: '1',
          EVENT_NAME: 'pull_request',
          PR_NUMBER: '5',
          REPO: '0xMiden/wallet',
          GH_TOKEN: 'stub-token',
          GITHUB_OUTPUT: outputFile
        }
      });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bridge-guardian-e2e runs on push, dispatch and a pull request based on main or next', () => {
    const src = configSource('.github/workflows/pr-e2e-bridge-guardian.yml');
    expect(src).toMatch(
      /name: bridge-guardian-e2e \(chrome\)\n(\s*#.*\n)*\s+if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.base\.ref == 'main' \|\| github\.event\.pull_request\.base\.ref == 'next'/
    );
  });

  it.each<[string, string | undefined, string, number]>([
    ['pull_request', 'feature', 'skipped', 0],
    ['pull_request', 'main', 'skipped', 1],
    ['pull_request', 'main', 'failure', 1],
    ['pull_request', 'main', 'success', 0],
    ['pull_request', 'next', 'skipped', 1],
    ['pull_request', 'next', 'failure', 1],
    ['pull_request', 'next', 'success', 0],
    ['pull_request', 'feature', 'failure', 1],
    ['pull_request', 'feature', 'success', 1],
    ['push', undefined, 'skipped', 1],
    ['push', undefined, 'success', 0],
    ['workflow_dispatch', undefined, 'success', 0]
  ])(
    'bridge-guardian-e2e-gate passes a skipped suite only on a pull request whose live base is stacked on another branch (event=%s base=%s result=%s)',
    (eventName, base, result, expected) => {
      const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'name: bridge-guardian-e2e-gate');
      const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
      const logFile = join(dir, 'calls.log');
      writeGhBaseStub(dir, logFile);
      try {
        const status = gateExit(script, {
          PATH: `${dir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          STUB_BASE: base ?? '',
          EVENT_NAME: eventName,
          PR_NUMBER: '5',
          REPO: '0xMiden/wallet',
          GH_TOKEN: 'stub-token',
          RESULT: result
        });
        expect(status).toBe(expected);
        expect(readFileSync(logFile, 'utf8').length > 0).toBe(eventName === 'pull_request');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('ignores an event-supplied BASE_REF: a live main base with a skipped suite still fails', () => {
    const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'name: bridge-guardian-e2e-gate');
    const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
    const logFile = join(dir, 'calls.log');
    writeGhBaseStub(dir, logFile);
    try {
      const status = gateExit(script, {
        PATH: `${dir}:${process.env.PATH}`,
        LOG_FILE: logFile,
        STUB_BASE: 'main',
        BASE_REF: 'feature',
        EVENT_NAME: 'pull_request',
        PR_NUMBER: '5',
        REPO: '0xMiden/wallet',
        GH_TOKEN: 'stub-token',
        RESULT: 'skipped'
      });
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bridge-guardian-e2e-gate exits non-zero when the live base cannot be read', () => {
    const script = runBlockAfter('.github/workflows/pr-e2e-bridge-guardian.yml', 'name: bridge-guardian-e2e-gate');
    const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
    const logFile = join(dir, 'calls.log');
    writeGhBaseStub(dir, logFile);
    try {
      const status = gateExit(script, {
        PATH: `${dir}:${process.env.PATH}`,
        LOG_FILE: logFile,
        FAIL_GH: '1',
        EVENT_NAME: 'pull_request',
        PR_NUMBER: '5',
        REPO: '0xMiden/wallet',
        GH_TOKEN: 'stub-token',
        RESULT: 'success'
      });
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each<[string, string, string, number]>([
    ['success', 'false', 'skipped', 0],
    ['success', 'true', 'skipped', 1],
    ['success', 'true', 'success', 0]
  ])(
    'guardian-lifecycle-e2e-gate passes a deselected suite and fails a selected one that did not succeed, on a push event where the stub is never called (select=%s run=%s e2e=%s)',
    (selectResult, selected, e2eResult, expected) => {
      const script = runBlockAfter(
        '.github/workflows/pr-e2e-guardian-lifecycle.yml',
        'name: guardian-lifecycle-e2e-gate'
      );
      const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
      const logFile = join(dir, 'calls.log');
      writeGhBaseStub(dir, logFile);
      try {
        const status = gateExit(script, {
          'needs.select-guardian-e2e.result': selectResult,
          'needs.select-guardian-e2e.outputs.run': selected,
          'needs.guardian-lifecycle-e2e.result': e2eResult,
          PATH: `${dir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          STUB_BASE: '',
          JUDGED_BASE: '',
          EVENT_NAME: 'push',
          PR_NUMBER: '',
          REPO: '',
          GH_TOKEN: ''
        });
        expect(status).toBe(expected);
        expect(readFileSync(logFile, 'utf8')).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it.each<[string, string, string, string, string, number]>([
    ['feature', 'main', 'success', 'false', 'skipped', 1],
    ['main', 'main', 'success', 'false', 'skipped', 0],
    ['main', 'main', 'success', 'true', 'success', 0]
  ])(
    'guardian-lifecycle-e2e-gate reads the live base and fails a stale judgement (judged=%s live=%s select=%s run=%s e2e=%s)',
    (judgedBase, liveBase, selectResult, selected, e2eResult, expected) => {
      const script = runBlockAfter(
        '.github/workflows/pr-e2e-guardian-lifecycle.yml',
        'name: guardian-lifecycle-e2e-gate'
      );
      const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
      const logFile = join(dir, 'calls.log');
      writeGhBaseStub(dir, logFile);
      try {
        const status = gateExit(script, {
          'needs.select-guardian-e2e.result': selectResult,
          'needs.select-guardian-e2e.outputs.run': selected,
          'needs.guardian-lifecycle-e2e.result': e2eResult,
          PATH: `${dir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          STUB_BASE: liveBase,
          JUDGED_BASE: judgedBase,
          EVENT_NAME: 'pull_request',
          PR_NUMBER: '5',
          REPO: '0xMiden/wallet',
          GH_TOKEN: 'stub-token'
        });
        expect(status).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('guardian-lifecycle-e2e-gate exits non-zero when the live base cannot be read', () => {
    const script = runBlockAfter(
      '.github/workflows/pr-e2e-guardian-lifecycle.yml',
      'name: guardian-lifecycle-e2e-gate'
    );
    const dir = mkdtempSync(join(tmpdir(), 'gh-base-stub-'));
    const logFile = join(dir, 'calls.log');
    writeGhBaseStub(dir, logFile);
    try {
      const status = gateExit(script, {
        'needs.select-guardian-e2e.result': 'success',
        'needs.select-guardian-e2e.outputs.run': 'true',
        'needs.guardian-lifecycle-e2e.result': 'success',
        PATH: `${dir}:${process.env.PATH}`,
        LOG_FILE: logFile,
        FAIL_GH: '1',
        JUDGED_BASE: 'main',
        EVENT_NAME: 'pull_request',
        PR_NUMBER: '5',
        REPO: '0xMiden/wallet',
        GH_TOKEN: 'stub-token'
      });
      expect(status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Guardian selector's base and body come from the pull-request step, not the event, and it outputs judged_base", () => {
    const src = configSource('.github/workflows/pr-e2e-guardian-lifecycle.yml');
    expect(src).toMatch(/BASE_REF: \$\{\{ steps\.pull-request\.outputs\.base_ref \}\}/);
    expect(src).toMatch(/BASE_SHA: \$\{\{ steps\.pull-request\.outputs\.base_sha \}\}/);
    expect(src).toMatch(/judged_base: \$\{\{ steps\.select\.outputs\.judged_base \}\}/);
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

describe('a base change to main or next posts failing required checks until the head runs them', () => {
  const file = '.github/workflows/pr-e2e-base-change.yml';
  const step = '- name: Post failing required checks until the head runs them';
  const REQUIRED_NAMES = ['local-e2e (chrome)', 'guardian-lifecycle-e2e-gate', 'bridge-guardian-e2e-gate'];

  it('runs only on a pull_request_target edited event, with checks: write and no other permission', () => {
    expect(onBlock(file)).toBe('  pull_request_target:\n    types: [edited]');
    expect(permissionsBlock(file)).toBe('  checks: write');
  });

  it("its job's if gates on a base change landing on main or next", () => {
    expect(configSource(file)).toMatch(
      /if: github\.event\.changes\.base\.ref\.from && \(github\.event\.pull_request\.base\.ref == 'main' \|\| github\.event\.pull_request\.base\.ref == 'next'\)/
    );
  });

  it('checks out nothing and keeps every event value out of the run: script', () => {
    expect(configSource(file)).not.toMatch(/actions\/checkout/);
    expect(runBlockAfter(file, step)).not.toMatch(/\$\{\{/);
  });

  it('its own job name is none of the required checks it posts', () => {
    const src = configSource(file);
    for (const name of REQUIRED_NAMES) {
      expect(src).not.toMatch(new RegExp(`\\n\\s+name: ${name.replace(/[()[\]]/g, '\\$&')}\\n`));
    }
  });

  it('posts all three required names as completed failures on the head commit, naming the base', () => {
    const body = runBlockAfter(file, step);
    const stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const logFile = join(stubDir, 'calls.log');
    const ghPath = join(stubDir, 'gh');
    writeFileSync(logFile, '');
    // \x1f (unit separator) joins one call's args on one line: none of gh's real
    // arguments can contain it, unlike the spaces and parens in a required name.
    writeFileSync(
      ghPath,
      '#!/usr/bin/env bash\nprintf \'%s\\x1f\' "$@" >> "$LOG_FILE"\nprintf \'\\n\' >> "$LOG_FILE"\n'
    );
    chmodSync(ghPath, 0o755);
    try {
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', body], {
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          LOG_FILE: logFile,
          REPO: '0xMiden/wallet',
          HEAD_SHA: 'deadbeefcafe',
          BASE: 'main',
          GH_TOKEN: 'stub-token'
        }
      });
      expect(result.status).toBe(0);
      const calls = readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => line.split('\x1f').filter(arg => arg.length > 0));
      expect(calls).toHaveLength(3);
      for (const name of REQUIRED_NAMES) {
        const call = calls.find(args => args.includes(`name=${name}`));
        expect(call).toBeDefined();
        expect(call).toEqual(
          expect.arrayContaining([
            'repos/0xMiden/wallet/check-runs',
            `name=${name}`,
            'head_sha=deadbeefcafe',
            'status=completed',
            'conclusion=failure'
          ])
        );
        expect(call!.some(arg => arg.startsWith('output[title]=Base changed to main:'))).toBe(true);
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
