import { closedDiagnosticPair, rootDiagnosticStore } from './closed-root-diagnostics';
export const GUARDIAN_PROVING_SUBSTEPS = [
  'prove_delegate',
  'local_prover_build',
  'prove_local',
  'fallback_prover_build',
  'prove_fallback',
  'proof_evidence',
  'submitting_stage_write',
  'unobserved'
] as const;
export type GuardianProvingSubstep = (typeof GUARDIAN_PROVING_SUBSTEPS)[number];
export interface GuardianProvingDiagnostics {
  guardianProvingSubstep: GuardianProvingSubstep;
}
export const validateGuardianProvingDiagnostics = (value: unknown): GuardianProvingDiagnostics | undefined =>
  closedDiagnosticPair(value, { guardianProvingSubstep: GUARDIAN_PROVING_SUBSTEPS });
const store = rootDiagnosticStore(validateGuardianProvingDiagnostics);
export const annotateGuardianProving = store.annotate;
export const snapshotGuardianProving = store.snapshot;
