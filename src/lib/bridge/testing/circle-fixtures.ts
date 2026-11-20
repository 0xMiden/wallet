import { bindTransferQuote } from 'lib/bridge/core/quote';

import { referenceSnapshot } from './fixtures';
import { reviewedCircleTransfer } from './operation-fixtures';

// Test-only explicitly supplied identities; the published wallet document does not currently supply a transmitter.
export const TEST_CCTP_TRANSMITTER = '0x2222222222222222222222222222222222222222';
export const TEST_CCTP_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
export function circleSnapshot() {
  const snapshot = referenceSnapshot('testnet');
  const deposit = snapshot.config?.supportedEvmChains.sepolia?.bridges.usdcx?.deposit;
  if (!deposit || deposit.route !== 'executor') throw new Error('Missing test CCTP source');
  Object.assign(deposit, { tokenMessenger: TEST_CCTP_MESSENGER.toLowerCase() });
  return snapshot;
}
export function reviewedOwnedCircleTransfer() {
  const review = reviewedCircleTransfer();
  const snapshot = circleSnapshot();
  if (!snapshot.config || !snapshot.derived || !review.quote) throw new Error('Missing test Circle configuration');
  review.route.recovery = { ...review.route.recovery, config: snapshot.config, derived: snapshot.derived };
  review.quote = bindTransferQuote({ route: review.route, amount: review.amount, ...review.accounts }, review.quote);
  return review;
}
