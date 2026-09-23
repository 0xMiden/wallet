/**
 * Non-fungible asset (NFA) checks of Miden Name. All of them are STUBS.
 *
 * Ownership of a name is custody of its NFA. The SDK has no binding to list
 * NFAs in an account vault or to put an NFA in a note yet. Until it has one,
 * the wallet gets "owned" from the registration row, not from the vault. Keep
 * every NFA check in this file, so that the change is in one place when the
 * binding is available.
 */

import { MidenNameRegistryPublishingUnsupportedError } from './errors';

/** False until the registry-note script bytes and the SDK NFA-in-note binding are available. */
export const REGISTRY_PUBLISHING_SUPPORTED = false;

export type DomainNfaHolding = 'held' | 'not-held' | 'unsupported';

/** Always 'unsupported': the SDK cannot list the NFAs of a vault yet. */
export async function accountHoldsDomainNfa(_accountId: string, _label: string): Promise<DomainNfaHolding> {
  return 'unsupported';
}

/** Always throws: registry-record publishing is not supported yet. */
export async function publishRegistryRecord(_accountId: string, _label: string): Promise<never> {
  throw new MidenNameRegistryPublishingUnsupportedError();
}
