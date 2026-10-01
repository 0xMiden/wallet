import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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

  // 0.17 expires a transaction 20 blocks after its reference block, so 500ms blocks left 10s
  // for a proof plus sync lag and the node dropped accepted transactions.
  it('local-e2e has no fast-blocks matrix and runs the node at its default 3s cadence', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).not.toMatch(/fast blocks/);
    expect(src).not.toMatch(/strategy:/);
    expect(src).toMatch(/name: local-e2e \(chrome\)/);
    expect(src).toMatch(/runs-on: warp-ubuntu-latest-x64-8x/);
    expect(src).not.toMatch(/MIDEN_NODE_BLOCK_INTERVAL:/);
  });

  it('coverage is sharded and gated under the required check name', () => {
    const src = configSource('.github/workflows/pr.yml');
    expect(src).toMatch(/shard: \[1, 2, 3\]/);
    expect(src).toMatch(/name: Coverage Check \(95% minimum\)/);
    expect(src).toMatch(/merge-jest-coverage\.mjs/);
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
