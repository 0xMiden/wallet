import { useSyncExternalStore } from 'react';

import { ITransactionStatus, type ITransaction } from '../../../src/lib/miden/db/types';
import type { BridgeConfigSnapshot } from '../../../src/lib/remote-config/runtime';
import { EARN_DATA } from '../../../src/screens/earn-flow/data';

export const NATIVE_ID = '0x111111111111111111111111111111';
export const COLLATERAL_ID = '0x222222222222222222222222222222';
export const TX_ID = 'visual-bridge-row';
export const VAULT_ID = EARN_DATA.vaults[1]!.id;
export const scenario = new URLSearchParams(location.search).get('case');
export const boundaryCalls: { name: string; args: unknown[] }[] = [];
const record = (name: string, ...args: unknown[]) => boundaryCalls.push({ name, args });

export function forbidden(name: string): never {
  record('forbidden', name);
  throw new Error(`Unexpected visual fixture boundary: ${name}`);
}

let phase: 'submitting' | 'failed' = 'submitting';
const rowListeners = new Set<() => void>();
const snapshot: BridgeConfigSnapshot = {
  network: 'mainnet',
  status: 'ready',
  config: null,
  derived: null,
  lastFetch: null
};
export function failBridge() {
  if (phase !== 'submitting') return forbidden('repeated bridge transition');
  phase = 'failed';
  for (const listener of rowListeners) listener();
}
export function useTransactionRow(id: string) {
  if (id !== TX_ID) return forbidden('unexpected transaction id');
  const currentPhase = useSyncExternalStore(
    listener => {
      rowListeners.add(listener);
      return () => rowListeners.delete(listener);
    },
    () => phase
  );
  const row: ITransaction = {
    id: TX_ID,
    type: 'bridged-receive',
    accountId: 'visual-guardian-account',
    amount: 0n,
    faucetId: COLLATERAL_ID,
    status: ITransactionStatus.Completed,
    initiatedAt: 1,
    completedAt: 1,
    displayMessage: 'Bridging in',
    displayIcon: 'DEFAULT',
    extraInputs: {
      provider: 'epoch',
      sourceAddress: '0x1111111111111111111111111111111111111111',
      sourceAmount: '12.5',
      sourceSymbol: 'USDC',
      phase: currentPhase,
      ...(currentPhase === 'failed' ? { error: '' } : {})
    }
  };
  return { row, loaded: true };
}

export const useAccount = () => ({ publicKey: 'visual-guardian-account', type: 'guardian' });
export const useAllTokensBaseMetadata = () => ({});
export const useAllBalances = () => ({
  data:
    scenario === 'earn-no-collateral'
      ? []
      : [
          {
            tokenId: COLLATERAL_ID,
            balance: 200,
            fiatPrice: 0,
            metadata: { symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true }
          }
        ]
});
export const useWalletStore = <T,>(select: (state: { tokenPrices: {}; assetsMetadata: {} }) => T): T =>
  select({ tokenPrices: {}, assetsMetadata: {} });
export const useEarnPositions = () => ({
  ...EARN_DATA,
  isLoading: false,
  notOnNetwork: false,
  refetch: () => forbidden('earn refetch')
});
export const useEarnCollateralState = () =>
  scenario === 'earn-no-collateral'
    ? { state: 'loading' as const, collateral: null }
    : {
        state: 'resolved' as const,
        collateral: { faucetId: COLLATERAL_ID, symbol: 'USDC', decimals: 6 }
      };
export const useFeatureAvailability = () => ({ state: 'available' as const });
export const useBridgeConfigSnapshot = () => snapshot;
export const getBridgeConfigSnapshot = () => snapshot;
export const useTokenLogoUri = () => undefined;
export const getEffectiveNetworkName = () => 'mainnet';
export const getTestNetworkNameKey = () => 'mainnet';
export const getEffectiveExplorerUrl = () => '';
export const getEffectiveRpcUrl = () => '';
export const getEffectiveGuardianUrl = () => '';
export const getNativeAssetIdSync = () => NATIVE_ID;
export const getSdkSyncedNativeAssetIdSync = () => NATIVE_ID;
export const getNativeAssetMetadataSync = () => ({ symbol: 'MIDEN', name: 'Miden', decimals: 6 });
export const getNativeAssetMetadata = async () => getNativeAssetMetadataSync();
export const hapticLight = () => record('hapticLight');
export const hapticMedium = () => record('hapticMedium');
export const hapticSelection = () => record('hapticSelection');
export const syncStatusBar = () => record('native status bar');
export const openExternalUrl = () => forbidden('external URL');
export const getTokenMetadata = () => forbidden('metadata fetch');
export const accountRefToSdk = () => {
  record('SDK parser unavailable');
  throw new Error('No WASM account parser in this display fixture');
};
export const getBech32AddressFromAccountId = () => forbidden('SDK account encoder');
export const walletRaised = <E extends Error,>(error: E): E => {
  record('walletRaised');
  return error;
};
export const enterRouteFlow = () => record('enterRouteFlow');
export const reportRouteFlowStep = () => record('reportRouteFlowStep');
export const settleRouteFlow = () => record('settleRouteFlow');
export const reportUserVisibleError = (id: string, surface: string) => record('visible error', id, surface);

export function UsdcxDepositSteps(): never {
  return forbidden('unselected USDCx steps');
}
export function UsdcxExecuteAction(): never {
  return forbidden('unselected USDCx action');
}
