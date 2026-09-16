import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { FEE_RESERVE_MULTIPLE } from 'lib/miden/fees/spendable';
import { resolveDisplayMetadata } from 'lib/miden/metadata/resolve';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { formatAmount } from 'lib/shared/format';
import { useWalletStore } from 'lib/store';

/**
 * The most a transaction's network fee can cost, formatted for a review screen.
 *
 * The kernel charges `baseFee x (floor(log2(cycles)) + 1)` and cycles are not known
 * until the transaction is proven, so no screen can quote the exact fee before the
 * user commits. This quotes the same upper bound the wallet already reserves against
 * (`FEE_RESERVE_MULTIPLE`), which is what makes the number honest rather than
 * decorative: it is the amount the form has ALREADY withheld from `Available`, so a
 * user who sends the maximum is told where the difference went.
 *
 * `undefined` — render nothing — on a chain that charges nothing (`0`), before the
 * fee is discovered (`null`), and when the fee asset's scale is unknown. Omitting the
 * row is the house convention for an unknown fee everywhere else it is shown
 * (receipt.ts, HistoryDetails, TransactionAssetView); rendering a zero or a guessed
 * quantity would be worse than silence.
 */
export function useNetworkFeeEstimate(): string | undefined {
  const baseFee = useVerificationBaseFee();
  const assetsMetadata = useWalletStore(state => state.assetsMetadata) ?? {};
  const nativeFaucetId = useMidenFaucetId();

  // Always the native asset: the fee is charged in it regardless of what is being sent.
  const feeMetadata = resolveDisplayMetadata(undefined, assetsMetadata, nativeFaucetId);

  if (baseFee === null || baseFee <= 0 || !hasKnownScale(feeMetadata)) {
    return undefined;
  }

  // `formatAmount` takes smallest units as a bigint; the base fee is already in
  // smallest units, so the multiple stays integral and `Math.round` only guards
  // float drift rather than changing the value.
  const bound = BigInt(Math.round(baseFee * FEE_RESERVE_MULTIPLE));
  return `${formatAmount(bound, feeMetadata.decimals)} ${feeMetadata.symbol}`;
}

export default useNetworkFeeEstimate;
