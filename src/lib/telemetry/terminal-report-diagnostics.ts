import {
  QUEUE_ADMISSION_OBSERVATIONS,
  type QueueAdmissionObservation
} from 'lib/miden/transaction/queue-admission-diagnostics';

import { rootDiagnosticStore, safeOwnDiagnosticData } from './closed-root-diagnostics';
import { REAP_START_RELATIONS, type ReapStartRelation } from './reap-start-diagnostics';
export interface TerminalReportDiagnostics {
  queueAdmissionObservation?: QueueAdmissionObservation;
  reapStartRelation?: ReapStartRelation;
}
const store = rootDiagnosticStore<TerminalReportDiagnostics>(value => {
  const queue = QUEUE_ADMISSION_OBSERVATIONS.find(
    item => item === safeOwnDiagnosticData(value, 'queueAdmissionObservation')
  );
  const reap = REAP_START_RELATIONS.find(item => item === safeOwnDiagnosticData(value, 'reapStartRelation'));
  return queue || reap
    ? { ...(queue ? { queueAdmissionObservation: queue } : {}), ...(reap ? { reapStartRelation: reap } : {}) }
    : undefined;
});
export const annotateTerminalReport = store.annotate;
export const snapshotTerminalReport = store.snapshot;
