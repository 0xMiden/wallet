import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

export const NetworkModeBanner = () => null;
export const useHideNavbarWhileOpen = () => undefined;
export const useUserVisibleError = () => undefined;
export const useTokenLogoUri = () => undefined;
export const getTestNetworkNameKey = () => 'mainnet';
export const getEffectiveExplorerUrl = (): string | undefined => 'https://explorer.mainnet.miden.io';
export const getEffectiveGuardianUrl = (): string => 'https://guardian.cedar.internal.lambdaclass.com';
export const getEffectiveDefaultGuardianEndpoint = (): string => 'https://guardian.cedar.internal.lambdaclass.com';
export const getEffectiveFeeFaucetId = (): string | undefined => undefined;
export const getEffectiveFaucetApiUrl = (): string | undefined => undefined;
export const getEffectiveNetworkName = (): MIDEN_NETWORK_NAME => MIDEN_NETWORK_NAME.MAINNET;
export const getEffectiveNoteTransportUrl = (): string | undefined => 'https://transport.mainnet.miden.io';
export const getEffectiveProverUrl = (): string | undefined => 'https://tx-prover.mainnet.miden.io';
export const getEffectiveRpcUrl = (): string => 'https://rpc.mainnet.miden.io';
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

export const NetworkNamedByShell = () => null;
export const hapticMedium = async (): Promise<void> => undefined;
export const hasDeveloperNetworkChoice = (): boolean => false;
export const isFaucetConfigured = (): boolean => false;
export const getEffectiveAllowNoGuardian = (): boolean => false;
export const getEffectiveFaucetUrl = (): string | undefined => undefined;
export const isEndpointOverrideActive = async (): Promise<boolean> => false;
const unsupportedEndpointMutation = (): never => {
  throw new Error('Endpoint mutation is outside the confirmation visual fixture');
};
export const adoptEndpointState = unsupportedEndpointMutation;
export const sameEndpointState = unsupportedEndpointMutation;
export const applyEndpointOverride = unsupportedEndpointMutation;
export const buildDefaultOverrideFor = unsupportedEndpointMutation;
export const buildNetworkChoiceOverride = unsupportedEndpointMutation;
export const forgetDeveloperNetworkChoice = unsupportedEndpointMutation;
