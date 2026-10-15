import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppKitProvider } from '@reown/appkit/react';
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
import { ReceiveStep } from 'app/pages/Receive/steps';
import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Navigator, NavigatorProvider, Route, useNavigator } from 'components/Navigator';
import { NetworkModeBanner, NetworkNamedByShell } from 'components/NetworkModeBanner';
import { PageHeader } from 'components/PageHeader';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL, midenAddrToEvmAddr } from 'lib/agglayer';
import { evmToMidenMinTokenOut, MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import { IBridgeProvider } from 'lib/miden/db/types';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import type { FeatureAvailability } from 'lib/remote-config/availability';
import type { MidenUsdc } from 'lib/remote-config/e2e-overrides';
import { evmUsdcLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot, useFeatureAvailability } from 'lib/remote-config/use-feature-availability';
import {
  type EvmUsdc,
  selectAgglayerChain,
  selectAgglayerRecoveryConfig,
  selectEvmUsdc,
  selectMidenUsdc
} from 'lib/remote-config/values';
import { withRequestTimeout } from 'lib/remote-json';
import { WalletAccount } from 'lib/shared/types';
import {
  CIRCLE_USDC_DECIMALS,
  CIRCLE_USDC_SYMBOL,
  ERC20_ALLOWANCE_ABI,
  ERC20_APPROVE_ABI,
  ERC20_BALANCE_OF_ABI,
  DEFAULT_USDCX_SOURCE_CHAIN_ID,
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
  isUsdcxForwardQuoteUnavailableError,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  UsdcxExecutorSigner
} from 'lib/usdcx/executor';
import { DEFAULT_CHAIN_ID, EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';
import { readNativeFeeFields } from 'lib/walletconnect/fees';
import {
  isNativeReownAvailable,
  NativeReown,
  prepareNativeSessionChain,
  unwrapNativeResult
} from 'lib/walletconnect/native';
import { EvmTransactionRevertedError, readEvmErc20Allowance, waitForEvmReceipt } from 'lib/walletconnect/receipt';
import { nativeSigningErrorMessage } from 'lib/walletconnect/signing-error';
import { BridgeNetwork, DEFAULT_BRIDGE_NETWORK, getBridgeNetworkByChainId } from 'screens/send-flow/bridge-networks';
import { Route as RouteStep } from 'screens/send-flow/Route';
import { BridgeRoute, UITokenWithPendingBalance } from 'screens/send-flow/types';

import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { arrivingTokenName, EvmBridgeDepositReview } from './EvmBridgeDepositReview';
import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';
import { EvmBridgeNetworkDrawer } from './EvmBridgeNetworkDrawer';
import { EvmBridgeTokenDrawer, type DepositToken } from './EvmBridgeTokenDrawer';
import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';
import { EvmSwitchWalletDrawer } from './EvmSwitchWalletDrawer';
import { useDepositToken } from './useDepositToken';

/** Native-ETH source token symbol/decimals (the non-USDC deposit option). */
// Also the symbol the AggLayer bridge-in matcher requires on a native deposit's tracker.
const ETH_SYMBOL = AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL;
const ETH_DECIMALS = 18;
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

async function rpcRequest(method: string, params: unknown[], chainId = DEFAULT_CHAIN_ID): Promise<unknown> {
  const chain = getChain(chainId);
  if (!chain) {
    throw new Error(`RPC is not configured for chain ${chainId}`);
  }

  const payload = await withRequestTimeout(RPC_TIMEOUT_MS, async (signal): Promise<RpcResponse> => {
    const response = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal
    });
    return response.json();
  });
  if (payload.error) {
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
async function readCircleUsdcBalance(evmAddress: string, source: UsdcxSourceChain): Promise<bigint> {
  if (!isAddress(evmAddress)) {
    throw new Error(`Invalid EVM address: ${evmAddress}`);
  }
  const data = encodeFunctionData({
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [evmAddress]
  });
  const result = await rpcRequest('eth_call', [{ to: source.usdc, data }, 'latest'], source.chain.id);
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
    throw new Error(`Invalid EVM address: ${evmAddress}`);
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
async function readEpochUsdcBalance(evmAddress: string, contract: `0x${string}`, chainId: number): Promise<bigint> {
  if (!isAddress(evmAddress)) {
    throw new Error(`Invalid EVM address: ${evmAddress}`);
  }
  const read = async (abi: typeof MOCK_USDC_GET_BALANCE_ABI | typeof ERC20_BALANCE_OF_ABI): Promise<bigint> => {
    const functionName = abi[0].name;
    const data = encodeFunctionData({ abi, functionName, args: [evmAddress] });
    const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest'], chainId);
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

/** The symbol the recipient gets on Miden. xReserve mints USDCx; the other routes keep the source symbol. */
function outputSymbolFor(route: IBridgeProvider, sourceSymbol: string): string {
  switch (route) {
    case 'usdcx':
      return USDCX_SYMBOL;
    case 'epoch':
    case 'agglayer':
    default:
      return sourceSymbol;
  }
}

/**
 * The route after a token change. Circle's USDC bridges only through xReserve, and no other token
 * can use that route; between ETH and the bridge's own USDC the chosen route stays.
 */
function routeAfterTokenChange(next: DepositToken, current: BridgeRoute): BridgeRoute {
  if (next === 'CIRCLE_USDC') return 'usdcx';
  if (current === 'usdcx') return 'epoch';
  return current;
}

async function readEthBalance(evmAddress: string, chainId: number): Promise<bigint> {
  const result = await rpcRequest('eth_getBalance', [evmAddress, 'latest'], chainId);
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
  const [slowError, setSlowError] = useState<string | null>(null);
  // Reached only through handleTokenSelect, which refuses under the confirm lock first.
  const clearTokenState = useCallback(() => {
    resetEpoch();
    setSlowStatus('idle');
    setSlowError(null);
  }, [resetEpoch]);
  const { token, selectToken } = useDepositToken(clearTokenState);
  const [tokenDrawerOpen, setTokenDrawerOpen] = useState(false);
  const [networkDrawerOpen, setNetworkDrawerOpen] = useState(false);
  const [switchDrawerOpen, setSwitchDrawerOpen] = useState(false);
  const [route, setRoute] = useState<BridgeRoute>('epoch');
  // The one chain picked in the network drawer. Each route resolves its own chain from it: the picked chain when
  // that chain offers the route, else the first that does.
  const [pickedChainId, setPickedChainId] = useState<number>();
  const bridgeConfig = useBridgeConfigSnapshot();
  const usdcxSourceNetworks: readonly BridgeNetwork[] = listUsdcxSourceChains().flatMap(entry => {
    const network = getBridgeNetworkByChainId(entry.chain.id);
    return network ? [network] : [];
  });
  const usdcxSource = useMemo(() => {
    const sources = usdcxSourceChains(bridgeConfig);
    return (
      (pickedChainId === undefined ? undefined : sources.get(pickedChainId)) ??
      sources.get(DEFAULT_USDCX_SOURCE_CHAIN_ID) ??
      sources.values().next().value
    );
  }, [pickedChainId, bridgeConfig]);
  // Circle's fee for a forwarded executor-route burn, shown on the route card. A display quote only: the
  // burn fetches its own right before signing, since a quote lives about two minutes. Kept with the amount it
  // was quoted for, so a fee for an earlier amount is never shown.
  const [usdcxQuote, setUsdcxQuote] = useState<{ amount: string; fee: string } | undefined>(undefined);
  const [amount, setAmount] = useState('');
  const [usdcBalance, setUsdcBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [circleUsdcBalance, setCircleUsdcBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  // Circle's Arc USDC is a source token only where its one route, xReserve, can start.
  const usdcxAvailability = useFeatureAvailability('usdcxDeposit', { chainId: usdcxSource?.chain.id });
  const usdcxAvailable = usdcxAvailability.state === 'available';
  const usdcxPending = usdcxAvailability.state === 'loading';
  const [ethBalance, setEthBalance] = useState<BridgeBalance>(EMPTY_BALANCE);
  const [bridgeTxId, setBridgeTxId] = useState<string | null>(null);
  const [creatingBridgeRow, setCreatingBridgeRow] = useState(false);
  // True between the approval being signed and the bridge prompt being answered — the gap in
  // which the wallet is silent and the user would otherwise read the flow as finished.
  const [awaitingNextConfirmation, setAwaitingNextConfirmation] = useState(false);
  // The Fast USDC pair the bridge config names: the EVM token deposited and the Miden faucet the solver delivers
  // into. While the config names none the Fast route reads unavailable, and nothing below quotes or bridges USDC.
  const allocatorUrl = bridgeConfig.config?.['bridge-providers'].epoch.allocatorUrl;
  // The selectors build new objects on every snapshot publish. Rebuilt from their fields, these keep their identity
  // until a value moves, so the balance read and the quote keyed on them run again only then.
  const agglayerChain = selectAgglayerChain(bridgeConfig, pickedChainId) ?? selectAgglayerChain(bridgeConfig);
  const selectedEvmUsdc =
    route === 'agglayer'
      ? selectEvmUsdc(bridgeConfig, agglayerChain?.chainId)
      : (selectEvmUsdc(bridgeConfig, pickedChainId) ?? selectEvmUsdc(bridgeConfig));
  const agglayerChainId = agglayerChain?.chainId;
  const agglayerRecovery = selectAgglayerRecoveryConfig(bridgeConfig, agglayerChainId);
  const evmUsdcAddress = selectedEvmUsdc?.address;
  const evmUsdcChainId = selectedEvmUsdc?.chainId;
  const usdcSymbol = selectedEvmUsdc?.symbol ?? '';
  // The one name the drawer, the amount step and the Review give the bridge's own USDC, while its read is pending
  // too. Circle's USDC on Arc Testnet is another token: it keeps its symbol and never takes that label.
  const usdcLabel = evmUsdcLabel(bridgeConfig, usdcSymbol || 'USDC');
  const { tokenSymbol, tokenLabel } = (() => {
    switch (token) {
      case 'ETH':
        return { tokenSymbol: ETH_SYMBOL, tokenLabel: ETH_SYMBOL };
      case 'CIRCLE_USDC':
        return { tokenSymbol: CIRCLE_USDC_SYMBOL, tokenLabel: CIRCLE_USDC_SYMBOL };
      case 'USDC':
      default:
        return { tokenSymbol: usdcSymbol, tokenLabel: usdcLabel };
    }
  })();
  // The route stays chosen when the user steps back, so the amount step names the arriving token as the Review does.
  const arrivingName = arrivingTokenName(route, tokenSymbol, tokenLabel);
  const usdcDecimals = selectedEvmUsdc?.decimals ?? 0;
  const evmUsdc = useMemo<EvmUsdc | null>(
    () =>
      evmUsdcAddress && evmUsdcChainId !== undefined
        ? { address: evmUsdcAddress, chainId: evmUsdcChainId, symbol: usdcSymbol, decimals: usdcDecimals }
        : null,
    [evmUsdcAddress, evmUsdcChainId, usdcSymbol, usdcDecimals]
  );
  const selectedMidenUsdc = selectMidenUsdc(bridgeConfig);
  const midenUsdcFaucetId = selectedMidenUsdc?.faucetId;
  const midenUsdcSymbol = selectedMidenUsdc?.symbol ?? '';
  const midenUsdcDecimals = selectedMidenUsdc?.decimals ?? 0;
  const midenUsdc = useMemo<MidenUsdc | null>(
    () =>
      midenUsdcFaucetId ? { faucetId: midenUsdcFaucetId, symbol: midenUsdcSymbol, decimals: midenUsdcDecimals } : null,
    [midenUsdcFaucetId, midenUsdcSymbol, midenUsdcDecimals]
  );
  // A token or chain not named yet while the snapshot loads is a wait, not a failure.
  const usdcPending = evmUsdc === null && bridgeConfig.status === 'loading';
  const agglayerPending = agglayerChainId === undefined && bridgeConfig.status === 'loading';
  // The status page is the one step that leads to no route card these grey out.
  const routesAhead = activeRoute?.name !== ReceiveStep.ShowBridgePageStatus;
  const fastAvailability = useFeatureAvailability('fastBridgeIn', { hold: routesAhead, chainId: evmUsdcChainId });
  const configuredSlowAvailability = useFeatureAvailability('bridgeIn', {
    hold: routesAhead,
    chainId: agglayerChainId
  });
  const slowAvailability: FeatureAvailability = (() => {
    if (token === 'USDC' && (!evmUsdc || evmUsdc.chainId !== agglayerChainId)) {
      return { state: 'unavailable', reason: 'not-configured', detail: 'AggLayer has no supported USDC on this chain' };
    }
    return configuredSlowAvailability;
  })();

  const selectedBalance = (() => {
    switch (token) {
      case 'ETH':
        return ethBalance;
      case 'CIRCLE_USDC':
        return circleUsdcBalance;
      case 'USDC':
      default:
        return usdcBalance;
    }
  })();
  // Circle's display quote follows the amount the user settled on, not every keystroke.
  const [debouncedUsdcxAmount] = useDebounce(route === 'usdcx' && isValidAmount(amount) ? amount.trim() : '', 500);
  const usdcxQuotedFee = usdcxQuote && usdcxQuote.amount === amount.trim() ? usdcxQuote.fee : undefined;
  // Only USDC on the Fast (Epoch) route is quotable today; ETH-fast wraps to WETH
  // (not implemented yet) and Slow (Agglayer) needs no quote.
  const [debouncedAmount] = useDebounce(
    token === 'USDC' && route === 'epoch' && isValidAmount(amount) ? amount.trim() : '',
    500
  );

  useMobileBackHandler(() => {
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
  }, [activeRoute?.name, cardStack.length, goBack, onClose]);

  useEffect(() => {
    resetEpoch();
  }, [resetEpoch]);

  useEffect(() => {
    setUsdcBalance(EMPTY_BALANCE);
    if (usdcPending) return;
    let cancelled = false;

    const usdcRead = evmUsdc
      ? readEpochUsdcBalance(evmAddress, evmUsdc.address, evmUsdc.chainId)
      : Promise.reject(new Error('The bridge config names no USDC token.'));
    usdcRead
      .then(value => {
        if (cancelled || !evmUsdc) return;
        setUsdcBalance({
          value,
          formatted: formatBalance(value, evmUsdc.decimals),
          loading: false,
          error: null
        });
      })
      .catch(err => {
        if (cancelled) return;
        setUsdcBalance({ value: null, formatted: '0', loading: false, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, evmUsdc, usdcPending]);

  // Circle's USDC on the source chain, the token xReserve takes; the config's Fast USDC pair is not it.
  useEffect(() => {
    setCircleUsdcBalance(EMPTY_BALANCE);
    if (usdcxPending) return;
    let cancelled = false;

    const circleRead =
      usdcxAvailable && usdcxSource
        ? readCircleUsdcBalance(evmAddress, usdcxSource)
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
        setCircleUsdcBalance({ value: null, formatted: '0', loading: false, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, usdcxAvailable, usdcxPending, usdcxSource]);

  useEffect(() => {
    let cancelled = false;
    setEthBalance(EMPTY_BALANCE);
    if (agglayerPending) return;

    const ethRead =
      agglayerChainId === undefined
        ? Promise.reject(new Error('The bridge config names no AggLayer chain.'))
        : readEthBalance(evmAddress, agglayerChainId);
    ethRead
      .then(value => {
        if (cancelled) return;
        setEthBalance({ value, formatted: formatBalance(value, 18), loading: false, error: null });
      })
      .catch(err => {
        if (cancelled) return;
        setEthBalance({ value: null, formatted: '0', loading: false, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, agglayerChainId, agglayerPending]);

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
        midenRecipientId: midenAccount.publicKey,
        midenFaucetId: midenUsdc.faucetId,
        minTokenOut
      },
      evmAddress
    ).catch(err => console.error('[EvmBridgeDepositScreen] quote failed', err));
  }, [debouncedAmount, evmAddress, evmUsdc, midenAccount.publicKey, midenUsdc, quoteEVMToMiden]);

  // The store quotes through the configured allocator, which it reads itself: a move of it quotes anew.
  useEffect(() => {
    if (route !== 'epoch' || token !== 'USDC') return;
    // A quote resets the store's deposit state, stopping its status poll, so nothing quotes over a deposit that has
    // started. Read, not subscribed: a status change alone must never quote, or a landed quote starts another and a
    // deposit that fails is re-quoted over its error.
    const { flow, status } = useEpochStore.getState();
    if (confirming.current) return;
    if (flow === 'evm-to-miden' && (status === 'signing' || status === 'pending' || status === 'done')) return;
    // A declined quote (no amount, or one that rounds to zero faucet units) clears the last one.
    const quoting = requote();
    if (quoting === undefined) resetEpoch();
  }, [allocatorUrl, confirmSettled, debouncedAmount, requote, resetEpoch, route, token]);

  useEffect(() => {
    if (epochStatus !== 'pending' || epochFlow !== 'evm-to-miden') return;
    const id = setInterval(() => {
      poll().catch(err => console.error('[EvmBridgeDepositScreen] poll failed', err));
    }, 3000);
    return () => clearInterval(id);
  }, [epochFlow, epochStatus, poll]);

  const handleAmountChange = useCallback((value?: string) => {
    if (confirming.current) return;
    setAmount(value ?? '');
  }, []);

  const handleTokenSelect = useCallback(
    (next: DepositToken) => {
      if (confirming.current) return;
      setTokenDrawerOpen(false);
      selectToken(next);
      setRoute(current => routeAfterTokenChange(next, current));
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
          setUsdcxQuote({ amount: quotedAmount, fee: formatUnits(quote.feeTotalAmount, CIRCLE_USDC_DECIMALS) });
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
      hapticLight();
      setRoute(next);
      setSlowStatus('idle');
      setSlowError(null);
      resetEpoch();
    },
    [resetEpoch, route]
  );

  // Read again right before the first wallet prompt: the balance can move after the amount step read it, and a wallet
  // asked for more than it holds refuses only at its own simulation, after an approval has already cost gas (#1431).
  const ensureBalanceCovers = useCallback(
    async (spend: bigint, decimals: number, chainId: number, readBalance: () => Promise<bigint>) => {
      const network = getChain(chainId)?.name ?? '';
      const balance = await readBalance().catch((cause: unknown) => {
        throw new Error(t('bridgeDepositBalanceReadFailed', { token: tokenLabel, network }), { cause });
      });
      if (balance < spend) {
        throw new Error(
          t('bridgeDepositBalanceTooLow', { balance: formatBalance(balance, decimals), token: tokenLabel, network })
        );
      }
    },
    [t, tokenLabel]
  );

  // Every other failure keeps the screen's own wording.
  const depositErrorMessage = useCallback(
    (err: unknown): string => nativeSigningErrorMessage(err, t, errorMessage),
    [t]
  );
  // The two USDCx refusals that stop a deposit before any wallet prompt get their own words.
  const usdcxDepositErrorMessage = useCallback(
    (err: unknown): string => {
      if (isUsdcxDomainNotRegisteredError(err)) return t('usdcxDomainNotRegistered');
      if (isUsdcxForwardQuoteUnavailableError(err)) return t('usdcxForwardQuoteUnavailable');
      return depositErrorMessage(err);
    },
    [t, depositErrorMessage]
  );

  const handleSlowBridge = useCallback(
    async (trackingTxId: string) => {
      if (!isValidAmount(amount) || (!nativeReownAvailable && !walletProvider)) {
        const message = 'The connected EVM wallet provider is unavailable.';
        setSlowError(message);
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', { error: message });
        return;
      }

      hapticMedium();
      setSlowStatus('signing');
      setSlowError(null);

      try {
        // AggLayer bridges any asset: native ETH rides as `msg.value` with the zero
        // token address; an ERC-20 is approved to the bridge first, unless its allowance
        // already covers the deposit, and then bridged with its own address and no value.
        const isNative = token === 'ETH';
        if (!isNative && (!evmUsdc || evmUsdc.chainId !== agglayerChainId)) {
          throw new Error('The bridge config has no supported USDC on this chain.');
        }
        // The L1 bridge the config names, and the Miden rollup id its bridge account reports.
        if (!agglayerChainId) throw new Error('AggLayer chain is not configured');
        const chain = EVM_CHAIN_DEFINITIONS.find(chain => chain.id === agglayerChainId);
        if (!chain) throw new Error('AggLayer chain is not supported');
        const captured = agglayerRecovery;
        if (!captured) throw new Error('AggLayer route is not configured');
        const { contractAddress, rollupId } = captured;
        const amountInBaseUnits = parseUnits(amount.trim(), isNative ? ETH_DECIMALS : usdcDecimals);
        const tokenAddress: `0x${string}` =
          isNative || !evmUsdc ? '0x0000000000000000000000000000000000000000' : evmUsdc.address;
        const args = [
          rollupId,
          midenAddrToEvmAddr(midenAccount.publicKey),
          amountInBaseUnits,
          tokenAddress,
          true,
          '0x'
        ] as const;
        const value = isNative ? amountInBaseUnits : 0n;
        // ETH is held to the deposit alone; a gas shortfall on top stays the wallet's to report.
        await ensureBalanceCovers(amountInBaseUnits, isNative ? ETH_DECIMALS : usdcDecimals, agglayerChainId, () =>
          isNative
            ? readEthBalance(evmAddress, agglayerChainId)
            : readEpochUsdcBalance(evmAddress, tokenAddress, agglayerChainId)
        );
        // Native Reown signs on the AggLayer chain: a session that did not approve it fails here, before any
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.". It comes after the
        // balance check because adding and switching the chain is itself a wallet prompt.
        if (nativeReownAvailable) await prepareNativeSessionChain(agglayerChainId);
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
            throw new Error(ALLOWANCE_READ_FAILED, { cause });
          })) < amountInBaseUnits;

        let hash: `0x${string}`;
        if (nativeReownAvailable) {
          if (needsApproval) {
            const approveData = encodeFunctionData({
              abi: ERC20_APPROVE_ABI,
              functionName: 'approve',
              args: [contractAddress, amountInBaseUnits]
            });
            const approval = await NativeReown.sendTransaction({
              chainId: agglayerChainId,
              from: evmAddress,
              to: tokenAddress,
              value: toHex(0n),
              data: approveData,
              ...(await readNativeFeeFields(agglayerChainId))
            });
            setAwaitingNextConfirmation(true);
            await waitForEvmReceipt(unwrapNativeResult(approval.hash) as `0x${string}`, chain);
          }
          const data = encodeFunctionData({
            abi: AGGLAYER_BRIDGE_ABI,
            functionName: 'bridgeAsset',
            args
          });
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
          await switchChainAsync({ chainId: agglayerChainId });
          if (needsApproval) {
            const approvalHash = await writeContract.mutateAsync({
              chainId: agglayerChainId,
              abi: ERC20_APPROVE_ABI,
              address: tokenAddress,
              functionName: 'approve',
              args: [contractAddress, amountInBaseUnits]
            });
            setAwaitingNextConfirmation(true);
            await waitForEvmReceipt(approvalHash, chain);
          }
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

        await updateBridgedReceivePhase(trackingTxId, 'submitting', { evmTxHash: hash });
        await waitForEvmReceipt(hash, chain);
        await updateBridgedReceivePhase(trackingTxId, 'delivering', { evmTxHash: hash });
        setSlowStatus('submitted');
      } catch (err) {
        console.error('[EvmBridgeDepositScreen] Agglayer bridge failed', err);
        const message = depositErrorMessage(err);
        setAwaitingNextConfirmation(false);
        setSlowError(message);
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', { error: message }).catch(() => undefined);
      }
    },
    [
      agglayerRecovery,
      agglayerChainId,
      amount,
      depositErrorMessage,
      ensureBalanceCovers,
      evmAddress,
      evmUsdc,
      midenAccount.publicKey,
      nativeReownAvailable,
      switchChainAsync,
      token,
      usdcDecimals,
      walletProvider,
      writeContract
    ]
  );

  const handleUsdcxDeposit = useCallback(
    async (trackingTxId: string) => {
      if (!isValidAmount(amount) || (!nativeReownAvailable && !walletProvider)) {
        const message = 'The connected EVM wallet provider is unavailable.';
        setSlowError(message);
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', { error: message });
        return;
      }

      hapticMedium();
      setSlowStatus('signing');
      setSlowError(null);

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
          throw new Error('The wallet returned no transaction hash.');
        }
        return hash;
      };
      // A signed approval is always followed by another wallet prompt: a second approval or the deposit or burn.
      const approve = async (spender: `0x${string}`, value: bigint): Promise<Hash> => {
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
        return hash;
      };
      // The deposit or burn is the last prompt; what follows is a chain wait, not a wallet wait.
      const lastPrompt = async (prompt: Promise<Hash>): Promise<Hash> => {
        const hash = await prompt;
        setAwaitingNextConfirmation(false);
        return hash;
      };

      let depositHash: string | undefined;
      try {
        // Encoded inside the try so an id the faucet cannot mint to fails the row
        // instead of throwing out of the flow.
        const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
        if (!isAddress(evmAddress)) throw new Error(`Invalid EVM address: ${evmAddress}`);
        await ensureBalanceCovers(
          parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
          CIRCLE_USDC_DECIMALS,
          usdcxChain.id,
          () => readCircleUsdcBalance(evmAddress, usdcxSource)
        );
        // Native Reown signs on the source chain: a session that did not approve it fails here, before the first
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.".
        if (nativeReownAvailable) await prepareNativeSessionChain(usdcxChain.id);
        if (!nativeReownAvailable) await switchChainAsync({ chainId: usdcxChain.id });
        const readAllowance = (spender: `0x${string}`) => readCircleUsdcAllowance(evmAddress, spender, usdcxSource);
        const waitForReceipt = (hash: Hash) => waitForEvmReceipt(hash, usdcxChain);
        const updatePhase: typeof updateBridgedReceivePhase = async (txId, phase, details) => {
          depositHash = details?.evmTxHash ?? depositHash;
          await updateBridgedReceivePhase(txId, phase, details);
        };
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
              isRemoteDomainRegistered: remoteDomain =>
                readRemoteDomainRegistered(remoteDomain, xReserve, usdcxChain.id),
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
              isRemoteDomainRegistered: remoteDomain =>
                readRemoteDomainRegistered(remoteDomain, target.xReserve, target.chain.id),
              readAllowance,
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
        const message = usdcxDepositErrorMessage(err);
        setSlowError(message);
        setSlowStatus('failed');
        await updateBridgedReceivePhase(trackingTxId, 'failed', { error: message }).catch(() => undefined);
      }
    },
    [
      amount,
      ensureBalanceCovers,
      evmAddress,
      midenAccount.publicKey,
      nativeReownAvailable,
      switchChainAsync,
      usdcxDepositErrorMessage,
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
      try {
        if (!evmUsdc || quotedTokenIn === null) throw new Error('The Fast route has no quoted deposit.');
        await ensureBalanceCovers(quotedTokenIn, evmUsdc.decimals, evmUsdc.chainId, () =>
          readEpochUsdcBalance(evmAddress, evmUsdc.address, evmUsdc.chainId)
        );
        if (nativeReownAvailable) await prepareNativeSessionChain(evmUsdc.chainId);
      } catch (err) {
        console.error('[EvmBridgeDepositScreen] Fast bridge failed', err);
        const message = depositErrorMessage(err);
        await updateBridgedReceivePhase(trackingTxId, 'failed', { error: message }).catch(() => undefined);
        return;
      }
      await executeEVMToMiden(trackingTxId);
    },
    [
      depositErrorMessage,
      ensureBalanceCovers,
      evmAddress,
      evmUsdc,
      executeEVMToMiden,
      nativeReownAvailable,
      quotedTokenIn
    ]
  );

  const setupToken: UITokenWithPendingBalance = useMemo(() => {
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
        return {
          id: usdcxSource?.usdc ?? '',
          name: CIRCLE_USDC_SYMBOL,
          decimals: CIRCLE_USDC_DECIMALS,
          balance: shownBalance(circleUsdcBalance, CIRCLE_USDC_DECIMALS),
          fiatPrice: 1,
          scaleIsKnown: true
        };
      case 'USDC':
      default:
        return {
          id: evmUsdc?.address ?? '',
          name: usdcSymbol,
          decimals: usdcDecimals,
          balance: shownBalance(usdcBalance, usdcDecimals),
          fiatPrice: 1,
          scaleIsKnown: evmUsdc !== null
        };
    }
  }, [token, ethBalance, usdcBalance, circleUsdcBalance, evmUsdc, usdcSymbol, usdcDecimals, usdcxSource?.usdc]);

  // Compared in base units: a float can round an amount at the balance either way.
  const typedUnits = isValidAmount(amount) ? toBaseUnits(amount, setupToken.decimals) : null;
  // Null while the balance loads or after its read failed, which the form shows: either way Continue waits.
  const heldUnits = selectedBalance.value;
  const amountExceedsBalance = typedUnits !== null && heldUnits !== null && typedUnits > heldUnits;
  const setupReady = typedUnits !== null && heldUnits !== null && !amountExceedsBalance;

  // Fast (Epoch) only bridges USDC today: ETH-fast needs WETH wrapping, which is not built.
  // The quote must be for the amount on screen: it lags the input by the debounce, and
  // an amount that rounds to zero faucet units is never quoted. Its deposit, not the
  // typed amount, is what the balance has to cover.
  const fastReady =
    route === 'epoch' &&
    fastAvailability.state === 'available' &&
    token === 'USDC' &&
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
  // USDCx has no quote: the deposit is 1:1, so the amount step's checks are the only ones.
  const usdcxReady =
    route === 'usdcx' && token === 'CIRCLE_USDC' && usdcxAvailable && setupReady && slowStatus !== 'signing';
  const canConfirmRoute = (() => {
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
  const fastFeeUsd = useMemo(() => {
    const rawIn = epochQuote?.quoteResult.tokenIn;
    const rawOut = epochQuote?.quoteResult.tokenOut;
    if (!rawIn || !rawOut || !midenUsdc) return undefined;
    try {
      const input = parseFloat(formatUnits(BigInt(String(rawIn)), usdcDecimals));
      const output = parseFloat(formatUnits(BigInt(String(rawOut)), midenUsdc.decimals));
      if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
      return Math.max(0, input - output);
    } catch {
      return undefined;
    }
  }, [epochQuote?.quoteResult.tokenIn, epochQuote?.quoteResult.tokenOut, midenUsdc, usdcDecimals]);
  const error = route === 'epoch' && epochFlow === 'evm-to-miden' ? epochError : slowError;

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

  const sourceChainId = (() => {
    switch (route) {
      case 'usdcx':
        return usdcxSource?.chain.id ?? 0;
      case 'agglayer':
        return agglayerChainId ?? 0;
      default:
        return evmUsdc?.chainId ?? 0;
    }
  })();
  const bridgeNetwork = getBridgeNetworkByChainId(sourceChainId) ?? DEFAULT_BRIDGE_NETWORK;
  const sourceNetworks = Object.values(bridgeConfig.config?.supportedEvmChains ?? {}).flatMap(entry => {
    const enabled = route === 'agglayer' ? entry.bridges.agglayer?.depositEnabled : entry.bridges.epoch?.depositEnabled;
    const network = getBridgeNetworkByChainId(entry.chainId);
    return enabled && network ? [network] : [];
  });
  const networkName = getChain(sourceChainId)?.name ?? '';

  // Every route step holds Confirm on the selected balance, which can be re-read while the step is up: picking Slow
  // moves it to the AggLayer chain's, and another wallet or chain re-reads it. While that read is pending or failed, or
  // short of the typed amount, the step says so as the amount step would. One value for every step, so none drifts.
  const balanceHoldNotice = (() => {
    if (selectedBalance.loading) return t('loading');
    return selectedBalance.error ?? (amountExceedsBalance ? t('amountMustBeLessThanBalance') : undefined);
  })();

  // Fast/Slow hint below the cards: ETH on Fast wraps to WETH, which isn't available yet. A typed amount the balance
  // covers can still quote a Fast deposit, fee included, above it; fastReady then holds Confirm, and this says why.
  const routeNotice = (() => {
    if (token === 'ETH' && route === 'epoch') return t('fastEthWrapNotice');
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
    route === 'epoch' && token === 'USDC' && epochFlow === 'evm-to-miden' && epochStatus === 'failed';
  const reviewCanConfirm = (canConfirmRoute || fastRetryable) && !submitting && !submitted;
  // Relabel Confirm → Retry after a failed Fast attempt (the tap re-quotes).
  const reviewConfirmLabel = fastRetryable ? t('retry') : undefined;

  const handleContinue = useCallback(() => {
    if (!setupReady) return;
    hapticMedium();
    navigateTo(ReceiveStep.ShowBridgePageRoute);
  }, [navigateTo, setupReady]);

  const handleHeaderBack = useCallback(() => {
    if (cardStack.length > 1) {
      goBack();
      return;
    }
    onClose();
  }, [cardStack.length, goBack, onClose]);

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
            return parseUnits(amount.trim(), token === 'ETH' ? ETH_DECIMALS : usdcDecimals);
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
            return handleUsdcxDeposit(id);
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
          usdcxSource,
          epochAllocatorUrl: allocatorUrl,
          sourceAmount: depositAmount.trim(),
          sourceSymbol: tokenSymbol,
          outputAmount,
          outputSymbol: outputSymbolFor(route, tokenSymbol)
        });
      const txId = await startBridgeReceiveSubmission(
        () => (reportDeposit ? reportDeposit(createTransfer) : createTransfer()),
        drive
      );
      setBridgeTxId(txId);
      navigateTo(ReceiveStep.ShowBridgePageStatus);
    } catch (err) {
      console.error('[EvmBridgeDepositScreen] bridge row creation failed', err);
      setSlowError(errorMessage(err));
      confirming.current = false;
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
    token,
    tokenSymbol,
    usdcDecimals
  ]);

  const renderStep = useCallback(
    (activeRoute: Route) => {
      switch (activeRoute.name) {
        case ReceiveStep.ShowBridgePageStatus:
          return bridgeTxId ? (
            <EvmBridgeDepositStatus
              txId={bridgeTxId}
              onDone={onClose}
              awaitingNextConfirmation={awaitingNextConfirmation}
            />
          ) : null;
        case ReceiveStep.ShowBridgePageReview:
          return (
            <EvmBridgeDepositReview
              amount={reviewAmount}
              symbol={tokenSymbol}
              label={tokenLabel}
              fiat={token === 'ETH' ? undefined : Number(reviewAmount)}
              route={route}
              outputAmount={formatMoneyAmount(outputAmount, 'typed')}
              fee={usdcxQuotedFee}
              networkName={networkName}
              sourceChainId={sourceChainId}
              youReceiveLoading={route === 'epoch' && epochStatus === 'quoting'}
              isSubmitting={submitting}
              canConfirm={reviewCanConfirm}
              confirmLabel={reviewConfirmLabel}
              error={error ?? undefined}
              onConfirm={handleConfirm}
              onBack={goBack}
            />
          );
        case ReceiveStep.ShowBridgePageRoute:
          // USDC has one route (Circle xReserve); ETH picks Fast or Slow.
          if (route === 'usdcx') {
            return (
              <EvmBridgeUsdcxRoute
                confirmDisabled={!canConfirmRoute}
                onConfirm={handleContinueToReview}
                sourceChainId={sourceChainId}
                fee={usdcxQuotedFee === undefined ? undefined : t('usdcxForwardFee', { fee: usdcxQuotedFee })}
                notice={
                  balanceHoldNotice ??
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
              route={route}
              onRouteChange={handleRouteChange}
              fastFeeUsd={fastFeeUsd}
              fastQuoteLoading={route === 'epoch' && epochStatus === 'quoting'}
              notice={routeNotice}
              confirmDisabled={!canConfirmRoute}
              onConfirm={handleContinueToReview}
              fastAvailability={fastAvailability}
              slowAvailability={slowAvailability}
            />
          );
        case ReceiveStep.ShowBridgePageTakeAmount:
        default:
          return (
            <EvmBridgeDepositForm
              token={setupToken}
              network={bridgeNetwork}
              tokenLabel={tokenLabel}
              arrivingName={arrivingName}
              amount={amount}
              isValidAmount={setupReady}
              error={
                amountExceedsBalance ? 'amountMustBeLessThanBalance' : (error ?? selectedBalance.error ?? undefined)
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
      awaitingNextConfirmation,
      balanceHoldNotice,
      bridgeTxId,
      reviewAmount,
      error,
      evmAddress,
      epochStatus,
      fastAvailability,
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
      token,
      routeNotice,
      usdcxQuotedFee,
      canConfirmRoute,
      outputAmount,
      networkName,
      sourceChainId,
      submitting,
      reviewCanConfirm,
      reviewConfirmLabel,
      goBack,
      onClose,
      setupToken,
      selectedBalance.error,
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
          <PageHeader title={t('midenBridge')} onBack={handleHeaderBack} />
        </div>
      )}
      <NetworkNamedByShell>
        <Navigator renderRoute={renderStep} />
      </NetworkNamedByShell>
      <EvmBridgeTokenDrawer
        open={tokenDrawerOpen}
        onOpenChange={setTokenDrawerOpen}
        selected={token}
        ethBalance={ethBalance.formatted}
        usdcBalance={usdcBalance.formatted}
        usdcLabel={usdcLabel}
        ethLoading={ethBalance.loading}
        usdcLoading={usdcBalance.loading}
        circleUsdcBalance={usdcxAvailable ? circleUsdcBalance.formatted : undefined}
        circleUsdcLabel={CIRCLE_USDC_SYMBOL}
        circleUsdcLoading={circleUsdcBalance.loading}
        onSelect={handleTokenSelect}
      />
      <EvmBridgeNetworkDrawer
        open={networkDrawerOpen}
        onOpenChange={setNetworkDrawerOpen}
        networks={route === 'usdcx' ? usdcxSourceNetworks : sourceNetworks}
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
