import type { CounterpartyTransaction } from '../ios/helpers/wc-counterparty-request';
import type { MainnetEpochCheckpoint } from './mainnet-epoch-checkpoint';

export function inspectEpochEvmTransaction(
  _state: MainnetEpochCheckpoint,
  _transaction: CounterpartyTransaction,
  _expiry: bigint,
  _now = Date.now()
): 'approve' | 'deposit' {
  return 'approve';
}
