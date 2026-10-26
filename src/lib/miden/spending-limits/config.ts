import { v4 as uuid } from 'uuid';

import { spendingLimits, db } from '../repo';
import { classifySpendingLimitChange } from './change';
import { canonicalSpendingLimitIdentity } from './identity';
import {
  SpendingLimitConfiguration,
  SpendingLimitDraft,
  parsePersistedSpendingLimit,
  parseSerializedSpendingLimitDraft,
  toSerializedSpendingLimitDraft,
  toPersistedSpendingLimit
} from './types';

export type { SpendingLimitDraft } from './types';
export { classifySpendingLimitChange } from './change';
export type { SpendingLimitChangeClassification } from './change';

export class SpendingLimitStrictAuthenticationRequiredError extends Error {
  readonly code = 'SPENDING_LIMIT_STRICT_AUTHENTICATION_REQUIRED';

  constructor() {
    super('Strict authentication is required for this spending limit change');
    this.name = 'SpendingLimitStrictAuthenticationRequiredError';
  }
}

export class SpendingLimitConfigurationConflictError extends Error {
  readonly code = 'SPENDING_LIMIT_CONFIGURATION_CONFLICT';

  constructor() {
    super('The spending limit changed before this edit was saved');
    this.name = 'SpendingLimitConfigurationConflictError';
  }
}

export interface SaveSpendingLimitOptions {
  observedRevision?: string;
  strictlyAuthenticated: boolean;
  now?: number;
  makeRevision?: () => string;
}

export const readSpendingLimit = async (accountId: string): Promise<SpendingLimitConfiguration | undefined> => {
  const row = await spendingLimits.get(canonicalSpendingLimitIdentity(accountId));
  return row === undefined ? undefined : parsePersistedSpendingLimit(row);
};

export const saveSpendingLimit = async (
  draft: SpendingLimitDraft,
  options: SaveSpendingLimitOptions
): Promise<SpendingLimitConfiguration | undefined> => {
  const parsedDraft = parseSerializedSpendingLimitDraft(toSerializedSpendingLimitDraft(draft));
  const accountId = canonicalSpendingLimitIdentity(parsedDraft.accountId);
  return db.transaction('rw', spendingLimits, async () => {
    const currentRow = await spendingLimits.get(accountId);
    const current = currentRow === undefined ? undefined : parsePersistedSpendingLimit(currentRow);
    if (
      (current === undefined && options.observedRevision !== undefined) ||
      (current !== undefined && options.observedRevision !== current.revision)
    ) {
      throw new SpendingLimitConfigurationConflictError();
    }
    if (
      classifySpendingLimitChange(current, { accountId, limit: parsedDraft.limit }) === 'strict-authentication' &&
      !options.strictlyAuthenticated
    ) {
      throw new SpendingLimitStrictAuthenticationRequiredError();
    }
    if (parsedDraft.limit === undefined) {
      await spendingLimits.delete(accountId);
      return undefined;
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const next: SpendingLimitConfiguration = {
      accountId,
      limit: parsedDraft.limit,
      revision: (options.makeRevision ?? uuid)(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    await spendingLimits.put(toPersistedSpendingLimit(next));
    return next;
  });
};
