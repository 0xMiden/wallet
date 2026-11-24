export type BurnFeeFailure =
  | 'configuration_failed'
  | 'native_asset_failed'
  | 'request_build_failed'
  | 'dry_run_failed'
  | 'result_decode_failed'
  | 'probe_mismatch'
  | 'busy_exhausted'
  | 'request_failed'
  | 'estimate_failed';

export const BURN_FEE_FAILURES: readonly BurnFeeFailure[] = [
  'configuration_failed',
  'native_asset_failed',
  'request_build_failed',
  'dry_run_failed',
  'result_decode_failed',
  'probe_mismatch',
  'busy_exhausted',
  'request_failed',
  'estimate_failed'
];

export function burnFeeFailureOf(value: unknown): BurnFeeFailure | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'failure');
    return descriptor && 'value' in descriptor
      ? BURN_FEE_FAILURES.find(failure => failure === descriptor.value)
      : undefined;
  } catch {
    return undefined;
  }
}
