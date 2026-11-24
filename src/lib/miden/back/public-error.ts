/**
 * An error whose message the wallet can show or send as it is.
 *
 * A leaf module, so a module can extend it without the intercom setup in `defaults.ts`. `defaults.ts` exports the same
 * class.
 */
export class PublicError extends Error {}

const MAINNET_ADMISSION_PENDING = 'MAINNET_ADMISSION_PENDING';

export class MainnetAdmissionPendingError extends PublicError {
  readonly code = MAINNET_ADMISSION_PENDING;
}

export function isMainnetAdmissionPending(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === MAINNET_ADMISSION_PENDING;
}

/** The confirm dry run outlasted its wait. The request can be tried again; the locked work is left running. */
export class CustomSimulationTimeoutError extends PublicError {
  constructor() {
    super('The wallet could not finish simulating this transaction. Try again.');
    this.name = 'CustomSimulationTimeoutError';
  }
}
