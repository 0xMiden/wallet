import { TRANSACTION_STAGES, type ITransactionStage } from 'lib/miden/db/types';

import { closedDiagnosticPair, rootDiagnosticStore, ownDiagnosticData } from './closed-root-diagnostics';
export const OFFSCREEN_DEADLINE_METHODS = [
  'sendTransaction',
  'swapTransaction',
  'consumeNoteId',
  'newTransaction',
  'guardianPipeline',
  'unobserved'
] as const;
export type OffscreenDeadlineMethod = (typeof OFFSCREEN_DEADLINE_METHODS)[number];
export type OffscreenDeadlineStage = ITransactionStage | 'not_observed';
export interface OffscreenDeadlineDiagnostics {
  offscreenDeadlineMethod: OffscreenDeadlineMethod;
  offscreenDeadlineStage: OffscreenDeadlineStage;
}
export const validateOffscreenDeadlineDiagnostics = (value: unknown): OffscreenDeadlineDiagnostics | undefined =>
  closedDiagnosticPair(value, {
    offscreenDeadlineMethod: OFFSCREEN_DEADLINE_METHODS,
    offscreenDeadlineStage: [...TRANSACTION_STAGES, 'not_observed']
  });
const store = rootDiagnosticStore(validateOffscreenDeadlineDiagnostics);
export const annotateOffscreenDeadline = store.annotate;
export const snapshotOffscreenDeadline = store.snapshot;
export function isOwnStartedWriteDeadline(error: unknown): boolean {
  try {
    const facts = ownDiagnosticData(error, 'facts');
    const deadline = ownDiagnosticData(facts, 'deadline');
    return (
      ownDiagnosticData(error, 'reason') === 'deadline' &&
      ownDiagnosticData(facts, 'started') === true &&
      ownDiagnosticData(deadline, 'owner') === 'own' &&
      ownDiagnosticData(deadline, 'killer') === 'write' &&
      ownDiagnosticData(deadline, 'timer') === 'started'
    );
  } catch {
    return false;
  }
}

const reports = rootDiagnosticStore(validateOffscreenDeadlineDiagnostics);
export function transferOffscreenDeadline(source: unknown, target: unknown): void {
  reports.annotate(target, isOwnStartedWriteDeadline(source) ? store.snapshot(source) : undefined);
}
export function snapshotOffscreenDeadlineForCrash(error: unknown): OffscreenDeadlineDiagnostics | undefined {
  const observed = store.snapshot(error);
  return observed && isOwnStartedWriteDeadline(error) ? observed : reports.snapshot(error);
}
