import { canonicalWalletAccountId } from '../sdk/helpers';

// Account and faucet references share the SDK AccountId representation, even
// when callers supply bech32, hex, or a wallet routing suffix.
export const canonicalSpendingLimitIdentity = (value: string): string => canonicalWalletAccountId(value);

export const sameSpendingLimitIdentity = (left: string, right: string): boolean =>
  canonicalSpendingLimitIdentity(left) === canonicalSpendingLimitIdentity(right);
