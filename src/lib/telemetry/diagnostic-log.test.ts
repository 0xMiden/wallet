import { captureDiagnosticLog } from './crash';
import {
  DIAGNOSTIC_DURATIONS,
  _resetDiagnosticLogLimitsForTest,
  logOperationEnd,
  logOperationStep,
  withOperationStep
} from './diagnostic-log';

jest.mock('./crash', () => ({ captureDiagnosticLog: jest.fn() }));

const records = () => jest.mocked(captureDiagnosticLog).mock.calls;

let now = 0;
beforeEach(() => {
  jest.mocked(captureDiagnosticLog).mockReset();
  _resetDiagnosticLogLimitsForTest();
  now = 1_000_000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

it('sends a step under its fixed event name with only its closed values and a duration bucket', () => {
  logOperationStep('swap', 'request_build', 'failed', 4_200);
  expect(records()).toEqual([
    ['operation_step', { operation: 'swap', step: 'request_build', outcome: 'failed', duration: '1_to_5s' }]
  ]);
});

it('sends an end without a duration when none is known', () => {
  logOperationEnd('swap', 'cancelled');
  expect(records()).toEqual([['operation_end', { operation: 'swap', outcome: 'cancelled' }]]);
});

it.each([
  [0, 'under_1s'],
  [999, 'under_1s'],
  [1_000, '1_to_5s'],
  [5_000, '5_to_30s'],
  [30_000, '30s_to_2m'],
  [120_000, '2_to_10m'],
  [600_000, 'over_10m']
])('buckets %d ms as %s', (ms, bucket) => {
  logOperationStep('swap', 'proposal_create', 'ok', ms);
  expect(records()[0]?.[1]).toMatchObject({ duration: bucket });
  expect(DIAGNOSTIC_DURATIONS).toContain(bucket);
});

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('omits an unusable duration %d', ms => {
  logOperationStep('swap', 'proposal_create', 'ok', ms);
  expect(records()[0]?.[1]).not.toHaveProperty('duration');
});

it('drops a record carrying any value outside the closed lists', () => {
  const address = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';
  const loose = (value: string) => value as never;
  logOperationStep(loose(address), 'request_build', 'ok');
  logOperationStep('swap', loose('1234.5'), 'ok');
  logOperationStep('swap', 'request_build', loose('https://rpc.example/secret'));
  logOperationEnd('swap', loose('ok'));
  logOperationStep('swap', 'request_build', loose('completed'));
  expect(records()).toEqual([]);
});

it('caps a burst at 10 records in 10 seconds for one operation', () => {
  for (let index = 0; index < 15; index++) logOperationStep('swap', 'service_prepare', 'failed');
  expect(records()).toHaveLength(10);
  now += 10_000;
  logOperationStep('swap', 'service_prepare', 'failed');
  expect(records()).toHaveLength(11);
});

it('caps one operation at 60 records in 10 minutes', () => {
  for (let index = 0; index < 200; index++) {
    now += 2_000;
    logOperationStep('swap', 'service_prepare', 'failed');
  }
  expect(records()).toHaveLength(60);
  now += 600_000;
  logOperationEnd('swap', 'failed');
  expect(records()).toHaveLength(61);
});

it('counts a dropped record against no limit', () => {
  for (let index = 0; index < 20; index++) logOperationStep('swap', 'service_prepare', 'nope' as never);
  logOperationStep('swap', 'service_prepare', 'ok');
  expect(records()).toHaveLength(1);
});

it('keeps logging when the reporting client throws', () => {
  jest.mocked(captureDiagnosticLog).mockImplementation(() => {
    throw new Error('client broke');
  });
  expect(() => logOperationStep('swap', 'request_build', 'ok')).not.toThrow();
});

describe('withOperationStep', () => {
  it('returns the step result and records it as ok with its duration', async () => {
    const value = await withOperationStep(
      'swap',
      'request_persist',
      async () => {
        now += 1_500;
        return 'bytes';
      },
      () => 'failed'
    );
    expect(value).toBe('bytes');
    expect(records()).toEqual([
      ['operation_step', { operation: 'swap', step: 'request_persist', outcome: 'ok', duration: '1_to_5s' }]
    ]);
  });

  it('rethrows the original error and records the outcome its classifier names', async () => {
    const failure = new Error('rpc timed out for mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe');
    const classify = jest.fn(() => 'timeout' as const);
    await expect(
      withOperationStep(
        'swap',
        'proposal_create',
        async () => {
          throw failure;
        },
        classify
      )
    ).rejects.toBe(failure);
    expect(classify).toHaveBeenCalledWith(failure);
    expect(records()).toEqual([
      ['operation_step', { operation: 'swap', step: 'proposal_create', outcome: 'timeout', duration: 'under_1s' }]
    ]);
  });

  it('still rethrows the original error when its classifier throws', async () => {
    const failure = new Error('boom');
    await expect(
      withOperationStep(
        'swap',
        'proposal_create',
        async () => {
          throw failure;
        },
        () => {
          throw new Error('classifier broke');
        }
      )
    ).rejects.toBe(failure);
    expect(records()).toEqual([
      ['operation_step', { operation: 'swap', step: 'proposal_create', outcome: 'failed', duration: 'under_1s' }]
    ]);
  });
});
