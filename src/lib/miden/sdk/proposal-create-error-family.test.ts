import { classifyProposalCreateRejection } from './proposal-create-error-family';

const pairs = [
  ['LegacyConsumeNotesNoteMissingError', 'consume_notes_legacy_note_missing', 'consume_note_missing'],
  ['ConsumeNoteNotAuthenticatedError', 'consume_notes_note_not_authenticated', 'consume_note_authentication'],
  ['ConsumeNotesMetadataOversizeError', 'consume_notes_metadata_oversize', 'consume_metadata_oversize'],
  ['MultisigAuthArgsMissingError', 'multisig_auth_args_missing', 'multisig_auth_args_missing'],
  ['BoundBlockNotDeclaredError', 'bound_block_not_declared', 'bound_block_not_declared'],
  ['TransactionSummaryLayoutError', 'transaction_summary_layout_unsupported', 'summary_layout_unsupported']
];
const prefixes = [
  ['failed to get input note: ', 'sdk_input_note_read'],
  ['failed to get account: ', 'sdk_account_read'],
  ['failed to read the latest block header for the auth args: ', 'sdk_auth_header_read'],
  ['failed to read the registered protocol configuration: ', 'sdk_protocol_config_read'],
  ['failed to build transaction request: ', 'sdk_request_build']
];
it.each(pairs)('requires the exact typed pair %s', (name, code, family) => {
  expect(
    classifyProposalCreateRejection(Object.assign(new Error('failed to get input note: canary'), { name, code }))
  ).toBe(family);
  expect(classifyProposalCreateRejection({ name, code: 'wrong', message: 'private' })).toBe('unmatched');
  expect(classifyProposalCreateRejection({ name: 'wrong', code, message: 'private' })).toBe('unmatched');
});
it.each(prefixes)('requires exact leading context %s including delimiter', (prefix, family) => {
  expect(classifyProposalCreateRejection(new Error(prefix + 'private-canary'))).toBe(family);
  for (const message of [
    'outer: ' + prefix,
    prefix.toUpperCase(),
    prefix.slice(0, -2) + ' private',
    prefix.slice(0, -1)
  ])
    expect(classifyProposalCreateRejection(new Error(message))).toBe('unmatched');
});
it('never invokes accessors or coercion and contains reflective failures', () => {
  const read = jest.fn(() => {
    throw new Error('private');
  });
  expect(classifyProposalCreateRejection(Object.defineProperty({}, 'message', { get: read }))).toBe('unreadable');
  expect(classifyProposalCreateRejection(new Proxy({}, { getOwnPropertyDescriptor: read }))).toBe('unreadable');
  expect(classifyProposalCreateRejection({ message: { toString: read } })).toBe('unmatched');
  expect(read).toHaveBeenCalledTimes(1);
  for (const value of [null, undefined, 'private', 7, Symbol('private')])
    expect(classifyProposalCreateRejection(value)).toBe('unmatched');
});
