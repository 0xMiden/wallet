import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function guardianSpecs(): string[] {
  const root = resolve(repoRoot, 'playwright/e2e/tests');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/^guardian-.*\.spec\.ts$/.test(ent.name)) out.push(ent.name);
    }
  };
  walk(root);
  return out.sort();
}

describe('guardian e2e suite split', () => {
  it('PR suite drops stress and fault.smoke; full suite does not', () => {
    const src = configSource('playwright.guardian.config.ts');
    expect(src).toMatch(/GUARDIAN_E2E_SUITE/);
    expect(src).toMatch(/-stress\\.spec\\.ts/);
    expect(src).toMatch(/guardian-fault\\.smoke\\.spec\\.ts/);
    expect(src).toMatch(/testIgnore: prSuite \? .* : undefined/);
  });

  it('classifies the live guardian specs into PR vs main', () => {
    const files = guardianSpecs();
    const mainOnly = files.filter(f => f.includes('-stress.spec.ts') || f.endsWith('guardian-fault.smoke.spec.ts'));
    expect(mainOnly).toEqual([
      'guardian-fault.smoke.spec.ts',
      'guardian-recovery-stress.spec.ts',
      'guardian-switch-stress.spec.ts'
    ]);
    expect(files).toEqual(
      expect.arrayContaining(['guardian-onboarding-create.spec.ts', 'guardian-send-consume.spec.ts'])
    );
    expect(files.length).toBeGreaterThan(mainOnly.length);
  });
});

describe('PR workflows skip the heavy swap and earn jobs', () => {
  it('swap-e2e is skipped on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-swap.yml');
    expect(src).toMatch(/if: github\.event_name != 'pull_request'/);
  });

  it('earn selector is false on pull_request', () => {
    const src = configSource('.github/workflows/pr-e2e-earn.yml');
    expect(src).toMatch(/GITHUB_EVENT_NAME" = pull_request/);
    expect(src).toMatch(/echo "run=false"/);
  });

  it('local-e2e has no fast-blocks matrix', () => {
    const src = configSource('.github/workflows/pr-e2e-local.yml');
    expect(src).not.toMatch(/fast blocks/);
    expect(src).not.toMatch(/strategy:/);
    expect(src).toMatch(/name: local-e2e \(chrome\)/);
  });
});
