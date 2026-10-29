import {
  observeProposalCreateRejection,
  snapshotProposalCreateDiagnostics,
  validateProposalCreateDiagnostics
} from './proposal-create-diagnostics';

it.each([
  ['ConsumeNoteNotAuthenticatedError', 'consume_notes_note_not_authenticated', 'consume_note_not_verified'],
  ['MultisigAuthArgsMissingError', 'multisig_auth_args_missing', 'multisig_required_args_missing']
])('publishes a finite unfiltered category for %s', (name, code, expected) => {
  const error = Object.assign(new Error('private canary'), { name, code });
  observeProposalCreateRejection(error);
  expect(snapshotProposalCreateDiagnostics(error)).toEqual({
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: expected
  });
});

it('publishes the latest block header category without raw error data', () => {
  const error = new Error('failed to read the latest block header for the auth args: private canary');
  observeProposalCreateRejection(error);
  expect(snapshotProposalCreateDiagnostics(error)).toEqual({
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'sdk_latest_block_header_read'
  });
});

it.each(['consume_note_authentication', 'multisig_auth_args_missing', 'sdk_auth_header_read'])(
  'rejects the filtered legacy wire category %s',
  family => {
    expect(validateProposalCreateDiagnostics({ proposalCreateApi: 'consume_notes', proposalCreateFamily: family }))
      .toBeUndefined();
  }
);

it('replaces reused root evidence, rejects structural/cause injection and requires the complete closed pair', () => {
  const error = new Error('failed to get account: private');
  observeProposalCreateRejection(error);
  expect(snapshotProposalCreateDiagnostics(error)).toEqual({
    proposalCreateApi: 'consume_notes',
    proposalCreateFamily: 'sdk_account_read'
  });
  error.message = 'private';
  observeProposalCreateRejection(error);
  expect(snapshotProposalCreateDiagnostics(error)?.proposalCreateFamily).toBe('unmatched');
  expect(snapshotProposalCreateDiagnostics(new Error('wrapper', { cause: error }))).toBeUndefined();
  expect(
    snapshotProposalCreateDiagnostics(
      Object.assign(new Error('forged'), {
        proposalCreateApi: 'consume_notes',
        proposalCreateFamily: 'sdk_account_read'
      })
    )
  ).toBeUndefined();
  for (const value of [
    { proposalCreateApi: 'consume_notes' },
    { proposalCreateApi: 'other', proposalCreateFamily: 'unmatched' },
    { proposalCreateApi: 'consume_notes', proposalCreateFamily: 'private' },
    { proposalCreateApi: 'consume_notes', proposalCreateFamily: 'unmatched', raw: 'canary' }
  ])
    expect(validateProposalCreateDiagnostics(value)).toBeUndefined();
  expect(() => observeProposalCreateRejection('primitive')).not.toThrow();
});
