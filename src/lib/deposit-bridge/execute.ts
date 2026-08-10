import { EpochIntentSDK } from '@epoch-protocol/epoch-intents-sdk';
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient
} from 'viem';
import { sepolia } from 'viem/chains';

import { AGGLAYER_BRIDGE_ABI, AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID } from 'lib/agglayer/constant';
import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { buildEVMToMidenIntent, getEVMToMidenQuote, type EVMToMidenQuote } from 'lib/epoch/bridge';
import { EPOCH_ALLOCATOR_URL, MIDEN_DESTINATION_CHAIN_ID } from 'lib/epoch/config';
import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';
import { ensureEpochSmartAccount } from 'lib/epoch/sdk';
import type { EVMToMidenIntentParams } from 'lib/epoch/types';
import { initiateBridgedReceiveTransaction, registerPendingBridgeIn } from 'lib/miden/activity';
import { getFaucetIdSetting } from 'lib/miden/assets';
import { updateBridgedReceivePhase } from 'lib/miden/transaction/complete';
import { DEFAULT_CHAIN_ID, getChain } from 'lib/walletconnect/config';
import { waitForSepoliaReceipt } from 'lib/walletconnect/receipt';

import { DEPOSIT_TOKENS, EPOCH_WETH_ADDRESS, ETH_DECIMALS, ETH_SYMBOL, type DepositTokenId } from './tokens';

/**
 * Vault-signed bridge executors for funds sitting on the derived deposit
 * address. Deps-injected free functions (NOT store methods): `useEpochStore` is
 * bound to a WalletConnect session, which this path deliberately has none of.
 *
 * Both executors follow the `gaslessEarnWithdrawalToMiden` discipline: the
 * tracking row is created BEFORE anything irreversible, a failure up to and
 * including the submit marks the row terminal `failed`, and a failure in the
 * POST-submit bookkeeping is swallowed — the funds are already moving, so
 * `reconcileAgglayerBridgedReceives` / the bridge-in registry heal the row
 * instead of falsely failing a live bridge.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// The Epoch "WETH" on Sepolia is a mock ERC-20 with an OPEN mint and NO
// deposit()/payable fallback (verified against the deployed bytecode) — so the
// ETH→WETH step mints rather than wraps, and the ETH itself is not consumed.
const WETH_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

/** Gas ceiling assumed when `estimateGas` reverts (near-empty address). */
const FALLBACK_BRIDGE_GAS = 150_000n;

/** Fee estimate used when the node cannot price a block. ~3 gwei. */
const FALLBACK_MAX_FEE_PER_GAS = 3_000_000_000n;

/** Headroom on the estimated fee so a base-fee bump doesn't strand the tx. */
const GAS_HEADROOM_NUMERATOR = 13n;
const GAS_HEADROOM_DENOMINATOR = 10n;

function isEvmAddress(value: string): value is Address {
  return EVM_ADDRESS_RE.test(value);
}

