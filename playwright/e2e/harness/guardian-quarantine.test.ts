import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The 0.16 guardian quarantine (#522), enforced at the spec-SELECTION layer.
 *
 * No `@openzeppelin/miden-multisig-client` release targets Miden 0.16, so every
 * spec that creates a guardian account fails. A mixed suite excludes its guardian
 * spec via `testIgnore` (swap, resilience); the guardian-only jobs are disabled at
 * the job level instead (`if: false` in pr-e2e-guardian-lifecycle /
 * pr-e2e-bridge-guardian — which is also where bridge-out-epoch-guardian is
 * handled, so playwright.bridge.config.ts is not part of this). The resilience
 * config was missed by that sweep: its
 * three guardian specs each burn `retries: 2` and, with the base config's
 * `maxFailures: 3` on localnet, abort the run before `network-faults-policy` and
 * `node-outage-recovery` ever execute — so the suite's real subject silently
 * stops running while the red job reads as "known guardian noise".
 *
 * Asserted on the config SOURCE rather than by importing it: `defineConfig`
 * returns the object unchanged, so the ignore list is exactly this literal, and
 * reading the file keeps @playwright/test out of the jest module graph.
 */
const repoRoot = resolve(__dirname, '../../..');

const configSource = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

/** Mixed suite configs whose testDir contains at least one `guardian-*.spec.ts`. */
const quarantinedConfigs = ['playwright.resilience.config.ts', 'playwright.swap.config.ts'];

describe('guardian specs are quarantined on 0.16 (#522)', () => {
  it.each(quarantinedConfigs)('%s excludes its guardian spec(s) via testIgnore', file => {
    const source = configSource(file);
    const testIgnore = /testIgnore:\s*(.+)/.exec(source)?.[1];
    expect(testIgnore).toMatch(/guardian/);
  });

  it('names the tracking issue so the quarantine can be lifted deliberately', () => {
    for (const file of quarantinedConfigs) {
      expect(configSource(file)).toContain('#522');
    }
  });

  it('the resilience suite still selects its non-guardian specs', () => {
    // The base config ignores `**/resilience/**` wholesale, so inheriting it
    // would select nothing at all — the quarantine must narrow, not inherit.
    const source = configSource('playwright.resilience.config.ts');
    expect(source).toContain("testDir: './playwright/e2e/tests/resilience'");
    expect(source).not.toContain('testIgnore: undefined');
    expect(/testIgnore:\s*(.+)/.exec(source)?.[1]).not.toMatch(/resilience/);
  });
});
