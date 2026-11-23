/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

import {
  walletCanarySourceFromEnvironment,
  writeWalletCanaryReport,
  type WalletCanaryReportInput
} from '../playwright/e2e/reporting/wallet-canary-report';
import {
  acknowledgeWalletCanaryAuthorization,
  snapshotWalletCanaryAuthorization
} from './mainnet-wallet-canary-ack.mjs';

const PROTECTED_ENV = {
  GITHUB_REPOSITORY: '0xMiden/wallet',
  GITHUB_REPOSITORY_ID: '853430876',
  GITHUB_WORKFLOW_REF: '0xMiden/wallet/.github/workflows/e2e-mainnet-wallet-canary.yml@refs/heads/main',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_JOB: 'wallet-canary',
  GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '1',
  MAINNET_CANARY_WORKFLOW_ID: '123'
};
const START = '2026-11-23T12:00:00Z';
const ADMISSION = '2026-11-23T12:00:10Z';
const RELEASE = '2026-11-23T12:00:30Z';
const SUBMISSION = '2026-11-23T12:00:40Z';
const RECEIPT = '2026-11-23T12:12:15Z';
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wallet-canary-report-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function input(): WalletCanaryReportInput {
  return {
    source: walletCanarySourceFromEnvironment(PROTECTED_ENV),
    original: { runId: '100', runAttempt: '1', slotStart: START, lineageId: 'd'.repeat(32) },
    slot: {
      slotStart: START,
      status: 'unknown',
      reason: 'submission_unconfirmed',
      admittedAt: ADMISSION,
      submittedAt: null,
      usableReceiptAt: null,
      claimMode: 'manual',
      runId: '100',
      runAttempt: '1'
    },
    observations: [
      { stage: 'admission', at: ADMISSION },
      { stage: 'authorization_released', at: RELEASE },
      { stage: 'timed_out', at: '2026-11-23T12:08:00Z' }
    ],
    pair: { offered: 'USDCx', requested: 'MIDEN' },
    terms: { offeredBaseUnits: '1000001', minimumBaseUnits: '30000000', offeredDecimals: 6, requestedDecimals: 8 }
  };
}

describe('sanitized wallet canary artifact', () => {
  it('pins the workflow source and exposes only the permitted per-slot fields', () => {
    const report = input();
    Object.assign(report, { privateCheckpoint: { privateWallet: 'private-wallet' } });
    for (const nested of [
      report.slot,
      report.original,
      report.source,
      report.pair,
      report.terms,
      ...report.observations
    ]) {
      if (nested) Object.assign(nested, { privateOrder: 'private-order' });
    }
    const path = writeWalletCanaryReport(directory, report);
    const output = readFileSync(path, 'utf8');
    expect(path).toBe(join(directory, 'wallet-canary-report-v1.json'));
    expect(output).not.toContain('private-');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 'wallet-e2e/canary-report-v1',
      source: { repositoryId: '853430876', workflowId: '123', jobKey: 'wallet-canary' },
      slot: { status: 'unknown', reason: 'submission_unconfirmed', submittedAt: null, usableReceiptAt: null },
      observations: [{ stage: 'admission' }, { stage: 'authorization_released' }, { stage: 'timed_out' }],
      terms: { offeredBaseUnits: '1000001', minimumBaseUnits: '30000000' }
    });
    expect(readdirSync(directory)).toEqual(['wallet-canary-report-v1.json']);
  });

  it.each([
    ['GITHUB_REPOSITORY_ID', '99999'],
    ['GITHUB_WORKFLOW_REF', '0xMiden/wallet/.github/workflows/e2e-mainnet-nightly.yml@refs/heads/main'],
    ['MAINNET_CANARY_WORKFLOW_ID', 'not-a-registration-id'],
    ['GITHUB_REF', 'refs/heads/other'],
    ['GITHUB_JOB', 'mainnet-nightly']
  ])('rejects untrusted source metadata at %s', (key, value) => {
    expect(() => walletCanarySourceFromEnvironment({ ...PROTECTED_ENV, [key]: value })).toThrow(
      'Invalid wallet canary'
    );
  });

  it('keeps the original slot when a later attempt sees its usable receipt', () => {
    const report = input();
    report.source.runId = '101';
    report.slot = {
      ...report.slot,
      status: 'usable_receipt',
      reason: null,
      submittedAt: SUBMISSION,
      usableReceiptAt: RECEIPT
    };
    report.observations = [
      { stage: 'payback', at: '2026-11-23T12:12:00Z' },
      { stage: 'claim', at: '2026-11-23T12:12:14Z' },
      { stage: 'usable_receipt', at: RECEIPT }
    ];
    const output = JSON.parse(readFileSync(writeWalletCanaryReport(directory, report), 'utf8'));
    expect(output.original).toEqual(report.original);
    expect(output.source.runId).toBe('101');
    expect(output.slot.runId).toBe('100');
    expect(output.slot.usableReceiptAt).toBe(RECEIPT);
  });

  it('cannot turn release alone into a submitted order', () => {
    const report = input();
    report.slot = { ...report.slot, status: 'submitted', reason: null, submittedAt: SUBMISSION };
    expect(() => writeWalletCanaryReport(directory, report)).toThrow('unsupported milestone');
    expect(readdirSync(directory)).toHaveLength(0);
  });

  it('cannot claim an admission for an elapsed slot or a fresh authorization in recovery', () => {
    const elapsed = input();
    elapsed.slot.admittedAt = '2026-11-23T12:05:00Z';
    expect(() => writeWalletCanaryReport(directory, elapsed)).toThrow('chronology');
    const recovery = input();
    recovery.source.runId = '101';
    expect(() => writeWalletCanaryReport(directory, recovery)).toThrow('Invalid wallet canary observation');
  });
});

