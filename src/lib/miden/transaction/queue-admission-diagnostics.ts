import { ownDiagnosticData, safeOwnDiagnosticData } from 'lib/telemetry/closed-root-diagnostics';

import type { ITransaction } from '../db/types';
export const QUEUE_ADMISSION_OBSERVATIONS = ['in_progress_gate', 'row_ineligible', 'selected', 'unavailable'] as const;
export type QueueAdmissionObservation = (typeof QUEUE_ADMISSION_OBSERVATIONS)[number];
/**
 * Strongest look the processing loop recorded for this queued incarnation. `never` means none.
 * `not_reached` means a lap ran and stopped at an earlier row.
 */
export const QUEUE_SIGHTINGS = ['never', 'not_reached', 'in_progress_gate', 'row_ineligible', 'selected'] as const;
export type QueueSighting = (typeof QUEUE_SIGHTINGS)[number];
export type QueueAdmissionMember = Readonly<Pick<ITransaction, 'id' | 'initiatedAt' | 'queuedSeq'>>;
type Fingerprint = { id: string; initiatedAt: number; queuedSeq: number | undefined };
type RecordedSighting = Exclude<QueueSighting, 'never'>;
const SIGHTING_RANK: Record<RecordedSighting, number> = {
  not_reached: 1,
  in_progress_gate: 2,
  row_ineligible: 3,
  selected: 4
};
const observations = new Map<string, { member: Fingerprint; observation: QueueAdmissionObservation; at: number }>();
const sightings = new Map<string, { member: Fingerprint; sighting: RecordedSighting }>();
const sightingRank = (value: unknown): number =>
  value === 'not_reached' || value === 'in_progress_gate' || value === 'row_ineligible' || value === 'selected'
    ? SIGHTING_RANK[value]
    : 0;
/** The observation to store when it outranks `current`, otherwise undefined. */
export function upgradedQueueSighting(current: unknown, observation: RecordedSighting): RecordedSighting | undefined {
  return sightingRank(observation) > sightingRank(current) ? observation : undefined;
}
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
    rememberSighting(safe, observation);
  } catch {}
}
/** A look that is not a 60-second admission, such as a lap that stopped before this row. */
export function noteQueueSighting(member: QueueAdmissionMember, sighting: RecordedSighting): void {
  try {
    const safe = fingerprint(member);
    if (!safe || sightingRank(sighting) === 0) return;
    rememberSighting(safe, sighting);
  } catch {}
}
function rememberSighting(safe: Fingerprint, sighting: RecordedSighting): void {
  const seen = sightings.get(safe.id);
  if (!seen || !equal(seen.member, safe) || sightingRank(sighting) > sightingRank(seen.sighting))
    sightings.set(safe.id, { member: safe, sighting });
}
/**
 * Strongest look for this exact queued incarnation: this process, or the copy stored on the row when it is bound
 * to the same `initiatedAt` and `queuedSeq`. `never` when neither has one.
 */
export function queueSightingFor(
  row: QueueAdmissionMember & {
    queueSighting?: unknown;
    queueSightingAt?: unknown;
    queueSightingSeq?: unknown;
  }
): QueueSighting {
  const stored =
    row.queueSightingAt === row.initiatedAt && row.queueSightingSeq === (row.queuedSeq ?? null)
      ? row.queueSighting
      : undefined;
  const memory = peekQueueSighting(row);
  const memoryRank = sightingRank(memory);
  const storedRank = sightingRank(stored);
  if (memoryRank === 0 && storedRank === 0) return 'never';
  const best = memoryRank >= storedRank ? memory : stored;
  return best === 'not_reached' || best === 'in_progress_gate' || best === 'row_ineligible' || best === 'selected'
    ? best
    : 'never';
}
/** Strongest look in this process for this exact queued incarnation, or `never`. Not cleared by the 60s consume. */
export function peekQueueSighting(member: QueueAdmissionMember): QueueSighting {
  try {
    const safe = fingerprint(member);
    if (!safe) return 'never';
    const entry = sightings.get(safe.id);
    return entry && equal(entry.member, safe) ? entry.sighting : 'never';
  } catch {
    return 'never';
  }
}
/** Drop looks for rows that are no longer queued, or whose queued incarnation changed. */
export function retainQueueSightings(members: readonly QueueAdmissionMember[]): void {
  try {
    if (members.length === 0) {
      sightings.clear();
      return;
    }
    const present = new Map(
      members
        .map(fingerprint)
        .filter((value): value is Fingerprint => value !== undefined)
        .map(value => [value.id, value])
    );
    for (const [id, entry] of sightings) {
      const current = present.get(id);
      if (!current || !equal(current, entry.member)) sightings.delete(id);
    }
  } catch {
    sightings.clear();
  }
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
    // An empty membership is the queue-is-empty reset. A partial lap must not forget looks at rows it
    // has not reached yet; only a new incarnation of an id drops that id's look.
    if (members.length === 0) sightings.clear();
    else
      for (const [id, entry] of sightings) {
        const current = present.get(id);
        if (current && !equal(current, entry.member)) sightings.delete(id);
      }
  } catch {
    observations.clear();
    sightings.clear();
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
