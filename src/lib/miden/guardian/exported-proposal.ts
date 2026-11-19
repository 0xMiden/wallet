import type { ExportedProposal, Proposal } from '@openzeppelin/miden-multisig-client';

type ExportedSignature = ExportedProposal['signatures'][number];

const exportedSignature = (entry: Proposal['signatures'][number]): ExportedSignature => {
  const { signature } = entry;
  switch (signature.scheme) {
    case 'ecdsa':
      return {
        commitment: entry.signerId,
        signatureHex: signature.signature,
        scheme: signature.scheme,
        publicKey: signature.publicKey,
        ...(signature.messageFormat ? { messageFormat: signature.messageFormat } : {}),
        timestamp: entry.timestamp
      };
    case 'falcon':
      return {
        commitment: entry.signerId,
        signatureHex: signature.signature,
        scheme: signature.scheme,
        timestamp: entry.timestamp
      };
  }
};

/**
 * Gives the JSON that `Multisig.importProposal` reads for a proposal this wallet holds.
 *
 * The SDK's `exportProposalToJson` reads the same fields from the cache of the Multisig
 * that made the proposal. This function reads them from the proposal itself, so a second
 * Multisig (the cold co-signer of a guardian switch) can adopt the proposal without that
 * first Multisig and without a read of the Guardian's pending list (#2225).
 */
export const exportedProposalJson = (proposal: Proposal): string => {
  const exported: ExportedProposal = {
    accountId: proposal.accountId,
    nonce: proposal.nonce,
    commitment: proposal.id,
    txSummaryBase64: proposal.txSummary,
    signatures: proposal.signatures.map(exportedSignature),
    metadata: proposal.metadata
  };
  return JSON.stringify(exported);
};
