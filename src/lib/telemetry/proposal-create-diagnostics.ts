import {
  classifyProposalCreateRejection,
  PROPOSAL_CREATE_FAMILIES,
  type ProposalCreateFamily
} from 'lib/miden/sdk/proposal-create-error-family';

import { closedDiagnosticPair, rootDiagnosticStore } from './closed-root-diagnostics';
export type { ProposalCreateFamily } from 'lib/miden/sdk/proposal-create-error-family';
export interface ProposalCreateDiagnostics {
  proposalCreateApi: 'consume_notes';
  proposalCreateFamily: ProposalCreateFamily;
}
export const validateProposalCreateDiagnostics = (value: unknown): ProposalCreateDiagnostics | undefined =>
  closedDiagnosticPair(value, { proposalCreateApi: ['consume_notes'], proposalCreateFamily: PROPOSAL_CREATE_FAMILIES });
const store = rootDiagnosticStore(validateProposalCreateDiagnostics);
export const snapshotProposalCreateDiagnostics = store.snapshot;
export function observeProposalCreateRejection(error: unknown): void {
  store.annotate(error, {
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: classifyProposalCreateRejection(error)
  });
}
export function clearProposalCreateDiagnostics(error: unknown): void {
  store.annotate(error, undefined);
}
export function transferProposalCreateDiagnostics(source: unknown, target: unknown): void {
  store.annotate(target, store.snapshot(source));
}
