'use strict';

const { join } = require('node:path');
const {
  REPORT_FILENAME,
  createOperation,
  createStage,
  errorFor,
  formatReport,
  known,
  makeReport,
  publishAtomically,
  testId,
  unknown
} = require('../report.cjs');

const sourceSha = 'cccee6fb4001f4d3debf36c73329563fbb996d6f';
const startAt = '2026-11-18T05:44:00.000Z';
const endAt = '2026-11-18T05:45:17.000Z';
const blocked = { selection: 'selected', status: 'not_started', reason: 'blocked_by_recovery' };

function recoveryFixture(claimObserved = false) {
  const recoveryGate = createStage({
    key: 'recovery_gate',
    status: claimObserved ? 'passed' : 'failed',
    origin: 'workflow',
    startAt,
    endAt,
    elapsedMs: 77000,
    errorCode: claimObserved ? undefined : 'recovery_gate_failed',
    ignoredError: 'PRIVATE_SEED_SENTINEL https://signed.invalid/?secret=SIGNED_URL_SENTINEL',
    attachments: { authorization: 'AUTH_HEADER_SENTINEL', note: 'PRIVATE_NOTE_SENTINEL' }
  });
  const operation = createOperation({
    key: 'swap-recovery',
    kind: 'recovery',
    surface: 'wallet_ui_and_helper',
    sourceRunId: '900001',
    recoveryEffect: claimObserved ? 'prior_authorized_claim' : 'unknown',
    outcome: claimObserved ? 'claimed' : 'unknown',
    provider: 'solver',
    sourceNetwork: 'Miden',
    destinationNetwork: 'Miden',
    proof: 'PRIVATE_PROOF_SENTINEL',
    browserStorage: 'BROWSER_STORAGE_SENTINEL'
  });
  if (claimObserved) {
    operation.stages.push(createStage({ key: 'claim', status: 'passed', origin: 'wallet_assertion' }));
  }
  const spec = 'mainnet-swap-loop.spec.ts';
  const title = 'real Guardian mainnet solver swaps out and back with recycled principal';
  return makeReport({
    generatedAt: '2026-11-18T05:45:18.000Z',
    fixture: true,
    availability: 'available',
    repository: '0xMiden/wallet',
    workflowId: '391951744',
    workflowPath: '.github/workflows/e2e-mainnet-nightly.yml',
    sourceSha,
    sourceRef: 'refs/heads/main',
    event: 'schedule',
    runId: claimObserved ? '900003' : '900002',
    runNumber: claimObserved ? '903' : '902',
    runAttempt: '1',
    jobKey: 'mainnet',
    timeoutMs: 12000000,
    coverage: { swap: blocked, bridge: blocked, freshSwapsStarted: known(0) },
    stages: [recoveryGate],
    invocations: [
      {
        id: 'swap-recover',
        mode: 'recover',
        suite: 'solver',
        spec,
        shard: unknown('not_applicable'),
        status: claimObserved ? 'passed' : 'failed',
        startAt: known(startAt),
        endAt: known(endAt),
        elapsedMs: known(77000),
        deadlineAt: unknown('not_applicable'),
        timeoutMs: known(claimObserved ? 1860000 : 1200000),
        exitCode: known(claimObserved ? 0 : 1),
        playwrightOutcome: known(claimObserved ? 'passed' : 'failed'),
        tests: [
          {
            id: testId(spec, title),
            title,
            project: 'default',
            status: claimObserved ? 'passed' : 'failed',
            outcome: claimObserved ? 'expected' : 'unexpected',
            attempts: [
              {
                retry: 0,
                worker: known(0),
                status: claimObserved ? 'passed' : 'failed',
                expectedStatus: 'passed',
                startAt: known(startAt),
                endAt: unknown(),
                elapsedMs: known(76800),
                timeoutMs: known(claimObserved ? 1800000 : 1200000),
                error: claimObserved ? null : errorFor('test_failed'),
                operations: [operation]
              }
            ]
          }
        ]
      }
    ]
  });
}

if (require.main === module) {
  const directory = process.argv[2] ?? __dirname;
  publishAtomically(join(directory, REPORT_FILENAME), formatReport(recoveryFixture()));
  publishAtomically(join(directory, 'prior-run-claim-v1.json'), formatReport(recoveryFixture(true)));
  const refused = { ...recoveryFixture(), unexpectedAttachment: { seed: 'TEST_ONLY_SEED_SENTINEL' } };
  publishAtomically(join(directory, 'rejected-v1.json'), JSON.stringify(refused, null, 2) + '\n');
}

module.exports = { recoveryFixture };
