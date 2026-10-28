import { captureCrash } from './crash';
import { snapshotCrashDiagnostics } from './crash-diagnostics';
import {
  USER_ERROR_IDS,
  USER_ERROR_SURFACES,
  _resetUserVisibleErrorLimitsForTest,
  isUserErrorId,
  reportUserVisibleError
} from './user-visible-error';
import en from '../../../public/_locales/en/en.json';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));

function report(id: unknown, surface: unknown): void {
  const reporter: unknown = reportUserVisibleError;
  if (typeof reporter !== 'function') throw new Error('Missing reporter');
  reporter(id, surface);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(0);
  _resetUserVisibleErrorLimitsForTest();
});

describe('user-visible error reports', () => {
  it('reports a known id and surface once as WalletUserVisibleError', () => {
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');

    expect(captureCrash).toHaveBeenCalledTimes(1);
    const error = jest.mocked(captureCrash).mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Missing error');
    expect(error.name).toBe('WalletUserVisibleError');
    expect(error.message).toBe('User-visible error: usdcxFaucetUnavailable; surface review');
    expect(error.stack).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(snapshotCrashDiagnostics(error)).toEqual({
      userErrorId: 'usdcxFaucetUnavailable',
      userErrorSurface: 'review'
    });
    expect(captureCrash).toHaveBeenCalledWith(error, 'manual', {
      initializeIfNeeded: true,
      level: 'warning',
      closedNames: new Set([...USER_ERROR_IDS, ...USER_ERROR_SURFACES].flatMap(value => [value, ...value.split('_')]))
    });
  });

  it.each([
    ['Unable to read 0x12ab', 'review'],
    ['usdcxFaucetUnavailable', 'toast'],
    [null, 'review'],
    [undefined, 'review'],
    [42, 'review'],
    [{ toString: (): string => 'usdcxFaucetUnavailable' }, 'review'],
    ['usdcxFaucetUnavailable', { toString: (): string => 'review' }],
    ['usdcxFaucetUnavailable', null]
  ])('drops an unknown id or surface: %p, %p', (id, surface) => {
    report(id, surface);
    expect(captureCrash).not.toHaveBeenCalled();
    expect(isUserErrorId(id)).toBe(id === 'usdcxFaucetUnavailable');
  });

  it('sends one report per id and surface per minute', () => {
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    jest.advanceTimersByTime(1);
    reportUserVisibleError('usdcxFaucetUnavailable', 'inline');
    expect(captureCrash).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(59_998);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(3);
  });

  it('caps a realm at 30 reports in 10 minutes', () => {
    for (const minute of [0, 1, 2]) {
      jest.advanceTimersByTime(minute === 0 ? 0 : 60_000);
      for (const surface of USER_ERROR_SURFACES.slice(0, minute === 2 ? 6 : 12)) {
        reportUserVisibleError('usdcxFaucetUnavailable', surface);
      }
    }
    expect(captureCrash).toHaveBeenCalledTimes(30);
    reportUserVisibleError('usdcxFaucetUnavailable', 'status_screen');
    expect(captureCrash).toHaveBeenCalledTimes(30);
    jest.advanceTimersByTime(480_001);
    reportUserVisibleError('usdcxFaucetUnavailable', 'status_screen');
    expect(captureCrash).toHaveBeenCalledTimes(31);
  });

  it.each([
    ['backward', -86_400_000],
    ['forward', 86_400_000]
  ])('keeps the pair cooldown tied to elapsed time after a %s wall-clock correction', (_direction, correction) => {
    const wallStart = 1_000_000_000;
    jest.setSystemTime(wallStart);
    const elapsedStart = performance.now();
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(1);

    jest.setSystemTime(wallStart + Number(correction));
    expect(performance.now()).toBe(elapsedStart);
    jest.advanceTimersByTime(59_999);
    expect(performance.now() - elapsedStart).toBe(59_999);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['backward', -86_400_000],
    ['forward', 86_400_000]
  ])('keeps the realm window tied to elapsed time after a %s wall-clock correction', (_direction, correction) => {
    const wallStart = 1_000_000_000;
    jest.setSystemTime(wallStart);
    const elapsedStart = performance.now();
    const pairs = USER_ERROR_IDS.flatMap(id => USER_ERROR_SURFACES.map(surface => ({ id, surface }))).slice(0, 31);
    expect(new Set(pairs.map(({ id, surface }) => `${id}:${surface}`)).size).toBe(31);
    for (const { id, surface } of pairs.slice(0, 30)) reportUserVisibleError(id, surface);
    expect(captureCrash).toHaveBeenCalledTimes(30);
    const nextPair = pairs[30]!;

    jest.setSystemTime(wallStart + Number(correction));
    expect(performance.now()).toBe(elapsedStart);
    jest.advanceTimersByTime(599_999);
    expect(performance.now() - elapsedStart).toBe(599_999);
    reportUserVisibleError(nextPair.id, nextPair.surface);
    expect(captureCrash).toHaveBeenCalledTimes(30);

    jest.advanceTimersByTime(1);
    reportUserVisibleError(nextPair.id, nextPair.surface);
    expect(captureCrash).toHaveBeenCalledTimes(31);
  });

  it('does not charge an invalid or throttled call against the realm cap', () => {
    for (let attempt = 0; attempt < 31; attempt++) {
      report('Unable to read 0x12ab', 'review');
      reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    }
    reportUserVisibleError('usdcxFaucetUnavailable', 'inline');
    expect(captureCrash).toHaveBeenCalledTimes(2);
  });

  it('resets both limits for isolated tests', () => {
    for (const minute of [0, 1, 2]) {
      jest.advanceTimersByTime(minute === 0 ? 0 : 60_000);
      for (const surface of USER_ERROR_SURFACES.slice(0, minute === 2 ? 6 : 12)) {
        reportUserVisibleError('usdcxFaucetUnavailable', surface);
      }
    }
    expect(captureCrash).toHaveBeenCalledTimes(30);
    _resetUserVisibleErrorLimitsForTest();
    reportUserVisibleError('usdcxFaucetUnavailable', 'review');
    expect(captureCrash).toHaveBeenCalledTimes(31);
  });

  it('every non-raw id is a key in en.json, and the list is sorted without duplicates', () => {
    expect(USER_ERROR_IDS).toEqual([...new Set(USER_ERROR_IDS)].sort());
    for (const id of USER_ERROR_IDS) {
      expect(isUserErrorId(id)).toBe(true);
    }
    for (const id of USER_ERROR_IDS.filter(value => !value.startsWith('raw_'))) {
      expect(Object.prototype.hasOwnProperty.call(en, id)).toBe(true);
    }
    expect(Object.isFrozen(USER_ERROR_IDS)).toBe(true);
    expect(Object.isFrozen(USER_ERROR_SURFACES)).toBe(true);
  });
});

