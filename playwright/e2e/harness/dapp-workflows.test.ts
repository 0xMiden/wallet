/**
 * @jest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-dapp.yml'), 'utf8');

const partFiles = (part: string): string[] =>
  workflow.match(new RegExp(`^\\s+${part}\\) files="([a-z -]+)" ;;$`, 'm'))?.[1]?.split(' ') ?? [];

describe('dApp E2E workflow', () => {
  it('runs on merges to main and next and by hand, never on a pull request or a timer', () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main, next\]\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request|schedule:/);
  });

  it('pairs main with testnet and next with devnet, as e2e-blockchain.yml does, and never runs the local stack', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/next' && 'devnet' || 'testnet'");
    expect(workflow).toMatch(/E2E_NETWORK: \$\{\{ matrix\.network \}\}/);
    expect(workflow).not.toMatch(/localhost|local-stack|run-local-node|docker/);
  });

  it('runs every leg to the end on first attempts only and cancels superseded runs', () => {
    expect(workflow).toMatch(/fail-fast: false/);
    expect(workflow).toMatch(/--retries=0/);
    expect(workflow).not.toMatch(/--retries=[1-9]/);
    expect(workflow).toMatch(
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/
    );
  });

  it('bounds the run step and still renders, uploads and judges after it', () => {
    expect(workflow).toMatch(/id: run\n\s+continue-on-error: true\n\s+timeout-minutes: 140/);
    expect(workflow).toMatch(/timeout-minutes: \$\{\{ github\.event_name == 'workflow_dispatch' && 220 \|\| 190 \}\}/);
    for (const step of ['Render matrix', 'Upload records', 'Judge']) {
      expect(workflow).toMatch(new RegExp(`- name: ${step}\\n\\s+if: always\\(\\)`));
    }
    // The report carries each journey's duration against its timeout (spec section 6, flake controls).
    expect(workflow).toContain(
      'node scripts/render-dapp-matrix.mjs test-results/dapp-cells test-results/results.json >> "$GITHUB_STEP_SUMMARY"'
    );
    expect(workflow).toMatch(/render-dapp-matrix\.mjs --gate test-results\/dapp-cells test-results\/results\.json/);
  });

  it('splits the journeys into the two parts of spec section 6 and selects every dApp spec file in one of them', () => {
    expect(partFiles('core')).toEqual(['session', 'signing-and-refusals', 'accounts-and-dapps']);
    expect(partFiles('writes')).toEqual(['wallet-writes-and-notes', 'custom-requests']);
    // A spec file no part names would never run, and the judge sees only the tests a run selected.
    const selected = [...partFiles('core'), ...partFiles('writes')];
    const specs = readdirSync(resolve(__dirname, '../tests/dapp'))
      .filter(name => name.endsWith('.spec.ts'))
      .map(name => name.replace(/\.spec\.ts$/, ''));
    expect(specs).toContain('session');
    expect(selected).toEqual(expect.arrayContaining(specs));
  });
});
