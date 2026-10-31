import { OFFSCREEN_PROOF_BUDGET_MS } from 'lib/miden/guardian/proof-freshness';
import { DELEGATED_PROVE_TIMEOUT_MS } from 'lib/miden/sdk/delegated-prove-timeout';
import { defineEntry, defineSource, occurrences, readSource, viteConfigs } from 'lib/testing/define-parity';

// A define replaces the whole `process.env` read, so a bundle never reaches the proxy's own fallback. Jest does, and
// reads a deadline no user runs unless the two are held equal: #1659 raised only the fallback.
const SHIPPED_DEADLINE_MS = 180_000;
const DEADLINE_READ = `process.env.MIDEN_WRITE_DEADLINE_MS ?? '${SHIPPED_DEADLINE_MS}'`;

describe('the write deadline each bundle ships', () => {
  it('finds the build configs', () => {
    expect(viteConfigs()).toEqual([
      'vite.background.config.ts',
      'vite.contentScripts.config.ts',
      'vite.desktop.config.ts',
      'vite.extension.config.ts',
      'vite.mobile.config.ts'
    ]);
  });

  it.each(viteConfigs())('%s defines the deadline the proxy falls back to', config => {
    const defines = defineSource(readSource(config));
    expect(occurrences(defines, `'process.env.MIDEN_WRITE_DEADLINE_MS':`)).toBe(1);
    expect(defines).toMatch(defineEntry('MIDEN_WRITE_DEADLINE_MS', DEADLINE_READ));
  });

  it('is the one the proxy falls back to', () => {
    expect(readSource('src/lib/miden/back/miden-client-proxy.ts')).toContain(`Number(${DEADLINE_READ})`);
  });

  it('outlasts a wait on a silent remote prover, or its local fallback never runs', () => {
    expect(SHIPPED_DEADLINE_MS).toBeGreaterThan(DELEGATED_PROVE_TIMEOUT_MS);
  });

  it('leaves a Guardian leaf time to submit after its last stale-proof pass (#2060)', () => {
    expect(SHIPPED_DEADLINE_MS - OFFSCREEN_PROOF_BUDGET_MS).toBeGreaterThanOrEqual(15_000);
  });
});