test('startup warning retains closed attempt diagnostics without attaching them to unrelated reports', () => {
  const diagnostics = {
    startupEligibilityStage: 'eligibility_lookup',
    startupEligibilityReason: 'version_mismatch',
    startupEligibilityRetry: 'config_not_advanced'
  };
  const reportWithDiagnostics = reportUserVisibleError as (...args: unknown[]) => void;
  reportWithDiagnostics('walletAccessUnavailableBody', 'startup', diagnostics);
  const error = jest.mocked(captureCrash).mock.calls[0]?.[0];
  expect(snapshotCrashDiagnostics(error)).toMatchObject(diagnostics);
  reportWithDiagnostics('usdcxFaucetUnavailable', 'review', diagnostics);
  const other = jest.mocked(captureCrash).mock.calls[1]?.[0];
  expect(snapshotCrashDiagnostics(other)).not.toHaveProperty('startupEligibilityStage');
});

const uiCases = [
  [
    'bridgeFeatureUnavailableBody',
    'notice',
    { kind: 'feature_unavailable', featureUnavailableFeature: 'earnDeposit', featureUnavailableReason: 'service-down' }
  ],
  ['submissionUnanswered', 'status_screen', { kind: 'submission_feedback', submissionFeedbackBranch: 'grpc_unknown' }],
  ['raw_pending_activity_retry_failed', 'notice', { kind: 'pending_retry', pendingRetryReason: 'guardian_hold' }],
  ['invalidMidenAccountId', 'inline', { kind: 'recipient_validation', recipientValidationStage: 'decoder_throw' }],
  [
    'raw_bridge_balance_failed',
    'field',
    { kind: 'bridge_balance_read', bridgeBalanceBranch: 'circle_usdc', bridgeBalanceStage: 'request' }
  ]
] as const;
it.each(uiCases)('carries exact UI producer evidence for %s through the reporting root', (id, surface, evidence) => {
  Reflect.apply(reportUserVisibleError, undefined, [id, surface, evidence]);
  const root = jest.mocked(captureCrash).mock.calls[0]?.[0];
  const { kind: _kind, ...fields } = evidence;
  expect(snapshotCrashDiagnostics(root)).toMatchObject({ userErrorId: id, userErrorSurface: surface, ...fields });
  expect(root).toBeInstanceOf(Error);
  expect((root as Error).message).toBe(`User-visible error: ${id}; surface ${surface}`);
});

it.each(uiCases)(
  'rejects UI evidence on another pair without changing the report identity for %s',
  (_id, _surface, evidence) => {
    Reflect.apply(reportUserVisibleError, undefined, ['invalidAmount', 'field', evidence]);
    expect(captureCrash).toHaveBeenCalledTimes(1);
    expect(snapshotCrashDiagnostics(jest.mocked(captureCrash).mock.calls[0]?.[0])).toEqual({
      userErrorId: 'invalidAmount',
      userErrorSurface: 'field'
    });
  }
);
it('rejects partial or unknown feature evidence and never reads getters', () => {
  const getter = jest.fn(() => 'earnDeposit');
  for (const value of [
    { kind: 'feature_unavailable', featureUnavailableFeature: 'earnDeposit' },
    { kind: 'feature_unavailable', featureUnavailableFeature: 'private', featureUnavailableReason: 'off' },
    Object.defineProperty(
      { kind: 'feature_unavailable', featureUnavailableReason: 'off' },
      'featureUnavailableFeature',
      { get: getter }
    )
  ]) {
    _resetUserVisibleErrorLimitsForTest();
    Reflect.apply(reportUserVisibleError, undefined, ['bridgeFeatureUnavailableBody', 'notice', value]);
    expect(snapshotCrashDiagnostics(jest.mocked(captureCrash).mock.calls.at(-1)?.[0])).not.toHaveProperty(
      'featureUnavailableFeature'
    );
  }
  expect(getter).not.toHaveBeenCalled();
});
