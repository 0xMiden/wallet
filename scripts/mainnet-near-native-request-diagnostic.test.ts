import { nearNativeRequestDiagnostic } from '../playwright/e2e/helpers/mainnet-near-native-request-diagnostic';

it('distinguishes a queued row from exact SDK request rejection without exporting raw strings', () => {
  const error = new Error('Actual native send request timed out');
  expect(nearNativeRequestDiagnostic(error, { status: 0 })).toEqual({
    stage: 'native-request',
    outcome: 'request-timeout',
    rowStatus: 'queued',
    rowStage: 'unknown',
    rejection: 'unknown'
  });
  expect(
    nearNativeRequestDiagnostic(error, {
      status: 3,
      stage: 'signing-proposal',
      rawError: 'Actual native send bytes differ from the exact authorized request: private context'
    })
  ).toEqual({
    stage: 'native-request',
    outcome: 'request-timeout',
    rowStatus: 'failed',
    rowStage: 'signing-proposal',
    rejection: 'request-mismatch'
  });
});

it('redacts unrecognized row stage and error text and distinguishes missing rows', () => {
  expect(
    nearNativeRequestDiagnostic(new Error('private context'), {
      status: 99,
      stage: 'private context',
      error: 'private context'
    })
  ).toEqual({
    stage: 'native-request',
    outcome: 'unknown',
    rowStatus: 'unknown',
    rowStage: 'unknown',
    rejection: 'unknown'
  });
  expect(nearNativeRequestDiagnostic(new Error('Native send authorization aborted or expired'), null).rowStatus).toBe(
    'missing'
  );
});
