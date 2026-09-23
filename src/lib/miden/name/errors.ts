/**
 * Errors of the Miden Name integration. Each class sets `name` so that a caller
 * can identify the error after it crosses a realm boundary as a plain object.
 */

import type { MidenLabelError } from './encoding';

/** The effective network has no Miden Name deployment. */
export class MidenNameUnsupportedNetworkError extends Error {
  constructor(network: string) {
    super(`Miden Name is not available on network "${network}"`);
    this.name = 'MidenNameUnsupportedNetworkError';
  }
}

/** The label is not a valid Miden Name label. */
export class MidenNameInvalidLabelError extends Error {
  readonly reason: MidenLabelError;

  constructor(label: string, reason: MidenLabelError) {
    super(`Invalid Miden Name label "${label}": ${reason}`);
    this.name = 'MidenNameInvalidLabelError';
    this.reason = reason;
  }
}

/** The bundled register script does not have the expected MAST root. */
export class MidenNameScriptMismatchError extends Error {
  constructor(expectedRoot: string, actualRoot: string) {
    super(`Register-domain script root mismatch: expected ${expectedRoot}, got ${actualRoot}`);
    this.name = 'MidenNameScriptMismatchError';
  }
}

/**
 * The node gave a proof for a different account, or the registry state has a
 * layout that this wallet does not know (for example a new commitment version).
 */
export class MidenNameRegistryMismatchError extends Error {
  constructor(detail: string) {
    super(`Miden Name registry mismatch: ${detail}`);
    this.name = 'MidenNameRegistryMismatchError';
  }
}

/** Publishing a registry record needs SDK support that is not available yet. */
export class MidenNameRegistryPublishingUnsupportedError extends Error {
  constructor() {
    super('Publishing a Miden Name registry record is not supported yet');
    this.name = 'MidenNameRegistryPublishingUnsupportedError';
  }
}

/** The caller aborted the operation through its `AbortSignal`. */
export class MidenNameAbortedError extends Error {
  constructor() {
    super('Miden Name operation aborted');
    this.name = 'MidenNameAbortedError';
  }
}

export function isMidenNameAbortedError(error: unknown): error is MidenNameAbortedError {
  return error instanceof MidenNameAbortedError;
}

/** The registry already issued the name to an account. */
export class MidenNameTakenError extends Error {
  constructor(label: string) {
    super(`The Miden Name "${label}" is already taken`);
    this.name = 'MidenNameTakenError';
  }
}

/** The registry does not allow the register script, or its fee entry has an unknown layout. */
export class MidenNameScriptNotAllowedError extends Error {
  constructor() {
    super('The Miden Name registry does not accept the register script');
    this.name = 'MidenNameScriptNotAllowedError';
  }
}

/** The price on chain is not the price that the user accepted. */
export class MidenNamePriceChangedError extends Error {
  readonly expectedPrice: bigint;
  readonly actualPrice: bigint;

  constructor(expectedPrice: bigint, actualPrice: bigint) {
    super(`The Miden Name price changed from ${expectedPrice} to ${actualPrice} base units`);
    this.name = 'MidenNamePriceChangedError';
    this.expectedPrice = expectedPrice;
    this.actualPrice = actualPrice;
  }
}

/** The chain tip is too near the reclaim height of the register note. */
export class MidenNameRegistrationExpiredError extends Error {
  constructor(tip: number, reclaimHeight: number) {
    super(`The Miden Name request expired: chain tip ${tip} is too near reclaim height ${reclaimHeight}`);
    this.name = 'MidenNameRegistrationExpiredError';
  }
}

/** A `register-name` row has missing or incorrect `extraInputs`. */
export class MidenNameRegistrationInputError extends Error {
  constructor(detail: string) {
    super(`The Miden Name registration row is not valid: ${detail}`);
    this.name = 'MidenNameRegistrationInputError';
  }
}
