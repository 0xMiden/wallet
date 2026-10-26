import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

export const NetworkModeBanner = () => null;
export const useHideNavbarWhileOpen = () => undefined;
export const useUserVisibleError = () => undefined;
export const useTokenLogoUri = () => undefined;
export const getTestNetworkNameKey = () => 'mainnet';
export const getEffectiveExplorerUrl = (): string | undefined => 'https://explorer.cedar.miden.io';
export const getEffectiveGuardianUrl = (): string => 'https://guardian.cedar.internal.lambdaclass.com';
export const getEffectiveDefaultGuardianEndpoint = (): string => 'https://guardian.cedar.internal.lambdaclass.com';
export const getEffectiveFeeFaucetId = (): string | undefined => undefined;
export const getEffectiveFaucetApiUrl = (): string | undefined => undefined;
export const getEffectiveNetworkName = (): MIDEN_NETWORK_NAME => MIDEN_NETWORK_NAME.MAINNET;
export const getEffectiveNoteTransportUrl = (): string | undefined => 'https://transport.cedar.miden.io';
export const getEffectiveProverUrl = (): string | undefined => 'https://tx-prover.cedar.miden.io';
export const getEffectiveRpcUrl = (): string => 'https://rpc.cedar.miden.io';
export const getEndpointState = (): { override: null; feeFaucetId: undefined } => ({
  override: null,
  feeFaucetId: undefined
});
export const whenEndpointOverridesLoaded = (): Promise<void> => Promise.resolve();
export const loadEndpointOverrides = async (): Promise<void> => undefined;
export const setFeeFaucetIdForTest = async (_id: string): Promise<void> => undefined;
export const getActiveOverride = (): null => null;
export const hasCustomEndpointOverride = (): boolean => false;
export const isNetworkChoiceOverride = (): boolean => false;
export const isNoteTransportConfigured = (): boolean => true;
export const ENDPOINT_OVERRIDE_STORAGE_KEY = 'endpoint_overrides';
export const hapticLight = () => undefined;
export const hapticSuccess = async (): Promise<void> => undefined;
export const hapticSelection = () => undefined;
export const hapticError = async (): Promise<void> => undefined;
