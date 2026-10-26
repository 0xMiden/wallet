import { ownDiagnosticData, safeOwnDiagnosticData } from 'lib/telemetry/closed-root-diagnostics';

import type { ITransaction } from '../db/types';
export const QUEUE_ADMISSION_OBSERVATIONS = ['in_progress_gate', 'row_ineligible', 'selected', 'unavailable'] as const;
export type QueueAdmissionObservation = (typeof QUEUE_ADMISSION_OBSERVATIONS)[number];
export type QueueAdmissionMember = Readonly<Pick<ITransaction, 'id' | 'initiatedAt' | 'queuedSeq'>>;
type Fingerprint = { id: string; initiatedAt: number; queuedSeq: number | undefined };
const observations = new Map<string, { member: Fingerprint; observation: QueueAdmissionObservation; at: number }>();
function fingerprint(value: unknown): Fingerprint | undefined {
  try {
    const id = ownDiagnosticData(value, 'id'),
      initiatedAt = ownDiagnosticData(value, 'initiatedAt'),
      queuedSeq = ownDiagnosticData(value, 'queuedSeq');
    if (
      typeof id !== 'string' ||
      !id ||
      typeof initiatedAt !== 'number' ||
      !Number.isFinite(initiatedAt) ||
      (queuedSeq !== undefined && (typeof queuedSeq !== 'number' || !Number.isFinite(queuedSeq)))
    )
      return undefined;
    return { id, initiatedAt, queuedSeq };
  } catch {
    return undefined;
  }
}
const equal = (left: Fingerprint, right: Fingerprint) =>
  left.id === right.id && left.initiatedAt === right.initiatedAt && left.queuedSeq === right.queuedSeq;
export function recordQueueAdmission(
  member: QueueAdmissionMember,
  observation: Exclude<QueueAdmissionObservation, 'unavailable'>
): void {
  try {
    const safe = fingerprint(member),
      at = performance.now();
    if (
      !safe ||
      !Number.isFinite(at) ||
      !['in_progress_gate', 'row_ineligible', 'selected'].some(value => value === observation)
    ) {
      const id = safeOwnDiagnosticData(member, 'id');
      if (typeof id === 'string') observations.delete(id);
      return;
    }
    observations.delete(safe.id);
    observations.set(safe.id, { member: safe, observation, at });
    if (observations.size > 256) observations.delete(observations.keys().next().value!);
  } catch {}
}
export function pruneQueueAdmission(members: readonly QueueAdmissionMember[]): void {
  try {
    const present = new Map(
      members
        .map(fingerprint)
        .filter((value): value is Fingerprint => value !== undefined)
        .map(value => [value.id, value])
    );
    for (const [id, entry] of observations) {
      const current = present.get(id);
      if (!current || !equal(current, entry.member)) observations.delete(id);
    }
  } catch {
    observations.clear();
  }
}
export function consumeQueueAdmission(member: QueueAdmissionMember): QueueAdmissionObservation {
  try {
    const id = safeOwnDiagnosticData(member, 'id');
    if (typeof id !== 'string') return 'unavailable';
    const entry = observations.get(id);
    observations.delete(id);
    const safe = fingerprint(member);
    if (!safe) return 'unavailable';
    if (!entry || !equal(safe, entry.member)) return 'unavailable';
    const age = performance.now() - entry.at;
    return Number.isFinite(age) && age >= 0 && age <= 60000 ? entry.observation : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
