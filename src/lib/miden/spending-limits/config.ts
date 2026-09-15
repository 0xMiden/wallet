import { v4 as uuid } from 'uuid';

import { spendingLimits, db } from '../repo';
import { classifySpendingLimitChange } from './change';
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

export const listSpendingLimits = async (accountId: string): Promise<SpendingLimitConfiguration[]> => {
  const rows = await spendingLimits.where('accountId').equals(accountId).toArray();
  return rows.map(parsePersistedSpendingLimit).sort((left, right) => left.faucetId.localeCompare(right.faucetId));
};

export const saveSpendingLimit = async (
  draft: SpendingLimitDraft,
  options: SaveSpendingLimitOptions
): Promise<SpendingLimitConfiguration | undefined> => {
  const validatedDraft = parseSerializedSpendingLimitDraft(toSerializedSpendingLimitDraft(draft));
  return db.transaction('rw', spendingLimits, async () => {
    const currentRow = await spendingLimits.get([validatedDraft.accountId, validatedDraft.faucetId]);
    const current = currentRow === undefined ? undefined : parsePersistedSpendingLimit(currentRow);
    if (
      (current === undefined && options.observedRevision !== undefined) ||
      (current !== undefined && options.observedRevision !== current.revision)
    ) {
      throw new SpendingLimitConfigurationConflictError();
    }
    if (
      classifySpendingLimitChange(current, validatedDraft) === 'strict-authentication' &&
      !options.strictlyAuthenticated
    ) {
      throw new SpendingLimitStrictAuthenticationRequiredError();
    }
    if (validatedDraft.dailyLimit === undefined && validatedDraft.weeklyLimit === undefined) {
      await spendingLimits.delete([validatedDraft.accountId, validatedDraft.faucetId]);
      return undefined;
    }

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const next: SpendingLimitConfiguration = {
      ...validatedDraft,
      revision: (options.makeRevision ?? uuid)(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    const persisted = toPersistedSpendingLimit(next);
    if (persisted === undefined) return undefined;
    await spendingLimits.put(persisted);
    return next;
  });
};