function asAddress(value: string, label: string): Address {
  if (!isEvmAddress(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value;
}

/** Read an untyped SDK result field without asserting the whole shape. */
function readStringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agglayerContractAddress(): Address {
  const address = AGGLAYER_CONTRACT_ADDRESS.get('sepolia');
  if (!address || !isEvmAddress(address)) throw new Error('The AggLayer bridge contract is not configured.');
  return address;
}

function bridgeAssetArgs(midenAccountPublicKey: string, amount: bigint) {
  return [MIDEN_CHAIN_ID, midenAddrToEvmAddr(midenAccountPublicKey), amount, ZERO_ADDRESS, true, '0x'] as const;
}

/**
 * Epoch SDK bound to the vault-derived EVM account. Built inline rather than via
 * `getEpochSigningSdk` because the deposit intent needs
 * `allowGaslessSmartAccount` — the flag is what lets a bare EOA pay no gas.
 */
function buildDepositEpochSdk(midenAccountPublicKey: string, evmAddress: Address): EpochIntentSDK {
  return new EpochIntentSDK({
    apiBaseUrl: EPOCH_ALLOCATOR_URL,
    walletClient: buildVaultEvmWalletClient(midenAccountPublicKey, evmAddress),
    allowGaslessSmartAccount: true
  });
}

export interface DepositBridgeArgs {
  /** Miden destination account (bech32 public key of the current account). */
  midenAccountPublicKey: string;
  /** The derived deposit address holding the funds. */
  evmAddress: string;
  token: DepositTokenId;
  /** Base-unit amount to bridge. */
  amount: bigint;
  /** Fired once the tracking row exists, BEFORE any signing — lets the caller navigate. */
  onRowCreated?: (txId: string) => void;
}

export interface DepositBridgeResult {
  txId: string;
  evmTxHash?: string;
  intentNonce?: string;
}

export type QuoteDepositArgs = Pick<DepositBridgeArgs, 'midenAccountPublicKey' | 'evmAddress' | 'token' | 'amount'>;

export interface QuoteDepositDeps {
  sdk?: EpochIntentSDK;
  getQuote?: typeof getEVMToMidenQuote;
  /** Native Miden faucet lookup for the ETH (WETH) route. */
  getNativeFaucetId?: typeof getFaucetIdSetting;
}

/** EVM token the Epoch intent spends + the Miden faucet it credits. */
interface EpochTokenInfo {
  evmTokenAddress: string;
  decimals: number;
  midenFaucetId: string;
  symbol: string;
}

/**
 * ETH rides Epoch as WETH and credits the wallet's native Miden faucet — the
 * same asset the AggLayer route delivers, except that route learns the faucet on
 * delivery while the intent must name it up front.
 */
async function resolveEpochTokenInfo(token: DepositTokenId, deps: QuoteDepositDeps): Promise<EpochTokenInfo> {
  if (token === 'USDC') {
    const usdc = DEPOSIT_TOKENS.USDC;
    return { evmTokenAddress: usdc.address ?? '', decimals: usdc.decimals, midenFaucetId: usdc.midenFaucetId, symbol: usdc.symbol };
  }
  const getNativeFaucetId = deps.getNativeFaucetId ?? getFaucetIdSetting;
  const midenFaucetId = await getNativeFaucetId();
  if (!midenFaucetId) {
    throw new Error('The native Miden faucet is not known yet — wait for a sync before fast-bridging ETH.');
  }
  return { evmTokenAddress: EPOCH_WETH_ADDRESS, decimals: ETH_DECIMALS, midenFaucetId, symbol: ETH_SYMBOL };
}

function epochIntentParams(args: QuoteDepositArgs, info: EpochTokenInfo): EVMToMidenIntentParams {
  return {
    sourceChainId: DEFAULT_CHAIN_ID,
    destinationChainId: MIDEN_DESTINATION_CHAIN_ID,
    evmSourceAddress: args.evmAddress,
    evmTokenAddress: info.evmTokenAddress,
    evmAmount: formatUnits(args.amount, info.decimals),
    evmTokenDecimals: info.decimals,
    midenRecipientId: args.midenAccountPublicKey,
    midenFaucetId: info.midenFaucetId,
    minTokenOut: '0'
  };
}

/** Forward quote for a deposit — drives the sheet's fee line. Signs nothing. */
export async function quoteDepositViaEpoch(
  args: QuoteDepositArgs,
  deps: QuoteDepositDeps = {}
): Promise<EVMToMidenQuote> {
  const evmAddress = asAddress(args.evmAddress, 'Deposit address');
  if (args.amount <= 0n) throw new Error('Bridge amount must be greater than zero.');
  const info = await resolveEpochTokenInfo(args.token, deps);
  const sdk = deps.sdk ?? buildDepositEpochSdk(args.midenAccountPublicKey, evmAddress);
  const getQuote = deps.getQuote ?? getEVMToMidenQuote;
  return getQuote(sdk, epochIntentParams(args, info), evmAddress);
}

/** Exactly what the WETH wrap write is given — the unit of injection. */
export interface WrapEthRequest {
  account: Address;
  value: bigint;
}

export interface EpochDepositDeps extends QuoteDepositDeps {
  ensureSmartAccount?: typeof ensureEpochSmartAccount;
  initiateRow?: typeof initiateBridgedReceiveTransaction;
  updatePhase?: typeof updateBridgedReceivePhase;
  registerBridgeIn?: typeof registerPendingBridgeIn;
  buildIntent?: typeof buildEVMToMidenIntent;
  /** ETH route only: WETH balance read that lets a retried bridge skip re-wrapping. */
  readWethBalance?: (account: Address) => Promise<bigint>;
  /** ETH route only: broadcasts the `WETH.deposit()` wrap; defaults to a vault-signed write. */
  sendWrap?: (request: WrapEthRequest) => Promise<Hash>;
  waitForReceipt?: typeof waitForSepoliaReceipt;
}

/** Vault-signed `WETH.mint(account, value)` — the mock's stand-in for wrapping. */
async function sendWrapFromVault(midenAccountPublicKey: string, request: WrapEthRequest): Promise<Hash> {
  const walletClient: WalletClient = buildVaultEvmWalletClient(midenAccountPublicKey, request.account);
  const account = walletClient.account;
  if (!account) throw new Error('The deposit wallet client has no account.');
  return walletClient.writeContract({
    account,
    chain: sepolia,
    address: asAddress(EPOCH_WETH_ADDRESS, 'WETH contract'),
    abi: WETH_ABI,
    functionName: 'mint',
    args: [request.account, request.value]
  });
}

async function readDepositWethBalance(account: Address): Promise<bigint> {
  return depositPublicClient().readContract({
    address: asAddress(EPOCH_WETH_ADDRESS, 'WETH contract'),
    abi: WETH_ABI,
    functionName: 'balanceOf',
    args: [account]
  });
}

/**
 * Bridge a deposit to Miden through Epoch. USDC goes straight into the intent
 * (gasless — the deposit address needs no ETH). ETH takes two Ethereum-side
 * steps: acquire WETH (the mock's open `mint`, self-funded — the deposit ETH
 * pays the gas), then the same gasless intent on the WETH. Only the missing
 * WETH is minted, so a bridge retried after a failed intent doesn't mint twice. The
 * intent submit (`buildEVMToMidenIntent`) is the point of no return; everything
 * after it is bookkeeping that must never fail the row.
 */
export async function bridgeDepositViaEpoch(
  args: DepositBridgeArgs,
  deps: EpochDepositDeps = {}
): Promise<DepositBridgeResult> {
  // --- Validation (throws before any row is created) ---
  const evmAddress = asAddress(args.evmAddress, 'Deposit address');
  if (!args.midenAccountPublicKey) throw new Error('A Miden destination account is required.');
  if (args.amount <= 0n) throw new Error('Bridge amount must be greater than zero.');
  const info = await resolveEpochTokenInfo(args.token, deps);

  const initiateRow = deps.initiateRow ?? initiateBridgedReceiveTransaction;
  const updatePhase = deps.updatePhase ?? updateBridgedReceivePhase;
  const registerBridgeIn = deps.registerBridgeIn ?? registerPendingBridgeIn;
  const sourceAmount = formatUnits(args.amount, info.decimals);

  // --- Tracking row (born Completed; lifecycle lives in extraInputs.phase) ---
  const txId = await initiateRow({
    accountId: args.midenAccountPublicKey,
    amount: args.amount,
    faucetId: info.midenFaucetId,
    provider: 'epoch',
    sourceAddress: evmAddress,
    sourceAmount,
    sourceSymbol: info.symbol,
    outputAmount: sourceAmount,
    outputSymbol: info.symbol
  });
  args.onRowCreated?.(txId);

  // --- Pre-submit + submit (reversible until the intent carries a nonce) ---
  let nonce: string | undefined;
  let evmTxHash: string | undefined;
  try {
    if (args.token === 'ETH') {
      // Mint only the shortfall: WETH left over from an earlier failed attempt
      // is still on the address and must be spent, not minted on top of.
      const readWethBalance = deps.readWethBalance ?? readDepositWethBalance;
      const wethBalance = await readWethBalance(evmAddress);
      if (wethBalance < args.amount) {
        const sendWrap = deps.sendWrap ?? (req => sendWrapFromVault(args.midenAccountPublicKey, req));
        const waitForReceipt = deps.waitForReceipt ?? waitForSepoliaReceipt;
        const wrapHash = await sendWrap({ account: evmAddress, value: args.amount - wethBalance });
        await waitForReceipt(wrapHash);
      }
    }
    const ensureSmartAccount = deps.ensureSmartAccount ?? ensureEpochSmartAccount;
    await ensureSmartAccount(args.midenAccountPublicKey, evmAddress);
    const sdk = deps.sdk ?? buildDepositEpochSdk(args.midenAccountPublicKey, evmAddress);
    const params = epochIntentParams(args, info);
    const quote = await quoteDepositViaEpoch(args, { sdk, getQuote: deps.getQuote, getNativeFaucetId: deps.getNativeFaucetId });
    const buildIntent = deps.buildIntent ?? buildEVMToMidenIntent;
    // Point of no return: a resolved intent means the Compact deposit is signed
    // and the solver is committed — it must not be re-run.
    const intent = await buildIntent(sdk, { ...params, preFetchedQuote: quote });
    if (intent.error) throw new Error(intent.error);
    nonce = intent.intentNonce ?? readStringField(intent.solveResult, 'nonce');
    evmTxHash =
      readStringField(Reflect.get(intent.solveResult ?? {}, 'depositResult'), 'transactionHash') ??
      readStringField(intent.solveResult, 'hash');
    if (!nonce) throw new Error('The deposit intent was submitted without a trackable nonce.');
  } catch (error) {
    await updatePhase(txId, 'failed', { error: errorMessage(error) }).catch((err: unknown) =>
      console.warn('[deposit-bridge] failed-phase patch failed', err)
    );
    throw error;
  }

  // --- Post-submit bookkeeping (intent in flight — DO NOT mark failed) ---
  // Written independently, registry FIRST: it is the durable proof-of-submit the
  // auto-consume path matches the delivered note against, and it survives a
  // failed row patch. Losing either one alone still leaves the row recoverable.
  try {
    await registerBridgeIn(evmAddress, nonce, {
      provider: 'epoch',
      sourceAmount,
      sourceSymbol: info.symbol,
      intentNonce: nonce,
      evmTxHash,
      bridgeReceiveTxId: txId
    });
  } catch (registrationError) {
    console.warn('[deposit-bridge] bridge-in registration failed; row phase will still track it', registrationError);
  }
  try {
    await updatePhase(txId, 'delivering', { intentNonce: nonce, evmTxHash });
  } catch (phaseError) {
    console.warn('[deposit-bridge] delivering-phase patch failed; registry + reconcile recover', phaseError);
  }

  return { txId, evmTxHash, intentNonce: nonce };
}

/** Exactly what the AggLayer bridge write is given — the unit of injection. */
export interface BridgeAssetRequest {
  account: Address;
  address: Address;
  args: ReturnType<typeof bridgeAssetArgs>;
  value: bigint;
}

export interface AgglayerDepositDeps {
  /** Broadcaster; defaults to a vault-signed viem `writeContract`. */
  sendBridgeAsset?: (request: BridgeAssetRequest) => Promise<Hash>;
  initiateRow?: typeof initiateBridgedReceiveTransaction;
  updatePhase?: typeof updateBridgedReceivePhase;
  waitForReceipt?: typeof waitForSepoliaReceipt;
}

/**
 * Default broadcaster: payable `bridgeAsset` signed by the vault-derived EVM
 * account. The viem write lives here rather than in `lib/agglayer/contract.ts` —
 * that module's ethers `bridgeAgglayer` is the WalletConnect path and stays
 * untouched; this is its only vault-signed consumer.
 */
async function sendBridgeAssetFromVault(
  midenAccountPublicKey: string,
  request: BridgeAssetRequest
): Promise<Hash> {
  const walletClient: WalletClient = buildVaultEvmWalletClient(midenAccountPublicKey, request.account);
  const account = walletClient.account;
  if (!account) throw new Error('The deposit wallet client has no account.');
  return walletClient.writeContract({
    account,
    chain: sepolia,
    address: request.address,
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'bridgeAsset',
    args: request.args,
    value: request.value
  });
}

/**
 * Bridge deposited ETH to Miden through AggLayer, self-funded: the deposit ETH
 * pays its own gas, so the caller must size `amount` with `maxSendableDeposit`.
 */
export async function bridgeDepositViaAgglayer(
  args: DepositBridgeArgs,
  deps: AgglayerDepositDeps = {}
): Promise<DepositBridgeResult> {
  if (args.token !== 'ETH') throw new Error('The AggLayer route only bridges native ETH deposits.');
  const evmAddress = asAddress(args.evmAddress, 'Deposit address');
  if (!args.midenAccountPublicKey) throw new Error('A Miden destination account is required.');
  if (args.amount <= 0n) throw new Error('Bridge amount must be greater than zero.');

  const eth = DEPOSIT_TOKENS.ETH;
  const initiateRow = deps.initiateRow ?? initiateBridgedReceiveTransaction;
  const updatePhase = deps.updatePhase ?? updateBridgedReceivePhase;
  const waitForReceipt = deps.waitForReceipt ?? waitForSepoliaReceipt;
  const sourceAmount = formatUnits(args.amount, eth.decimals);

  const txId = await initiateRow({
    accountId: args.midenAccountPublicKey,
    amount: args.amount,
    // Native faucet id is unknown until the note is delivered (matches the WC path).
    faucetId: eth.midenFaucetId,
    provider: 'agglayer',
    sourceAddress: evmAddress,
    sourceAmount,
    sourceSymbol: eth.symbol,
    outputAmount: sourceAmount,
    outputSymbol: eth.symbol
  });
  args.onRowCreated?.(txId);

  let hash: Hash;
  try {
    // Payable: the bridged ETH rides as msg.value.
    const request: BridgeAssetRequest = {
      account: evmAddress,
      address: agglayerContractAddress(),
      args: bridgeAssetArgs(args.midenAccountPublicKey, args.amount),
      value: args.amount
    };
    const send = deps.sendBridgeAsset ?? (req => sendBridgeAssetFromVault(args.midenAccountPublicKey, req));
    hash = await send(request);
  } catch (error) {
    await updatePhase(txId, 'failed', { error: errorMessage(error) }).catch((err: unknown) =>
      console.warn('[deposit-bridge] failed-phase patch failed', err)
    );
    throw error;
  }

  // --- Post-submit (broadcast — DO NOT mark failed) ---
  // The ETH has left the address; a reverted or slow receipt is
  // `reconcileAgglayerBridgedReceives`'s call to make, and it re-derives
  // everything from the persisted `evmTxHash`.
  try {
    await updatePhase(txId, 'submitting', { evmTxHash: hash });
    await waitForReceipt(hash);
    await updatePhase(txId, 'delivering', { evmTxHash: hash });
  } catch (error) {
    console.warn('[deposit-bridge] agglayer post-submit tracking failed; reconcile will heal the row', error);
  }

  return { txId, evmTxHash: hash };
}

export interface MaxSendableArgs {
  token: DepositTokenId;
  /** Current deposit-address balance in base units. */
  balance: bigint;
  evmAddress: string;
  midenAccountPublicKey: string;
}

/** The two chain reads the gas reserve needs — the unit of injection. */
export interface DepositFeeProbe {
  estimateGas(args: { account: Address; to: Address; value: bigint; data: `0x${string}` }): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint }>;
}

export interface GasReserveDeps {
  probe?: DepositFeeProbe;
}

function depositPublicClient(): PublicClient {
  const rpcUrl = getChain(DEFAULT_CHAIN_ID)?.rpcUrl;
  if (!rpcUrl) throw new Error('Sepolia RPC is not configured');
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
}

function defaultFeeProbe(): DepositFeeProbe {
  const client = depositPublicClient();
  return {
    estimateGas: params => client.estimateGas(params),
    estimateFeesPerGas: async () => {
      const fees = await client.estimateFeesPerGas();
      return { maxFeePerGas: fees.maxFeePerGas };
    }
  };
}

/**
 * ETH the AggLayer bridge tx will cost, with headroom. Probed at HALF the
 * balance so the estimate itself doesn't revert for insufficient funds; a revert
 * anyway (near-empty address) falls back to a fixed gas ceiling rather than
 * blocking the flow. The same reserve also covers the Epoch route's only
 * self-funded step — the WETH mint — which costs less gas than `bridgeAsset`,
 * so one route-agnostic reserve serves the amount step.
 */
export async function estimateDepositGasReserve(args: MaxSendableArgs, deps: GasReserveDeps = {}): Promise<bigint> {
  if (args.token !== 'ETH') return 0n;
  const evmAddress = asAddress(args.evmAddress, 'Deposit address');
  const probe = deps.probe ?? defaultFeeProbe();
  const data = encodeFunctionData({
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'bridgeAsset',
    args: bridgeAssetArgs(args.midenAccountPublicKey, args.balance / 2n)
  });

  let gas = FALLBACK_BRIDGE_GAS;
  try {
    gas = await probe.estimateGas({
      account: evmAddress,
      to: agglayerContractAddress(),
      value: args.balance / 2n,
      data
    });
  } catch (err) {
    console.warn('[deposit-bridge] bridge gas estimate reverted; using the fixed ceiling', err);
  }

  let maxFeePerGas = FALLBACK_MAX_FEE_PER_GAS;
  try {
    const fees = await probe.estimateFeesPerGas();
    if (fees.maxFeePerGas > 0n) maxFeePerGas = fees.maxFeePerGas;
  } catch (err) {
    console.warn('[deposit-bridge] fee estimate failed; using the fixed gas price', err);
  }

  return (gas * maxFeePerGas * GAS_HEADROOM_NUMERATOR) / GAS_HEADROOM_DENOMINATOR;
}

/**
 * Largest bridgeable amount. USDC is gasless, so the whole balance goes; ETH is
 * self-funded, so the gas reserve comes off the top. `0n` means the address
 * cannot cover its own network fee — the sheet must disable Confirm.
 */
export async function maxSendableDeposit(args: MaxSendableArgs, deps: GasReserveDeps = {}): Promise<bigint> {
  if (args.balance <= 0n) return 0n;
  if (args.token !== 'ETH') return args.balance;
  const reserve = await estimateDepositGasReserve(args, deps);
  return args.balance > reserve ? args.balance - reserve : 0n;
}
