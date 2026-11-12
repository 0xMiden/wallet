import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { COMPACT_ADDRESS } from '@epoch-protocol/epoch-intents-sdk';
import { useAppKitProvider } from '@reown/appkit/react';
import PQueue from 'p-queue';
import { useTranslation } from 'react-i18next';
import { useDebounce } from 'use-debounce';
import {
  decodeFunctionResult,
  encodeFunctionData,
  EIP1193Provider,
  formatUnits,
  Hash,
  isAddress,
  isHash,
  isHex,
  parseUnits,
  toHex
} from 'viem';
import { useSwitchChain, useWriteContract } from 'wagmi';

import { ReportDeposit } from 'app/hooks/useFundTelemetry';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ReceiveStep } from 'app/pages/Receive/steps';
import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { NetworkModeBanner, NetworkNamedByShell } from 'components/NetworkModeBanner';
import { PageHeader } from 'components/PageHeader';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL, midenAddrToEvmAddr } from 'lib/agglayer';
import { type Erc20Holding, readErc20Holdings } from 'lib/agglayer/token-holdings';
import { evmToMidenMinTokenOut, MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import { IBridgeProvider } from 'lib/miden/db/types';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { quotedPrice } from 'lib/prices/binance';
import { evmQuote } from 'lib/prices/evm';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import type { MidenUsdc } from 'lib/remote-config/e2e-overrides';
import { evmUsdcLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import { selectNativeEthFaucet } from 'lib/remote-config/values';
import {
  type EvmUsdc,
  selectAgglayerChain,
  selectAgglayerDepositTokens,
  selectAgglayerRecoveryConfig,
  selectAgglayerRegistryToken,
  selectEpochDepositTokens,
  selectEvmUsdc
} from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import {
  type BridgeBalanceCheck,
  type BridgeReceiveRequestClient,
  type BridgeReceiveFailureSource,
  type BridgeReceiveFailureStep,
  walletRaised
} from 'lib/telemetry/bridge-receive-failure';
import type { BridgeBalanceBranch, BridgeBalanceStage, UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import {
  CIRCLE_USDC_DECIMALS,
  CIRCLE_USDC_SYMBOL,
  ERC20_ALLOWANCE_ABI,
  ERC20_APPROVE_ABI,
  ERC20_BALANCE_OF_ABI,
  defaultUsdcxChainId,
  usdcxSourceChains,
  listUsdcxSourceChains,
  TOKEN_MESSENGER_WITH_FEES_ABI,
  USDCX_DECIMALS,
  type UsdcxSourceChain,
  USDCX_SYMBOL,
  XRESERVE_ABI
} from 'lib/usdcx/constant';
import { isUsdcxDomainNotRegisteredError, runUsdcxDeposit, UsdcxSigner } from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import {
  buildExecutorBurnIntent,
  isUsdcxExecutorBalanceTooLowError,
  isUsdcxForwardQuoteUnavailableError,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  usdcxExecutorFeeShortfall,
  UsdcxExecutorSigner
} from 'lib/usdcx/executor';
import { DEFAULT_CHAIN_ID, EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';
import { readNativeFeeFields } from 'lib/walletconnect/fees';
import { chromeExtensionWalletConnectId } from 'lib/walletconnect/identity';
import {
  isNativeReownAvailable,
  NativeReown,
  prepareNativeSessionChain,
  unwrapNativeResult
} from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, readEvmErc20Allowance, waitForEvmReceipt } from 'lib/walletconnect/receipt';
import { nativeSigningErrorId, nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';
import { approxFiatAmount } from 'screens/send-flow/amount-format';
import { BridgeNetwork, getBridgeNetworkByChainId } from 'screens/send-flow/bridge-networks';
import { Route as RouteStep } from 'screens/send-flow/Route';
import { BridgeRoute, UITokenWithPendingBalance } from 'screens/send-flow/types';

import { depositTokenPrice, useBridgeInBalanceCap } from './bridge-in-balance-cap';
import { type DepositToken, depositTokenKey, epochTokenKey, type OfferedErc20 } from './deposit-token';
import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { arrivingTokenName, EvmBridgeDepositReview } from './EvmBridgeDepositReview';
import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';
import { EvmBridgeNetworkDrawer } from './EvmBridgeNetworkDrawer';
import { type DepositEpochRow, type DepositErc20Row, EvmBridgeTokenDrawer } from './EvmBridgeTokenDrawer';
import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';
import { EvmSwitchWalletDrawer } from './EvmSwitchWalletDrawer';
import { useDepositToken } from './useDepositToken';

/** Native-ETH source token symbol/decimals (the non-USDC deposit option). */
// Also the symbol the AggLayer bridge-in matcher requires on a native deposit's tracker.
const ETH_SYMBOL = AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL;
const ETH_DECIMALS = 18;
// The address a chain's native coin is deposited at, on AggLayer and on an Epoch route alike.
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
// Circle's USDC and AggLayer's native coin share an Epoch token only when both name the same contract.
const sameTokenContract = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
// The source chains a USDCx deposit can start from on this network family, as the network drawer lists them.
// Every read, signer call and receipt wait below takes its chain from the chosen `UsdcxSourceChain` entry.
const MOCK_USDC_GET_BALANCE_ABI = [
  {
    type: 'function',
    name: 'getBalance',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

const ALLOWANCE_READ_FAILED = 'Could not check the USDC allowance the bridge has on Sepolia.';

type SlowBridgeStatus = 'idle' | 'signing' | 'submitted' | 'failed';

interface BridgeBalance {
  value: bigint | null;
  formatted: string;
  loading: boolean;
  error: string | null;
  errorId?: UserErrorId;
  errorDiagnostics?: UiEvidenceInput;
}

interface DepositError {
  text: string;
  id: UserErrorId;
}

class DepositBalanceError extends Error {
  constructor(
    readonly id: 'bridgeDepositBalanceReadFailed' | 'bridgeDepositBalanceTooLow',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

interface EvmBridgeDepositScreenProps {
  evmAddress: string;
  midenAccount: WalletAccount;
  /** Reopens the wallet picker to switch to (connect) a different EVM wallet. */
  onConnectAnother: () => void;
  onClose: () => void;
  /** Supplied by the hosting page to report the outcome of a deposit attempt. */
  reportDeposit?: ReportDeposit;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

const EMPTY_BALANCE: BridgeBalance = { value: null, formatted: '0', loading: true, error: null };

// Continue and the check before the first wallet prompt wait on these reads, so an RPC that never answers has to fail
// them rather than hold the step or the row forever.
const RPC_TIMEOUT_MS = 15_000;
const HELD_BALANCE_REREAD_MS = 10_000;

type BalanceStageObserver = (stage: BridgeBalanceStage) => void;

function recordBalanceStage(observer: BalanceStageObserver | undefined, stage: BridgeBalanceStage): void {
  try {
    observer?.(stage);
  } catch {
    // Observing a read cannot change its result or rejection.
  }
}

function createBalanceEvidence(branch: BridgeBalanceBranch) {
  let stage: BridgeBalanceStage = 'configuration';
  return {
    observe(next: BridgeBalanceStage) {
      stage = next;
    },
    snapshot(): UiEvidenceInput {
      return { kind: 'bridge_balance_read', bridgeBalanceBranch: branch, bridgeBalanceStage: stage };
    }
  };
}

async function rpcRequest(
  method: string,
  params: unknown[],
  chainId = DEFAULT_CHAIN_ID,
  observer?: BalanceStageObserver
): Promise<unknown> {
  recordBalanceStage(observer, 'configuration');
  const chain = getChain(chainId);
  if (!chain) {
    throw walletRaised(new Error(`RPC is not configured for chain ${chainId}`));
  }

  const payload = await withRequestTimeout(RPC_TIMEOUT_MS, async (signal): Promise<RpcResponse> => {
    recordBalanceStage(observer, 'request_build');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    recordBalanceStage(observer, 'request');
    const response = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal
    });
    recordBalanceStage(observer, 'response_decode');
    return response.json();
  });
  if (payload.error) {
    recordBalanceStage(observer, 'rpc_rejected');
    throw new Error(payload.error.message ?? `RPC ${method} failed`);
  }
  return payload.result;
}

function formatBalance(value: bigint, decimals: number): string {
  const [whole = '0', rawFraction = ''] = formatUnits(value, decimals).split('.');
  const fraction = rawFraction.slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The balance the amount step shows: null while its read is pending, 0 once a failed read shows its error instead. */
function shownBalance({ value, loading }: BridgeBalance, decimals: number): number | null {
  if (loading) return null;
  return value === null ? 0 : Number(formatUnits(value, decimals));
}

/** Read the source chain's USDC through its 6-decimal ERC-20 interface. */
async function readCircleUsdcBalance(
  evmAddress: string,
  source: UsdcxSourceChain,
  observer?: BalanceStageObserver
): Promise<bigint> {
  recordBalanceStage(observer, 'input_validation');
  if (!isAddress(evmAddress)) {
    throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
  }
  recordBalanceStage(observer, 'request_build');
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [evmAddress]
  });
  const result = await rpcRequest('eth_call', [{ to: source.usdc, data }, 'latest'], source.chain.id, observer);
  recordBalanceStage(observer, 'value_decode');
  if (!isHex(result)) {
    throw new Error('USDC balanceOf returned no data');
  }
  return decodeFunctionResult({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', data: result });
}

/** The source chain's USDC allowance `evmAddress` gave `spender`, in base units. */
async function readCircleUsdcAllowance(
  evmAddress: string,
  spender: `0x${string}`,
  source: UsdcxSourceChain
): Promise<bigint> {
  if (!isAddress(evmAddress)) {
    throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
  }
  const data = encodeFunctionData({
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [evmAddress, spender]
  });
  const result = await rpcRequest('eth_call', [{ to: source.usdc, data }, 'latest'], source.chain.id);
  if (!isHex(result)) {
    throw new Error('USDC allowance returned no data');
  }
  return decodeFunctionResult({ abi: ERC20_ALLOWANCE_ABI, functionName: 'allowance', data: result });
}

/**
 * Whether Circle registered `remoteDomain` on the xReserve the deposit lands in: the source chain's own, or
 * Arc's on the executor route. A deposit to an unregistered domain reverts.
 */
async function readRemoteDomainRegistered(
  remoteDomain: number,
  xReserve: `0x${string}`,
  chainId: number
): Promise<boolean> {
  const data = encodeFunctionData({
    abi: XRESERVE_ABI,
    functionName: 'isRemoteDomainRegistered',
    args: [remoteDomain]
  });
  const result = await rpcRequest('eth_call', [{ to: xReserve, data }, 'latest'], chainId);
  if (!isHex(result)) {
    throw new Error('xReserve isRemoteDomainRegistered returned no data');
  }
  return decodeFunctionResult({ abi: XRESERVE_ABI, functionName: 'isRemoteDomainRegistered', data: result });
}

/** Read the bridge's own USDC (the token the config names) on Sepolia: `getBalance`, else `balanceOf`. */
async function readEpochUsdcBalance(
  evmAddress: string,
  contract: `0x${string}`,
  chainId: number,
  observer?: BalanceStageObserver
): Promise<bigint> {
  recordBalanceStage(observer, 'input_validation');
  if (!isAddress(evmAddress)) {
    throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
  }
  const read = async (abi: typeof MOCK_USDC_GET_BALANCE_ABI | typeof ERC20_BALANCE_OF_ABI): Promise<bigint> => {
    const functionName = abi[0].name;
    recordBalanceStage(observer, 'request_build');
    const data = encodeFunctionData({ abi, functionName, args: [evmAddress] });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest'], chainId, observer);
    recordBalanceStage(observer, 'value_decode');
    if (!isHex(result)) {
      throw new Error(`USDC ${functionName} returned no data`);
    }
    return decodeFunctionResult({ abi, functionName, data: result });
  };
  try {
    return await read(MOCK_USDC_GET_BALANCE_ABI);
  } catch (err) {
    console.warn('[EvmBridgeDepositScreen] USDC getBalance failed, falling back to balanceOf', err);
    return read(ERC20_BALANCE_OF_ABI);
  }
}

/** A registered ERC-20's balance on the AggLayer chain, through the standard `balanceOf`. */
async function readErc20Balance(
  evmAddress: string,
  contract: `0x${string}`,
  chainId: number,
  observer?: BalanceStageObserver
): Promise<bigint> {
  recordBalanceStage(observer, 'input_validation');
  if (!isAddress(evmAddress)) {
    throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
  }
  recordBalanceStage(observer, 'request_build');
  const data = encodeFunctionData({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [evmAddress] });
  const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest'], chainId, observer);
  recordBalanceStage(observer, 'value_decode');
  if (!isHex(result)) {
    throw new Error('ERC-20 balanceOf returned no data');
  }
  return decodeFunctionResult({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', data: result });
}

/** The ERC-20 row balances read at once. */
const ERC20_BALANCE_READS = 4;

const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }
] as const;

/** An ERC-20's decimals as its contract on the AggLayer chain reports them. */
async function readErc20Decimals(contract: `0x${string}`, chainId: number): Promise<number> {
  const data = encodeFunctionData({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals' });
  const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest'], chainId);
  if (!isHex(result)) {
    throw new Error('ERC-20 decimals returned no data');
  }
  return decodeFunctionResult({ abi: ERC20_DECIMALS_ABI, functionName: 'decimals', data: result });
}

/**
 * The symbol the recipient gets on Miden. xReserve mints USDCx; Epoch delivers its token's Miden faucet
 * (`deliveredSymbol`); AggLayer keeps the source symbol.
 */
function outputSymbolFor(route: IBridgeProvider, sourceSymbol: string, deliveredSymbol: string): string {
  switch (route) {
    case 'usdcx':
      return USDCX_SYMBOL;
    case 'epoch':
      return deliveredSymbol || sourceSymbol;
    case 'agglayer':
    default:
      return sourceSymbol;
  }
}

/**
 * The one route a token bridges through. Circle's USDC bridges only through xReserve, a token of the chain's Epoch
 * route only through Epoch, and ETH and a registered ERC-20 only through AggLayer.
 */
function routeForToken(token: DepositToken): BridgeRoute {
  if (token === 'CIRCLE_USDC') return 'usdcx';
  return epochTokenKey(token) === null ? 'agglayer' : 'epoch';
}

async function readEthBalance(evmAddress: string, chainId: number, observer?: BalanceStageObserver): Promise<bigint> {
  const result = await rpcRequest('eth_getBalance', [evmAddress, 'latest'], chainId, observer);
  recordBalanceStage(observer, 'value_decode');
  return BigInt(result as string);
}

function isValidAmount(amount: string): boolean {
  const parsed = Number(amount);
  return Number.isFinite(parsed) && parsed > 0;
}

/** `amount` in base units at `decimals`, or null when parseUnits cannot read it. */
function toBaseUnits(amount: string, decimals: number): bigint | null {
  try {
    return parseUnits(amount.trim(), decimals);
  } catch {
    return null;
  }
}

// Bridge sub-flow steps. These run on a navigator nested inside this screen
// (not the outer Receive navigator) so the manager below stays mounted across
// the amount → route transition and keeps its state (amount, quote, route).
const BRIDGE_ROUTES: Route[] = [
  {
    name: ReceiveStep.ShowBridgePageTakeAmount,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: ReceiveStep.ShowBridgePageRoute,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: ReceiveStep.ShowBridgePageReview,
    animationIn: 'push',
    animationOut: 'pop'
  },
  {
    name: ReceiveStep.ShowBridgePageStatus,
    animationIn: 'push',
    animationOut: 'pop'
  }
];

const EvmBridgeDepositManager: React.FC<EvmBridgeDepositScreenProps> = ({
  evmAddress,
  midenAccount,
  onConnectAnother,
  onClose,
  reportDeposit
}) => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack, activeRoute } = useNavigator();
  const { walletProvider } = useAppKitProvider<EIP1193Provider>('eip155');
  const nativeReownAvailable = isNativeReownAvailable();
  const writeContract = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  const epochStatus = useEpochStore(s => s.status);
  const epochFlow = useEpochStore(s => s.flow);
  const epochQuote = useEpochStore(s => s.quote);
  const epochError = useEpochStore(s => s.error);
  const compactWatchClosed = useEpochStore(s => s.compactWatchClosed);
  const quoteEVMToMiden = useEpochStore(s => s.quoteEVMToMiden);
  const executeEVMToMiden = useEpochStore(s => s.executeEVMToMiden);
  const poll = useEpochStore(s => s.poll);
  const resetEpoch = useEpochStore(s => s.reset);
  // Set at the Confirm tap and released only by a confirm that ends without a row: nothing may quote over or reset the
  // deposit, nor change the amount, token or wallet it was confirmed with. Once the row exists the screen stays on the
  // status page until it closes, so the lock holds for the rest of the screen.
  const confirming = useRef(false);
  // Bumped by a confirm that ends without a row, so the quote effect runs over whatever it skipped during the confirm.
  const [confirmSettled, setConfirmSettled] = useState(0);

  const [slowStatus, setSlowStatus] = useState<SlowBridgeStatus>('idle');
  const [slowError, setSlowError] = useState<DepositError | null>(null);
  // Reached only through handleTokenSelect, which refuses under the confirm lock first.
  const clearTokenState = useCallback(() => {
    resetEpoch();
    setSlowStatus('idle');
    setSlowError(null);
  }, [resetEpoch]);
  const { token, selectToken } = useDepositToken(clearTokenState, 'CIRCLE_USDC');
  const [tokenDrawerOpen, setTokenDrawerOpen] = useState(false);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [switchDrawerOpen, setSwitchDrawerOpen] = useState(false);
  const [route, setRoute] = useState<BridgeRoute>(routeForToken(token));
  // The one chain picked in the network drawer. Every route starts from it, and the token drawer offers what it bridges.
  const [pickedChainId, setPickedChainId] = useState<number>();
  const bridgeConfig = useBridgeConfigSnapshot();
  const usdcxSources = useMemo(() => usdcxSourceChains(bridgeConfig), [bridgeConfig]);
  // Every chain a deposit can start from, in the document's order: a Circle source, a chain whose Epoch route offers a
  // token, or an AggLayer chain that takes deposits. The list is the same for every token.
  const sourceNetworks = useMemo<readonly BridgeNetwork[]>(() => {
    const circle = new Set(listUsdcxSourceChains().map(entry => entry.chain.id));
    return Object.values(bridgeConfig.config?.supportedEvmChains ?? {}).flatMap(entry => {
      const offered =
        circle.has(entry.chainId) ||
        selectEpochDepositTokens(bridgeConfig, entry.chainId).length > 0 ||
        entry.bridges.agglayer?.depositEnabled === true;
      const network = getBridgeNetworkByChainId(entry.chainId);
      return offered && network ? [network] : [];
    });
  }, [bridgeConfig]);
  // The picked chain, else Circle's default source, else the first chain listed. Zero while the config lists none: the
  // form then asks for a network instead of naming a compiled default.
  const sourceChainId = (() => {
    if (pickedChainId !== undefined) return pickedChainId;
    const circleDefault = defaultUsdcxChainId();
    if (sourceNetworks.some(network => network.chainId === circleDefault)) return circleDefault;
    return sourceNetworks[0]?.chainId ?? 0;
  })();
  // Circle's source on the picked chain, when that chain is one.
  const usdcxSource = usdcxSources.get(sourceChainId);
  // Circle's fee for a forwarded executor-route burn, shown on the route card. A display quote only: the
  // burn fetches its own right before signing, since a quote lives about two minutes. Kept with the amount it
  // was quoted for, so a fee for an earlier amount is never shown.
  const [usdcxQuote, setUsdcxQuote] = useState<{ amount: string; fee: bigint } | undefined>(undefined);
  const [amount, setAmount] = useState('');
  // The connected wallet's balance of each Epoch token of the source chain, by its document key.
  const [epochBalances, setEpochBalances] = useState<Record<string, BridgeBalance>>({});
  const [circleUsdcBalance, setCircleUsdcBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  // Circle's Arc USDC is a source token only where its one route, xReserve, can start.
  const usdcxAvailability = useFeatureAvailability('usdcxDeposit', { chainId: usdcxSource?.chain.id });
  const usdcxAvailable = usdcxAvailability.state === 'available';
  const usdcxPending = usdcxAvailability.state === 'loading';
  const [ethBalance, setEthBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [bridgeTxId, setBridgeTxId] = useState<string | null>(null);
  const [creatingBridgeRow, setCreatingBridgeRow] = useState(false);
  // Only the live USDCx source-wallet sequence holds dismissal. Always release on settlement of the
  // local attempt, including errors whose phase could not be saved; background delivery remains dismissible.
  const [usdcxSubmissionPending, setUsdcxSubmissionPending] = useState(false);
  // True between the approval being signed and the bridge prompt being answered — the gap in
  // which the wallet is silent and the user would otherwise read the flow as finished.
  const [awaitingNextConfirmation, setAwaitingNextConfirmation] = useState(false);
  const allocatorUrl = bridgeConfig.config?.['bridge-providers'].epoch.allocatorUrl;
  // The selectors build new objects on every snapshot publish. Rebuilt from their fields, these keep their identity
  // until a value moves, so the balance read and the quote keyed on them run again only then.
  const usdPrices = useWalletStore(state => state.tokenPrices);
  const nativeUsdFaucetId = useMidenFaucetId();
  // The AggLayer route of the picked chain, when it has one: ETH and the registered ERC-20s are offered only there.
  const agglayerChain = selectAgglayerChain(bridgeConfig, sourceChainId);
  const agglayerChainId = agglayerChain?.chainId;
  const agglayerRecovery = selectAgglayerRecoveryConfig(bridgeConfig, agglayerChainId);
  // The tokens the picked chain's Epoch route takes a deposit of, each with the Miden faucet it delivers into.
  const epochTokens = useMemo(
    () => selectEpochDepositTokens(bridgeConfig, sourceChainId),
    [bridgeConfig, sourceChainId]
  );
  // Circle's USDC and AggLayer's native ETH offer the Epoch route only for an Epoch token on the picked chain
  // whose contract is that provider's contract.
  const circleOffered = usdcxSource !== undefined && usdcxAvailable;
  const epochTokenAt = (contract: string | undefined) =>
    contract === undefined ? undefined : epochTokens.find(candidate => sameTokenContract(candidate.address, contract));
  const circleFastToken = epochTokenAt(circleOffered ? usdcxSource?.usdc : undefined);
  const agglayerFastToken = epochTokenAt(agglayerChain !== null ? NATIVE_TOKEN_ADDRESS : undefined);
  const sharedFastToken = token === 'CIRCLE_USDC' ? circleFastToken : token === 'ETH' ? agglayerFastToken : undefined;
  // The token's own Epoch key: the Epoch route is its only route, but for the Epoch USDC's AggLayer one.
  const ownFastKey = epochTokenKey(token);
  // The matched token's key, and only while that Circle or ETH pick is on the Fast route.
  const fastKey =
    token === 'CIRCLE_USDC' || token === 'ETH'
      ? route === 'epoch' && sharedFastToken !== undefined
        ? sharedFastToken.key
        : null
      : ownFastKey;
  const fastToken = fastKey === null ? null : (epochTokens.find(candidate => candidate.key === fastKey) ?? null);
  // The Fast pair, named for the USDC it first carried: the picked Epoch token and the Miden faucet the solver delivers
  // it into. While the route lists no such token the Fast route reads unavailable, and nothing below quotes or bridges.
  const evmUsdcAddress = fastToken?.address;
  const evmUsdcChainId = fastToken?.chainId;
  const usdcSymbol = fastToken?.symbol ?? '';
  // A native coin is deposited as the call's value, with no approval, and its balance is the account's own.
  const fastNative = evmUsdcAddress?.toLowerCase() === NATIVE_TOKEN_ADDRESS;
  // The one name the drawer, the amount step and the Review give the bridge's own USDC, while its read is pending
  // too. Circle's USDC on Arc Testnet is another token: it keeps its symbol and never takes that label, and so does
  // any other Epoch token.
  const usdcLabel = fastKey === 'USDC' ? evmUsdcLabel(bridgeConfig, usdcSymbol || 'USDC') : usdcSymbol;
  const usdcBalance = fastKey === null ? EMPTY_BALANCE : (epochBalances[fastKey] ?? EMPTY_BALANCE);
  // Keep the list stable between config updates, including an empty list. A new list restarts the balance reads.
  const depositTokens = useMemo(
    () => selectAgglayerDepositTokens(bridgeConfig, agglayerChainId),
    [bridgeConfig, agglayerChainId]
  );
  // On a test network the picker also offers the connected wallet's holdings, read from the chain's Blockscout: the
  // testnet bridge registers a token's faucet on its first deposit. Mainnet offers the document's list alone.
  const tokenApiUrl = agglayerChain?.bridges.agglayer?.tokenApiUrl;
  const offersHoldings = bridgeConfig.config?.network !== 'mainnet' && tokenApiUrl !== undefined;
  const [holdings, setHoldings] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; tokens: Erc20Holding[] }>({
    status: 'idle',
    tokens: []
  });
  useEffect(() => {
    if (!offersHoldings || tokenApiUrl === undefined) {
      setHoldings({ status: 'idle', tokens: [] });
      return;
    }
    let cancelled = false;
    setHoldings({ status: 'loading', tokens: [] });
    readErc20Holdings(tokenApiUrl, evmAddress)
      .then(tokens => {
        if (!cancelled) setHoldings({ status: 'ok', tokens });
      })
      .catch(err => {
        console.warn('[EvmBridgeDepositScreen] token holdings read failed', err);
        if (!cancelled) setHoldings({ status: 'error', tokens: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [offersHoldings, tokenApiUrl, evmAddress]);
  // What the picker offers: the document's tokens first, then the wallet's other holdings, each once by address. A
  // holding takes its faucet from the registry when the bridge holds one for it already.
  const offeredErc20s = useMemo<OfferedErc20[]>(() => {
    const offered: OfferedErc20[] = (depositTokens ?? []).map(candidate => ({
      symbol: candidate.symbol,
      contractAddress: candidate.contractAddress,
      decimals: candidate.decimals,
      delivery: { midenFaucetId: candidate.midenFaucetId, scale: candidate.scale }
    }));
    const listed = new Set(offered.map(candidate => candidate.contractAddress));
    for (const held of holdings.tokens) {
      if (listed.has(held.contractAddress)) continue;
      listed.add(held.contractAddress);
      const registered = selectAgglayerRegistryToken(bridgeConfig, held.contractAddress, agglayerChainId);
      offered.push({
        symbol: held.symbol,
        contractAddress: held.contractAddress,
        decimals: held.decimals,
        ...(registered ? { delivery: { midenFaucetId: registered.midenFaucetId, scale: registered.scale } } : {})
      });
    }
    return offered;
  }, [depositTokens, holdings.tokens, bridgeConfig, agglayerChainId]);
  // The picked ERC-20, resolved from the live list on every render: a document or a wallet that drops it leaves the
  // pick unresolved, which the route step reports instead of bridging it.
  const erc20 = useMemo<OfferedErc20 | null>(
    () =>
      typeof token === 'string' || token.kind !== 'erc20'
        ? null
        : (offeredErc20s.find(candidate => candidate.contractAddress === token.contractAddress) ?? null),
    [token, offeredErc20s]
  );
  // True for a pick of an ERC-20 offered on the AggLayer chain, resolved in `erc20` or not.
  const erc20Picked = typeof token !== 'string' && token.kind === 'erc20';
  // The bridge's own USDC keeps its testnet label wherever it is picked from; any other ERC-20 is its symbol.
  const bridgeUsdcAddress = selectEvmUsdc(bridgeConfig, sourceChainId)?.address.toLowerCase();
  const erc20Label = (candidate: OfferedErc20): string =>
    candidate.contractAddress === bridgeUsdcAddress ? evmUsdcLabel(bridgeConfig, candidate.symbol) : candidate.symbol;
  const { tokenSymbol, tokenLabel } = (() => {
    if (fastKey !== null) return { tokenSymbol: usdcSymbol, tokenLabel: usdcLabel };
    if (erc20Picked) return { tokenSymbol: erc20?.symbol ?? '', tokenLabel: erc20 ? erc20Label(erc20) : '' };
    switch (token) {
      case 'ETH':
        return { tokenSymbol: ETH_SYMBOL, tokenLabel: ETH_SYMBOL };
      case 'CIRCLE_USDC':
      default:
        return { tokenSymbol: CIRCLE_USDC_SYMBOL, tokenLabel: CIRCLE_USDC_SYMBOL };
    }
  })();
  // The Miden token another Epoch token arrives as; the Epoch USDC arrives under its label, as it always has.
  const deliveredSymbol = fastKey === 'USDC' ? undefined : fastToken?.midenSymbol;
  // The route stays chosen when the user steps back, so the amount step names the arriving token as the Review does.
  const arrivingName = arrivingTokenName(route, tokenSymbol, tokenLabel, deliveredSymbol);
  const usdcDecimals = fastToken?.decimals ?? 0;
  // The decimals a Slow (AggLayer) deposit converts the typed amount with: the picked token's own.
  const slowSourceDecimals = (() => {
    if (token === 'ETH') return ETH_DECIMALS;
    if (erc20) return erc20.decimals;
    return usdcDecimals;
  })();
  const evmUsdc = useMemo<EvmUsdc | null>(
    () =>
      evmUsdcAddress && evmUsdcChainId !== undefined
        ? { address: evmUsdcAddress, chainId: evmUsdcChainId, symbol: usdcSymbol, decimals: usdcDecimals }
        : null,
    [evmUsdcAddress, evmUsdcChainId, usdcSymbol, usdcDecimals]
  );
  const midenUsdcFaucetId = fastToken?.midenFaucetId;
  const midenUsdcSymbol = fastToken?.midenSymbol ?? '';
  const midenUsdcDecimals = fastToken?.midenDecimals ?? 0;
  const midenUsdc = useMemo<MidenUsdc | null>(
    () =>
      midenUsdcFaucetId ? { faucetId: midenUsdcFaucetId, symbol: midenUsdcSymbol, decimals: midenUsdcDecimals } : null,
    [midenUsdcFaucetId, midenUsdcSymbol, midenUsdcDecimals]
  );
  // A chain not named yet while the snapshot loads is a wait, not a failure.
  const agglayerPending = agglayerChainId === undefined && bridgeConfig.status === 'loading';
  // The config moves the token or route below only on the opening amount step and never under a confirm, so a publish
  // cannot flip a deposit on its way to, or on, Review.
  const onAmountStep = activeRoute?.name === ReceiveStep.ShowBridgePageTakeAmount;
  // What the picked chain offers, in the order a token it does not offer falls back to: Circle USDC, then native ETH,
  // then each Epoch token. An Epoch token that names the same contract as Circle's USDC or AggLayer's native ETH is
  // that row, with Fast as its other route. A registered ERC-20 is offered wherever ETH is, and is never a fallback.
  const ownRowCarries = useCallback(
    (entry: { address: string }) =>
      (circleFastToken !== undefined && sameTokenContract(entry.address, circleFastToken.address)) ||
      (agglayerFastToken !== undefined && sameTokenContract(entry.address, agglayerFastToken.address)),
    [circleFastToken, agglayerFastToken]
  );
  const fallbackTokens = useMemo(() => {
    const tokens: DepositToken[] = [];
    if (circleOffered) tokens.push('CIRCLE_USDC');
    if (agglayerChain) tokens.push('ETH');
    for (const candidate of epochTokens) {
      if (!ownRowCarries(candidate)) tokens.push({ kind: 'epoch', key: candidate.key });
    }
    return tokens;
  }, [circleOffered, epochTokens, agglayerChain, ownRowCarries]);
  const tokenOffered = erc20Picked
    ? agglayerChain !== null
    : fallbackTokens.some(candidate => depositTokenKey(candidate) === depositTokenKey(token));
  // A token the picked chain does not offer, the opening Circle USDC on a chain without Circle deposits included, moves
  // to the first token it does. Nothing moves while the config or Circle's availability is still loading.
  useEffect(() => {
    if (confirming.current || !onAmountStep) return;
    if (tokenOffered || bridgeConfig.status === 'loading' || usdcxPending) return;
    const first = fallbackTokens[0];
    if (first === undefined) return;
    selectToken(first);
    setRoute(routeForToken(first));
  }, [onAmountStep, tokenOffered, bridgeConfig.status, usdcxPending, fallbackTokens, selectToken]);
  // A Circle or ETH pick on the Fast route moves back to its own route when no Epoch token names the same contract,
  // including after the picked chain changes.
  useEffect(() => {
    if (confirming.current || !onAmountStep) return;
    if ((token === 'CIRCLE_USDC' || token === 'ETH') && route === 'epoch' && sharedFastToken === undefined) {
      setRoute(routeForToken(token));
    }
  }, [onAmountStep, token, route, sharedFastToken]);
  // The status page is the one step that leads to no route card these grey out.
  const routesAhead = activeRoute?.name !== ReceiveStep.ShowBridgePageStatus;
  const configuredFastAvailability = useFeatureAvailability('fastBridgeIn', {
    hold: routesAhead,
    chainId: sourceChainId
  });
  const configuredSlowAvailability = useFeatureAvailability('bridgeIn', {
    hold: routesAhead,
    chainId: agglayerChainId
  });
  // An Epoch token bridges through Epoch, and an ERC-20 only through AggLayer; ETH takes AggLayer, and Epoch too where
  // the chain's Epoch route lists it. The Epoch USDC can also take the AggLayer route where that route is on the same
  // chain.
  const slowAvailability: FeatureAvailability = (() => {
    if (ownFastKey !== null && (ownFastKey !== 'USDC' || !evmUsdcChainId || evmUsdcChainId !== agglayerChainId)) {
      return {
        state: 'unavailable',
        reason: 'not-configured',
        detail: 'AggLayer has no supported token on this chain'
      };
    }
    if (erc20Picked && erc20 === null) {
      return { state: 'unavailable', reason: 'not-configured', detail: t('bridgeDepositTokenNotListed') };
    }
    return configuredSlowAvailability;
  })();
  // The Fast card is open to an Epoch token the route lists, and to Circle's USDC or AggLayer's ETH while an Epoch
  // token on this chain names the same contract.
  const fastAvailability = useMemo<FeatureAvailability>(() => {
    if (token === 'CIRCLE_USDC' || token === 'ETH') {
      return sharedFastToken
        ? configuredFastAvailability
        : { state: 'unavailable', reason: 'not-configured', detail: 'The Epoch route lists no such token here' };
    }
    if (ownFastKey === null) {
      return { state: 'unavailable', reason: 'not-configured', detail: 'This token bridges through AggLayer only' };
    }
    if (fastToken === null) {
      return { state: 'unavailable', reason: 'not-configured', detail: t('bridgeDepositTokenNotListed') };
    }
    return configuredFastAvailability;
  }, [token, sharedFastToken, ownFastKey, fastToken, configuredFastAvailability, t]);

  // The connected wallet's balance of each registered ERC-20, by its lowercase address, read together.
  const [erc20Balances, setErc20Balances] = useState<Record<string, BridgeBalance>>({});
  const selectedBalance = (() => {
    if (fastKey !== null) return usdcBalance;
    if (typeof token !== 'string' && token.kind === 'erc20') {
      return erc20Balances[token.contractAddress] ?? EMPTY_BALANCE;
    }
    switch (token) {
      case 'ETH':
        return ethBalance;
      case 'CIRCLE_USDC':
      default:
        return circleUsdcBalance;
    }
  })();
  // Circle's display quote follows the amount the user settled on, not every keystroke.
  const [debouncedUsdcxAmount] = useDebounce(route === 'usdcx' && isValidAmount(amount) ? amount.trim() : '', 500);
  const usdcxQuotedFeeUnits = usdcxQuote && usdcxQuote.amount === amount.trim() ? usdcxQuote.fee : undefined;
  const usdcxQuotedFee =
    usdcxQuotedFeeUnits === undefined ? undefined : formatUnits(usdcxQuotedFeeUnits, CIRCLE_USDC_DECIMALS);
  // Only an Epoch token on the Fast route is quoted; Slow (AggLayer) and Circle need no quote.
  const [debouncedAmount] = useDebounce(
    fastKey !== null && route === 'epoch' && isValidAmount(amount) ? amount.trim() : '',
    500
  );

  useMobileBackHandler(() => {
    if (usdcxSubmissionPending) return true;
    if (activeRoute?.name === ReceiveStep.ShowBridgePageStatus) {
      onClose();
      return true;
    }
    if (cardStack.length > 1) {
      goBack();
      return true;
    }
    onClose();
    return true;
  }, [activeRoute?.name, cardStack.length, goBack, onClose, usdcxSubmissionPending]);

  useEffect(() => {
    resetEpoch();
  }, [resetEpoch]);

  // Every Epoch token's balance on the source chain, each row settling on its own: the native coin is the account's own
  // balance, any other token its ERC-20 balance. Keyed on the chain and token set, not the array a config publish
  // rebuilds: two chains can list the same entry, native ETH at the zero address above all.
  const epochTokensRef = useRef(epochTokens);
  epochTokensRef.current = epochTokens;
  const epochTokensKey = epochTokens
    .map(({ key, address, chainId, decimals }) => `${chainId}:${key}:${address}:${decimals}`)
    .join(',');
  useEffect(() => {
    setEpochBalances({});
    const tokens = epochTokensRef.current;
    if (tokens.length === 0) return;
    let cancelled = false;
    const settle = (key: string, balance: BridgeBalance) => {
      if (cancelled) return;
      setEpochBalances(current => ({ ...current, [key]: balance }));
    };
    for (const { key, address, chainId, decimals } of tokens) {
      const native = address.toLowerCase() === NATIVE_TOKEN_ADDRESS;
      const evidence = createBalanceEvidence(native ? 'native' : 'fast_usdc');
      const read = native
        ? readEthBalance(evmAddress, chainId, evidence.observe)
        : readEpochUsdcBalance(evmAddress, address, chainId, evidence.observe);
      read
        .then(value => settle(key, { value, formatted: formatBalance(value, decimals), loading: false, error: null }))
        .catch(err =>
          settle(key, {
            value: null,
            formatted: '0',
            loading: false,
            error: errorMessage(err),
            errorId: 'raw_bridge_balance_failed',
            errorDiagnostics: evidence.snapshot()
          })
        );
    }
    return () => {
      cancelled = true;
    };
  }, [evmAddress, epochTokensKey]);

  // Circle's USDC on the source chain, the token xReserve takes; the config's Fast USDC pair is not it.
  useEffect(() => {
    setCircleUsdcBalance(EMPTY_BALANCE);
    if (usdcxPending) return;
    let cancelled = false;
    const evidence = createBalanceEvidence('circle_usdc');

    const circleRead =
      usdcxAvailable && usdcxSource
        ? readCircleUsdcBalance(evmAddress, usdcxSource, evidence.observe)
        : Promise.reject(new Error('The bridge config names no USDCx source.'));
    circleRead
      .then(value => {
        if (cancelled) return;
        setCircleUsdcBalance({
          value,
          formatted: formatBalance(value, CIRCLE_USDC_DECIMALS),
          loading: false,
          error: null
        });
      })
      .catch(err => {
        if (cancelled) return;
        setCircleUsdcBalance({
          value: null,
          formatted: '0',
          loading: false,
          error: errorMessage(err),
          errorId: 'raw_bridge_balance_failed',
          errorDiagnostics: evidence.snapshot()
        });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, usdcxAvailable, usdcxPending, usdcxSource]);

  useEffect(() => {
    let cancelled = false;
    setEthBalance(EMPTY_BALANCE);
    if (agglayerPending) return;
    const evidence = createBalanceEvidence('native');

    const ethRead =
      agglayerChainId === undefined
        ? Promise.reject(new Error('The bridge config names no AggLayer chain.'))
        : readEthBalance(evmAddress, agglayerChainId, evidence.observe);
    ethRead
      .then(value => {
        if (cancelled) return;
        setEthBalance({ value, formatted: formatBalance(value, 18), loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        setEthBalance({
          value: null,
          formatted: '0',
          loading: false,
          error: errorMessage(err),
          errorId: 'raw_bridge_balance_failed',
          errorDiagnostics: evidence.snapshot()
        });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, agglayerChainId, agglayerPending]);

  // Every registered ERC-20's balance on the AggLayer chain, each row settling on its own: one failed read marks only
  // its token, which the amount step then shows when that token is picked.
  // Keyed on the token set, not the array a config publish rebuilds, and read a few at a time so a long holdings list
  // cannot flood the chain's RPC.
  const offeredRef = useRef(offeredErc20s);
  offeredRef.current = offeredErc20s;
  const offeredKey = offeredErc20s.map(({ contractAddress, decimals }) => `${contractAddress}:${decimals}`).join(',');
  useEffect(() => {
    setErc20Balances({});
    const offered = offeredRef.current;
    if (agglayerChainId === undefined || offered.length === 0) return;
    const chainId = agglayerChainId;
    let cancelled = false;
    const settle = (address: string, balance: BridgeBalance) => {
      if (cancelled) return;
      setErc20Balances(current => ({ ...current, [address]: balance }));
    };
    const reads = new PQueue({ concurrency: ERC20_BALANCE_READS });
    for (const { contractAddress, decimals } of offered) {
      const evidence = createBalanceEvidence('registered_erc20');
      void reads.add(() =>
        readErc20Balance(evmAddress, contractAddress, chainId, evidence.observe)
          .then(value =>
            settle(contractAddress, { value, formatted: formatBalance(value, decimals), loading: false, error: null })
          )
          .catch(err =>
            settle(contractAddress, {
              value: null,
              formatted: '0',
              loading: false,
              error: errorMessage(err),
              errorDiagnostics: evidence.snapshot()
            })
          )
      );
    }
    return () => {
      cancelled = true;
      reads.clear();
    };
  }, [evmAddress, agglayerChainId, offeredKey]);

  // A fresh EVM→Miden reverse-quote for the current amount. The typed amount is
  // the Miden-side output (`minTokenOut`, faucet base units); the allocator
  // answers with the EVM `tokenIn` to deposit. Extracted so a failed deposit can
  // re-quote to recover (executeEVMToMiden requires status 'quoted', so without
  // this a failed attempt dead-ends until the amount is edited).
  const requote = useCallback(() => {
    if (!evmUsdc || !midenUsdc) return undefined;
    const minTokenOut = evmToMidenMinTokenOut(debouncedAmount, midenUsdc.decimals);
    if (!minTokenOut) return undefined;
    return quoteEVMToMiden(
      {
        sourceChainId: evmUsdc.chainId,
        destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
        evmSourceAddress: evmAddress,
        evmTokenAddress: evmUsdc.address,
        isNative: fastNative,
        midenRecipientId: midenAccount.publicKey,
        midenFaucetId: midenUsdc.faucetId,
        minTokenOut
      },
      evmAddress
    ).catch(err => console.error('[EvmBridgeDepositScreen] quote failed', err));
  }, [debouncedAmount, evmAddress, evmUsdc, fastNative, midenAccount.publicKey, midenUsdc, quoteEVMToMiden]);

  // The store quotes through the configured allocator, which it reads itself: a move of it quotes anew.
  useEffect(() => {
    if (route !== 'epoch' || fastKey === null) return;
    // A quote resets the store's deposit state, stopping its status poll, so nothing quotes over a deposit that has
    // started. Read, not subscribed: a status change alone must never quote, or a landed quote starts another and a
    // deposit that fails is re-quoted over its error.
    const { flow, status } = useEpochStore.getState();
    if (confirming.current) return;
    if (flow === 'evm-to-miden' && (status === 'signing' || status === 'pending' || status === 'done')) return;
    // A declined quote (no amount, or one that rounds to zero faucet units) clears the last one.
    const quoting = requote();
    if (quoting === undefined) resetEpoch();
  }, [allocatorUrl, confirmSettled, debouncedAmount, requote, resetEpoch, route, fastKey]);

  useEffect(() => {
    if (compactWatchClosed || epochStatus !== 'pending' || epochFlow !== 'evm-to-miden') return;
    const id = setInterval(() => {
      poll().catch(err => console.error('[EvmBridgeDepositScreen] poll failed', err));
    }, 3000);
    return () => clearInterval(id);
  }, [compactWatchClosed, epochFlow, epochStatus, poll]);

  const handleAmountChange = useCallback((value?: string) => {
    if (confirming.current) return;
    setAmount(value ?? '');
  }, []);

  const handleTokenSelect = useCallback(
    (next: DepositToken) => {
      if (confirming.current) return;
      setTokenDrawerOpen(false);
      selectToken(next);
      setRoute(routeForToken(next));
    },
    [selectToken]
  );

  const handleOpenSwitchDrawer = useCallback(() => {
    if (confirming.current) return;
    setSwitchDrawerOpen(true);
  }, []);

  const handleOpenTokenDrawer = useCallback(() => {
    if (confirming.current) return;
    setTokenDrawerOpen(true);
  }, []);

  useEffect(() => {
    setUsdcxQuote(undefined);
    if (
      route !== 'usdcx' ||
      !usdcxSource ||
      usdcxSource.route !== 'cctp-executor' ||
      !debouncedUsdcxAmount ||
      !isAddress(evmAddress)
    ) {
      return;
    }
    const source = usdcxSource;
    const quotedAmount = debouncedUsdcxAmount;
    let cancelled = false;
    (async () => {
      try {
        const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
        const quote = await quoteExecutorBurn(
          source,
          buildExecutorBurnIntent(quotedAmount, source, recipient, evmAddress)
        );
        if (!cancelled) {
          setUsdcxQuote({ amount: quotedAmount, fee: quote.feeTotalAmount });
        }
      } catch (err) {
        // No quote on the card: the burn tries again and falls back to the manual execute if Circle refuses.
        console.warn('[EvmBridgeDepositScreen] USDCx fee quote failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route, usdcxSource, debouncedUsdcxAmount, evmAddress, midenAccount.publicKey]);

  const handleOpenNetworkDrawer = useCallback(() => {
    if (confirming.current) return;
    setNetworkDrawerOpen(true);
  }, []);

  const handleNetworkSelect = useCallback((next: BridgeNetwork) => {
    if (confirming.current) return;
    hapticLight();
    setNetworkDrawerOpen(false);
    setPickedChainId(next.chainId);
  }, []);

  // The drawer may have been open since before the tap.
  const handleConnectAnother = useCallback(() => {
    if (confirming.current) return;
    onConnectAnother();
  }, [onConnectAnother]);

  const handleRouteChange = useCallback(
    (next: BridgeRoute) => {
      if (next === route || confirming.current) return;
      setRoute(next);
      setSlowStatus('idle');
      setSlowError(null);
      resetEpoch();
    },
    [resetEpoch, route]
  );

  const readBalanceOrFail = useCallback(
    (chainId: number, readBalance: () => Promise<bigint>): Promise<bigint> =>
      readBalance().catch((cause: unknown) => {
        const network = getChain(chainId)?.name ?? '';
        throw walletRaised(
          new DepositBalanceError(
            'bridgeDepositBalanceReadFailed',
            t('bridgeDepositBalanceReadFailed', { token: tokenLabel, network }),
            { cause }
          )
        );
      }),
    [t, tokenLabel]
  );
  // Read again right before the first wallet prompt: the balance can move after the amount step read it, and a wallet
  // asked for more than it holds refuses only at its own simulation, after an approval has already cost gas (#1431).
  const ensureBalanceCovers = useCallback(
    async (spend: bigint, decimals: number, chainId: number, readBalance: () => Promise<bigint>) => {
      const balance = await readBalanceOrFail(chainId, readBalance);
      if (balance < spend) {
        const network = getChain(chainId)?.name ?? '';
        throw walletRaised(
          new DepositBalanceError(
            'bridgeDepositBalanceTooLow',
            t('bridgeDepositBalanceTooLow', { balance: formatBalance(balance, decimals), token: tokenLabel, network })
          )
        );
      }
    },
    [readBalanceOrFail, t, tokenLabel]
  );

  // Every other failure keeps the screen's own wording.
  const depositError = useCallback(
    (err: unknown): DepositError => ({
      text: nativeSigningErrorMessage(err, t, errorMessage),
      id: nativeSigningErrorId(err) ?? (err instanceof DepositBalanceError ? err.id : 'raw_bridge_deposit_failed')
    }),
    [t]
  );
  // The route step holds an amount its displayed fee takes past the balance in the words the deposit refuses it with.
  const usdcxFeeAboveBalanceMessage = useCallback(
    ({ needed, fee, balance }: { needed: bigint; fee: bigint; balance: bigint }): string =>
      t('usdcxDepositFeeAboveBalance', {
        total: formatUnits(needed, CIRCLE_USDC_DECIMALS),
        fee: formatUnits(fee, CIRCLE_USDC_DECIMALS),
        balance: formatUnits(balance, CIRCLE_USDC_DECIMALS),
        token: tokenLabel,
        network: (usdcxSource && getChain(usdcxSource.chain.id)?.name) ?? ''
      }),
    [t, tokenLabel, usdcxSource]
  );
  // The USDCx refusals that stop a deposit before any wallet prompt get their own words.
  const usdcxDepositError = useCallback(
    (err: unknown): DepositError => {
      if (isUsdcxDomainNotRegisteredError(err)) {
        return { id: 'usdcxDomainNotRegistered', text: t('usdcxDomainNotRegistered') };
      }
      if (isUsdcxForwardQuoteUnavailableError(err)) {
        return { id: 'usdcxForwardQuoteUnavailable', text: t('usdcxForwardQuoteUnavailable') };
      }
      if (isUsdcxExecutorBalanceTooLowError(err)) {
        return { id: 'usdcxDepositFeeAboveBalance', text: usdcxFeeAboveBalanceMessage(err) };
      }
      return depositError(err);
    },
    [t, depositError, usdcxFeeAboveBalanceMessage]
  );

  const handleSlowBridge = useCallback(
    async (trackingTxId: string) => {
      if (!isValidAmount(amount) || (!nativeReownAvailable && !walletProvider)) {
        const message = 'The connected EVM wallet provider is unavailable.';
        setSlowError({ text: message, id: 'raw_bridge_deposit_failed' });
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', {
          error: message,
          errorId: 'raw_bridge_deposit_failed',
          failure: { step: 'provider_unavailable' }
        });
        return;
      }

      hapticMedium();
      setSlowStatus('signing');
      setSlowError(null);

      // The step a failure is reported at, moved on as the deposit enters each one.
      let step: BridgeReceiveFailureStep = 'precheck_route';
      let depositHash: `0x${string}` | undefined;
      try {
        // AggLayer bridges any asset: native ETH rides as `msg.value` with the zero
        // token address; an ERC-20 is approved to the bridge first, unless its allowance
        // already covers the deposit, and then bridged with its own address and no value.
        const isNative = token === 'ETH';
        if (fastKey !== null && (fastKey !== 'USDC' || !evmUsdc || evmUsdc.chainId !== agglayerChainId)) {
          throw walletRaised(new Error('The bridge config has no supported token for AggLayer on this chain.'));
        }
        if (erc20Picked && !erc20) {
          throw walletRaised(new Error('The bridge does not list this token on this chain.'));
        }
        // The L1 bridge the config names, and the Miden rollup id its bridge account reports.
        if (!agglayerChainId) throw walletRaised(new Error('AggLayer chain is not configured'));
        const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === agglayerChainId);
        if (!chain) throw walletRaised(new Error('AggLayer chain is not supported'));
        const captured = agglayerRecovery;
        if (!captured) throw walletRaised(new Error('AggLayer route is not configured'));
        const { contractAddress, rollupId } = captured;
        // An offered token's decimals may be an indexer's; the contract's own decide the amount sent.
        if (erc20 && (await readErc20Decimals(erc20.contractAddress, agglayerChainId)) !== erc20.decimals) {
          throw walletRaised(new Error('The token contract reports other decimals than the wallet offered it at.'));
        }
        const sourceDecimals = slowSourceDecimals;
        const amountInBaseUnits = parseUnits(amount.trim(), sourceDecimals);
        const tokenAddress: `0x${string}` = (() => {
          if (isNative) return '0x0000000000000000000000000000000000000000';
          if (erc20) return erc20.contractAddress;
          return evmUsdc?.address ?? '0x0000000000000000000000000000000000000000';
        })();
        const args = [
          rollupId,
          midenAddrToEvmAddr(midenAccount.publicKey),
          amountInBaseUnits,
          tokenAddress,
          true,
          '0x'
        ] as const;
        const value = isNative ? amountInBaseUnits : 0n;
        step = 'precheck_balance';
        // ETH is held to the deposit alone; a gas shortfall on top stays the wallet's to report.
        await ensureBalanceCovers(amountInBaseUnits, sourceDecimals, agglayerChainId, () => {
          if (isNative) return readEthBalance(evmAddress, agglayerChainId);
          if (erc20) return readErc20Balance(evmAddress, tokenAddress, agglayerChainId);
          return readEpochUsdcBalance(evmAddress, tokenAddress, agglayerChainId);
        });
        // Native Reown signs on the AggLayer chain: a session that did not approve it fails here, before any
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.". It comes after the
        // balance check because adding and switching the chain is itself a wallet prompt.
        step = 'precheck_session_chain';
        if (nativeReownAvailable) await prepareNativeSessionChain(agglayerChainId);
        step = 'precheck_allowance';
        // An allowance that covers the deposit needs no approval: no second prompt, gas or receipt,
        // and `approve` would replace a larger allowance with this amount.
        // A failed or timed-out read fails the deposit before any wallet prompt: the approve's own
        // receipt wait would use the same RPC.
        const needsApproval =
          !isNative &&
          (await readEvmErc20Allowance(
            tokenAddress,
            evmAddress as `0x${string}`,
            contractAddress,
            agglayerChainId
          ).catch((cause: unknown) => {
            throw walletRaised(new Error(ALLOWANCE_READ_FAILED, { cause }));
          })) < amountInBaseUnits;

        let hash: `0x${string}`;
        if (nativeReownAvailable) {
          if (needsApproval) {
            const approveData = encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: 'approve',
              args: [contractAddress, amountInBaseUnits]
            });
            step = 'wallet_approve';
            const approval = await NativeReown.sendTransaction({
              chainId: agglayerChainId,
              from: evmAddress,
              to: tokenAddress,
              value: toHex(0n),
              data: approveData,
              ...(await readNativeFeeFields(agglayerChainId))
            });
            setAwaitingNextConfirmation(true);
            step = 'approve_receipt';
            await waitForEvmReceipt(unwrapNativeResult(approval.hash) as `0x${string}`, chain);
          }
          const data = encodeFunctionData({
            abi: AGGLAYER_BRIDGE_ABI,
            functionName: 'bridgeAsset',
            args
          });
          step = 'wallet_deposit';
          const result = await NativeReown.sendTransaction({
            chainId: agglayerChainId,
            from: evmAddress,
            to: contractAddress,
            value: toHex(value),
            data,
            ...(await readNativeFeeFields(agglayerChainId))
          });
          hash = unwrapNativeResult(result.hash) as `0x${string}`;
        } else {
          // Pin the target chain so wagmi/viem assert the wallet's ACTIVE chain is
          // Sepolia before broadcasting. The WC session namespace declares Sepolia,
          // but the wallet's active chain can be anything (often mainnet); without
          // this a payable `bridgeAsset` would broadcast real ETH on the wrong chain
          // to a Sepolia-only address. The Fast/Epoch path guards this same case in
          // executeEVMToMiden; the native branch above already pins DEFAULT_CHAIN_ID.
          // A USDCx deposit switches the wallet to Arc or Base, so switch it back first.
          step = 'precheck_session_chain';
          await switchChainAsync({ chainId: agglayerChainId });
          if (needsApproval) {
            step = 'wallet_approve';
            const approvalHash = await writeContract.mutateAsync({
              chainId: agglayerChainId,
              abi: ERC20_APPROVE_ABI,
              address: tokenAddress,
              functionName: 'approve',
              args: [contractAddress, amountInBaseUnits]
            });
            setAwaitingNextConfirmation(true);
            step = 'approve_receipt';
            await waitForEvmReceipt(approvalHash, chain);
          }
          step = 'wallet_deposit';
          hash = await writeContract.mutateAsync({
            chainId: agglayerChainId,
            abi: AGGLAYER_BRIDGE_ABI,
            address: contractAddress,
            functionName: 'bridgeAsset',
            args,
            value
          });
        }

        // The bridge prompt has been answered; what follows is a chain wait, not a wallet wait.
        setAwaitingNextConfirmation(false);
        step = 'deposit_receipt';
        depositHash = hash;

        await updateBridgedReceivePhase(trackingTxId, 'submitting', { evmTxHash: hash });
        await waitForEvmReceipt(hash, chain);
        await updateBridgedReceivePhase(trackingTxId, 'delivering', { evmTxHash: hash });
        setSlowStatus('submitted');
      } catch (err) {
        setAwaitingNextConfirmation(false);
        if (depositHash && !(err instanceof EvmTransactionRevertedError)) {
          // Keep the deposit open for background checks when its receipt cannot be read.
          await updateBridgedReceivePhase(trackingTxId, 'submitting', { evmTxHash: depositHash }).catch(
            () => undefined
          );
          setSlowStatus('submitted');
          return;
        }
        console.error('[EvmBridgeDepositScreen] Agglayer bridge failed', err);
        const failure = depositError(err);
        setSlowError(failure);
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', {
          error: failure.text,
          errorId: failure.id,
          failure: failureSource(
            step,
            err,
            step === 'wallet_approve' || step === 'wallet_deposit'
              ? nativeReownAvailable
                ? 'native_reown'
                : 'wagmi'
              : undefined
          )
        }).catch(() => undefined);
      }
    },
    [
      agglayerRecovery,
      agglayerChainId,
      amount,
      depositError,
      ensureBalanceCovers,
      erc20,
      erc20Picked,
      evmAddress,
      evmUsdc,
      fastKey,
      midenAccount.publicKey,
      nativeReownAvailable,
      slowSourceDecimals,
      switchChainAsync,
      token,
      walletProvider,
      writeContract
    ]
  );

  const handleUsdcxDeposit = useCallback(
    async (trackingTxId: string) => {
      if (!isValidAmount(amount) || (!nativeReownAvailable && !walletProvider)) {
        const message = 'The connected EVM wallet provider is unavailable.';
        setSlowError({ text: message, id: 'raw_bridge_deposit_failed' });
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', {
          error: message,
          errorId: 'raw_bridge_deposit_failed',
          failure: { step: 'provider_unavailable' }
        });
        return;
      }

      hapticMedium();
      setSlowStatus('signing');
      setSlowError(null);

      // The step a failure is reported at, moved on as the deposit enters each one.
      let step: BridgeReceiveFailureStep = 'precheck_route';
      // Native Reown takes calldata and returns a JSON-quoted hash; wagmi takes
      // the typed call. Both pin the source chain before broadcasting.
      if (!usdcxSource) throw new Error('USDCx source is not configured');
      const { usdc: circleUsdcAddress, chain: usdcxChain } = usdcxSource;
      const sendNative = async (to: `0x${string}`, data: `0x${string}`): Promise<Hash> => {
        // Fee fields with headroom: the wallet's own estimate can fall under a base fee that rose
        // during the prompt, and the node then rejects the signed transaction outright.
        const result = await NativeReown.sendTransaction({
          chainId: usdcxChain.id,
          from: evmAddress,
          to,
          value: toHex(0n),
          data,
          ...(await readNativeFeeFields(usdcxChain.id))
        });
        const hash = unwrapNativeResult(result.hash);
        if (!isHash(hash)) {
          throw walletRaised(new Error('The wallet returned no transaction hash.'));
        }
        return hash;
      };
      // A signed approval is always followed by another wallet prompt: a second approval or the deposit or burn.
      const approve = async (spender: `0x${string}`, value: bigint): Promise<Hash> => {
        step = 'wallet_approve';
        const hash = await (nativeReownAvailable
          ? sendNative(
              circleUsdcAddress,
              encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender, value] })
            )
          : writeContract.mutateAsync({
              chainId: usdcxChain.id,
              abi: ERC20_APPROVE_ABI,
              address: circleUsdcAddress,
              functionName: 'approve',
              args: [spender, value]
            }));
        setAwaitingNextConfirmation(true);
        step = 'approve_receipt';
        return hash;
      };
      // The deposit or burn is the last prompt; what follows is a chain wait, not a wallet wait.
      const lastPrompt = async (prompt: Promise<Hash>): Promise<Hash> => {
        step = 'wallet_deposit';
        const hash = await prompt;
        setAwaitingNextConfirmation(false);
        return hash;
      };

      let depositHash: string | undefined;
      try {
        // Encoded inside the try so an id the faucet cannot mint to fails the row
        // instead of throwing out of the flow.
        const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
        if (!isAddress(evmAddress)) throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
        const readBalance = () => readCircleUsdcBalance(evmAddress, usdcxSource);
        step = 'precheck_balance';
        await ensureBalanceCovers(
          parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
          CIRCLE_USDC_DECIMALS,
          usdcxChain.id,
          readBalance
        );
        // Native Reown signs on the source chain: a session that did not approve it fails here, before the first
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.".
        step = 'precheck_session_chain';
        if (nativeReownAvailable) await prepareNativeSessionChain(usdcxChain.id);
        if (!nativeReownAvailable) await switchChainAsync({ chainId: usdcxChain.id });
        const readAllowance = (spender: `0x${string}`) => {
          step = 'precheck_allowance';
          return readCircleUsdcAllowance(evmAddress, spender, usdcxSource);
        };
        const waitForReceipt = (hash: Hash) => waitForEvmReceipt(hash, usdcxChain);
        const updatePhase: typeof updateBridgedReceivePhase = async (txId, phase, details) => {
          depositHash = details?.evmTxHash ?? depositHash;
          // A recorded hash is a signed deposit, so what is left is its receipt.
          if (depositHash !== undefined) step = 'deposit_receipt';
          await updateBridgedReceivePhase(txId, phase, details);
        };
        step = 'precheck_route';
        switch (usdcxSource.route) {
          case 'xreserve': {
            const { xReserve } = usdcxSource;
            const signer: UsdcxSigner = {
              approve,
              depositToRemote: args =>
                lastPrompt(
                  nativeReownAvailable
                    ? sendNative(
                        xReserve,
                        encodeFunctionData({ abi: XRESERVE_ABI, functionName: 'depositToRemote', args })
                      )
                    : writeContract.mutateAsync({
                        chainId: usdcxChain.id,
                        abi: XRESERVE_ABI,
                        address: xReserve,
                        functionName: 'depositToRemote',
                        args
                      })
                )
            };
            await runUsdcxDeposit(trackingTxId, amount, recipient, {
              sourceChainId: usdcxChain.id,
              source: usdcxSource,
              signer,
              isRemoteDomainRegistered: remoteDomain => {
                step = 'precheck_domain';
                return readRemoteDomainRegistered(remoteDomain, xReserve, usdcxChain.id);
              },
              readAllowance,
              waitForReceipt,
              updatePhase
            });
            break;
          }
          case 'cctp-executor': {
            // The burn mints to Circle's executor on Arc, which deposits into Arc's xReserve; the registration
            // check therefore reads Arc's xReserve, where the deposit lands.
            const { tokenMessengerWithFees, target } = usdcxSource;
            const signer: UsdcxExecutorSigner = {
              approve,
              depositForBurnWithHookAndFees: args =>
                lastPrompt(
                  nativeReownAvailable
                    ? sendNative(
                        tokenMessengerWithFees,
                        encodeFunctionData({
                          abi: TOKEN_MESSENGER_WITH_FEES_ABI,
                          functionName: 'depositForBurnWithHookAndFees',
                          args
                        })
                      )
                    : writeContract.mutateAsync({
                        chainId: usdcxChain.id,
                        abi: TOKEN_MESSENGER_WITH_FEES_ABI,
                        address: tokenMessengerWithFees,
                        functionName: 'depositForBurnWithHookAndFees',
                        args
                      })
                )
            };
            await runUsdcxExecutorDeposit(trackingTxId, amount, recipient, {
              source: usdcxSource,
              depositor: evmAddress,
              signer,
              isRemoteDomainRegistered: remoteDomain => {
                step = 'precheck_domain';
                return readRemoteDomainRegistered(remoteDomain, target.xReserve, target.chain.id);
              },
              readAllowance,
              readBalance: () => {
                step = 'precheck_balance';
                return readBalanceOrFail(usdcxChain.id, readBalance);
              },
              waitForReceipt,
              updatePhase
            });
            break;
          }
        }
        setSlowStatus('submitted');
      } catch (err) {
        setAwaitingNextConfirmation(false);
        if (depositHash && !(err instanceof EvmTransactionRevertedError)) {
          // Keep the deposit open for background checks when its receipt cannot be read.
          await updateBridgedReceivePhase(trackingTxId, 'submitting', { evmTxHash: depositHash }).catch(
            () => undefined
          );
          setSlowStatus('submitted');
          return;
        }
        console.error('[EvmBridgeDepositScreen] USDCx bridge failed', err);
        const failure = usdcxDepositError(err);
        setSlowError(failure);
        setSlowStatus('failed');
        const failureStep = usdcxFailureStep(err, step);
        await updateBridgedReceivePhase(trackingTxId, 'failed', {
          error: failure.text,
          errorId: failure.id,
          failure: failureSource(
            failureStep,
            err,
            failureStep === 'wallet_approve' || failureStep === 'wallet_deposit'
              ? nativeReownAvailable
                ? 'native_reown'
                : 'wagmi'
              : undefined
          )
        }).catch(() => undefined);
      }
    },
    [
      amount,
      ensureBalanceCovers,
      evmAddress,
      midenAccount.publicKey,
      nativeReownAvailable,
      readBalanceOrFail,
      switchChainAsync,
      usdcxDepositError,
      usdcxSource,
      walletProvider,
      writeContract
    ]
  );

  const quotedTokenIn = useMemo(() => {
    const raw = epochQuote?.quoteResult.tokenIn;
    if (!raw) return null;
    try {
      return BigInt(String(raw));
    } catch {
      return null;
    }
  }, [epochQuote?.quoteResult.tokenIn]);

  // Fast signs inside the store, so its balance is checked here, against the quoted deposit, fee included.
  // The Epoch SDK then signs on the Fast USDC's chain (the one it was quoted on) through the native Reown
  // provider. The provider checks the session chain too, but this check runs before the SDK starts, so the
  // row fails with the localized reconnect message and no wallet prompt opens.
  const handleFastBridge = useCallback(
    async (trackingTxId: string) => {
      let step: BridgeReceiveFailureStep = 'precheck_route';
      try {
        if (!evmUsdc || quotedTokenIn === null) throw walletRaised(new Error('The Fast route has no quoted deposit.'));
        step = 'precheck_balance';
        // A native deposit is held to the quoted amount alone; a gas shortfall on top stays the wallet's to report.
        await ensureBalanceCovers(quotedTokenIn, evmUsdc.decimals, evmUsdc.chainId, () =>
          fastNative
            ? readEthBalance(evmAddress, evmUsdc.chainId)
            : readEpochUsdcBalance(evmAddress, evmUsdc.address, evmUsdc.chainId)
        );
        step = 'precheck_session_chain';
        if (nativeReownAvailable) await prepareNativeSessionChain(evmUsdc.chainId);
      } catch (err) {
        console.error('[EvmBridgeDepositScreen] Fast bridge failed', err);
        const failure = depositError(err);
        await updateBridgedReceivePhase(trackingTxId, 'failed', {
          error: failure.text,
          errorId: failure.id,
          failure: failureSource(step, err)
        }).catch(() => undefined);
        return;
      }
      await executeEVMToMiden(trackingTxId);
    },
    [
      depositError,
      ensureBalanceCovers,
      evmAddress,
      evmUsdc,
      executeEVMToMiden,
      fastNative,
      nativeReownAvailable,
      quotedTokenIn
    ]
  );

  const setupToken: UITokenWithPendingBalance = useMemo(() => {
    if (fastKey !== null) {
      return {
        id: evmUsdc?.address ?? '',
        name: usdcSymbol,
        decimals: usdcDecimals,
        balance: shownBalance(usdcBalance, usdcDecimals),
        // Only the route's USDC is at par; any other Epoch token has no price here, so no bogus ≈USD shows.
        fiatPrice: fastKey === 'USDC' ? 1 : 0,
        scaleIsKnown: evmUsdc !== null
      };
    }
    if (typeof token !== 'string' && token.kind === 'erc20') {
      const decimals = erc20?.decimals ?? 0;
      return {
        id: token.contractAddress,
        name: erc20?.symbol ?? '',
        decimals,
        balance: shownBalance(erc20Balances[token.contractAddress] ?? EMPTY_BALANCE, decimals),
        // No price feed for a registered token; fiatPrice 0 keeps the review from showing a bogus ≈USD.
        fiatPrice: 0,
        scaleIsKnown: erc20 !== null
      };
    }
    switch (token) {
      case 'ETH':
        return {
          id: ETH_SYMBOL,
          name: ETH_SYMBOL,
          decimals: ETH_DECIMALS,
          balance: shownBalance(ethBalance, ETH_DECIMALS),
          // No reliable testnet ETH price; fiatPrice 0 keeps the review from showing a bogus ≈USD.
          fiatPrice: 0,
          // A compile-time constant for a fixed token, not a guess about an
          // unresolved faucet.
          scaleIsKnown: true
        };
      case 'CIRCLE_USDC':
      default:
        return {
          id: usdcxSource?.usdc ?? '',
          name: CIRCLE_USDC_SYMBOL,
          decimals: CIRCLE_USDC_DECIMALS,
          balance: shownBalance(circleUsdcBalance, CIRCLE_USDC_DECIMALS),
          fiatPrice: 1,
          scaleIsKnown: true
        };
    }
  }, [
    fastKey,
    token,
    erc20,
    erc20Balances,
    ethBalance,
    usdcBalance,
    circleUsdcBalance,
    evmUsdc,
    usdcSymbol,
    usdcDecimals,
    usdcxSource?.usdc
  ]);

  // Compared in base units: a float can round an amount at the balance either way.
  const typedUnits = isValidAmount(amount) ? toBaseUnits(amount, setupToken.decimals) : null;
  // Null while the balance loads or after its read failed, which the form shows: either way Continue waits.
  const heldUnits = selectedBalance.value;
  const amountExceedsBalance = typedUnits !== null && heldUnits !== null && typedUnits > heldUnits;

  // The document's bridge-in ceiling (`limits.bridgeInMaxBalanceUsd`) is a gate on this screen only: it weighs the
  // receiving account's valued holdings plus this deposit, at its own token's price (`depositTokenPrice`), and holds
  // every step while they pass it. A note that lands by any other way is not this screen's to refuse.
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const depositPrice = depositTokenPrice(
    token,
    fastToken ? { symbol: fastToken.midenSymbol, delivery: { midenFaucetId: fastToken.midenFaucetId } } : erc20,
    tokenPrices
  );
  const capVerdict = useBridgeInBalanceCap({
    accountPublicKey: midenAccount.publicKey,
    depositAmount: typedUnits === null ? null : Number(amount),
    depositPriceUsd: depositPrice.priceUsd,
    depositPricePending: depositPrice.pending,
    depositQuoteExpiresAt: depositPrice.expiresAt
  });
  const capHold = capVerdict.state !== 'none' && capVerdict.state !== 'clear';
  const capHoldError = ((): { id: UserErrorId; text: string } | undefined => {
    switch (capVerdict.state) {
      case 'exceeded':
        return {
          id: 'bridgeDepositBalanceCapExceeded',
          text: t('bridgeDepositBalanceCapExceeded', {
            cap: approxFiatAmount(capVerdict.capUsd),
            held: approxFiatAmount(capVerdict.heldUsd),
            deposit: approxFiatAmount(capVerdict.depositUsd)
          })
        };
      case 'unpriced':
        return {
          id: 'bridgeDepositBalanceCapUnpriced',
          text: t('bridgeDepositBalanceCapUnpriced', { cap: approxFiatAmount(capVerdict.capUsd), token: tokenLabel })
        };
      default:
        return undefined;
    }
  })();
  const capHoldNotice = capHoldError?.text;
  const capHoldErrorId = capHoldError?.id;
  const setupReady = typedUnits !== null && heldUnits !== null && !amountExceedsBalance && !capHold;

  // Fast (Epoch) bridges the picked Epoch token. The quote must be for the amount on screen: it lags the input by the
  // debounce, and an amount that rounds to zero faucet units is never quoted. Its deposit, not the typed amount, is
  // what the balance has to cover.
  const fastReady =
    route === 'epoch' &&
    fastAvailability.state === 'available' &&
    fastKey !== null &&
    epochFlow === 'evm-to-miden' &&
    epochStatus === 'quoted' &&
    !!epochQuote &&
    !!midenUsdc &&
    epochQuote.params.minTokenOut === evmToMidenMinTokenOut(amount, midenUsdc.decimals) &&
    quotedTokenIn !== null &&
    usdcBalance.value !== null &&
    quotedTokenIn <= usdcBalance.value;
  // Picking Slow can move the USDC to the AggLayer chain's, so the amount is held to that balance here as well.
  const slowReady =
    route === 'agglayer' &&
    agglayerChainId !== undefined &&
    slowAvailability.state === 'available' &&
    setupReady &&
    slowStatus !== 'signing';
  // The deposit is 1:1, but an executor-route burn pulls Circle's fee on top of the amount, so once the fee is on
  // screen Confirm holds an amount it takes past the balance. The deposit checks the fee it signs before any prompt,
  // and again after an approval, before the burn prompt.
  const usdcxFeeShortfall =
    route === 'usdcx' &&
    token === 'CIRCLE_USDC' &&
    typedUnits !== null &&
    heldUnits !== null &&
    usdcxQuotedFeeUnits !== undefined
      ? usdcxExecutorFeeShortfall(typedUnits, usdcxQuotedFeeUnits, heldUnits)
      : undefined;
  const usdcxFeeHoldNotice = usdcxFeeShortfall ? usdcxFeeAboveBalanceMessage(usdcxFeeShortfall) : undefined;
  // A user clears either hold by adding USDC, so the balance is re-read in place until it covers; a failed read keeps it.
  const usdcxBalanceHeld =
    usdcxFeeShortfall !== undefined || (route === 'usdcx' && token === 'CIRCLE_USDC' && amountExceedsBalance);
  useEffect(() => {
    if (!usdcxBalanceHeld || !usdcxSource) return;
    let cancelled = false;
    let reading = false;
    const id = setInterval(() => {
      if (reading) return;
      reading = true;
      readCircleUsdcBalance(evmAddress, usdcxSource)
        .then(value => {
          if (cancelled) return;
          setCircleUsdcBalance(current =>
            current.value === value
              ? current
              : { value, formatted: formatBalance(value, CIRCLE_USDC_DECIMALS), loading: false, error: null }
          );
        })
        .catch(err => console.warn('[EvmBridgeDepositScreen] Circle USDC balance re-read failed', err))
        .finally(() => {
          reading = false;
        });
    }, HELD_BALANCE_REREAD_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [usdcxBalanceHeld, evmAddress, usdcxSource]);
  const usdcxReady =
    route === 'usdcx' &&
    token === 'CIRCLE_USDC' &&
    usdcxAvailable &&
    setupReady &&
    !usdcxFeeShortfall &&
    slowStatus !== 'signing';
  // Fast does not read setupReady, so the ceiling is applied here as well, to every route.
  const canConfirmRoute =
    !capHold &&
    (() => {
      switch (route) {
        case 'epoch':
          return fastReady;
        case 'agglayer':
          return slowReady;
        case 'usdcx':
          return usdcxReady;
        default:
          return false;
      }
    })();
  // Fast (Epoch): the EVM amount the sponsor deposits, from the reverse quote's
  // `tokenIn` (EVM token base units). This is what the wallet signs for, so it
  // is the amount shown as "depositing". It stays exact because the tracking row
  // stores it; every screen that shows it rounds it up. Falls back to the typed
  // amount for the Slow route and while no quote is present.
  const quotedDeposit = useMemo(
    () => (route === 'epoch' && quotedTokenIn ? formatUnits(quotedTokenIn, usdcDecimals) : undefined),
    [route, quotedTokenIn, usdcDecimals]
  );
  const depositAmount = quotedDeposit ?? amount;
  // What the Review hero prints; its fiat prices this figure, not the exact quote.
  const reviewAmount = quotedDeposit
    ? formatMoneyAmount(quotedDeposit, 'pays', tokenSymbol)
    : formatMoneyAmount(amount, 'typed');
  // The Fast fee in US dollars: what goes in less what comes out. USDC in and USDCx out are both at par; any other
  // token is valued at the feed's price on each side, and the fee is not shown while either side has none.
  const fastInputPrice =
    fastKey === 'USDC' ? 1 : evmQuote(usdPrices, evmUsdc?.chainId, evmUsdc?.address, bridgeConfig)?.price;
  const fastOutputPrice =
    fastKey === 'USDC' || !midenUsdc
      ? 1
      : quotedPrice(usdPrices, priceSymbolFor(midenUsdc.faucetId, midenUsdc.symbol))?.price;
  const fastFeeUsd = useMemo(() => {
    const rawIn = epochQuote?.quoteResult.tokenIn;
    const rawOut = epochQuote?.quoteResult.tokenOut;
    if (!rawIn || !rawOut || !midenUsdc || fastInputPrice === undefined || fastOutputPrice === undefined) {
      return undefined;
    }
    try {
      const input = parseFloat(formatUnits(BigInt(String(rawIn)), usdcDecimals)) * fastInputPrice;
      const output = parseFloat(formatUnits(BigInt(String(rawOut)), midenUsdc.decimals)) * fastOutputPrice;
      if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
      return Math.max(0, input - output);
    } catch {
      return undefined;
    }
  }, [
    epochQuote?.quoteResult.tokenIn,
    epochQuote?.quoteResult.tokenOut,
    midenUsdc,
    usdcDecimals,
    fastInputPrice,
    fastOutputPrice
  ]);
  const displayedError: DepositError | null =
    route === 'epoch' && epochFlow === 'evm-to-miden'
      ? epochError == null
        ? null
        : { text: epochError, id: 'raw_bridge_deposit_failed' }
      : slowError;
  const error = displayedError?.text;
  const errorId = displayedError?.id;

  // Output the recipient receives on Miden, exact, as the tracking row stores it. Every route
  // receives what was typed: Fast asks the reverse quote for `minTokenOut` (pinned to the typed
  // amount by `fastReady`), Slow (Agglayer) and USDCx (xReserve, maxFee 0) deliver the deposit 1:1.
  const outputAmount = useMemo(() => {
    if (route !== 'epoch') return isValidAmount(amount) ? amount : undefined;
    const minTokenOut = epochQuote?.params.minTokenOut;
    if (minTokenOut === undefined || !midenUsdc) return undefined;
    try {
      return formatUnits(BigInt(minTokenOut), midenUsdc.decimals);
    } catch {
      return undefined;
    }
  }, [route, amount, epochQuote?.params.minTokenOut, midenUsdc]);

  // Undefined while no chain is listed: the form then asks for a network instead of naming a compiled default.
  const bridgeNetwork = getBridgeNetworkByChainId(sourceChainId);
  // The deposited token's address on the source chain, which prices it.
  const sourceTokenAddress = (() => {
    if (fastKey !== null) return evmUsdc?.address;
    if (typeof token !== 'string' && token.kind === 'erc20') return token.contractAddress;
    switch (token) {
      case 'ETH':
        return NATIVE_TOKEN_ADDRESS;
      case 'CIRCLE_USDC':
        return usdcxSource?.usdc;
      default:
        return undefined;
    }
  })();
  // The Miden faucet the deposit arrives in, as the Review values it.
  const outputFaucetId = (() => {
    switch (route) {
      case 'usdcx':
        return nativeUsdFaucetId ?? undefined;
      case 'epoch':
        return midenUsdcFaucetId;
      case 'agglayer':
      default:
        if (erc20Picked) return erc20?.delivery?.midenFaucetId;
        return token === 'ETH' ? (selectNativeEthFaucet(bridgeConfig, sourceChainId) ?? undefined) : undefined;
    }
  })();
  const networkName = getChain(sourceChainId)?.name ?? '';

  // Every route step holds Confirm on the selected balance, which can be re-read while the step is up: picking Slow
  // moves it to the AggLayer chain's, and another wallet or chain re-reads it. While that read is pending or failed, or
  // short of the typed amount, the step says so as the amount step would. One value for every step, so none drifts.
  const balanceHoldNotice = (() => {
    if (selectedBalance.loading) return t('loading');
    return selectedBalance.error ?? (amountExceedsBalance ? t('amountMustBeLessThanBalance') : capHoldNotice);
  })();

  // Fast/Slow hint below the cards. A typed amount the balance covers can still quote a Fast deposit, fee included,
  // above it; fastReady then holds Confirm, and this says why.
  const routeNotice = (() => {
    if (balanceHoldNotice) return balanceHoldNotice;
    const balance = usdcBalance.value;
    const quoteForAmount =
      route === 'epoch' &&
      epochFlow === 'evm-to-miden' &&
      epochStatus === 'quoted' &&
      !!epochQuote &&
      !!midenUsdc &&
      epochQuote.params.minTokenOut === evmToMidenMinTokenOut(amount, midenUsdc.decimals);
    if (!quoteForAmount || quotedTokenIn === null || balance === null || quotedTokenIn <= balance) return undefined;
    // The deposit as the Review shows it, rounded up, and the balance rounded down, so the two never read as equal.
    return t('fastQuoteAboveBalanceNotice', {
      deposit: reviewAmount,
      balance: formatMoneyAmount(formatUnits(balance, usdcDecimals), 'receives', tokenSymbol),
      token: tokenLabel
    });
  })();

  // Review-step confirm state: spin while the submit is signing, and block
  // re-submits once it's in flight / done.
  const submitting = creatingBridgeRow || (route === 'epoch' ? epochStatus === 'signing' : slowStatus === 'signing');
  const submitted =
    route === 'epoch' ? epochStatus === 'pending' || epochStatus === 'done' : slowStatus === 'submitted';
  // Allow a retry tap after a failed Fast attempt (wrong chain / reject / intent
  // error) so the Review isn't a dead-end — handleConfirm re-quotes to recover.
  const fastRetryable =
    route === 'epoch' && fastKey !== null && epochFlow === 'evm-to-miden' && epochStatus === 'failed';
  const reviewCanConfirm = (canConfirmRoute || (fastRetryable && !capHold)) && !submitting && !submitted;
  // Relabel Confirm → Retry after a failed Fast attempt (the tap re-quotes).
  const reviewConfirmLabel = fastRetryable ? t('retry') : undefined;

  const handleContinue = useCallback(() => {
    if (!setupReady) return;
    hapticMedium();
    navigateTo(ReceiveStep.ShowBridgePageRoute);
  }, [navigateTo, setupReady]);

  const handleHeaderBack = useCallback(() => {
    if (usdcxSubmissionPending) return;
    if (cardStack.length > 1) {
      goBack();
      return;
    }
    onClose();
  }, [cardStack.length, goBack, onClose, usdcxSubmissionPending]);

  // From the Route step: proceed to Review (once the route is confirmable) rather
  // than submitting directly. The Review step's Confirm runs handleConfirm.
  const handleContinueToReview = useCallback(() => {
    if (!canConfirmRoute) return;
    hapticMedium();
    navigateTo(ReceiveStep.ShowBridgePageReview);
  }, [canConfirmRoute, navigateTo]);

  const handleConfirm = useCallback(async () => {
    // A tap that lands once a row exists (Review is still on screen while the Navigator leaves it) changes nothing.
    if (confirming.current) return;
    // Fast (Epoch): after a failed attempt the store is 'failed' and
    // executeEVMToMiden requires 'quoted', so re-quote to recover instead of
    // dead-ending until the amount changes. Once re-quoted, the next tap submits.
    if (route === 'epoch' && epochStatus === 'failed') {
      hapticMedium();
      void requote();
      return;
    }
    if (!canConfirmRoute || creatingBridgeRow) return;
    confirming.current = true;
    setUsdcxSubmissionPending(route === 'usdcx');
    setTokenDrawerOpen(false);
    setSwitchDrawerOpen(false);
    setCreatingBridgeRow(true);
    try {
      hapticMedium();
      // The Miden-side amount in faucet base units: Epoch quotes it, the other
      // two routes deliver the typed amount 1:1 in their own token's scale.
      const expectedAmount = (() => {
        switch (route) {
          case 'agglayer':
            return parseUnits(amount.trim(), slowSourceDecimals);
          case 'usdcx':
            return parseUnits(amount.trim(), USDCX_DECIMALS);
          case 'epoch':
          default:
            return BigInt(String(epochQuote?.quoteResult.tokenOut ?? '0'));
        }
      })();
      // USDCx is the chain's native asset, so its faucet id is the discovered one.
      const usdcxFaucetId = route === 'usdcx' ? await getNativeAssetId() : '';
      const faucetId = (() => {
        switch (route) {
          case 'epoch':
            return midenUsdc?.faucetId ?? '';
          case 'usdcx':
            return usdcxFaucetId;
          case 'agglayer':
          default:
            return '';
        }
      })();
      const drive = (id: string) => {
        switch (route) {
          case 'agglayer':
            return handleSlowBridge(id);
          case 'usdcx':
            return handleUsdcxDeposit(id).finally(() => setUsdcxSubmissionPending(false));
          case 'epoch':
          default:
            return handleFastBridge(id);
        }
      };
      // The row is born `submitting`; the submission keeps the app-root watcher
      // from resuming it as an orphan while this flow still signs and writes it.
      // Reported around the tracked-transfer creation: that is the point the
      // deposit is accepted, and the catch below absorbs its failure, so a
      // wrapper any further out would read every failure as a success.
      const createTransfer = () =>
        initiateBridgedReceiveTransaction({
          accountId: midenAccount.publicKey,
          amount: expectedAmount,
          faucetId,
          provider: route,
          sourceAddress: evmAddress,
          sourceChainId,
          agglayerRoute: agglayerRecovery,
          // The ERC-20 and, once the registry holds it, its faucet, saved with the row: its delivery is matched by
          // that faucet at its scale, read from the registry later when the testnet bridge registers it on deposit.
          agglayerDelivery:
            route === 'agglayer' && erc20
              ? {
                  originToken: erc20.contractAddress,
                  ...(erc20.delivery ? { faucetId: erc20.delivery.midenFaucetId, scale: erc20.delivery.scale } : {})
                }
              : undefined,
          usdcxSource,
          epochAllocatorUrl: allocatorUrl,
          sourceAmount: depositAmount.trim(),
          sourceSymbol: tokenSymbol,
          outputAmount,
          outputSymbol: outputSymbolFor(route, tokenSymbol, deliveredSymbol ?? '')
        });
      const txId = await startBridgeReceiveSubmission(
        () => (reportDeposit ? reportDeposit(createTransfer) : createTransfer()),
        drive
      );
      setBridgeTxId(txId);
      navigateTo(ReceiveStep.ShowBridgePageStatus);
    } catch (err) {
      console.error('[EvmBridgeDepositScreen] bridge row creation failed', err);
      setSlowError({ text: errorMessage(err), id: 'raw_bridge_deposit_submit_failed' });
      confirming.current = false;
      setUsdcxSubmissionPending(false);
      setConfirmSettled(count => count + 1);
    } finally {
      setCreatingBridgeRow(false);
    }
  }, [
    agglayerRecovery,
    allocatorUrl,
    usdcxSource,
    amount,
    canConfirmRoute,
    creatingBridgeRow,
    deliveredSymbol,
    depositAmount,
    epochQuote?.quoteResult.tokenOut,
    epochStatus,
    evmAddress,
    handleFastBridge,
    handleSlowBridge,
    handleUsdcxDeposit,
    midenAccount.publicKey,
    midenUsdc,
    navigateTo,
    outputAmount,
    reportDeposit,
    requote,
    route,
    sourceChainId,
    erc20,
    slowSourceDecimals,
    tokenSymbol
  ]);

  const renderStep = useCallback(
    (activeRoute: Route) => {
      switch (activeRoute.name) {
        case ReceiveStep.ShowBridgePageStatus:
          return bridgeTxId ? (
            <EvmBridgeDepositStatus
              txId={bridgeTxId}
              newSubmissionTxId={bridgeTxId}
              onDone={onClose}
              submissionPending={usdcxSubmissionPending}
              awaitingNextConfirmation={awaitingNextConfirmation}
            />
          ) : null;
        case ReceiveStep.ShowBridgePageReview:
          return (
            <EvmBridgeDepositReview
              amount={reviewAmount}
              symbol={tokenSymbol}
              label={tokenLabel}
              sourceQuote={evmQuote(usdPrices, sourceChainId, sourceTokenAddress, bridgeConfig)}
              outputFaucetId={outputFaucetId}
              deliveredSymbol={route === 'epoch' ? deliveredSymbol : undefined}
              route={route}
              outputAmount={formatMoneyAmount(outputAmount, 'typed')}
              fee={usdcxQuotedFee}
              networkName={networkName}
              networkId={bridgeNetwork?.id}
              destinationName={midenAccount.name}
              sourceChainId={sourceChainId}
              extensionId={typeof window !== 'undefined' ? chromeExtensionWalletConnectId(window.location) : undefined}
              promptAmount={depositAmount.trim()}
              nativeSource={(route === 'agglayer' && token === 'ETH') || (route === 'epoch' && fastNative)}
              epochResourceLockRequired={epochQuote?.quoteResult.resourceLockRequired}
              epochQuoteTransactions={epochQuote?.quoteResult.transactions}
              promptContract={
                route === 'epoch'
                  ? COMPACT_ADDRESS[sourceChainId]
                  : route === 'agglayer'
                    ? agglayerRecovery?.contractAddress
                    : usdcxSource?.route === 'xreserve'
                      ? usdcxSource.xReserve
                      : usdcxSource?.tokenMessengerWithFees
              }
              usdcxExecutor={usdcxSource?.route === 'cctp-executor'}
              youReceiveLoading={route === 'epoch' && epochStatus === 'quoting'}
              isSubmitting={submitting}
              canConfirm={reviewCanConfirm}
              confirmLabel={reviewConfirmLabel}
              error={error ?? usdcxFeeHoldNotice ?? capHoldNotice}
              errorId={
                error != null ? errorId : usdcxFeeHoldNotice ? 'usdcxDepositFeeAboveBalance' : (capHoldErrorId ?? null)
              }
              onConfirm={handleConfirm}
              onBack={handleHeaderBack}
            />
          );
        case ReceiveStep.ShowBridgePageRoute:
          // Circle's USDC takes Circle, or Fast where an Epoch token names the same contract; any other token picks
          // between Fast and Slow.
          if (token === 'CIRCLE_USDC') {
            return (
              <EvmBridgeUsdcxRoute
                confirmDisabled={!canConfirmRoute}
                onConfirm={handleContinueToReview}
                onSelectCircle={() => handleRouteChange('usdcx')}
                fast={
                  sharedFastToken
                    ? {
                        selected: route === 'epoch',
                        onSelect: () => handleRouteChange('epoch'),
                        availability: configuredFastAvailability,
                        feeUsd: fastFeeUsd,
                        loading: route === 'epoch' && epochStatus === 'quoting',
                        notice: route === 'epoch' ? routeNotice : undefined
                      }
                    : undefined
                }
                sourceChainId={sourceChainId}
                fee={usdcxQuotedFee === undefined ? undefined : t('usdcxForwardFee', { fee: usdcxQuotedFee })}
                notice={
                  balanceHoldNotice ??
                  usdcxFeeHoldNotice ??
                  (usdcxSource?.route === 'cctp-executor'
                    ? t('usdcxExecutorRouteNotice', {
                        source: usdcxSource.chain.name,
                        target: usdcxSource.target.chain.name
                      })
                    : undefined)
                }
              />
            );
          }
          return (
            <RouteStep
              accent="receive"
              route={route}
              onRouteChange={handleRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={route === 'epoch' && epochStatus === 'quoting'}
              notice={routeNotice}
              confirmDisabled={!canConfirmRoute}
              onConfirm={handleContinueToReview}
              fastFeature="fastBridgeIn"
              fastAvailability={fastAvailability}
              slowFeature="bridgeIn"
              slowAvailability={slowAvailability}
            />
          );
        case ReceiveStep.ShowBridgePageTakeAmount:
        default:
          return (
            <EvmBridgeDepositForm
              token={setupToken}
              logoFaucetId={outputFaucetId}
              network={bridgeNetwork}
              tokenLabel={tokenLabel}
              arrivingName={arrivingName}
              destinationName={midenAccount.name}
              amount={amount}
              isValidAmount={setupReady}
              error={
                amountExceedsBalance
                  ? 'amountMustBeLessThanBalance'
                  : (error ?? selectedBalance.error ?? capHoldNotice ?? undefined)
              }
              errorId={
                amountExceedsBalance
                  ? 'amountMustBeLessThanBalance'
                  : error != null
                    ? errorId
                    : selectedBalance.error != null
                      ? selectedBalance.errorId
                      : capHoldErrorId
              }
              errorDiagnostics={
                !amountExceedsBalance && error == null && selectedBalance.error != null
                  ? selectedBalance.errorDiagnostics
                  : undefined
              }
              evmAddress={evmAddress}
              onAmountChange={handleAmountChange}
              onSelectToken={handleOpenTokenDrawer}
              onSelectNetwork={handleOpenNetworkDrawer}
              onSwitch={handleOpenSwitchDrawer}
              onContinue={handleContinue}
            />
          );
      }
    },
    [
      amount,
      amountExceedsBalance,
      usdPrices,
      sourceTokenAddress,
      outputFaucetId,
      deliveredSymbol,
      fastNative,
      token,
      bridgeConfig,
      agglayerRecovery?.contractAddress,
      depositAmount,
      epochQuote?.quoteResult.resourceLockRequired,
      epochQuote?.quoteResult.transactions,
      awaitingNextConfirmation,
      balanceHoldNotice,
      capHoldNotice,
      capHoldErrorId,
      bridgeTxId,
      reviewAmount,
      error,
      errorId,
      evmAddress,
      midenAccount.name,
      epochStatus,
      fastAvailability,
      sharedFastToken,
      configuredFastAvailability,
      fastFeeUsd,
      handleAmountChange,
      handleConfirm,
      handleContinue,
      handleContinueToReview,
      handleOpenNetworkDrawer,
      handleOpenSwitchDrawer,
      handleOpenTokenDrawer,
      bridgeNetwork,
      usdcxSource,
      t,
      handleRouteChange,
      route,
      routeNotice,
      usdcxFeeHoldNotice,
      usdcxQuotedFee,
      canConfirmRoute,
      outputAmount,
      networkName,
      sourceChainId,
      submitting,
      usdcxSubmissionPending,
      handleHeaderBack,
      reviewCanConfirm,
      reviewConfirmLabel,
      onClose,
      setupToken,
      selectedBalance.error,
      selectedBalance.errorId,
      selectedBalance.errorDiagnostics,
      setupReady,
      slowAvailability,
      tokenSymbol,
      tokenLabel,
      arrivingName
    ]
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-ink">
      {/* This flow commits value, so it names the network once, here, for every step. The review
          step renders through `ReviewLayout`, which carries a banner of its own; wrapping the
          steps below tells it to stand down, so the pair cannot both be up.
          Suppressing it with a step condition instead is what shipped first, and it is wrong:
          `activeRoute` is live state read outside `AnimatePresence`, so on the way back from
          review this banner mounted while the exiting card still had ReviewLayout's, and on the
          way forward neither was up for the length of the transition. */}
      <NetworkModeBanner />
      {activeRoute?.name !== ReceiveStep.ShowBridgePageStatus && (
        <div className="shrink-0 px-4">
          <PageHeader title={t('bridgeInTitle')} onBack={usdcxSubmissionPending ? undefined : handleHeaderBack} />
        </div>
      )}
      <NetworkNamedByShell>
        <Navigator renderRoute={renderStep} />
      </NetworkNamedByShell>
      <EvmBridgeTokenDrawer
        open={tokenDrawerOpen}
        onOpenChange={setTokenDrawerOpen}
        selected={token}
        chainId={sourceChainId}
        circleUsdcAddress={usdcxSource?.usdc}
        // The picked chain's tokens: Circle USDC where it is Circle's source, ETH and the registered ERC-20s where it is
        // the AggLayer chain, and every token its Epoch route takes. An Epoch token that names the same contract as
        // Circle's USDC or AggLayer's native ETH is that row, and Epoch is its other route.
        ethBalance={agglayerChain ? ethBalance.formatted : undefined}
        ethLoading={ethBalance.loading}
        ethFaucetId={selectNativeEthFaucet(bridgeConfig, agglayerChainId) ?? undefined}
        circleUsdcBalance={circleOffered ? circleUsdcBalance.formatted : undefined}
        circleUsdcFaucetId={nativeUsdFaucetId ?? undefined}
        epochRows={epochTokens.flatMap((candidate): DepositEpochRow[] => {
          if (ownRowCarries(candidate)) return [];
          const balance = epochBalances[candidate.key] ?? EMPTY_BALANCE;
          return [
            {
              key: candidate.key,
              address: candidate.address,
              midenFaucetId: candidate.midenFaucetId,
              name: candidate.key === 'USDC' ? evmUsdcLabel(bridgeConfig, candidate.symbol) : candidate.symbol,
              balance: balance.formatted,
              loading: balance.loading
            }
          ];
        })}
        circleUsdcLabel={CIRCLE_USDC_SYMBOL}
        circleUsdcLoading={circleUsdcBalance.loading}
        erc20Rows={
          agglayerChain
            ? offeredErc20s.map((candidate): DepositErc20Row => {
                const balance = erc20Balances[candidate.contractAddress] ?? EMPTY_BALANCE;
                return {
                  token: candidate,
                  name: erc20Label(candidate),
                  balance: balance.formatted,
                  loading: balance.loading
                };
              })
            : undefined
        }
        // A failed list read, of the document's tokens or of the wallet's holdings, is said, not shown as a shorter
        // list; while the snapshot loads it is only pending.
        erc20Unavailable={
          agglayerChain !== null &&
          ((depositTokens === null && bridgeConfig.status !== 'loading') || holdings.status === 'error')
        }
        onSelect={handleTokenSelect}
      />
      <EvmBridgeNetworkDrawer
        open={networkDrawerOpen}
        onOpenChange={setNetworkDrawerOpen}
        networks={sourceNetworks}
        selected={bridgeNetwork}
        onSelect={handleNetworkSelect}
      />
      <EvmSwitchWalletDrawer
        open={switchDrawerOpen}
        onOpenChange={setSwitchDrawerOpen}
        address={evmAddress}
        ethBalance={ethBalance.formatted}
        ethLoading={ethBalance.loading}
        onConnectAnother={handleConnectAnother}
      />
    </div>
  );
};

export const EvmBridgeDepositScreen: React.FC<EvmBridgeDepositScreenProps> = props => (
  <NavigatorProvider routes={BRIDGE_ROUTES} initialRouteName={ReceiveStep.ShowBridgePageTakeAmount}>
    <EvmBridgeDepositManager {...props} />
  </NavigatorProvider>
);

function balanceCheckOf(err: unknown): BridgeBalanceCheck | undefined {
  if (err instanceof DepositBalanceError) return err.id === 'bridgeDepositBalanceTooLow' ? 'too_low' : 'read_failed';
  return isUsdcxExecutorBalanceTooLowError(err) ? 'too_low' : undefined;
}

function failureSource(
  step: BridgeReceiveFailureStep,
  err: unknown,
  requestClient?: BridgeReceiveRequestClient
): BridgeReceiveFailureSource {
  const balanceCheck = balanceCheckOf(err);
  return {
    step,
    cause: err,
    ...(balanceCheck === undefined ? {} : { balanceCheck }),
    ...(requestClient === undefined ? {} : { requestClient })
  };
}

// A USDCx refusal is thrown where the deposit decided it, so it names its own step.
function usdcxFailureStep(err: unknown, step: BridgeReceiveFailureStep): BridgeReceiveFailureStep {
  if (isUsdcxDomainNotRegisteredError(err)) return 'precheck_domain';
  if (isUsdcxForwardQuoteUnavailableError(err)) return 'precheck_quote';
  if (isUsdcxExecutorBalanceTooLowError(err)) return 'precheck_balance';
  return step;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const walk = Reflect.get(err, 'walk');
    if (typeof walk === 'function') {
      const root = Reflect.apply(walk, err, []);
      const rootMessage = firstString(root, ['details', 'shortMessage', 'message']);
      if (rootMessage) return rootMessage;
    }

    const message = firstString(err, ['details', 'shortMessage', 'message']);
    if (message) return message;
  }

  return err instanceof Error ? err.message : 'Unknown error';
}

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = Reflect.get(source, key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
