import { rootDiagnosticStore } from './closed-root-diagnostics';

export const PROOF_WAIT_AVAILABILITIES = [
  'current_attempt_missing',
  'current_entry_missing',
  'execution_time_invalid',
  'submit_time_invalid',
  'time_order_invalid',
  'reference_block_missing',
  'expiration_block_missing',
  'reference_block_invalid',
  'expiration_block_invalid',
  'expiry_order_invalid',
  'derived_wait_invalid',
  'derived_window_invalid',
  'available'
] as const;
export type ProofWaitAvailability = (typeof PROOF_WAIT_AVAILABILITIES)[number];
export const validateProofWaitAvailability = (value: unknown): ProofWaitAvailability | undefined =>
  PROOF_WAIT_AVAILABILITIES.find(member => member === value);
const store = rootDiagnosticStore(validateProofWaitAvailability);
export const annotateProofWaitAvailability = store.annotate;
export const snapshotProofWaitAvailability = store.snapshot;
