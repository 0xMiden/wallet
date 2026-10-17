// Hermetic visual fixture: production controls, mocked positions/quotes and NO transaction capability.
import React from 'react';
import { useSyncExternalStore } from 'react';
import BigNumber from 'bignumber.js';
import type { EarnPosition } from '../../../src/screens/earn-flow/types';
import { getAdaptiveDecimalPlaces } from '../../../src/lib/i18n/adaptive-precision';
import { withdrawalAmount } from '../../../src/lib/epoch/withdraw-amount';
import type { EarnWithdrawalQuote } from '../../../src/lib/epoch/earn-withdraw-quote';
export const account = { publicKey: 'fixture-miden-account', evmAddress: '0x1111111111111111111111111111111111111111' };
export const position: EarnPosition = {
  id: 'position-1',
  vaultId: 'vault',
  owner: account.evmAddress,
  marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  chainId: '11155111',
  underlyingAddress: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  withdrawable: '10.123456789012345678',
  decimals: 18,
  protocol: 'Dummy Lending',
  asset: 'USDC',
  network: 'Sepolia',
  amount: '10.123456789012345678',
  depositedAmount: '10.12 USDC',
  depositsUsd: 10.123456789012345,
  rewards: '—',
  age: '—',
  activeDuration: '—',
  apy: '2%',
  dailyAverage: '—',
  started: '—',
  yearlyEstimate: '—',
  withdrawTime: '~1 minute',
  route: 'Sepolia → Miden',
  stale: false,
  chartData: [
    { label: 'Oct 10', value: 10 },
    { label: 'Oct 13', value: 10.06 },
    { label: 'Oct 17', value: 10.123456 }
  ]
};
export function navigate(url: string) {
  history.pushState(null, '', url);
  window.dispatchEvent(new Event('popstate'));
}
export const goBack = () => {
  history.back();
};
export const useAccount = () => account;
export function useLocation() {
  const query = useSyncExternalStore(
    fn => {
      window.addEventListener('popstate', fn);
      return () => window.removeEventListener('popstate', fn);
    },
    () => location.pathname + location.search
  );
  return { search: new URL(query, location.origin).search };
}
export const useEarnPositions = () => {
  const remaining = new URLSearchParams(location.search).has('remaining');
  const current = remaining
    ? {
        ...position,
        amount: '7.873456789012345678',
        withdrawable: '7.873456789012345678',
        depositedAmount: '7.87 USDC',
        depositsUsd: 7.873456789012345
      }
    : position;
  return {
    positions: [current],
    summary: {
      totalRewardsUsd: null,
      blendedApyPercent: 2,
      totalDepositedUsd: remaining ? 7.873456789012345 : 10.123456789012345,
      estimatedRewardsUsd: null
    },
    isLoading: false,
    refetch: () => undefined
  };
};
export const earnItemLoadState = () => ({ pending: false, loadFailed: false });
export const useTokenLogoUri = () => undefined;
export const getCurrentLocale = () => 'en';
export const getNumberSymbols = () => ({ decimal: '.', group: ',' });
export const getTestNetworkNameKey = () => 'testnet';
export const NetworkModeSheet = () => null;
export const hapticLight = () => undefined;
export const hapticMedium = () => undefined;
export const hapticSelection = () => undefined;
export const isMobile = () => false;
export const isExtension = () => false;
// Mirror the production formatter at this mocked history boundary. Submission never reads this text.
export const formatMoneyAmount = (value: string, kind: 'typed' | 'pays' | 'receives' = 'receives') => {
  const amount = new BigNumber(value);
  return kind === 'typed'
    ? amount.toFixed()
    : amount
        .decimalPlaces(getAdaptiveDecimalPlaces(value), kind === 'pays' ? BigNumber.ROUND_UP : BigNumber.ROUND_DOWN)
        .toFixed();
};
export const gaslessEarnWithdrawalToMiden = async (args: { onRowCreated?: (id: string) => void }) => {
  // Only a local route transition. No SDK, signer, network request or transaction exists here.
  args.onRowCreated?.('fixture-withdrawal');
};
export const quoteEarnWithdrawal = async (args: {
  amount: string;
  accountId: string;
}): Promise<EarnWithdrawalQuote> => {
  if (new URLSearchParams(location.search).has('quoteError')) throw Error('fixture quote unavailable');
  const amountAtomic = withdrawalAmount(args.amount, 18)!;
  const expectedAtomic = (amountAtomic * 991822n) / 1000000000000000000n;
  return {
    position,
    accountId: args.accountId,
    amount: args.amount,
    amountAtomic: amountAtomic.toString(),
    availableAtomic: '10123456789012345678',
    scope: 'fixture',
    allocatorUrl: 'fixture',
    destinationFaucetId: 'fixture',
    destinationSymbol: 'USDCX',
    destinationDecimals: 6,
    expectedAtomic: expectedAtomic.toString(),
    minimumAtomic: ((expectedAtomic * 99n) / 100n).toString(),
    expiresAt: Date.now() + 60000
  };
};
export const MIDEN_METADATA = { symbol: 'USDCX', decimals: 6 };
export const getEffectiveExplorerUrl = () => '';
export const getEffectiveGuardianUrl = () => '';
export const getEffectiveNetworkName = () => 'testnet';
export const getEffectiveRpcUrl = () => '';
export default function useMidenFaucetId() {
  return 'fixture-native';
}
export const getNativeAssetIdSync = () => 'fixture-native';
export const getNativeAssetMetadataSync = () => ({ name: 'USDCX', symbol: 'USDCX', decimals: 6 });
export const getNativeAssetMetadata = async () => getNativeAssetMetadataSync();
export const getSdkSyncedNativeAssetIdSync = getNativeAssetIdSync;
export const claimAccentColor = () => 'var(--tx-received)';
export const useWalletStore = <T,>(selector: (state: { assetsMetadata: Record<string, unknown> }) => T): T =>
  selector({ assetsMetadata: {} });
export const useHideNavbarWhileOpen = () => undefined;
export const useBridgeConfigSnapshot = () => undefined;
export const earnWithdrawAmountFields = (_inputs: unknown, amount: bigint) => ({
  amount: (Number(amount) / 1e6).toFixed(6),
  token: 'USDCX'
});
export function useTransactionRow() {
  const phase = new URLSearchParams(location.search).get('phase') ?? 'prepared';
  return {
    loaded: true,
    row: {
      id: 'fixture-withdrawal',
      accountId: account.publicKey,
      type: 'earn-withdraw',
      faucetId: 'fixture-native',
      amount: phase === 'received' ? 2231598n : 0n,
      extraInputs: {
        sourceAmount: '2.25',
        sourceSymbol: 'USDC',
        phase: phase === 'prepared' ? 'redeeming' : phase,
        submissionState: phase === 'prepared' ? 'prepared' : 'accepted',
        error: phase === 'failed' ? 'The withdrawal could not be submitted. Your position is unchanged.' : undefined
      }
    }
  };
}
