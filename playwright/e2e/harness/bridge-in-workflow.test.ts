/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const workflow = readFileSync(resolve(root, '.github/workflows/e2e-bridge-in.yml'), 'utf8');
const config = readFileSync(resolve(root, 'playwright.ios.bridge-in.config.ts'), 'utf8');

/** The suite's test step, from its name to the next step. */
function testStep(): string {
  const at = workflow.indexOf('      - name: Run bridge-IN E2E');
  if (at === -1) throw new Error('no bridge-IN test step');
  const next = workflow.indexOf('\n      - ', at + 1);
  return workflow.slice(at, next === -1 ? workflow.length : next);
}

describe('E2E Bridge-IN workflow', () => {
  // With the base config's maxFailures 1, one failed spec hid every spec after it: the Reown pairing spec did not run
  // from 2026-10-14 to 2026-10-17.
  it('runs every spec even after one failed', () => {
    expect(config).toMatch(/^ {2}maxFailures: 0,$/m);
  });

  // With retries, a test that fails once and then passes reads flaky and exits 0, so a fix is proven at retries 0.
  it('takes its retries from a dispatch input, 2 unless a dispatch says otherwise', () => {
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n {4}inputs:\n {6}retries:\n/);
    expect(testStep()).toMatch(/\n {10}RETRIES: \$\{\{ inputs\.retries \|\| '2' \}\}\n/);
    expect(testStep()).toMatch(
      /\n {8}run: yarn playwright test --config playwright\.ios\.bridge-in\.config\.ts --retries="\$RETRIES"\n/
    );
  });

  // The suite is the bridge-in deposit's only hermetic E2E; continue-on-error kept main green through a real
  // regression (#1453 to #1478) and through three days in which one spec failed every run.
  it('fails its run when a spec fails', () => {
    expect(testStep()).not.toMatch(/^ {8}continue-on-error:/m);
  });
});
