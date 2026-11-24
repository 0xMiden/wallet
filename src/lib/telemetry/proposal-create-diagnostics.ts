import { classifyProposalCreateRejection, type ProposalCreateFamily } from 'lib/miden/sdk/proposal-create-error-family';

import { closedDiagnosticPair, rootDiagnosticStore } from './closed-root-diagnostics';
export type { ProposalCreateFamily } from 'lib/miden/sdk/proposal-create-error-family';
const wireFamilies = {
  consume_note_missing: 'consume_note_missing',
  consume_note_authentication: 'consume_note_not_verified',
  consume_metadata_oversize: 'consume_metadata_oversize',
  multisig_auth_args_missing: 'multisig_required_args_missing',
  bound_block_not_declared: 'bound_block_not_declared',
  summary_layout_unsupported: 'summary_layout_unsupported',
  sdk_input_note_read: 'sdk_input_note_read',
  sdk_account_read: 'sdk_account_read',
  sdk_auth_header_read: 'sdk_latest_block_header_read',
  sdk_protocol_config_read: 'sdk_protocol_config_read',
  sdk_request_build: 'sdk_request_build',
  unmatched: 'unmatched',
  unreadable: 'unreadable'
} as const satisfies Record<ProposalCreateFamily, string>;
type ProposalCreateWireFamily = (typeof wireFamilies)[ProposalCreateFamily];
export interface ProposalCreateDiagnostics {
  proposalCreateApi: 'consume_notes';
  proposalCreateFamily: ProposalCreateWireFamily;
}
export const validateProposalCreateDiagnostics = (value: unknown): ProposalCreateDiagnostics | undefined =>
  closedDiagnosticPair(value, {
    proposalCreateApi: ['consume_notes'],
    proposalCreateFamily: Object.values(wireFamilies)
  });
const store = rootDiagnosticStore(validateProposalCreateDiagnostics);
export const snapshotProposalCreateDiagnostics = store.snapshot;
export function observeProposalCreateRejection(error: unknown): void {
  store.annotate(error, {
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: wireFamilies[classifyProposalCreateRejection(error)]
  });
}
export function clearProposalCreateDiagnostics(error: unknown): void {
  store.annotate(error, undefined);
}
export function transferProposalCreateDiagnostics(source: unknown, target: unknown): void {
  store.annotate(target, store.snapshot(source));
}
