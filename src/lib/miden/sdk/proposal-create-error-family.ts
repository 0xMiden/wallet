import { ownDiagnosticData } from 'lib/telemetry/closed-root-diagnostics';

export const PROPOSAL_CREATE_FAMILIES = [
  'consume_note_missing',
  'consume_note_authentication',
  'consume_metadata_oversize',
  'multisig_auth_args_missing',
  'bound_block_not_declared',
  'summary_layout_unsupported',
  'sdk_input_note_read',
  'sdk_account_read',
  'sdk_auth_header_read',
  'sdk_protocol_config_read',
  'sdk_request_build',
  'unmatched',
  'unreadable'
] as const;
export type ProposalCreateFamily = (typeof PROPOSAL_CREATE_FAMILIES)[number];
const typed: ReadonlyArray<readonly [string, string, ProposalCreateFamily]> = [
  ['LegacyConsumeNotesNoteMissingError', 'consume_notes_legacy_note_missing', 'consume_note_missing'],
  ['ConsumeNoteNotAuthenticatedError', 'consume_notes_note_not_authenticated', 'consume_note_authentication'],
  ['ConsumeNotesMetadataOversizeError', 'consume_notes_metadata_oversize', 'consume_metadata_oversize'],
  ['MultisigAuthArgsMissingError', 'multisig_auth_args_missing', 'multisig_auth_args_missing'],
  ['BoundBlockNotDeclaredError', 'bound_block_not_declared', 'bound_block_not_declared'],
  ['TransactionSummaryLayoutError', 'transaction_summary_layout_unsupported', 'summary_layout_unsupported']
];
const prefixes: ReadonlyArray<readonly [string, ProposalCreateFamily]> = [
  ['failed to get input note: ', 'sdk_input_note_read'],
  ['failed to get account: ', 'sdk_account_read'],
  ['failed to read the latest block header for the auth args: ', 'sdk_auth_header_read'],
  ['failed to read the registered protocol configuration: ', 'sdk_protocol_config_read'],
  ['failed to build transaction request: ', 'sdk_request_build']
];
export function classifyProposalCreateRejection(error: unknown): ProposalCreateFamily {
  try {
    const name = ownDiagnosticData(error, 'name');
    const code = ownDiagnosticData(error, 'code');
    const family = typed.find(([expectedName, expectedCode]) => name === expectedName && code === expectedCode)?.[2];
    if (family) return family;
    const message = ownDiagnosticData(error, 'message');
    return typeof message === 'string'
      ? (prefixes.find(([prefix]) => message.startsWith(prefix))?.[1] ?? 'unmatched')
      : 'unmatched';
  } catch {
    return 'unreadable';
  }
}
