/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('Expected workflow mapping');
  return value;
}
const document = object(
  YAML.parse(readFileSync(resolve(__dirname, '../.github/workflows/e2e-mainnet-nightly.yml'), 'utf8'))
);
const jobs = object(document.jobs);
const main = object(jobs['mainnet-nightly']);
const steps = Array.isArray(main.steps) ? main.steps.filter(record) : [];
const index = (name: string) => steps.findIndex(step => step.name === name);
function step(name: string): Record<string, unknown> {
  const found = steps.find(entry => entry.name === name);
  if (!found) throw new Error(`Missing workflow step ${name}`);
  return found;
}

describe('funded nightly swap workflow', () => {
  it('restores and reconciles prior swaps before any shared Guardian send', () => {
    expect(index('Recover prior mainnet swap')).toBeGreaterThan(-1);
    expect(index('Recover prior mainnet swap')).toBeLessThan(index('Run native mainnet round trip'));
    expect(object(step('Restore prior swap checkpoint').with)['github-token']).toBe('${{ github.token }}');
  });
  it.each(['forward', 'reverse'])('uploads durable %s authorization before its single funded stage', leg => {
    const upload = `Upload mainnet swap ${leg} authorization`;
    const execute = `Run mainnet swap ${leg}`;
    expect(index(upload)).toBeGreaterThan(-1);
    expect(index(upload)).toBeLessThan(index(execute));
    expect(object(step(upload).with)['if-no-files-found']).toBe('error');
    expect(step(execute).run).toContain(`MAINNET_SWAP_MODE=${leg}`);
    expect(step(execute).run).toContain('--retries=0');
    expect(step(execute)['continue-on-error']).toBeUndefined();
  });
  it('retains failure state without uploading secrets or browser artifacts', () => {
    const final = step('Retain mainnet swap checkpoint');
    expect(final.if).toContain('always()');
    expect(object(final.with).path).toBe('test-results/mainnet-swap-state/roundtrip.json');
    expect(object(final.with)['if-no-files-found']).toBe('error');
    expect(object(document.concurrency)['cancel-in-progress']).toBe(false);
    expect(object(document.concurrency).group).toBe('e2e-mainnet-nightly');
  });
  it('keeps bridge work independent of swap failure but away from a recovery-only or swaps-only run', () => {
    expect(step('Run USDCx bridge loops and read-only 1Click preflight').if).toContain('!cancelled()');
    expect(step('Run USDCx bridge loops and read-only 1Click preflight').if).toContain('recovery_only');
    expect(object(jobs['mainnet-agglayer']).if).toContain('swaps_only');
    expect(object(jobs['mainnet-agglayer']).if).toContain('recovery_only');
  });
});
