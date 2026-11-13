/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  it('adds loops_only without redefining swaps_only or enabling public NEAR configuration', () => {
    const inputs = object(object(object(document.on).workflow_dispatch).inputs);
    expect(object(inputs.loops_only)).toMatchObject({ type: 'boolean', default: false });
    expect(object(inputs.swaps_only)).toMatchObject({ type: 'boolean', default: false });
    expect(step('Start owned provider loop config').run).toContain('scripts/mainnet-loop-config-server.mjs');
    expect(step('Start owned provider loop config').run).toContain('MIDEN_REMOTE_CONFIG_URL');
    expect(object(main.env).MAINNET_ONE_CLICK_ENABLED).toBeUndefined();
  });
  it('accepts only a bounded explicit remaining loss allowance without changing the default', () => {
    const inputs = object(object(object(document.on).workflow_dispatch).inputs);
    expect(inputs.loss_budget_usd_micros).toMatchObject({ type: 'string', default: '2000000' });
    expect(object(main.env).MAINNET_LOOP_LOSS_BUDGET_USD_MICROS).toContain('inputs.loss_budget_usd_micros');
  });
  it.each(['', '0', '-1', '2000001', '02000000', '1e6', '1.5', 'unknown'])('rejects unsafe remaining budget before wallet restoration: %s', value => {
    expect(() => execFileSync('bash', ['-c', String(step('Require an original, unambiguous run').run)], {
      env: { ...process.env, GITHUB_RUN_ATTEMPT: '1', SWAPS_ONLY: 'false', LOOPS_ONLY: 'true', MAINNET_SWAP_RECOVERY_RETURN_APPROVED: 'false', MAINNET_LOOP_LOSS_BUDGET_USD_MICROS: value }, stdio: 'pipe'
    })).toThrow();
  });
  it('requires all three provider recoveries to finish before any new native or EVM spending', () => {
    const barrier = index('Clear all-provider recovery barrier');
    expect(barrier).toBeGreaterThan(index('Wait for original NEAR recovery'));
    for (const name of [
      'Recover prior mainnet swap',
      'Wait for original Epoch recovery',
      'Wait for original NEAR recovery'
    ]) {
      expect(index(name)).toBeGreaterThan(-1);
      expect(index(name)).toBeLessThan(barrier);
    }
    for (const name of ['Prepare mainnet solver swap', 'Run native mainnet round trip', 'Run USDCx bridge loops']) {
      expect(index(name)).toBeGreaterThan(barrier);
      expect(step(name).if).toContain("recovery_cleared == 'true'");
    }
    expect(step('Clear all-provider recovery barrier').run).toContain('mainnet-epoch-recovery.json');
    expect(step('Clear all-provider recovery barrier').run).toContain('mainnet-near-recovery.json');
    expect(object(main.outputs).recovery_cleared).toBe('${{ steps.recovery-barrier.outputs.recovery_cleared }}');
    expect(object(jobs['mainnet-agglayer']).if).toContain("recovery_cleared == 'true'");
    expect(object(jobs['mainnet-agglayer']).if).toContain('!inputs.loops_only');
  });
  it('serializes same-run swap, Epoch, then NEAR before legacy activity changes their portfolio', () => {
    const order = [
      'Run mainnet swap reverse',
      'Prepare mainnet Epoch loop',
      'Wait for mainnet Epoch return',
      'Prepare mainnet NEAR loop',
      'Wait for mainnet NEAR return',
      'Run native mainnet round trip'
    ];
    for (const name of order) expect(index(name)).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(index(order[i]!)).toBeGreaterThan(index(order[i - 1]!));
    for (const name of ['Prepare mainnet Epoch loop', 'Prepare mainnet NEAR loop'])
      expect(step(name).if).toContain('!inputs.swaps_only');
  });
  it('uses the actual immutable uploader for every SDK, signed EVM and native claim hold', () => {
    for (const name of [
      'Upload Epoch native forward authority',
      'Upload Epoch reverse authority',
      'Upload mainnet epoch signed EVM 1',
      'Upload mainnet epoch signed EVM 2',
      'Upload mainnet epoch signed EVM 3',
      'Upload mainnet epoch native return claim',
      'Upload NEAR native forward authority',
      'Upload NEAR reverse authority',
      'Upload mainnet near signed EVM 1',
      'Upload mainnet near native return claim'
    ]) {
      const entry = step(name);
      expect(entry.uses).toBe('./.github/actions/mainnet-loop-upload');
      const withInputs = object(entry.with);
      for (const input of ['checkpoint', 'gate', 'artifact-name', 'process-id', 'snapshot-directory'])
        expect(withInputs[input]).toEqual(expect.any(String));
      expect(withInputs['artifact-name']).toContain('${{ github.run_id }}');
    }
    expect(step('Upload mainnet epoch signed EVM 3').if).toContain("envelope-kind != 'deposit'");
    expect(object(step('Upload mainnet epoch signed EVM 3').with)['skip-after-deposit']).toBeUndefined();
    expect(object(step('Upload mainnet near signed EVM 1').with).gate).toContain('.evm-1');
    expect(object(step('Upload mainnet near native return claim').with).gate).toContain('.claim');
  });
  it('uploads the actual final Epoch SDK snapshot after queued inspection and before collateral execution completes', () => {
    const upload = step('Upload Epoch SDK forward authority');
    expect(upload.uses).toBe('./.github/actions/mainnet-loop-upload');
    expect(upload.if).toContain("recovery_cleared == 'true'");
    expect(upload.if).toContain('!inputs.swaps_only');
    expect(object(upload.with)).toMatchObject({
      checkpoint: 'test-results/mainnet-epoch-state/roundtrip.json',
      gate: 'test-results/mainnet-epoch-state/roundtrip.json.forward.sdk',
      'artifact-name': 'mainnet-epoch-forward-sdk-authorized-${{ github.run_id }}',
      'process-id': '${{ runner.temp }}/epoch-forward.pid'
    });
    expect(index('Upload Epoch SDK forward authority')).toBeGreaterThan(index('Upload Epoch native forward authority'));
    expect(index('Wait for mainnet Epoch forward')).toBeGreaterThan(index('Upload Epoch SDK forward authority'));
  });
  it.each([
    ['Upload swap SDK forward authority', 'Wait for mainnet swap forward', 'forward-sdk-authorized'],
    ['Upload swap SDK reverse authority', 'Wait for mainnet swap return', 'reverse-sdk-authorized'],
    ['Upload recovered swap SDK return authority', 'Wait for recovered swap return', 'reverse-sdk-authorized'],
    ['Upload swap SDK forward claim authority', 'Wait for mainnet swap forward', 'forward-claim-sdk-authorized'],
    ['Upload swap SDK reverse claim authority', 'Wait for mainnet swap return', 'reverse-claim-sdk-authorized'],
    [
      'Upload recovered swap SDK return claim authority',
      'Wait for recovered swap return',
      'reverse-claim-sdk-authorized'
    ]
  ])(
    'uploads and verifies the actual held PSWAP snapshot through %s before waiting for execution',
    (upload, wait, artifact) => {
      const entry = step(upload);
      expect(entry.uses).toBe('./.github/actions/mainnet-loop-upload');
      const inputs = object(entry.with);
      expect(inputs.checkpoint).toBe('test-results/mainnet-swap-state/roundtrip.json');
      expect(inputs['artifact-name']).toBe(`mainnet-swap-${artifact}-${'${{ github.run_id }}'}`);
      for (const name of ['gate', 'process-id', 'snapshot-directory']) expect(inputs[name]).toEqual(expect.any(String));
      expect(index(wait)).toBeGreaterThan(index(upload));
      if (upload.includes('recovered')) expect(index(wait)).toBeLessThan(index('Clear all-provider recovery barrier'));
      else expect(index(wait)).toBeLessThan(index('Prepare mainnet Epoch loop'));
      expect(String(step(wait).run)).not.toMatch(/playwright test/);
    }
  );
  it('keeps a first recovery-return grant explicit, manual and recovery-only', () => {
    const inputs = object(object(object(document.on).workflow_dispatch).inputs);
    expect(object(inputs.authorize_swap_recovery_return)).toMatchObject({ type: 'boolean', default: false });
    const prepare = step('Prepare explicitly approved first swap recovery return');
    expect(prepare.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(prepare.if).toContain('inputs.authorize_swap_recovery_return');
    expect(prepare.run).toContain('MAINNET_SWAP_MODE=authorize-recovery-return');
    expect(prepare.run).toContain('$RUNNER_TEMP/swap-operator-prepare.log');
    expect(index('Prepare explicitly approved first swap recovery return')).toBeLessThan(
      index('Recover prior mainnet swap')
    );
    expect(object(main.env).MAINNET_SWAP_RECOVERY_RETURN_APPROVED).toContain('workflow_dispatch');
    const guard = String(step('Require an original, unambiguous run').run);
    for (const { swaps, loops, accepted } of [
      { swaps: 'true', loops: 'false', accepted: true },
      { swaps: 'false', loops: 'false', accepted: false },
      { swaps: 'true', loops: 'true', accepted: false }
    ]) {
      const execute = () =>
        execFileSync('bash', ['-c', guard], {
          env: {
            ...process.env,
            GITHUB_RUN_ATTEMPT: '1',
            SWAPS_ONLY: swaps,
            LOOPS_ONLY: loops,
            MAINNET_SWAP_RECOVERY_RETURN_APPROVED: 'true'
          },
          stdio: 'pipe'
        });
      if (accepted) expect(execute).not.toThrow();
      else expect(execute).toThrow();
    }
  });
  it.each([
    ['Upload swap SDK forward authority', 'Upload swap SDK forward claim authority'],
    ['Upload swap SDK reverse authority', 'Upload swap SDK reverse claim authority'],
    ['Upload recovered swap SDK return authority', 'Upload recovered swap SDK return claim authority']
  ])('requires claim fingerprints after %s, not merely the create ACK', (create, claim) => {
    expect(index(claim)).toBeGreaterThan(index(create));
    expect(object(step(claim).with).gate).toContain('.sdk.claim');
    const runner = readFileSync(
      resolve(__dirname, '../playwright/e2e/tests/mainnet/mainnet-swap-loop.spec.ts'),
      'utf8'
    );
    for (const value of [
      'readMainnetSwapPayback',
      'armMainnetConsumeAuthorization',
      'releaseMainnetConsumeAuthorization',
      'forwardClaimAuthority',
      'reverseClaimAuthority',
      'mainnetSwapRequestExpiresAt'
    ])
      expect(runner).toContain(value);
    const ui = readFileSync(resolve(__dirname, '../playwright/e2e/helpers/mainnet-swap-ui.ts'), 'utf8');
    expect(ui).toContain('swap-auto-consume');
  });
  it('connects the reviewed UI minimum to the actual SDK hold and durable exact order identity', () => {
    const runner = readFileSync(
      resolve(__dirname, '../playwright/e2e/tests/mainnet/mainnet-swap-loop.spec.ts'),
      'utf8'
    );
    for (const value of [
      'armMainnetSendAuthorization',
      'releaseMainnetSendAuthorization',
      'forwardRequestAuthority',
      'reverseRequestAuthority',
      'MAINNET_SWAP_SDK_GATE'
    ])
      expect(runner).toContain(value);
    const ui = readFileSync(resolve(__dirname, '../playwright/e2e/helpers/mainnet-swap-ui.ts'), 'utf8');
    expect(ui).toContain('minimumReceive: actualMinimum.toString()');
  });
  it('reports the actual snapshot envelope and recovery gate, rather than guessing from a newer live file', () => {
    const action = object(
      YAML.parse(readFileSync(resolve(__dirname, '../.github/actions/mainnet-loop-upload/action.yml'), 'utf8'))
    );
    const outputs = object(action.outputs);
    expect(object(outputs['envelope-kind']).value).toBe('${{ steps.snapshot.outputs.envelope_kind }}');
    expect(object(outputs['alternative-gate']).value).toBe('${{ steps.snapshot.outputs.alternative_gate }}');
  });
  it('waits for the existing provider settlement window without extending the SDK request hold', () => {
    const action = readFileSync(resolve(__dirname, '../.github/actions/mainnet-loop-upload/action.yml'), 'utf8');
    expect(action).toContain('deadline=$((SECONDS + 1100))');
    const hold = readFileSync(resolve(__dirname, '../playwright/e2e/helpers/mainnet-loop-authorization.ts'), 'utf8');
    expect(hold).toContain('240_000');
  });
  it('never uploads browser folders, private process logs, profiles or raw note files', () => {
    for (const job of Object.values(jobs).map(object)) {
      if (!Array.isArray(job.steps)) throw new Error('Missing job steps');
      for (const entry of job.steps.filter(record).filter(value => value.uses === 'actions/upload-artifact@v4')) {
        const paths = object(entry.with).path;
        expect(typeof paths).toBe('string');
        for (const path of String(paths).trim().split(/\s+/)) {
          expect(path).toMatch(/\.(json|md)$/);
          expect(path).not.toMatch(/profile|trace|note[-.]file|process[-.]log|results\.json/);
        }
      }
    }
  });
  it.each([true, false])('installs xvfb only when missing (installed: %s)', installed => {
    const bin = mkdtempSync(resolve(tmpdir(), 'nightly-xvfb-'));
    try {
      writeFileSync(resolve(bin, 'sudo'), '#!/bin/sh\nprintf \'%s\\n\' "$*"\n', { mode: 0o700 });
      if (installed) {
        writeFileSync(resolve(bin, 'xvfb-run'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      }
      for (const name of ['mainnet-nightly', 'mainnet-agglayer']) {
        const jobSteps = object(jobs[name]).steps;
        if (!Array.isArray(jobSteps)) throw new Error(`Missing steps in ${name}`);
        const install = jobSteps.filter(record).find(entry => entry.name === 'Install xvfb');
        if (typeof install?.run !== 'string') throw new Error(`Missing xvfb script in ${name}`);
        const output = execFileSync('/bin/bash', ['-e', '-c', install.run], {
          encoding: 'utf8',
          env: { ...process.env, PATH: bin }
        });
        if (installed) expect(output).toBe('');
        else expect(output).toContain('apt-get install -y xvfb');
      }
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
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
  it('keeps bridge work independent of swap failure but away from a recovery-only, loops-only or swaps-only run', () => {
    expect(step('Run USDCx bridge loops').if).toContain('!cancelled()');
    expect(step('Run USDCx bridge loops').if).toContain('recovery_only');
    expect(step('Run USDCx bridge loops').if).toContain('loops_only');
    expect(object(jobs['mainnet-agglayer']).if).toContain('swaps_only');
    expect(object(jobs['mainnet-agglayer']).if).toContain('recovery_only');
  });
});
