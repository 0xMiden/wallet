import React, { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  getAddress,
  Hash,
  isAddress,
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
import { Spinner } from 'components/ui/Spinner';
import { AGGLAYER_BRIDGE_ABI, AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL, midenAddrToEvmAddr } from 'lib/agglayer';
import { type Erc20Holding, readErc20Holdings } from 'lib/agglayer/token-holdings';
import { evmToMidenMinTokenOut, MIDEN_DESTINATION_CHAIN_ID, useEpochStore } from 'lib/epoch';
import { evmPaymentLinks } from 'lib/evm/payment-links';
import type { BatchCall } from 'lib/evm-relay/batch';
import {
  RelayApiError,
  RelayExpiredError,
  RelayMismatchError,
  RelayNotSubmittedError,
  RelayProviderRpcError,
  RelayRefusedError,
  RelayRevertedError,
  RelayStillPendingError,
  RelayUnavailableError,
  RelayUnknownOutcomeError
} from 'lib/evm-relay/errors';
import {
  createPendingRelayDepositId,
  type PendingRelayDeposit,
  readPendingRelayDeposits,
  removePendingRelayDeposit,
  savePendingRelayDeposit
} from 'lib/evm-relay/pending-deposit';
import { buildRelayProvider, type RelaySource, relayServesChain } from 'lib/evm-relay/source';
import { depositArrivalOf, useDepositArrival } from 'lib/evm-relay/use-deposit-arrival';
import { useRelayAccount } from 'lib/evm-relay/use-relay-account';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { initiateBridgedReceiveTransaction, updateBridgedReceivePhase } from 'lib/miden/activity';
import { startBridgeReceiveSubmission } from 'lib/miden/activity/bridge-receive';
import type { IBridgeProvider } from 'lib/miden/db/types';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { openWalletPayment } from 'lib/mobile/wallet-payments';
import { isExtension } from 'lib/platform';
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
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import {
  CIRCLE_USDC_DECIMALS,
  CIRCLE_USDC_SYMBOL,
  ERC20_ALLOWANCE_ABI,
  ERC20_APPROVE_ABI,
  ERC20_BALANCE_OF_ABI,
  defaultUsdcxChainId,
  usdcxArrivalKey,
  usdcxSourceChains,
  listUsdcxSourceChains,
  TOKEN_MESSENGER_WITH_FEES_ABI,
  USDCX_DECIMALS,
  type UsdcxSourceChain,
  USDCX_SYMBOL,
  XRESERVE_ABI
} from 'lib/usdcx/constant';
import {
  isUsdcxDomainNotRegisteredError,
  runUsdcxDeposit,
  type UsdcxApproval,
  type UsdcxDepositFacts,
  type UsdcxSigner
} from 'lib/usdcx/deposit';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';
import {
  buildExecutorBurnIntent,
  isUsdcxExecutorBalanceTooLowError,
  isUsdcxForwardQuoteUnavailableError,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  type UsdcxBurnFacts,
  usdcxExecutorFeeShortfall,
  type UsdcxExecutorFeeShortfall,
  type UsdcxExecutorSigner
} from 'lib/usdcx/executor';
import { DEFAULT_CHAIN_ID, EVM_CHAIN_DEFINITIONS, getChain } from 'lib/walletconnect/config';
import { sendEvmContractTransaction } from 'lib/walletconnect/contract-send';
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
import { type DepositAddressStatus, DepositAddressView } from 'screens/deposit-flow/DepositAddressView';
import { DepositAmountView } from 'screens/deposit-flow/DepositAmountView';
import { DepositQrSheet } from 'screens/deposit-flow/DepositQrSheet';
import { DepositReviewView } from 'screens/deposit-flow/DepositReviewView';
import { type DepositRouteOption, DepositRouteSheet } from 'screens/deposit-flow/DepositRouteSheet';
import { DepositTokenSheet } from 'screens/deposit-flow/DepositTokenSheet';
import { OpenWalletSheet } from 'screens/deposit-flow/OpenWalletSheet';
import { DepositNotice } from 'screens/deposit-flow/parts';
import type { DepositAmountValue, DepositFee, DepositLayout } from 'screens/deposit-flow/types';
import { approxFiatAmount } from 'screens/send-flow/amount-format';
import { BridgeNetwork, getBridgeNetworkByChainId } from 'screens/send-flow/bridge-networks';
import { Route as RouteStep } from 'screens/send-flow/Route';
import { BridgeRoute, UITokenWithPendingBalance } from 'screens/send-flow/types';

import { depositTokenPrice, useBridgeInBalanceCap } from './bridge-in-balance-cap';
import { type DepositToken, depositTokenKey, epochTokenKey, type OfferedErc20 } from './deposit-token';
import { EpochWithdrawalGate } from './EpochWithdrawalGate';
import { EvmBridgeDepositForm } from './EvmBridgeDepositForm';
import { arrivingTokenName, EvmBridgeDepositReview } from './EvmBridgeDepositReview';
import { EvmBridgeDepositStatus } from './EvmBridgeDepositStatus';
import { EvmBridgeNetworkDrawer } from './EvmBridgeNetworkDrawer';
import { type DepositEpochRow, type DepositErc20Row, EvmBridgeTokenDrawer } from './EvmBridgeTokenDrawer';
import { EvmBridgeUsdcxRoute } from './EvmBridgeUsdcxRoute';
import { EvmSwitchWalletDrawer } from './EvmSwitchWalletDrawer';
import {
  claimPendingRelayDeposit,
  decodeRelayDepositForm,
  encodeRelayDepositForm,
  pendingRelayDepositOf,
  relayRouteOf,
  type RelayRoute
} from './relay-deposit-record';
import { relayTokenChoiceId, relayTokenChoices } from './relay-token-choices';
import { RelayDepositProgress, useOpenRelayJob } from './RelayDepositProgress';
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

/**
 * What sends the deposit: the relay for the relay address of the current account, else the external wallet through the
 * native Reown plugin (iOS, Android) or through wagmi (web).
 */
type DepositSource = { client: 'relay'; relay: RelaySource } | { client: 'native_reown' } | { client: 'wagmi' };

function depositSourceOf(relaySource: RelaySource | undefined, nativeReownAvailable: boolean): DepositSource {
  if (relaySource !== undefined) return { client: 'relay', relay: relaySource };
  return nativeReownAvailable ? { client: 'native_reown' } : { client: 'wagmi' };
}

/**
 * What a relay error means for the deposit row. `open`: the job can still execute, so the row stays open and nothing
 * signs again. `reverted`, `expired`: the job is final and did not execute. `refused`: the relay stored no job.
 */
type RelayDepositOutcome = 'open' | 'reverted' | 'expired' | 'refused';

// Errors that end a relay attempt before a job is stored: the relay or the wallet refused it.
const RELAY_REFUSALS = [
  RelayApiError,
  RelayUnavailableError,
  RelayRefusedError,
  RelayMismatchError,
  RelayProviderRpcError
];

function relayDepositOutcome(err: unknown): RelayDepositOutcome | undefined {
  if (err instanceof RelayUnknownOutcomeError || err instanceof RelayStillPendingError) return 'open';
  if (err instanceof RelayRevertedError) return 'reverted';
  if (err instanceof RelayExpiredError || err instanceof RelayNotSubmittedError) return 'expired';
  return RELAY_REFUSALS.some(type => err instanceof type) ? 'refused' : undefined;
}

interface EvmBridgeDepositScreenProps {
  /** The source wallet: the connected external wallet, or the relay address when `relaySource` is set. */
  evmAddress: string;
  /**
   * The relay address of the current account as the source wallet. When it is set, `evmAddress` is its address, no
   * external wallet takes part, and only chains that the relay serves are offered.
   */
  relaySource?: RelaySource;
  midenAccount: WalletAccount;
  /**
   * Leaves the current source wallet. For an external wallet, it reopens the wallet picker to connect another one. For
   * a relay source, it opens the connect-wallet path ("Connect a wallet instead").
   */
  onConnectAnother: () => void;
  onClose: () => void;
  /** Leaves the flow for Home (the close of the address and processing steps). Defaults to `onClose`. */
  onExit?: () => void;
  /**
   * A relay source only: the pending deposit to open the screen on (`?pending=<id>`), on its address step with its form
   * state. An id that the account does not have opens the amount step.
   */
  pendingDepositId?: string;
  /** Supplied by the hosting page to report the outcome of a deposit attempt. */
  reportDeposit?: ReportDeposit;
}

/**
 * The steps of the deposit-address flow of a relay source. `restoring` reads the pending deposit of `?pending=<id>`;
 * `processing` follows the tracked row to its success or failure.
 */
type RelayStep = 'restoring' | 'amount' | 'review' | 'address' | 'processing';

/**
 * Where the start of the bridge for a pending deposit is. `quoting`: an Epoch deposit asked for a new quote when the
 * funds arrived. `starting`: the deposit is claimed and the row is being created.
 */
type RelayStartPhase = 'idle' | 'quoting' | 'starting';

/** What a confirm did: a row exists, nothing started (the deposit was not ready), or the row creation failed. */
type ConfirmResult = { kind: 'started'; txId: string } | { kind: 'refused' } | { kind: 'failed'; error: DepositError };

/** A fee that the receipt cannot show yet (no amount typed): the mock-up's rate slot, which a quote fills. */
const NO_FEE_YET = '–';

/**
 * The relay routes by cost, the mock-up's order (`routeRowsV`, `cost = { A: 1, E: 2 }`): Agglayer takes no bridge fee,
 * so it receives most. Circle is not in the mock-up's sheet; its fee model has no bridge fee for Circle, so it comes
 * before Epoch.
 */
const RELAY_ROUTES_BY_COST: readonly RelayRoute[] = ['agglayer', 'usdcx', 'epoch'];
/** The mock-up's speed rank (`rank = { E: 1, A: 3 }`), for two routes whose stated times are the same. Circle last. */
const RELAY_ROUTES_BY_RANK: readonly RelayRoute[] = ['epoch', 'agglayer', 'usdcx'];
/** The minutes that each arrival text of the wallet states, so the route sheet can name the fastest route. */
const STATED_MINUTES = {
  depositFlowArrivesAgglayer: 30,
  depositFlowArrivesEpoch: 2,
  usdcxArrival: 2,
  usdcxArrivalArc: 1
} satisfies Record<string, number>;

/** The i18n key of a route's arrival time: Circle's is the one that the Circle screens show for the chain. */
function arrivalKeyOf(route: RelayRoute, chainId: number): keyof typeof STATED_MINUTES {
  switch (route) {
    case 'agglayer':
      return 'depositFlowArrivesAgglayer';
    case 'epoch':
      return 'depositFlowArrivesEpoch';
    case 'usdcx':
      return usdcxArrivalKey(chainId);
  }
}

// The helpers below keep the conditions of the deposit screen out of its body: each branch there multiplies the code
// paths that the hooks lint rule counts, and past its limit it reports every hook as conditional.

/** Circle's fee is quoted on the Circle route, and for a relay source on every route of Circle's USDC. */
function quotesUsdcxFee(route: BridgeRoute, relay: boolean, token: DepositToken): boolean {
  return route === 'usdcx' || (relay && token === 'CIRCLE_USDC');
}

/** The connected wallet's Circle USDC balance holds the Circle route; a relay source's funds arrive after the review. */
function holdsCircleBalance(relay: boolean, route: BridgeRoute, token: DepositToken): boolean {
  return !relay && route === 'usdcx' && token === 'CIRCLE_USDC';
}

/** The typed amount that a quote asks for, trimmed, or empty text for an amount that is not valid. */
function quotedAmountOf(amount: string): string {
  return isValidAmount(amount) ? amount.trim() : '';
}

/**
 * What an executor-route burn needs past the connected wallet's Circle USDC balance (the amount plus the fee on screen),
 * or undefined while that balance does not hold the route, or a value is not known.
 */
function circleFeeShortfall(
  holds: boolean,
  typedUnits: bigint | null,
  heldUnits: bigint | null,
  feeUnits: bigint | undefined
): UsdcxExecutorFeeShortfall | undefined {
  if (!holds || typedUnits === null || heldUnits === null || feeUnits === undefined) return undefined;
  return usdcxExecutorFeeShortfall(typedUnits, feeUnits, heldUnits);
}

/** The Circle balance holds Confirm: the fee takes the amount past it, or the amount alone is past it. */
function circleBalanceHeld(
  shortfall: UsdcxExecutorFeeShortfall | undefined,
  holds: boolean,
  amountExceedsBalance: boolean
): boolean {
  return shortfall !== undefined || (holds && amountExceedsBalance);
}

/** True for Circle's executor route: a CCTP burn that Circle executes on Arc, with Circle's fee on top. */
function isExecutorSource(source: UsdcxSourceChain | undefined): boolean {
  return source !== undefined && source.route === 'cctp-executor';
}

/** True when Circle refused the display quote of the typed amount on the executor route. */
function quoteFailedFor(executor: boolean, failedFor: string | null, amount: string): boolean {
  return executor && failedFor !== null && failedFor === amount.trim();
}

/** Epoch's fee and Circle's executor fee come on top of the amount: they show with no minus sign. */
function feeComesOnTop(route: RelayRoute, executor: boolean): boolean {
  return route === 'epoch' || (route === 'usdcx' && executor);
}

/** The route is ready and what the user sends is known. */
function sendReady(canConfirm: boolean, sendUnits: bigint | null): boolean {
  return canConfirm && sendUnits !== null;
}

/** The amount a review shows while its quote refreshes. */
const ZERO_AMOUNT: DepositAmountValue = { amount: '0' };

function lowerHexAddress(address: `0x${string}`): `0x${string}` {
  return `0x${address.slice(2).toLowerCase()}`;
}

/** What a pending deposit delivers, as it was reviewed. */
function pendingDepositReceived(deposit: PendingRelayDeposit): DepositAmountValue {
  return { amount: deposit.outputAmount ?? deposit.amount };
}

/**
 * The bridge fee of a pending deposit. Agglayer takes none. On Epoch and on Circle it is what is sent less what arrives,
 * both in the source token (the Epoch tokens arrive as the same asset, and Circle's USDC arrives 1:1 as USDCx): Circle's
 * executor fee, and none on a direct xReserve deposit.
 */
function pendingDepositFee(deposit: PendingRelayDeposit): DepositFee {
  if (deposit.route === 'agglayer') return { kind: 'none' };
  const sent = BigInt(deposit.amountBaseUnits);
  const received =
    deposit.outputAmount === undefined ? null : toBaseUnits(deposit.outputAmount, deposit.token.decimals);
  return received !== null && sent > received
    ? { kind: 'amount', value: { amount: sent - received, decimals: deposit.token.decimals } }
    : { kind: 'none' };
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

/**
 * One signal that aborts when `timeout` or `abort` does. `AbortSignal.any` is missing on iOS before 17.4, so the
 * link is made by hand.
 */
function linkedSignal(timeout: AbortSignal, abort: AbortSignal | undefined): AbortSignal {
  if (abort === undefined) return timeout;
  const controller = new AbortController();
  for (const source of [timeout, abort]) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

async function rpcRequest(
  method: string,
  params: unknown[],
  chainId = DEFAULT_CHAIN_ID,
  observer?: BalanceStageObserver,
  abort?: AbortSignal
): Promise<unknown> {
  recordBalanceStage(observer, 'configuration');
  const chain = getChain(chainId);
  if (!chain) {
    throw walletRaised(new Error(`RPC is not configured for chain ${chainId}`));
  }

  const payload = await withRequestTimeout(RPC_TIMEOUT_MS, async (timeout): Promise<RpcResponse> => {
    recordBalanceStage(observer, 'request_build');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    recordBalanceStage(observer, 'request');
    const response = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: linkedSignal(timeout, abort)
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
  return formatAmountDisplay(value, { decimals, minimumFractionDigits: 4, rounding: 'down' });
}

/** The amount step receives a value only when the balance read settled successfully. */
function shownBalance({ value, loading }: BridgeBalance, decimals: number): number | null {
  if (loading || value === null) return null;
  return Number(formatUnits(value, decimals));
}

/** Epoch balance map: the account and the complete source-chain token set that was read. */
interface EpochBalancesIdentity {
  evmAddress: string;
  tokensKey: string;
}

/** Circle USDC read: the account, Arc's USDC, and whether xReserve could be used. */
interface CircleBalanceIdentity {
  evmAddress: string;
  chainId: number | undefined;
  usdc: string | undefined;
  usdcxAvailable: boolean;
  usdcxPending: boolean;
}

/** Native ETH read: the account and the AggLayer chain the balance was asked on. */
interface EthBalanceIdentity {
  evmAddress: string;
  agglayerChainId: number | undefined;
  agglayerPending: boolean;
}

/** ERC-20 map read: the account, the AggLayer chain, and the offered set those rows were read for. */
interface Erc20BalanceIdentity {
  evmAddress: string;
  agglayerChainId: number | undefined;
  offeredKey: string;
}

interface StampedBalance<Identity> {
  identity: Identity;
  balance: BridgeBalance;
}

interface StampedBalanceMap<Identity> {
  identity: Identity;
  balances: Record<string, BridgeBalance>;
}

function sameHexAddress(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function epochBalancesIdentity(evmAddress: string, tokensKey: string): EpochBalancesIdentity {
  return { evmAddress, tokensKey };
}

function sameEpochBalancesIdentity(left: EpochBalancesIdentity, right: EpochBalancesIdentity): boolean {
  return sameHexAddress(left.evmAddress, right.evmAddress) && left.tokensKey === right.tokensKey;
}

function circleBalanceIdentity(
  evmAddress: string,
  chainId: number | undefined,
  usdc: string | undefined,
  usdcxAvailable: boolean,
  usdcxPending: boolean
): CircleBalanceIdentity {
  return { evmAddress, chainId, usdc, usdcxAvailable, usdcxPending };
}

function sameCircleBalanceIdentity(left: CircleBalanceIdentity, right: CircleBalanceIdentity): boolean {
  return (
    sameHexAddress(left.evmAddress, right.evmAddress) &&
    left.chainId === right.chainId &&
    sameHexAddress(left.usdc, right.usdc) &&
    left.usdcxAvailable === right.usdcxAvailable &&
    left.usdcxPending === right.usdcxPending
  );
}

function ethBalanceIdentity(
  evmAddress: string,
  agglayerChainId: number | undefined,
  agglayerPending: boolean
): EthBalanceIdentity {
  return { evmAddress, agglayerChainId, agglayerPending };
}

function sameEthBalanceIdentity(left: EthBalanceIdentity, right: EthBalanceIdentity): boolean {
  return (
    sameHexAddress(left.evmAddress, right.evmAddress) &&
    left.agglayerChainId === right.agglayerChainId &&
    left.agglayerPending === right.agglayerPending
  );
}

function erc20BalanceIdentity(
  evmAddress: string,
  agglayerChainId: number | undefined,
  offeredKey: string
): Erc20BalanceIdentity {
  return { evmAddress, agglayerChainId, offeredKey };
}

function sameErc20BalanceIdentity(left: Erc20BalanceIdentity, right: Erc20BalanceIdentity): boolean {
  return (
    sameHexAddress(left.evmAddress, right.evmAddress) &&
    left.agglayerChainId === right.agglayerChainId &&
    left.offeredKey === right.offeredKey
  );
}

function sameBridgeBalance(left: BridgeBalance, right: BridgeBalance): boolean {
  return (
    left.value === right.value &&
    left.formatted === right.formatted &&
    left.loading === right.loading &&
    left.error === right.error &&
    left.errorId === right.errorId &&
    left.errorDiagnostics === right.errorDiagnostics
  );
}

function sameBalanceMap(left: Record<string, BridgeBalance>, right: Record<string, BridgeBalance>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(key => {
    const balance = left[key];
    const other = right[key];
    return balance !== undefined && other !== undefined && sameBridgeBalance(balance, other);
  });
}

/**
 * Stores `balance` only while the slot is still the identity captured when the read started. A completion that
 * lost that race keeps the newer stamp. The render installs a new identity before the effect resets it.
 */
function commitStampedBalance<Identity>(
  setSlot: Dispatch<SetStateAction<StampedBalance<Identity> | null>>,
  identity: Identity,
  balance: BridgeBalance,
  same: (left: Identity, right: Identity) => boolean
) {
  setSlot(current => {
    if (current === null || !same(current.identity, identity)) return current;
    if (sameBridgeBalance(current.balance, balance)) return current;
    return { identity: current.identity, balance };
  });
}

/** One entry of a token map, addressed by its stable key and guarded by the map's read identity. */
function commitStampedBalanceMap<Identity>(
  setSlot: Dispatch<SetStateAction<StampedBalanceMap<Identity> | null>>,
  identity: Identity,
  update: (balances: Record<string, BridgeBalance>) => Record<string, BridgeBalance>,
  same: (left: Identity, right: Identity) => boolean
) {
  setSlot(current => {
    if (current === null || !same(current.identity, identity)) return current;
    const balances = update(current.balances);
    if (sameBalanceMap(current.balances, balances)) return current;
    return { identity: current.identity, balances };
  });
}

/** The stored balance when this render's identity produced it; otherwise unread, before any effect runs. */
function visibleStampedBalance<Identity>(
  slot: StampedBalance<Identity> | null,
  identity: Identity,
  setSlot: Dispatch<SetStateAction<StampedBalance<Identity> | null>>,
  same: (left: Identity, right: Identity) => boolean
): BridgeBalance {
  if (slot !== null && same(slot.identity, identity)) return slot.balance;
  setSlot({ identity, balance: EMPTY_BALANCE });
  return EMPTY_BALANCE;
}

function visibleStampedBalanceMap<Identity>(
  slot: StampedBalanceMap<Identity> | null,
  identity: Identity,
  setSlot: Dispatch<SetStateAction<StampedBalanceMap<Identity> | null>>,
  same: (left: Identity, right: Identity) => boolean
): Record<string, BridgeBalance> {
  if (slot !== null && same(slot.identity, identity)) return slot.balances;
  setSlot({ identity, balances: {} });
  return {};
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
  observer?: BalanceStageObserver,
  abort?: AbortSignal
): Promise<bigint> {
  recordBalanceStage(observer, 'input_validation');
  if (!isAddress(evmAddress)) {
    throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
  }
  recordBalanceStage(observer, 'request_build');
  const data = encodeFunctionData({ abi: ERC20_BALANCE_OF_ABI, functionName: 'balanceOf', args: [evmAddress] });
  const result = await rpcRequest('eth_call', [{ to: contract, data }, 'latest'], chainId, observer, abort);
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
  // A quantity that is not a hex word ("", " ", "0", a number) is a failed read, not a zero balance.
  if (!isHex(result)) {
    throw new Error('ETH getBalance returned no quantity');
  }
  return BigInt(result);
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
  relaySource,
  midenAccount,
  onConnectAnother,
  onClose,
  onExit = onClose,
  pendingDepositId,
  reportDeposit
}) => {
  const { t } = useTranslation();
  const { navigateTo, goBack, cardStack, activeRoute } = useNavigator();
  const { walletProvider } = useAppKitProvider<EIP1193Provider>('eip155');
  const nativeReownAvailable = isNativeReownAvailable();
  const depositSource = useMemo(
    () => depositSourceOf(relaySource, nativeReownAvailable),
    [relaySource, nativeReownAvailable]
  );
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
  // A relay source runs the deposit-address flow in the place of the Navigator steps.
  const relay = relaySource !== undefined;
  const [relayStep, setRelayStep] = useState<RelayStep>(pendingDepositId === undefined ? 'amount' : 'restoring');

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
  // token, or an AggLayer chain that takes deposits. The list is the same for every token. A relay source takes only a
  // chain that the relay serves.
  const sourceNetworks = useMemo<readonly BridgeNetwork[]>(() => {
    const circle = new Set(listUsdcxSourceChains().map(entry => entry.chain.id));
    return Object.values(bridgeConfig.config?.supportedEvmChains ?? {}).flatMap(entry => {
      const offered =
        circle.has(entry.chainId) ||
        selectEpochDepositTokens(bridgeConfig, entry.chainId).length > 0 ||
        entry.bridges.agglayer?.depositEnabled === true;
      const served = relaySource === undefined || relayServesChain(entry.chainId);
      const network = getBridgeNetworkByChainId(entry.chainId);
      return offered && served && network ? [network] : [];
    });
  }, [bridgeConfig, relaySource]);
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
  // The amount whose display quote Circle refused, which the relay amount step says.
  const [usdcxQuoteFailedFor, setUsdcxQuoteFailedFor] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [epochBalanceSlot, setEpochBalanceSlot] = useState<StampedBalanceMap<EpochBalancesIdentity> | null>(null);
  const [circleBalanceSlot, setCircleBalanceSlot] = useState<StampedBalance<CircleBalanceIdentity> | null>(null);
  // Circle's Arc USDC is a source token only where its one route, xReserve, can start.
  const usdcxAvailability = useFeatureAvailability('usdcxDeposit', { chainId: usdcxSource?.chain.id });
  const usdcxAvailable = usdcxAvailability.state === 'available';
  const usdcxPending = usdcxAvailability.state === 'loading';
  const [ethBalanceSlot, setEthBalanceSlot] = useState<StampedBalance<EthBalanceIdentity> | null>(null);
  const [erc20BalanceSlot, setErc20BalanceSlot] = useState<StampedBalanceMap<Erc20BalanceIdentity> | null>(null);
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
  const epochTokensKey = epochTokens
    .map(({ key, address, chainId, decimals }) => `${chainId}:${key}:${address}:${decimals}`)
    .join(',');
  const epochIdentity = epochBalancesIdentity(evmAddress, epochTokensKey);
  const epochBalances = visibleStampedBalanceMap(
    epochBalanceSlot,
    epochIdentity,
    setEpochBalanceSlot,
    sameEpochBalancesIdentity
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
  const onAmountStep = relay ? relayStep === 'amount' : activeRoute?.name === ReceiveStep.ShowBridgePageTakeAmount;
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
  const routesAhead = relay ? relayStep !== 'processing' : activeRoute?.name !== ReceiveStep.ShowBridgePageStatus;
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
  // Keyed on the token set, not the array a config publish rebuilds.
  const offeredKey = offeredErc20s.map(({ contractAddress, decimals }) => `${contractAddress}:${decimals}`).join(',');
  // Visible only for the read that produced them. A new account, chain, token or availability is unread in this
  // render, before the effect that starts the next read, so Continue and Confirm cannot spend the previous balance.
  const circleIdentity = circleBalanceIdentity(
    evmAddress,
    usdcxSource?.chain.id,
    usdcxSource?.usdc,
    usdcxAvailable,
    usdcxPending
  );
  const ethIdentity = ethBalanceIdentity(evmAddress, agglayerChainId, agglayerPending);
  const erc20Identity = erc20BalanceIdentity(evmAddress, agglayerChainId, offeredKey);
  const circleUsdcBalance = visibleStampedBalance(
    circleBalanceSlot,
    circleIdentity,
    setCircleBalanceSlot,
    sameCircleBalanceIdentity
  );
  const ethBalance = visibleStampedBalance(ethBalanceSlot, ethIdentity, setEthBalanceSlot, sameEthBalanceIdentity);
  const erc20Balances = visibleStampedBalanceMap(
    erc20BalanceSlot,
    erc20Identity,
    setErc20BalanceSlot,
    sameErc20BalanceIdentity
  );
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
  const balanceUnreadable = !selectedBalance.loading && selectedBalance.value === null;
  // Circle's display quote follows the amount the user settled on, not every keystroke. A relay source quotes Circle's
  // USDC on its Epoch route too, so the route sheet can show the fee of both routes.
  const usdcxQuoted = quotesUsdcxFee(route, relay, token);
  const [debouncedUsdcxAmount] = useDebounce(usdcxQuoted ? quotedAmountOf(amount) : '', 500);
  const usdcxQuotedFeeUnits = usdcxQuote && usdcxQuote.amount === amount.trim() ? usdcxQuote.fee : undefined;
  const usdcxQuotedFee =
    usdcxQuotedFeeUnits === undefined
      ? undefined
      : formatAmountDisplay(usdcxQuotedFeeUnits, { decimals: CIRCLE_USDC_DECIMALS, formatting: 'exact' });
  // Only an Epoch token on the Fast route is quoted; Slow (AggLayer) and Circle need no quote.
  const [debouncedAmount] = useDebounce(
    fastKey !== null && route === 'epoch' && isValidAmount(amount) ? amount.trim() : '',
    500
  );

  useEffect(() => {
    resetEpoch();
  }, [resetEpoch]);

  // Every Epoch token's balance on the source chain, each row settling on its own: the native coin is the account's own
  // balance, any other token its ERC-20 balance. Keyed on the chain and token set, not the array a config publish
  // rebuilds: two chains can list the same entry, native ETH at the zero address above all.
  const epochTokensRef = useRef(epochTokens);
  epochTokensRef.current = epochTokens;
  useEffect(() => {
    const identity = epochBalancesIdentity(evmAddress, epochTokensKey);
    commitStampedBalanceMap(setEpochBalanceSlot, identity, () => ({}), sameEpochBalancesIdentity);
    const tokens = epochTokensRef.current;
    if (tokens.length === 0) return;
    let cancelled = false;
    const settle = (key: string, balance: BridgeBalance) => {
      if (cancelled) return;
      commitStampedBalanceMap(
        setEpochBalanceSlot,
        identity,
        current => ({ ...current, [key]: balance }),
        sameEpochBalancesIdentity
      );
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
    const identity = circleBalanceIdentity(
      evmAddress,
      usdcxSource?.chain.id,
      usdcxSource?.usdc,
      usdcxAvailable,
      usdcxPending
    );
    commitStampedBalance(setCircleBalanceSlot, identity, EMPTY_BALANCE, sameCircleBalanceIdentity);
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
        commitStampedBalance(
          setCircleBalanceSlot,
          identity,
          { value, formatted: formatBalance(value, CIRCLE_USDC_DECIMALS), loading: false, error: null },
          sameCircleBalanceIdentity
        );
      })
      .catch(err => {
        if (cancelled) return;
        commitStampedBalance(
          setCircleBalanceSlot,
          identity,
          {
            value: null,
            formatted: '0',
            loading: false,
            error: errorMessage(err),
            errorId: 'raw_bridge_balance_failed',
            errorDiagnostics: evidence.snapshot()
          },
          sameCircleBalanceIdentity
        );
      });

    return () => {
      cancelled = true;
    };
  }, [evmAddress, usdcxAvailable, usdcxPending, usdcxSource]);

  useEffect(() => {
    const identity = ethBalanceIdentity(evmAddress, agglayerChainId, agglayerPending);
    let cancelled = false;
    commitStampedBalance(setEthBalanceSlot, identity, EMPTY_BALANCE, sameEthBalanceIdentity);
    if (agglayerPending) return;
    const evidence = createBalanceEvidence('native');

    const ethRead =
      agglayerChainId === undefined
        ? Promise.reject(new Error('The bridge config names no AggLayer chain.'))
        : readEthBalance(evmAddress, agglayerChainId, evidence.observe);
    ethRead
      .then(value => {
        if (cancelled) return;
        commitStampedBalance(
          setEthBalanceSlot,
          identity,
          { value, formatted: formatBalance(value, 18), loading: false, error: null },
          sameEthBalanceIdentity
        );
      })
      .catch(err => {
        if (cancelled) return;
        commitStampedBalance(
          setEthBalanceSlot,
          identity,
          {
            value: null,
            formatted: '0',
            loading: false,
            error: errorMessage(err),
            errorId: 'raw_bridge_balance_failed',
            errorDiagnostics: evidence.snapshot()
          },
          sameEthBalanceIdentity
        );
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
  useEffect(() => {
    const identity = erc20BalanceIdentity(evmAddress, agglayerChainId, offeredKey);
    const chainId = agglayerChainId;
    commitStampedBalanceMap(setErc20BalanceSlot, identity, () => ({}), sameErc20BalanceIdentity);
    const offered = offeredRef.current;
    if (chainId === undefined || offered.length === 0) return;
    let cancelled = false;
    // Ends the reads in flight when the identity changes, so a stale answer never costs a request to settle.
    const abort = new AbortController();
    const settle = (address: string, balance: BridgeBalance) => {
      if (cancelled) return;
      commitStampedBalanceMap(
        setErc20BalanceSlot,
        identity,
        current => ({ ...current, [address]: balance }),
        sameErc20BalanceIdentity
      );
    };
    const reads = new PQueue({ concurrency: ERC20_BALANCE_READS });
    for (const { contractAddress, decimals } of offered) {
      const evidence = createBalanceEvidence('registered_erc20');
      void reads.add(() =>
        readErc20Balance(evmAddress, contractAddress, chainId, evidence.observe, abort.signal)
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
      abort.abort();
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
    setUsdcxQuoteFailedFor(null);
    if (
      !usdcxQuoted ||
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
        if (!cancelled) setUsdcxQuoteFailedFor(quotedAmount);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [usdcxQuoted, usdcxSource, debouncedUsdcxAmount, evmAddress, midenAccount.publicKey]);

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
  // A relay attempt that ended with no executed batch says so; the funds stay at the relay address.
  const relayDepositError = useCallback(
    (err: unknown): DepositError => {
      switch (relayDepositOutcome(err)) {
        case 'reverted':
          return { id: 'raw_bridge_deposit_failed', text: t('depositFlowRelayReverted') };
        case 'expired':
          return { id: 'raw_bridge_deposit_failed', text: t('depositFlowRelayExpired') };
        case 'refused':
          return { id: 'raw_bridge_deposit_failed', text: t('depositFlowRelayRefused') };
        case 'open':
        case undefined:
        default:
          return depositError(err);
      }
    },
    [depositError, t]
  );
  /**
   * The end of a deposit send that threw, for the Agglayer and the Circle handlers. A relay job whose outcome is not
   * known yet can still execute: the row keeps its job and stays open, and nothing signs again for this deposit. Else
   * the row fails at `step`: a relay error in the words of the relay, every other error in the handler's `ownWords`.
   */
  const settleFailedSend = useCallback(
    async (
      trackingTxId: string,
      err: unknown,
      step: BridgeReceiveFailureStep,
      ownWords: (err: unknown) => DepositError,
      bridgeName: string
    ): Promise<void> => {
      const outcome = relayDepositOutcome(err);
      if (outcome === 'open') {
        console.warn(`[EvmBridgeDepositScreen] ${bridgeName} relay outcome not known yet`, err);
        setSlowStatus('submitted');
        return;
      }
      console.error(`[EvmBridgeDepositScreen] ${bridgeName} bridge failed`, err);
      const failure =
        depositSource.client === 'relay' && outcome !== undefined ? relayDepositError(err) : ownWords(err);
      setSlowError(failure);
      setSlowStatus('failed');
      await updateBridgedReceivePhase(trackingTxId, 'failed', {
        error: failure.text,
        errorId: failure.id,
        failure: failureSource(
          step,
          err,
          step === 'wallet_approve' || step === 'wallet_deposit' ? depositSource.client : undefined
        )
      }).catch(() => undefined);
    },
    [depositSource.client, relayDepositError]
  );
  // The route step holds an amount its displayed fee takes past the balance in the words the deposit refuses it with.
  const usdcxFeeAboveBalanceMessage = useCallback(
    ({ needed, fee, balance }: { needed: bigint; fee: bigint; balance: bigint }): string =>
      t('usdcxDepositFeeAboveBalance', {
        // Exact: a one-unit shortfall must read as one, and the fee is the one Circle quoted.
        total: formatAmountDisplay(needed, { decimals: CIRCLE_USDC_DECIMALS, formatting: 'exact' }),
        fee: formatAmountDisplay(fee, { decimals: CIRCLE_USDC_DECIMALS, formatting: 'exact' }),
        balance: formatAmountDisplay(balance, { decimals: CIRCLE_USDC_DECIMALS, formatting: 'exact' }),
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
      if (!isValidAmount(amount) || (depositSource.client === 'wagmi' && !walletProvider)) {
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
        const coversDeposit = () =>
          ensureBalanceCovers(amountInBaseUnits, sourceDecimals, agglayerChainId, () => {
            if (isNative) return readEthBalance(evmAddress, agglayerChainId);
            if (erc20) return readErc20Balance(evmAddress, tokenAddress, agglayerChainId);
            return readEpochUsdcBalance(evmAddress, tokenAddress, agglayerChainId);
          });
        await coversDeposit();
        // Native Reown signs on the AggLayer chain: a session that did not approve it fails here, before any
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.". It comes after the
        // balance check because adding and switching the chain is itself a wallet prompt.
        step = 'precheck_session_chain';
        if (depositSource.client === 'native_reown') await prepareNativeSessionChain(agglayerChainId);
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

        // Each call is encoded once for every source: the relay sends the two in one batch, an external wallet asks
        // for each one in its own prompt.
        const approveArgs: readonly [`0x${string}`, bigint] = [contractAddress, amountInBaseUnits];
        const approveCall: BatchCall | null = needsApproval
          ? {
              to: tokenAddress,
              value: 0n,
              data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: approveArgs })
            }
          : null;
        const depositCall: BatchCall = {
          to: contractAddress,
          value,
          data: encodeFunctionData({ abi: AGGLAYER_BRIDGE_ABI, functionName: 'bridgeAsset', args })
        };

        let hash: `0x${string}`;
        switch (depositSource.client) {
          case 'relay': {
            // One batch holds the approval and the deposit, so there is no second prompt to wait for. The job is on
            // the row before the POST, so a lost answer leaves a job to follow. Each signature checks the balance again.
            step = 'wallet_deposit';
            const provider = buildRelayProvider(depositSource.relay, agglayerChainId, {
              beforeSign: async () => {
                step = 'precheck_balance';
                await coversDeposit();
                step = 'wallet_deposit';
              },
              onJob: job => updateBridgedReceivePhase(trackingTxId, 'submitting', { relayJob: job })
            });
            hash = await provider.sendCalls(approveCall === null ? [depositCall] : [approveCall, depositCall]);
            break;
          }
          case 'native_reown': {
            const sendNative = async (call: BatchCall) =>
              NativeReown.sendTransaction({
                chainId: agglayerChainId,
                from: evmAddress,
                to: call.to,
                value: toHex(call.value),
                data: call.data,
                ...(await readNativeFeeFields(agglayerChainId))
              });
            if (approveCall !== null) {
              step = 'wallet_approve';
              const approval = await sendNative(approveCall);
              setAwaitingNextConfirmation(true);
              step = 'approve_receipt';
              await waitForEvmReceipt(unwrapNativeResult(approval.hash) as `0x${string}`, chain);
            }
            step = 'wallet_deposit';
            const result = await sendNative(depositCall);
            hash = unwrapNativeResult(result.hash) as `0x${string}`;
            break;
          }
          case 'wagmi':
          default: {
            // Pin the target chain so wagmi/viem assert the wallet's ACTIVE chain is
            // Sepolia before broadcasting. The WC session namespace declares Sepolia,
            // but the wallet's active chain can be anything (often mainnet); without
            // this a payable `bridgeAsset` would broadcast real ETH on the wrong chain
            // to a Sepolia-only address. The Fast/Epoch path guards this same case in
            // executeEVMToMiden; the native branch above already pins DEFAULT_CHAIN_ID.
            // A USDCx deposit switches the wallet to Arc or Base, so switch it back first.
            // wagmi takes the typed call: the same target, arguments and value as the encoded one.
            step = 'precheck_session_chain';
            await switchChainAsync({ chainId: agglayerChainId });
            if (approveCall !== null) {
              step = 'wallet_approve';
              const approvalHash = await writeContract.mutateAsync({
                chainId: agglayerChainId,
                abi: ERC20_APPROVE_ABI,
                address: approveCall.to,
                functionName: 'approve',
                args: approveArgs
              });
              setAwaitingNextConfirmation(true);
              step = 'approve_receipt';
              await waitForEvmReceipt(approvalHash, chain);
            }
            step = 'wallet_deposit';
            hash = await writeContract.mutateAsync({
              chainId: agglayerChainId,
              abi: AGGLAYER_BRIDGE_ABI,
              address: depositCall.to,
              functionName: 'bridgeAsset',
              args,
              value: depositCall.value
            });
            break;
          }
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
        await settleFailedSend(trackingTxId, err, step, depositError, 'Agglayer');
      }
    },
    [
      agglayerRecovery,
      agglayerChainId,
      amount,
      depositError,
      depositSource,
      ensureBalanceCovers,
      erc20,
      erc20Picked,
      evmAddress,
      evmUsdc,
      fastKey,
      midenAccount.publicKey,
      settleFailedSend,
      slowSourceDecimals,
      switchChainAsync,
      token,
      walletProvider,
      writeContract
    ]
  );

  const handleUsdcxDeposit = useCallback(
    async (trackingTxId: string) => {
      if (!isValidAmount(amount) || (depositSource.client === 'wagmi' && !walletProvider)) {
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
      const usdcxSigner = {
        nativeReownAvailable,
        writeContract: writeContract.mutateAsync,
        chainId: usdcxChain.id,
        from: evmAddress
      };
      // A signed approval is always followed by another wallet prompt: a second approval or the deposit or burn.
      const approve = async (spender: `0x${string}`, value: bigint): Promise<Hash> => {
        step = 'wallet_approve';
        const hash = await sendEvmContractTransaction({
          ...usdcxSigner,
          address: circleUsdcAddress,
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
          args: [spender, value]
        });
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
      const readBalance = () => readCircleUsdcBalance(evmAddress, usdcxSource);
      // The relay calls are the wallet's calls, encoded: an approval of Circle's USDC, then the deposit or the burn.
      const approveCall = ({ spender, value }: UsdcxApproval): BatchCall => ({
        to: circleUsdcAddress,
        value: 0n,
        data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [spender, value] })
      });
      // The relay sends the approval (when it is necessary) and the deposit or burn in one batch, so there is no second
      // prompt to wait for. The job is on the row before the POST, with what the row records with the hash, so a lost
      // answer leaves a job to follow. Each signature checks again that the address holds `spend`.
      const relaySend = (
        relay: RelaySource,
        calls: BatchCall[],
        spend: bigint,
        facts: UsdcxDepositFacts | UsdcxBurnFacts
      ): Promise<Hash> => {
        step = 'wallet_deposit';
        const provider = buildRelayProvider(relay, usdcxChain.id, {
          beforeSign: async () => {
            step = 'precheck_balance';
            await ensureBalanceCovers(spend, CIRCLE_USDC_DECIMALS, usdcxChain.id, readBalance);
            step = 'wallet_deposit';
          },
          onJob: job => updateBridgedReceivePhase(trackingTxId, 'submitting', { relayJob: job, ...facts })
        });
        return provider.sendCalls(calls);
      };
      // A signer with a batch method gets only batch calls, so the relay never sends one call of the pair alone.
      const relayBatchOnly = (): Promise<Hash> =>
        Promise.reject(new Error('The relay sends the approval and the deposit in one batch.'));
      const xReserveSigner = (xReserve: `0x${string}`): UsdcxSigner => {
        switch (depositSource.client) {
          case 'relay': {
            const { relay } = depositSource;
            return {
              approve: relayBatchOnly,
              depositToRemote: relayBatchOnly,
              approveAndDepositToRemote: (approval, args, facts) => {
                const deposit: BatchCall = {
                  to: xReserve,
                  value: 0n,
                  data: encodeFunctionData({ abi: XRESERVE_ABI, functionName: 'depositToRemote', args })
                };
                const [value] = args;
                return relaySend(relay, approval === null ? [deposit] : [approveCall(approval), deposit], value, facts);
              }
            };
          }
          case 'native_reown':
          case 'wagmi':
          default:
            return {
              approve,
              depositToRemote: args =>
                lastPrompt(
                  sendEvmContractTransaction({
                    ...usdcxSigner,
                    address: xReserve,
                    abi: XRESERVE_ABI,
                    functionName: 'depositToRemote',
                    args
                  })
                )
            };
        }
      };
      const executorSigner = (tokenMessengerWithFees: `0x${string}`): UsdcxExecutorSigner => {
        switch (depositSource.client) {
          case 'relay': {
            const { relay } = depositSource;
            return {
              approve: relayBatchOnly,
              depositForBurnWithHookAndFees: relayBatchOnly,
              // The burn pulls the amount and Circle's fee, so the address must hold both.
              approveAndBurn: (approval, args, facts) => {
                const burn: BatchCall = {
                  to: tokenMessengerWithFees,
                  value: 0n,
                  data: encodeFunctionData({
                    abi: TOKEN_MESSENGER_WITH_FEES_ABI,
                    functionName: 'depositForBurnWithHookAndFees',
                    args
                  })
                };
                const [value] = args;
                const spend = value + BigInt(facts.cctp.forwardFee);
                return relaySend(relay, approval === null ? [burn] : [approveCall(approval), burn], spend, facts);
              }
            };
          }
          case 'native_reown':
          case 'wagmi':
          default:
            return {
              approve,
              depositForBurnWithHookAndFees: args =>
                lastPrompt(
                  sendEvmContractTransaction({
                    ...usdcxSigner,
                    address: tokenMessengerWithFees,
                    abi: TOKEN_MESSENGER_WITH_FEES_ABI,
                    functionName: 'depositForBurnWithHookAndFees',
                    args
                  })
                )
            };
        }
      };

      let depositHash: string | undefined;
      try {
        // Encoded inside the try so an id the faucet cannot mint to fails the row
        // instead of throwing out of the flow.
        const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
        if (!isAddress(evmAddress)) throw walletRaised(new Error(`Invalid EVM address: ${evmAddress}`));
        step = 'precheck_balance';
        await ensureBalanceCovers(
          parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
          CIRCLE_USDC_DECIMALS,
          usdcxChain.id,
          readBalance
        );
        // Native Reown signs on the source chain: a session that did not approve it fails here, before the first
        // wallet prompt, instead of with the Sign SDK's "Invalid permissions for call.". wagmi switches the wallet to
        // the source chain. The relay has no session and no wallet chain: it sends on the chain it is built for.
        step = 'precheck_session_chain';
        switch (depositSource.client) {
          case 'native_reown':
            await prepareNativeSessionChain(usdcxChain.id);
            break;
          case 'wagmi':
            await switchChainAsync({ chainId: usdcxChain.id });
            break;
          case 'relay':
          default:
            break;
        }
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
            await runUsdcxDeposit(trackingTxId, amount, recipient, {
              sourceChainId: usdcxChain.id,
              source: usdcxSource,
              signer: xReserveSigner(xReserve),
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
            await runUsdcxExecutorDeposit(trackingTxId, amount, recipient, {
              source: usdcxSource,
              depositor: evmAddress,
              signer: executorSigner(tokenMessengerWithFees),
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
        await settleFailedSend(trackingTxId, err, usdcxFailureStep(err, step), usdcxDepositError, 'USDCx');
      }
    },
    [
      amount,
      depositSource,
      ensureBalanceCovers,
      evmAddress,
      midenAccount.publicKey,
      nativeReownAvailable,
      readBalanceOrFail,
      settleFailedSend,
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
  // row fails with the localized reconnect message and no wallet prompt opens. A relay source has no session: the
  // store sends through the relay, from the relay address that the quote names as source and sponsor.
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
        if (depositSource.client === 'native_reown') await prepareNativeSessionChain(evmUsdc.chainId);
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
      depositSource,
      ensureBalanceCovers,
      evmAddress,
      evmUsdc,
      executeEVMToMiden,
      fastNative,
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
  // A relay source deposits funds that arrive after the review, so its amount is not held to a balance here: the start
  // waits for the funds at the address, and each handler reads the balance again before it signs.
  const setupReady = typedUnits !== null && (relay || (heldUnits !== null && !amountExceedsBalance)) && !capHold;

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
    (relay || (usdcBalance.value !== null && quotedTokenIn <= usdcBalance.value));
  // Picking Slow can move the USDC to the AggLayer chain's, so the amount is held to that balance here as well.
  const slowReady =
    route === 'agglayer' &&
    agglayerChainId !== undefined &&
    slowAvailability.state === 'available' &&
    setupReady &&
    slowStatus !== 'signing';
  // The deposit is 1:1, but an executor-route burn pulls Circle's fee on top of the amount, so once the fee is on
  // screen Confirm holds an amount it takes past the balance. The deposit checks the fee it signs before any prompt,
  // and again after an approval, before the burn prompt. A relay source asks for the fee on top of the amount at its
  // address, so its balance holds nothing here.
  const circleBalanceHolds = holdsCircleBalance(relay, route, token);
  const usdcxFeeShortfall = circleFeeShortfall(circleBalanceHolds, typedUnits, heldUnits, usdcxQuotedFeeUnits);
  const usdcxFeeHoldNotice = usdcxFeeShortfall ? usdcxFeeAboveBalanceMessage(usdcxFeeShortfall) : undefined;
  // A user clears either hold by adding USDC, so the balance is re-read in place until it covers; a failed read keeps it.
  const usdcxBalanceHeld = circleBalanceHeld(usdcxFeeShortfall, circleBalanceHolds, amountExceedsBalance);
  useEffect(() => {
    if (!usdcxBalanceHeld || !usdcxSource) return;
    // Availability is part of the stamp. A change replaces the interval and drops any prior in-flight read.
    const identity = circleBalanceIdentity(
      evmAddress,
      usdcxSource.chain.id,
      usdcxSource.usdc,
      usdcxAvailable,
      usdcxPending
    );
    let cancelled = false;
    let reading = false;
    const id = setInterval(() => {
      if (reading) return;
      reading = true;
      readCircleUsdcBalance(evmAddress, usdcxSource)
        .then(value => {
          if (cancelled) return;
          commitStampedBalance(
            setCircleBalanceSlot,
            identity,
            { value, formatted: formatBalance(value, CIRCLE_USDC_DECIMALS), loading: false, error: null },
            sameCircleBalanceIdentity
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
  }, [usdcxBalanceHeld, evmAddress, usdcxAvailable, usdcxPending, usdcxSource]);
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
  // A relay row whose job can still execute is in progress, whatever the store says: nothing may sign a second deposit.
  const relayJobOpen = useOpenRelayJob(relay ? bridgeTxId : null);
  const fastRetryable =
    route === 'epoch' && fastKey !== null && epochFlow === 'evm-to-miden' && epochStatus === 'failed' && !relayJobOpen;
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

  const handleConfirm = useCallback(async (): Promise<ConfirmResult> => {
    // A tap that lands once a row exists (Review is still on screen while the Navigator leaves it) changes nothing.
    if (confirming.current || relayJobOpen) return { kind: 'refused' };
    // Fast (Epoch): after a failed attempt the store is 'failed' and
    // executeEVMToMiden requires 'quoted', so re-quote to recover instead of
    // dead-ending until the amount changes. Once re-quoted, the next tap submits.
    if (route === 'epoch' && epochStatus === 'failed') {
      hapticMedium();
      requote();
      return { kind: 'refused' };
    }
    if (!canConfirmRoute || creatingBridgeRow) return { kind: 'refused' };
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
      // A relay source follows the row on its own processing step.
      if (relaySource === undefined) navigateTo(ReceiveStep.ShowBridgePageStatus);
      return { kind: 'started', txId };
    } catch (err) {
      console.error('[EvmBridgeDepositScreen] bridge row creation failed', err);
      const failure: DepositError = { text: errorMessage(err), id: 'raw_bridge_deposit_submit_failed' };
      setSlowError(failure);
      confirming.current = false;
      setUsdcxSubmissionPending(false);
      setConfirmSettled(count => count + 1);
      return { kind: 'failed', error: failure };
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
    relayJobOpen,
    relaySource,
    reportDeposit,
    requote,
    route,
    sourceChainId,
    erc20,
    slowSourceDecimals,
    tokenSymbol
  ]);

  const renderDepositStep = useCallback(
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
              // The guide describes the prompts of an external wallet: a relay source signs with no prompt.
              walletPromptGuide={relaySource === undefined}
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
              balanceUnreadable={balanceUnreadable}
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
              // The wallet pill names an external wallet: a relay source has none to show or switch.
              onSwitch={relaySource ? undefined : handleOpenSwitchDrawer}
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
      relaySource,
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
      balanceUnreadable,
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

  // A route or review step of an Epoch deposit waits behind the forced-withdrawal check of the sponsor's lock.
  const gateEpochWithdrawal = useCallback(
    (content: React.ReactNode) => {
      if (route !== 'epoch' || fastAvailability.state !== 'available' || !evmUsdc || !allocatorUrl) {
        return content;
      }
      const alternative = (() => {
        if (token === 'CIRCLE_USDC' && usdcxAvailable) {
          return { label: t('bridgeWithdrawalUseCircle'), onSelect: () => handleRouteChange('usdcx') };
        }
        if (slowAvailability.state === 'available') {
          return { label: t('bridgeWithdrawalUseSlow'), onSelect: () => handleRouteChange('agglayer') };
        }
        return undefined;
      })();
      return (
        <EpochWithdrawalGate
          key={`${allocatorUrl}:${evmUsdc.chainId}:${evmUsdc.address}:${evmAddress}`}
          chainId={evmUsdc.chainId}
          tokenAddress={evmUsdc.address}
          tokenLabel={tokenLabel}
          sponsorAddress={evmAddress}
          allocatorUrl={allocatorUrl}
          onDisabled={requote}
          alternative={alternative}
        >
          {content}
        </EpochWithdrawalGate>
      );
    },
    [
      allocatorUrl,
      evmAddress,
      evmUsdc,
      fastAvailability.state,
      handleRouteChange,
      requote,
      route,
      slowAvailability.state,
      t,
      token,
      tokenLabel,
      usdcxAvailable
    ]
  );

  const renderStep = useCallback(
    (step: Route) => {
      const content = renderDepositStep(step);
      const checksWithdrawal =
        step.name === ReceiveStep.ShowBridgePageRoute || step.name === ReceiveStep.ShowBridgePageReview;
      return checksWithdrawal ? gateEpochWithdrawal(content) : content;
    },
    [gateEpochWithdrawal, renderDepositStep]
  );

  // The deposit-address flow of a relay source (mock-up bread-deposit-R.html, its default state "Relay built"): amount,
  // review, the address that waits for the funds, then the bridge from that address with no further tap.
  const layout: DepositLayout = isExtension() ? 'extension' : 'mobile';
  const relayRoute = ((): RelayRoute => {
    switch (route) {
      case 'epoch':
        return 'epoch';
      case 'usdcx':
        return 'usdcx';
      case 'agglayer':
      case 'near-intents':
      default:
        return 'agglayer';
    }
  })();
  const sourceDecimals = setupToken.decimals;
  const [pendingDeposit, setPendingDeposit] = useState<PendingRelayDeposit | null>(null);
  // The record keeps its route as an id; a record with an id that this screen does not know is not shown.
  const pendingRoute = relayRouteOf(pendingDeposit);
  const [relayStartError, setRelayStartError] = useState<DepositError | null>(null);
  const [startPhase, setStartPhase] = useState<RelayStartPhase>('idle');
  // An Epoch deposit whose new quote at arrival asks for more than the record: what the address must hold now.
  const [requiredUnits, setRequiredUnits] = useState<bigint | null>(null);
  const [routeSheetOpen, setRouteSheetOpen] = useState(false);
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [walletSheetOpen, setWalletSheetOpen] = useState(false);
  const [slideResetKey, setSlideResetKey] = useState(0);
  // The pending deposits whose start this mounted screen runs. The claim in storage guards every other page and mount.
  const startedIds = useRef(new Set<string>());
  // The Epoch quote in the store when the start asked for a new one: only a newer quote can start the deposit.
  const quoteAtRequest = useRef<typeof epochQuote>(null);
  // The pending deposit whose start asked for that quote.
  const quoteRequestedFor = useRef<string | null>(null);
  // Circle's fee for the burn of a pending deposit on the executor route, quoted again when its funds arrived.
  const [arrivalFee, setArrivalFee] = useState<{ id: string; fee: bigint } | null>(null);

  // `?pending=<id>`: open on the address step of that deposit with its form state. An unknown id opens the amount step.
  const selectTokenRef = useRef(selectToken);
  selectTokenRef.current = selectToken;
  const relayAccountKey = relaySource?.accountPublicKey;
  const relayAddress = relaySource?.address;
  useEffect(() => {
    if (relayAccountKey === undefined || relayAddress === undefined || pendingDepositId === undefined) return undefined;
    let cancelled = false;
    setRelayStep('restoring');
    readPendingRelayDeposits(relayAccountKey)
      .then(deposits => {
        if (cancelled) return;
        const deposit = deposits.find(entry => entry.id === pendingDepositId);
        const form = deposit?.address === relayAddress ? decodeRelayDepositForm(deposit.form) : null;
        if (deposit === undefined || form === null) {
          setRelayStep('amount');
          return;
        }
        setPickedChainId(form.chainId);
        selectTokenRef.current(form.token);
        setRoute(form.route);
        setAmount(form.amount);
        setRelayStartError(null);
        setRequiredUnits(null);
        setStartPhase('idle');
        setPendingDeposit(deposit);
        setRelayStep('address');
      })
      .catch(err => {
        console.warn('[EvmBridgeDepositScreen] the pending deposit read failed', err);
        if (!cancelled) setRelayStep('amount');
      });
    return () => {
      cancelled = true;
    };
  }, [pendingDepositId, relayAccountKey, relayAddress]);

  // The balance at the address, read while the address step is on screen.
  const arrival = useDepositArrival(relayStep === 'address' ? pendingDeposit : null);
  // The relay's gas mode before the address step, for the chosen chain.
  const relayAccount = useRelayAccount({
    chainId: relay && (relayStep === 'amount' || relayStep === 'review') && sourceChainId > 0 ? sourceChainId : null,
    address: relaySource?.address
  });
  const relayMode = arrival.mode ?? relayAccount.account?.mode ?? null;
  // A relay that takes its gas out of the deposit cannot run this flow yet: the connect-wallet path takes it.
  useEffect(() => {
    if (relay && relayMode === 'deduct') onConnectAnother();
  }, [relay, relayMode, onConnectAnother]);

  // What the address must hold: the reviewed amount, or more when a new Epoch quote asks for more.
  const recordUnits = pendingDeposit === null ? null : BigInt(pendingDeposit.amountBaseUnits);
  const neededUnits =
    recordUnits !== null && requiredUnits !== null && requiredUnits > recordUnits ? requiredUnits : recordUnits;
  const relayArrival = neededUnits === null ? arrival : depositArrivalOf(arrival.balance, neededUnits);

  // Circle's USDC takes Circle xReserve, and Epoch where an Epoch token names the same contract; every other token takes
  // Agglayer and Epoch.
  const routeAvailable = (candidate: RelayRoute): boolean => {
    switch (candidate) {
      case 'agglayer':
        return token !== 'CIRCLE_USDC' && slowAvailability.state === 'available';
      case 'epoch':
        return fastAvailability.state === 'available';
      case 'usdcx':
        return token === 'CIRCLE_USDC' && circleOffered;
    }
  };
  const availableRelayRoutes = RELAY_ROUTES_BY_COST.filter(routeAvailable);
  const routeNameOf = (value: RelayRoute): string => {
    switch (value) {
      case 'agglayer':
        return t('depositFlowRouteAgglayer');
      case 'epoch':
        return t('depositFlowRouteEpoch');
      case 'usdcx':
        return t('depositFlowRouteCircle');
    }
  };
  const arrivesInOf = (value: RelayRoute, chainId: number): string => t(arrivalKeyOf(value, chainId));

  // Circle's executor route burns on this chain and Circle executes on Arc: its fee comes on top of the amount.
  const usdcxExecutorRoute = isExecutorSource(usdcxSource);
  // The bridge fee of a route, on top of the received amount, in source base units, or null while it is not known:
  // Agglayer and a direct xReserve deposit take none, Circle's executor route takes the fee Circle quoted for the amount,
  // and Epoch's fee is known only from the quote of the chosen Epoch route (its quote asks for the typed amount out).
  const routeFeeUnits = (candidate: RelayRoute): bigint | null => {
    switch (candidate) {
      case 'agglayer':
        return 0n;
      case 'usdcx':
        return usdcxExecutorRoute ? (usdcxQuotedFeeUnits ?? null) : 0n;
      case 'epoch':
        if (relayRoute !== 'epoch' || !fastReady || quotedTokenIn === null || typedUnits === null) return null;
        return quotedTokenIn > typedUnits ? quotedTokenIn - typedUnits : 0n;
    }
  };
  // What the user sends: the typed amount on Agglayer and on a direct xReserve deposit (1:1), the quoted deposit on
  // Epoch, and the amount plus Circle's quoted fee on Circle's executor route.
  const relaySendUnits = ((): bigint | null => {
    switch (relayRoute) {
      case 'epoch':
        return fastReady ? quotedTokenIn : null;
      case 'agglayer':
        return typedUnits;
      case 'usdcx': {
        const fee = routeFeeUnits('usdcx');
        return typedUnits === null || fee === null ? null : typedUnits + fee;
      }
    }
  })();
  const relaySent: DepositAmountValue | undefined =
    relaySendUnits === null ? undefined : { amount: relaySendUnits, decimals: sourceDecimals };
  // What arrives: the typed amount on every route.
  const relayReceived: DepositAmountValue | undefined =
    typedUnits === null ? undefined : { amount: formatUnits(typedUnits, sourceDecimals) };
  // Circle refused the display quote of this amount: its fee has no value to show.
  const usdcxQuoteFailed = quoteFailedFor(usdcxExecutorRoute, usdcxQuoteFailedFor, amount);
  const feeOf = (candidate: RelayRoute): DepositFee => {
    const fee = routeFeeUnits(candidate);
    if (fee === null) {
      const waiting = typedUnits !== null && !(candidate === 'usdcx' && usdcxQuoteFailed);
      return { kind: 'rate', text: waiting ? t('loading') : NO_FEE_YET };
    }
    return fee > 0n ? { kind: 'amount', value: { amount: fee, decimals: sourceDecimals } } : { kind: 'none' };
  };
  const relayFee = feeOf(relayRoute);
  // Circle's executor fee and Epoch's fee come on top of the amount, so they show with no minus sign.
  const relayFeeOnTop = feeComesOnTop(relayRoute, usdcxExecutorRoute);
  const relayFeeShare =
    relayFee.kind === 'amount' &&
    relaySendUnits !== null &&
    relaySendUnits > 0n &&
    typeof relayFee.value.amount === 'bigint'
      ? Number(relayFee.value.amount) / Number(relaySendUnits)
      : undefined;
  const relayUsd =
    typedUnits === null || depositPrice.priceUsd === undefined
      ? undefined
      : Number(formatUnits(typedUnits, sourceDecimals)) * depositPrice.priceUsd;
  // An Epoch amount takes no more fraction digits than the Miden token it arrives as.
  const relayInputDecimals =
    relayRoute === 'epoch' && midenUsdc ? Math.min(sourceDecimals, midenUsdc.decimals) : sourceDecimals;
  const relaySourceToken = { symbol: tokenLabel, logoFaucetId: outputFaucetId };
  const relayReceivedToken = { symbol: arrivingName, logoFaucetId: outputFaucetId };
  const relayNetwork = { id: bridgeNetwork?.id ?? '', name: networkName };
  // A quote that failed on the amount step is said under the receipt: Epoch's, or Circle's fee quote of the executor
  // route.
  const relayQuoteError = ((): DepositError | null => {
    if (!relay || relayStep !== 'amount') return null;
    switch (relayRoute) {
      case 'epoch':
        return epochFlow === 'evm-to-miden' && epochError
          ? { text: epochError, id: 'raw_bridge_deposit_failed' }
          : null;
      case 'usdcx':
        return usdcxQuoteFailed
          ? { text: t('usdcxForwardQuoteUnavailable'), id: 'usdcxForwardQuoteUnavailable' }
          : null;
      case 'agglayer':
        return null;
    }
  })();
  useUserVisibleError(relayQuoteError === null ? null : relayQuoteError.id, 'notice');

  // Every route delivers the typed amount, so the one that receives most is the one with the smallest fee on top. The
  // rows go by that fee, a known fee before one that is not known yet, and by the mock-up's cost order on a tie
  // (`routeRowsV`). "Fastest" is the route with the shortest time that the wallet states, by the mock-up's rank on a tie.
  const relayRoutesByReceived = [...availableRelayRoutes].sort((a, b) => {
    const feeA = routeFeeUnits(a);
    const feeB = routeFeeUnits(b);
    if (feeA !== null && feeB !== null && feeA !== feeB) return feeA < feeB ? -1 : 1;
    if ((feeA === null) !== (feeB === null)) return feeA === null ? 1 : -1;
    return RELAY_ROUTES_BY_COST.indexOf(a) - RELAY_ROUTES_BY_COST.indexOf(b);
  });
  const minutesOf = (candidate: RelayRoute): number => STATED_MINUTES[arrivalKeyOf(candidate, sourceChainId)];
  const fastestRelayRoute = [...availableRelayRoutes].sort(
    (a, b) => minutesOf(a) - minutesOf(b) || RELAY_ROUTES_BY_RANK.indexOf(a) - RELAY_ROUTES_BY_RANK.indexOf(b)
  )[0];
  const relayRouteOptions: DepositRouteOption[] = relayRoutesByReceived.map((candidate, index) => ({
    id: candidate,
    name: routeNameOf(candidate),
    arrivesIn: arrivesInOf(candidate, sourceChainId),
    received: relayReceived,
    // A fee that is not known yet (the Epoch fee of a route that is not chosen) shows no fee line.
    fee: candidate === relayRoute ? relayFee : routeFeeUnits(candidate) === null ? undefined : feeOf(candidate),
    best: index === 0,
    fastest: candidate === fastestRelayRoute,
    selected: candidate === relayRoute
  }));

  const relayChoices = useMemo(
    () => (relay ? relayTokenChoices(bridgeConfig, sourceNetworks, nativeUsdFaucetId ?? undefined) : []),
    [relay, bridgeConfig, sourceNetworks, nativeUsdFaucetId]
  );
  const relaySheetNetworks = sourceNetworks
    .filter(network => relayChoices.some(choice => choice.chainId === network.chainId))
    .map(network => ({ id: network.id, name: network.name }));
  const handleRelayTokenPick = useCallback(
    (id: string) => {
      const choice = relayChoices.find(candidate => candidate.option.id === id);
      if (choice === undefined || confirming.current) return;
      setPickedChainId(choice.chainId);
      handleTokenSelect(choice.token);
    },
    [handleTokenSelect, relayChoices]
  );

  // Review needs what the user sends: Epoch's quote, or Circle's fee on its executor route.
  const relayReviewReady = sendReady(canConfirmRoute, relaySendUnits);
  const handleRelayReview = useCallback(() => {
    if (!relayReviewReady) return;
    hapticMedium();
    setSlideResetKey(count => count + 1);
    setRelayStep('review');
  }, [relayReviewReady]);

  // The slide on Review: the pending deposit is saved, then the address shows.
  const handleRelaySlide = useCallback(async () => {
    const resetSlide = () => setSlideResetKey(count => count + 1);
    if (relaySource === undefined || relaySendUnits === null || typedUnits === null || !canConfirmRoute) {
      resetSlide();
      return;
    }
    if (sourceTokenAddress === undefined || !isAddress(sourceTokenAddress)) {
      resetSlide();
      return;
    }
    const output = relayRoute === 'epoch' ? outputAmount : formatUnits(typedUnits, sourceDecimals);
    const deposit = pendingRelayDepositOf({
      id: createPendingRelayDepositId(),
      accountPublicKey: relaySource.accountPublicKey,
      address: relaySource.address,
      chainId: sourceChainId,
      route: relayRoute,
      token: { address: lowerHexAddress(sourceTokenAddress), symbol: tokenLabel, decimals: sourceDecimals },
      amount: formatUnits(relaySendUnits, sourceDecimals),
      amountBaseUnits: relaySendUnits.toString(),
      ...(output === undefined ? {} : { outputAmount: output }),
      outputSymbol: arrivingName,
      createdAt: Date.now(),
      form: encodeRelayDepositForm({
        token,
        chainId: sourceChainId,
        route: relayRoute,
        amount: formatUnits(typedUnits, sourceDecimals)
      })
    });
    // The record holds only what its parser takes, the route included.
    if (deposit === null) {
      console.error('[EvmBridgeDepositScreen] the pending deposit record cannot hold this deposit', relayRoute);
      resetSlide();
      return;
    }
    try {
      await savePendingRelayDeposit(deposit);
    } catch (err) {
      console.error('[EvmBridgeDepositScreen] the pending deposit save failed', err);
      resetSlide();
      return;
    }
    setRelayStartError(null);
    setRequiredUnits(null);
    setStartPhase('idle');
    setPendingDeposit(deposit);
    setRelayStep('address');
  }, [
    arrivingName,
    canConfirmRoute,
    outputAmount,
    relayRoute,
    relaySendUnits,
    relaySource,
    sourceChainId,
    sourceDecimals,
    sourceTokenAddress,
    token,
    tokenLabel,
    typedUnits
  ]);

  // Back on the address step: Review again, and the pending deposit is removed (the mock-up's `back`). Not while the
  // bridge starts.
  const leaveAddressStep = useCallback(() => {
    if (startPhase === 'starting') return;
    if (pendingDeposit !== null) {
      removePendingRelayDeposit(pendingDeposit.accountPublicKey, pendingDeposit.id).catch(err =>
        console.error('[EvmBridgeDepositScreen] the pending deposit removal failed', err)
      );
    }
    setPendingDeposit(null);
    setRelayStartError(null);
    setRequiredUnits(null);
    setArrivalFee(null);
    quoteRequestedFor.current = null;
    setStartPhase('idle');
    setSlideResetKey(count => count + 1);
    setRelayStep('review');
  }, [pendingDeposit, startPhase]);

  // "Deposit X instead": Review again with what arrived. On Epoch the received amount is scaled by the share that
  // arrived, so the next quote asks for about that deposit.
  const handleDepositReceived = useCallback(() => {
    if (relayArrival.state !== 'partial' || neededUnits === null || neededUnits <= 0n) return;
    const arrived = relayArrival.balance;
    const next = ((): string | null => {
      switch (relayRoute) {
        case 'agglayer':
          return formatUnits(arrived, sourceDecimals);
        case 'epoch': {
          const minOut = midenUsdc ? evmToMidenMinTokenOut(amount, midenUsdc.decimals) : undefined;
          if (minOut === undefined || !midenUsdc) return null;
          return formatUnits((BigInt(minOut) * arrived) / neededUnits, midenUsdc.decimals);
        }
        case 'usdcx': {
          // Circle's executor fee is a fixed amount on top: what arrived less that fee can be deposited.
          const fee = typedUnits === null ? null : neededUnits - typedUnits;
          if (fee === null || fee < 0n || arrived <= fee) return null;
          return formatUnits(arrived - fee, sourceDecimals);
        }
      }
    })();
    leaveAddressStep();
    if (next !== null) setAmount(next);
  }, [amount, leaveAddressStep, midenUsdc, neededUnits, relayArrival, relayRoute, sourceDecimals, typedUnits]);

  // The start of the bridge for a pending deposit. The record is claimed first, so only one page or mount runs it; no
  // row: the record goes back, the failure shows, and the deposit can start again.
  const startRelayDeposit = useCallback(
    async (deposit: PendingRelayDeposit) => {
      let claimed: PendingRelayDeposit | null;
      try {
        claimed = await claimPendingRelayDeposit(deposit.accountPublicKey, deposit.id);
      } catch (err) {
        console.error('[EvmBridgeDepositScreen] the pending deposit claim failed', err);
        startedIds.current.delete(deposit.id);
        setStartPhase('idle');
        setRelayStartError({ text: errorMessage(err), id: 'raw_bridge_deposit_submit_failed' });
        return;
      }
      // Another page or mount started this deposit, or the user removed it: nothing starts here.
      if (claimed === null) {
        onExit();
        return;
      }
      const result = await handleConfirm();
      if (result.kind === 'started') {
        setRelayStep('processing');
        return;
      }
      await savePendingRelayDeposit(claimed).catch(err =>
        console.error('[EvmBridgeDepositScreen] the pending deposit could not be saved again', err)
      );
      startedIds.current.delete(deposit.id);
      quoteRequestedFor.current = null;
      setStartPhase('idle');
      setRelayStartError(
        result.kind === 'failed'
          ? result.error
          : { text: t('depositFlowStartFailedBody'), id: 'raw_bridge_deposit_submit_failed' }
      );
    },
    [handleConfirm, onExit, t]
  );

  // Starts the bridge once when the funds are at the address. An Epoch deposit asks for a new quote first and starts
  // only on a quote newer than that request, for an amount the address holds.
  useEffect(() => {
    if (relaySource === undefined || relayStep !== 'address' || pendingDeposit === null) return;
    if (relayStartError !== null || startedIds.current.has(pendingDeposit.id) || relayMode === 'deduct') return;
    if (relayArrival.state !== 'arrived') return;
    if (relayRoute === 'epoch') {
      switch (startPhase) {
        case 'idle':
          // A restored amount settles before its quote, or the quote asks for no amount.
          if (debouncedAmount !== amount.trim()) return;
          // The store can render again inside `requote`, before the phase changes: the ref blocks a second request.
          if (quoteRequestedFor.current === pendingDeposit.id) return;
          quoteRequestedFor.current = pendingDeposit.id;
          quoteAtRequest.current = useEpochStore.getState().quote;
          setStartPhase('quoting');
          if (requote() === undefined) {
            quoteRequestedFor.current = null;
            setStartPhase('idle');
            setRelayStartError({ text: t('depositFlowStartFailedBody'), id: 'raw_bridge_deposit_failed' });
          }
          return;
        case 'quoting':
          if (epochStatus === 'failed') {
            quoteRequestedFor.current = null;
            setStartPhase('idle');
            setRelayStartError({
              text: epochError ?? t('depositFlowStartFailedBody'),
              id: 'raw_bridge_deposit_failed'
            });
            return;
          }
          if (!fastReady || quotedTokenIn === null || epochQuote === quoteAtRequest.current) return;
          if (arrival.balance === null || quotedTokenIn > arrival.balance) {
            // The new quote asks for more than arrived: the address waits for the rest.
            quoteRequestedFor.current = null;
            setRequiredUnits(quotedTokenIn);
            setStartPhase('idle');
            return;
          }
          break;
        case 'starting':
          return;
      }
    } else if (relayRoute === 'usdcx' && usdcxSource?.route === 'cctp-executor') {
      // The burn pulls Circle's fee on top of the amount, and a quote lives about two minutes. The fee is quoted again
      // when the funds arrive, and the burn starts only when the address holds the amount and that fee.
      switch (startPhase) {
        case 'idle': {
          if (quoteRequestedFor.current === pendingDeposit.id) return;
          const id = pendingDeposit.id;
          const source = usdcxSource;
          const quotedAmount = amount.trim();
          quoteRequestedFor.current = id;
          setArrivalFee(null);
          setStartPhase('quoting');
          (async () => {
            if (!isAddress(evmAddress)) throw new Error(`Invalid EVM address: ${evmAddress}`);
            const recipient = usdcxRemoteRecipientFor(midenAccount.publicKey);
            const intent = buildExecutorBurnIntent(quotedAmount, source, recipient, evmAddress);
            return (await quoteExecutorBurn(source, intent)).feeTotalAmount;
          })()
            .then(fee => {
              if (quoteRequestedFor.current === id) setArrivalFee({ id, fee });
            })
            .catch(err => {
              if (quoteRequestedFor.current !== id) return;
              console.warn('[EvmBridgeDepositScreen] the USDCx fee quote at arrival failed', err);
              quoteRequestedFor.current = null;
              setStartPhase('idle');
              setRelayStartError({ text: t('usdcxForwardQuoteUnavailable'), id: 'usdcxForwardQuoteUnavailable' });
            });
          return;
        }
        case 'quoting': {
          if (arrivalFee === null || arrivalFee.id !== pendingDeposit.id || typedUnits === null) return;
          const needed = typedUnits + arrivalFee.fee;
          if (arrival.balance === null || needed > arrival.balance) {
            // The new fee asks for more than arrived: the address waits for the rest.
            quoteRequestedFor.current = null;
            setArrivalFee(null);
            setRequiredUnits(needed);
            setStartPhase('idle');
            return;
          }
          break;
        }
        case 'starting':
          return;
      }
    } else if (startPhase !== 'idle') {
      return;
    }
    if (!canConfirmRoute) return;
    startedIds.current.add(pendingDeposit.id);
    setStartPhase('starting');
    startRelayDeposit(pendingDeposit);
  }, [
    amount,
    arrival.balance,
    arrivalFee,
    canConfirmRoute,
    debouncedAmount,
    epochError,
    epochQuote,
    epochStatus,
    evmAddress,
    fastReady,
    midenAccount.publicKey,
    pendingDeposit,
    quotedTokenIn,
    relayArrival.state,
    relayMode,
    relayRoute,
    relaySource,
    relayStartError,
    relayStep,
    requote,
    startPhase,
    startRelayDeposit,
    t,
    typedUnits,
    usdcxSource
  ]);

  const relayAddressStatus = ((): DepositAddressStatus => {
    const failed = (reason: string, errorId: UserErrorId): DepositAddressStatus => ({
      kind: 'failed',
      title: t('depositFlowStartFailedTitle'),
      reason,
      errorId
    });
    if (relayStartError !== null) return failed(relayStartError.text, relayStartError.id);
    if (startPhase === 'starting') return { kind: 'starting' };
    switch (relayArrival.state) {
      case 'partial':
        return {
          kind: 'partial',
          received: { amount: relayArrival.balance, decimals: pendingDeposit?.token.decimals ?? sourceDecimals }
        };
      case 'arrived':
        // The cap can hold a deposit whose funds arrived (the wallet's holdings moved since the review).
        return capHoldError === undefined ? { kind: 'starting' } : failed(capHoldError.text, capHoldError.id);
      case 'waiting':
      default:
        return { kind: 'waiting' };
    }
  })();

  // A new deposit on the amount step, from the success screen.
  const handleDepositAgain = useCallback(() => {
    confirming.current = false;
    setBridgeTxId(null);
    setPendingDeposit(null);
    setRelayStartError(null);
    setRequiredUnits(null);
    setArrivalFee(null);
    setStartPhase('idle');
    setSlowStatus('idle');
    setSlowError(null);
    resetEpoch();
    setAmount('');
    setSlideResetKey(count => count + 1);
    setConfirmSettled(count => count + 1);
    setRelayStep('amount');
  }, [resetEpoch]);

  // Back, from the header arrow or the hardware back: the step before, as the mock-up's `back` does.
  const handleRelayBack = useCallback(() => {
    switch (relayStep) {
      case 'restoring':
      case 'amount':
        onClose();
        return;
      case 'review':
        setRelayStep('amount');
        return;
      case 'address':
        leaveAddressStep();
        return;
      case 'processing':
        onExit();
        return;
    }
  }, [leaveAddressStep, onClose, onExit, relayStep]);

  useMobileBackHandler(() => {
    if (relay) {
      handleRelayBack();
      return true;
    }
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
  }, [activeRoute?.name, cardStack.length, goBack, handleRelayBack, onClose, relay, usdcxSubmissionPending]);

  const walletLinks = useMemo(
    () =>
      pendingDeposit === null || neededUnits === null
        ? []
        : evmPaymentLinks({
            chainId: pendingDeposit.chainId,
            token: pendingDeposit.token.address,
            to: pendingDeposit.address,
            amountBaseUnits: neededUnits,
            decimals: pendingDeposit.token.decimals
          }),
    [neededUnits, pendingDeposit]
  );

  const relayHeader = ((): React.ReactNode => {
    switch (relayStep) {
      case 'restoring':
      case 'amount':
        return <PageHeader title={t('depositFlowTitle')} onBack={handleRelayBack} />;
      case 'review':
        return <PageHeader title={t('depositFlowReviewTitle')} onClose={handleRelayBack} />;
      case 'address':
        return (
          <PageHeader
            title={
              layout === 'extension'
                ? t('depositFlowDepositTokenTitle', { token: pendingDeposit?.token.symbol ?? tokenLabel })
                : t('depositFlowDetailsTitle')
            }
            onBack={startPhase === 'starting' ? undefined : handleRelayBack}
            onClose={onExit}
          />
        );
      case 'processing':
        // The processing view draws its own header; the success view has none.
        return null;
    }
  })();

  const relayBody = ((): React.ReactNode => {
    switch (relayStep) {
      case 'restoring':
        return (
          <div className="flex justify-center pt-5" data-testid="deposit-restoring">
            <Spinner />
          </div>
        );
      case 'amount':
        return (
          <DepositAmountView
            layout={layout}
            amount={amount}
            onAmountChange={handleAmountChange}
            decimals={relayInputDecimals}
            amountUsd={relayUsd}
            sourceToken={relaySourceToken}
            receivedToken={relayReceivedToken}
            network={relayNetwork}
            onSelectToken={handleOpenTokenDrawer}
            bridgeFee={relayFee}
            bridgeFeeDeducted={!relayFeeOnTop}
            routeName={routeNameOf(relayRoute)}
            routeCount={availableRelayRoutes.length}
            onChangeRoute={() => setRouteSheetOpen(true)}
            // The mock-up states no arrival time for Circle and leaves the row out (`viewAmount`).
            arrivesIn={relayRoute === 'usdcx' ? undefined : arrivesInOf(relayRoute, sourceChainId)}
            received={relayReceived}
            receivedUsd={relayUsd}
            depositCapUsd={capVerdict.state === 'exceeded' ? capVerdict.capUsd : undefined}
            depositCapUnpriced={capVerdict.state === 'unpriced' ? capHoldError?.text : undefined}
            notice={
              relayQuoteError ? (
                <DepositNotice kind="negative" role="alert" data-testid="deposit-quote-failed">
                  {relayQuoteError.text}
                </DepositNotice>
              ) : undefined
            }
            isValidAmount={relayReviewReady}
            onReview={handleRelayReview}
          />
        );
      case 'review':
        return gateEpochWithdrawal(
          <DepositReviewView
            layout={layout}
            received={relayReceived ?? ZERO_AMOUNT}
            receivedUsd={relayUsd}
            receivedToken={relayReceivedToken}
            amount={relaySent ?? ZERO_AMOUNT}
            sourceToken={relaySourceToken}
            network={relayNetwork}
            bridgeFee={relayFee}
            routeName={routeNameOf(relayRoute)}
            arrivesIn={arrivesInOf(relayRoute, sourceChainId)}
            feeShare={relayFeeShare}
            onConfirm={handleRelaySlide}
            confirmDisabled={relaySendUnits === null || !canConfirmRoute}
            confirmResetKey={slideResetKey}
          />
        );
      case 'address':
        return pendingDeposit === null || pendingRoute === null || neededUnits === null ? null : (
          <DepositAddressView
            layout={layout}
            address={getAddress(pendingDeposit.address)}
            qrValue={getAddress(pendingDeposit.address)}
            amount={{ amount: neededUnits, decimals: pendingDeposit.token.decimals }}
            sourceToken={{ symbol: pendingDeposit.token.symbol, logoFaucetId: outputFaucetId }}
            network={relayNetwork}
            received={pendingDepositReceived(pendingDeposit)}
            receivedToken={{ symbol: pendingDeposit.outputSymbol ?? arrivingName, logoFaucetId: outputFaucetId }}
            bridgeFee={pendingDepositFee(pendingDeposit)}
            routeName={routeNameOf(pendingRoute)}
            arrivesIn={arrivesInOf(pendingRoute, pendingDeposit.chainId)}
            status={relayAddressStatus}
            onShowQr={() => setQrSheetOpen(true)}
            onOpenWallet={walletLinks.length > 0 ? () => setWalletSheetOpen(true) : undefined}
            onDepositReceived={handleDepositReceived}
          />
        );
      case 'processing':
        return bridgeTxId === null || pendingDeposit === null || pendingRoute === null ? null : (
          <RelayDepositProgress
            txId={bridgeTxId}
            sent={{
              value: { amount: neededUnits ?? 0n, decimals: pendingDeposit.token.decimals },
              symbol: pendingDeposit.token.symbol,
              rounding: 'exact'
            }}
            received={{
              value: pendingDeposit.outputAmount === undefined ? undefined : { amount: pendingDeposit.outputAmount },
              symbol: pendingDeposit.outputSymbol ?? arrivingName,
              rounding: 'down'
            }}
            networkName={relayNetwork.name}
            routeName={routeNameOf(pendingRoute)}
            bridgeFee={pendingDepositFee(pendingDeposit)}
            feeSymbol={pendingDeposit.token.symbol}
            slow={pendingRoute === 'agglayer'}
            onDone={onExit}
            onDepositAgain={handleDepositAgain}
          />
        );
    }
  })();

  if (relay) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-app-bg text-ink">
        <NetworkModeBanner />
        {relayHeader && <div className="shrink-0 px-4">{relayHeader}</div>}
        <NetworkNamedByShell>
          <div
            className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden"
            data-testid="deposit-relay-flow"
          >
            {relayBody}
          </div>
        </NetworkNamedByShell>
        <DepositTokenSheet
          open={tokenDrawerOpen}
          onOpenChange={setTokenDrawerOpen}
          networks={relaySheetNetworks}
          networkId={relayNetwork.id}
          tokens={relayChoices.map(choice => choice.option)}
          selectedId={relayTokenChoiceId(sourceChainId, token)}
          onSelect={handleRelayTokenPick}
          onConnectWallet={handleConnectAnother}
        />
        <DepositRouteSheet
          open={routeSheetOpen}
          onOpenChange={setRouteSheetOpen}
          routes={relayRouteOptions}
          receivedSymbol={arrivingName}
          feeSymbol={tokenLabel}
          onSelect={id => {
            setRouteSheetOpen(false);
            const picked = availableRelayRoutes.find(candidate => candidate === id);
            if (picked !== undefined) handleRouteChange(picked);
          }}
        />
        {pendingDeposit !== null && (
          <DepositQrSheet open={qrSheetOpen} onOpenChange={setQrSheetOpen} value={getAddress(pendingDeposit.address)} />
        )}
        <OpenWalletSheet
          open={walletSheetOpen}
          onOpenChange={setWalletSheetOpen}
          links={walletLinks}
          onOpenWallet={link => openWalletPayment(link)}
        />
      </div>
    );
  }

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
        ethBalanceValue={ethBalance.value}
        ethLoading={ethBalance.loading}
        ethFaucetId={selectNativeEthFaucet(bridgeConfig, agglayerChainId) ?? undefined}
        circleUsdcBalance={circleOffered ? circleUsdcBalance.formatted : undefined}
        circleUsdcBalanceValue={circleUsdcBalance.value}
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
              value: balance.value,
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
                  value: balance.value,
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
        erc20ListLoading={agglayerChain !== null && holdings.status === 'loading'}
        onSelect={handleTokenSelect}
      />
      <EvmBridgeNetworkDrawer
        open={networkDrawerOpen}
        onOpenChange={setNetworkDrawerOpen}
        networks={sourceNetworks}
        selected={bridgeNetwork}
        onSelect={handleNetworkSelect}
      />
      {relaySource === undefined && (
        <EvmSwitchWalletDrawer
          open={switchDrawerOpen}
          onOpenChange={setSwitchDrawerOpen}
          address={evmAddress}
          ethBalance={ethBalance.formatted}
          ethLoading={ethBalance.loading}
          onConnectAnother={handleConnectAnother}
        />
      )}
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
