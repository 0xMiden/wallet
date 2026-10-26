export const REAP_START_RELATIONS = ['before_realm_cutoff', 'at_or_after_realm_cutoff', 'unavailable'] as const;
export type ReapStartRelation = (typeof REAP_START_RELATIONS)[number];
export function classifyReapStartRelation(processingStartedAt: unknown, realmCutoff: unknown): ReapStartRelation {
  if (
    typeof processingStartedAt !== 'number' ||
    typeof realmCutoff !== 'number' ||
    !Number.isSafeInteger(processingStartedAt) ||
    !Number.isSafeInteger(realmCutoff) ||
    processingStartedAt <= 0 ||
    realmCutoff <= 0
  )
    return 'unavailable';
  return processingStartedAt < realmCutoff ? 'before_realm_cutoff' : 'at_or_after_realm_cutoff';
}
