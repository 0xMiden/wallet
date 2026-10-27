import {
  observeProposalCreateRejection,
  snapshotProposalCreateDiagnostics,
  validateProposalCreateDiagnostics
} from './proposal-create-diagnostics';

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