function authorization() {
  const checkpoint = join(directory, 'checkpoint.json');
  const gate = join(directory, 'authorization');
  const bytes = '{"privateWallet":"never upload this","privateOrder":"never upload this either"}';
  const digest = createHash('sha256').update(bytes).digest('hex') + '\n';
  writeFileSync(checkpoint, bytes, { mode: 0o600 });
  writeFileSync(`${gate}.ready`, digest, { mode: 0o600 });
  const snapshot = snapshotWalletCanaryAuthorization(checkpoint, gate, join(directory, 'snapshot'));
  const downloaded = join(directory, 'downloaded.sha256');
  writeFileSync(downloaded, digest, { mode: 0o600 });
  return {
    checkpoint,
    gate,
    snapshot,
    downloaded,
    stage: 'send',
    runId: 100,
    runAttempt: 1,
    artifactId: 700,
    headSha: 'a'.repeat(40),
    artifact: {
      id: 700,
      name: 'wallet-canary-send-ack-100-1',
      expired: false,
      size_in_bytes: 220,
      workflow_run: {
        id: 100,
        repository_id: 853430876,
        head_repository_id: 853430876,
        head_branch: 'main',
        head_sha: 'a'.repeat(40)
      }
    },
    digest
  };
}

describe('wallet canary authorization acknowledgment', () => {
  it('uploads only the digest and releases after matching source and digest', () => {
    const fixture = authorization();
    expect(readFileSync(fixture.snapshot, 'utf8')).toBe(fixture.digest);
    expect(existsSync(fixture.gate)).toBe(false);
    acknowledgeWalletCanaryAuthorization(fixture);
    expect(readFileSync(fixture.gate, 'utf8')).toBe(fixture.digest);
    expect(() => acknowledgeWalletCanaryAuthorization(fixture)).toThrow();
  });

  it('leaves the request held if run provenance or checkpoint changes', () => {
    const fixture = authorization();
    expect(() => acknowledgeWalletCanaryAuthorization({ ...fixture, runAttempt: 2 })).toThrow('workflow attempt');
    writeFileSync(fixture.checkpoint, 'changed');
    expect(() => acknowledgeWalletCanaryAuthorization(fixture)).toThrow('differs from the private checkpoint');
    expect(existsSync(fixture.gate)).toBe(false);
  });

  it('leaves the request held if the downloaded digest differs', () => {
    const fixture = authorization();
    writeFileSync(fixture.downloaded, 'b'.repeat(64) + '\n');
    expect(() => acknowledgeWalletCanaryAuthorization(fixture)).toThrow('Uploaded digest differs');
    expect(existsSync(fixture.gate)).toBe(false);
  });
});

describe('dedicated wallet canary workflow', () => {
  const workflowText = readFileSync('.github/workflows/e2e-mainnet-wallet-canary.yml', 'utf8');
  const workflow = YAML.parse(workflowText);
  const actionText = readFileSync('.github/actions/mainnet-wallet-canary-ack/action.yml', 'utf8');

  it('has a disabled manual job and separate runner, identity, lock, and artifact paths', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.jobs['wallet-canary'].if).toBe('${{ false }}');
    expect(workflow.jobs['wallet-canary']['runs-on']).toContain('wallet-canary');
    expect(workflowText).not.toContain('E2E_MAINNET_GUARDIAN_KEY_PAIR');
    expect(workflowText).toContain('wallet-canary-v1-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflowText).toContain('/wallet-canary-report-v1.json');
    expect(workflowText).toContain('stage: send');
    expect(workflowText).toContain('stage: claim');
    expect(actionText).toContain('authorization.sha256');
    expect(actionText).not.toContain('roundtrip.json');
  });

  it('uses a valid shell launcher with inherited wallet locking and no retry', () => {
    const path = 'scripts/run-mainnet-wallet-canary.sh';
    const launcher = readFileSync(path, 'utf8');
    expect(spawnSync('bash', ['-n', path]).status).toBe(0);
    expect(launcher).toContain('flock --exclusive --nonblock 9');
    expect(launcher).toContain('export MAINNET_CANARY_LOCK_HELD=true');
    expect(launcher).toContain('export E2E_WALLET_B_PROFILE="$profile"');
    expect(launcher).toContain('--workers=1 --retries=0');
  });
});
