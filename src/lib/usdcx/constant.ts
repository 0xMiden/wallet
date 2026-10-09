import type { Address, Chain, Hex } from 'viem';
import { arbitrum, arbitrumSepolia, arc, base, baseSepolia, mainnet, sepolia } from 'viem/chains';

import { ARC_TESTNET } from 'lib/walletconnect/config';

// E2E-only: the bridge-in harness runs the deposit on a local Anvil fork of Sepolia. Arc's USDC calls
// chain precompiles that Anvil does not have, so an Arc fork reverts every transfer; Sepolia's USDC
// is a plain ERC-20 and its xReserve is the same contract at the same address. Inert in production:
// the flag is baked in only by the e2e build, and only when `MIDEN_E2E_TEST` is also on.
const E2E_USDCX_CHAIN = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.MIDEN_E2E_USDCX_CHAIN ?? '').trim() : '';

/** Circle's direct-deposit contracts, keyed by EVM chain id (not Circle domain). */
export const XRESERVE_ADDRESS = new Map<number, Address>([
  [ARC_TESTNET.id, '0x008888878f94C0d87defdf0B07f46B93C1934442'],
  [sepolia.id, '0x008888878f94C0d87defdf0B07f46B93C1934442'],
  [mainnet.id, '0x8888888199b2Df864bf678259607d6D5EBb4e3Ce'],
  [arc.id, '0x8888888199b2Df864bf678259607d6D5EBb4e3Ce']
]);

/** Native Circle USDC via its 6-decimal ERC-20 interface, including on Arc. */
export const CIRCLE_USDC_ADDRESS = new Map<number, Address>([
  [ARC_TESTNET.id, '0x3600000000000000000000000000000000000000'],
  [sepolia.id, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],
  [mainnet.id, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  [arc.id, '0x3600000000000000000000000000000000000000'],
  [arbitrum.id, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
  [arbitrumSepolia.id, '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'],
  [base.id, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
  [baseSepolia.id, '0x036CbD53842c5426634e7929541eC2318f3dCF7e']
]);

/** Public CCTP fee-collecting entry points. Arc mainnet deployment is not confirmed. */
export const TOKEN_MESSENGER_WITH_FEES_ADDRESS = new Map<number, Address>([
  [mainnet.id, '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408'],
  [arbitrum.id, '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408'],
  [base.id, '0x71f54F818671cD0D7ea140Da213e5C8b5C92a408'],
  [sepolia.id, '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'],
  [arbitrumSepolia.id, '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'],
  [baseSepolia.id, '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A'],
  [ARC_TESTNET.id, '0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A']
]);

/** EVM chain id → Circle domain; these are separate namespaces. */
export const CIRCLE_DOMAIN = new Map<number, number>([
  [mainnet.id, 0],
  [sepolia.id, 0],
  [arbitrum.id, 3],
  [arbitrumSepolia.id, 3],
  [base.id, 6],
  [baseSepolia.id, 6],
  [arc.id, 26],
  [ARC_TESTNET.id, 26]
]);

export const XRESERVE_ATTESTATION_API_TESTNET = 'https://xreserve-api-testnet.circle.com';
export const XRESERVE_ATTESTATION_API_MAINNET = 'https://xreserve-api.circle.com';
/** Circle's testnet attestation service also serves deposits on Arc Testnet. */
export const XRESERVE_ATTESTATION_API = XRESERVE_ATTESTATION_API_TESTNET;

/** Circle's Iris API: CCTP V2 messages, attestations and fee quotes. */
export const IRIS_API_TESTNET = 'https://iris-api-sandbox.circle.com';
export const IRIS_API_MAINNET = 'https://iris-api.circle.com';

/** CCTP V2 `TokenMessengerV2`, the same address on every V2 EVM chain, testnet and mainnet. */
export const TOKEN_MESSENGER_V2_ADDRESS: Address = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';

/**
 * Circle's Generic Executor and its DepositFor handler on Arc, keyed by Arc chain id. The testnet pair is
 * verified on the Arc Testnet explorer (`GenericExecutor` and `DepositForHandler` behind ERC1967 proxies,
 * the handler bound to the executor); the mainnet pair comes from Circle's partner document only.
 */
export const CCTP_EXECUTOR_ADDRESS = new Map<number, { executor: Address; handler: Address }>([
  [
    ARC_TESTNET.id,
    { executor: '0xEdC81040756AcCfF070c21D37b265b9D0b5Ba45e', handler: '0xD05E7D2E7d30b92c5F17d7d0fC575fce231F1A48' }
  ],
  [
    arc.id,
    { executor: '0xFa7be2f04F3Ad4ca969260729c6d45B5625984A7', handler: '0x16529813203f77e036576666336554a1210dce4d' }
  ]
]);

/** The 24-byte hook name the Generic Executor looks for in composable hook data (`circle-generic-executor`). */
export const CCTP_EXECUTOR_HOOK_NAME = 'circle-generic-executor';
/** The one composable hook-data version the executor accepts. */
export const CCTP_HOOK_VERSION = 1;
/** The executor payload version `GenericExecutor._decodeAndValidatePayload` accepts. */
export const CCTP_EXECUTOR_PAYLOAD_VERSION = 1;
/** A standard CCTP V2 transfer, which Circle prices at no protocol fee on the routes the wallet uses. */
export const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;

/** What every source chain shares: the USDC burned or deposited there, and Circle's domain of the chain. */
interface UsdcxSourceChainBase {
  chain: Chain;
  usdc: Address;
  /** Circle's domain of the source chain. */
  domain: number;
}

/** A source with a local xReserve: the deposit is one `depositToRemote` on the source chain. */
export interface UsdcxXReserveSource extends UsdcxSourceChainBase {
  route: 'xreserve';
  xReserve: Address;
  /** The attestation service that signs deposits made on this chain. */
  attestationApi: string;
}

/**
 * The Arc side of an executor route: the CCTP message mints to Circle's Generic Executor on Arc, whose
 * DepositFor handler deposits into Arc's xReserve for Miden. The attestation for the xReserve deposit is
 * keyed by the Arc transaction that executed the message.
 */
export interface UsdcxExecutorTarget {
  chain: Chain;
  domain: number;
  executor: Address;
  handler: Address;
  xReserve: Address;
  usdc: Address;
  attestationApi: string;
  irisApi: string;
}

/**
 * A source with CCTP only (Base, Arbitrum): the deposit is a CCTP burn to the executor on Arc carrying the
 * xReserve deposit as hook data. Circle's forwarder does not execute such messages yet, so the wallet asks
 * the connected EVM wallet to execute the attested message on Arc itself.
 */
export interface UsdcxExecutorSource extends UsdcxSourceChainBase {
  route: 'cctp-executor';
  tokenMessenger: Address;
  /** Circle's Iris API for this network family, which attests the CCTP leg. */
  irisApi: string;
  target: UsdcxExecutorTarget;
}

/** A chain a USDCx bridge-in can start from, on one of the two routes. */
export type UsdcxSourceChain = UsdcxXReserveSource | UsdcxExecutorSource;

/** A chain a USDCx burn can pay out to: a direct-payout domain of Circle's withdrawal API. */
export interface UsdcxDestination {
  chain: Chain;
  /** The domain word of the burn note's withdrawal attachment. */
  domain: number;
  /** The USDC the recipient's balance is read from, in six-decimal units. */
  usdc: Address;
}

function sourceChain(chain: Chain): [number, UsdcxSourceChain] {
  const xReserve = XRESERVE_ADDRESS.get(chain.id);
  const usdc = CIRCLE_USDC_ADDRESS.get(chain.id);
  const domain = CIRCLE_DOMAIN.get(chain.id);
  if (!xReserve || !usdc || domain === undefined) {
    throw new Error(`USDCx source chain ${chain.id} is missing a contract or a domain`);
  }
  const attestationApi = chain.testnet ? XRESERVE_ATTESTATION_API_TESTNET : XRESERVE_ATTESTATION_API_MAINNET;
  return [chain.id, { route: 'xreserve', chain, xReserve, usdc, domain, attestationApi }];
}

function executorTarget(chain: Chain): UsdcxExecutorTarget {
  const addresses = CCTP_EXECUTOR_ADDRESS.get(chain.id);
  const xReserve = XRESERVE_ADDRESS.get(chain.id);
  const usdc = CIRCLE_USDC_ADDRESS.get(chain.id);
  const domain = CIRCLE_DOMAIN.get(chain.id);
  if (!addresses || !xReserve || !usdc || domain === undefined) {
    throw new Error(`USDCx executor target ${chain.id} is missing a contract or a domain`);
  }
  const testnet = chain.testnet ?? false;
  return {
    chain,
    domain,
    executor: addresses.executor,
    handler: addresses.handler,
    xReserve,
    usdc,
    attestationApi: testnet ? XRESERVE_ATTESTATION_API_TESTNET : XRESERVE_ATTESTATION_API_MAINNET,
    irisApi: testnet ? IRIS_API_TESTNET : IRIS_API_MAINNET
  };
}

function executorSource(chain: Chain, target: UsdcxExecutorTarget): [number, UsdcxSourceChain] {
  const usdc = CIRCLE_USDC_ADDRESS.get(chain.id);
  const domain = CIRCLE_DOMAIN.get(chain.id);
  if (!usdc || domain === undefined) {
    throw new Error(`USDCx source chain ${chain.id} is missing a USDC address or a domain`);
  }
  if ((chain.testnet ?? false) !== (target.chain.testnet ?? false)) {
    throw new Error(`USDCx source chain ${chain.id} and its executor target are on different network families`);
  }
  return [
    chain.id,
    {
      route: 'cctp-executor',
      chain,
      usdc,
      domain,
      tokenMessenger: TOKEN_MESSENGER_V2_ADDRESS,
      irisApi: chain.testnet ? IRIS_API_TESTNET : IRIS_API_MAINNET,
      target
    }
  ];
}

const ARC_TESTNET_EXECUTOR = executorTarget(ARC_TESTNET);
const ARC_EXECUTOR = executorTarget(arc);

function destination(chain: Chain): [number, UsdcxDestination] {
  const domain = CIRCLE_DOMAIN.get(chain.id);
  const usdc = CIRCLE_USDC_ADDRESS.get(chain.id);
  if (domain === undefined || !usdc) {
    throw new Error(`USDCx destination ${chain.id} is missing a domain or a USDC address`);
  }
  return [chain.id, { chain, domain, usdc }];
}

/**
 * Every chain a bridge-in can start from, keyed by EVM chain id. Testnet entries first. Chains with a local
 * xReserve deposit directly; Base and Arbitrum reach Arc's xReserve through Circle's executor.
 */
export const USDCX_SOURCE_CHAINS: ReadonlyMap<number, UsdcxSourceChain> = new Map([
  sourceChain(ARC_TESTNET),
  sourceChain(sepolia),
  executorSource(baseSepolia, ARC_TESTNET_EXECUTOR),
  executorSource(arbitrumSepolia, ARC_TESTNET_EXECUTOR),
  sourceChain(arc),
  sourceChain(mainnet),
  executorSource(base, ARC_EXECUTOR),
  executorSource(arbitrum, ARC_EXECUTOR)
]);

/**
 * Every chain a burn can pay out to, keyed by EVM chain id. All are direct-payout domains, so the
 * attester needs no forwarding. Testnet entries first; the wallet offers the ones whose
 * `chain.testnet` matches the effective network.
 */
export const USDCX_DESTINATIONS: ReadonlyMap<number, UsdcxDestination> = new Map([
  destination(ARC_TESTNET),
  destination(sepolia),
  destination(arbitrumSepolia),
  destination(baseSepolia),
  destination(arc),
  destination(mainnet),
  destination(arbitrum),
  destination(base)
]);

/** The source chain a bridge-in starts from until the screen offers a picker. */
export const DEFAULT_USDCX_SOURCE_CHAIN_ID: number = E2E_USDCX_CHAIN === 'sepolia' ? sepolia.id : ARC_TESTNET.id;
/** The destination pre-selected for a USDCx withdrawal. */
export const DEFAULT_USDCX_DESTINATION_CHAIN_ID: number = ARC_TESTNET.id;

export function getUsdcxSourceChain(chainId: number): UsdcxSourceChain {
  const source = USDCX_SOURCE_CHAINS.get(chainId);
  if (!source) throw new Error(`USDCx bridge-in is not configured for chain ${chainId}`);
  return source;
}

/** The source entry of a chain with a local xReserve; throws for an executor source or an unknown chain. */
export function getUsdcxXReserveSource(chainId: number): UsdcxXReserveSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'xreserve') throw new Error(`USDCx chain ${chainId} has no local xReserve`);
  return source;
}

/** The source entry of a chain that reaches Arc's xReserve through the executor; throws otherwise. */
export function getUsdcxExecutorSource(chainId: number): UsdcxExecutorSource {
  const source = getUsdcxSourceChain(chainId);
  if (source.route !== 'cctp-executor') throw new Error(`USDCx chain ${chainId} is not an executor source`);
  return source;
}

/** Whether `chainId` deposits through Circle's executor on Arc. Unknown chains read as false. */
export function isUsdcxExecutorSource(chainId: number | undefined): boolean {
  return chainId !== undefined && USDCX_SOURCE_CHAINS.get(chainId)?.route === 'cctp-executor';
}

export function getUsdcxDestination(chainId: number): UsdcxDestination {
  const entry = USDCX_DESTINATIONS.get(chainId);
  if (!entry) throw new Error(`USDCx withdrawal is not configured for chain ${chainId}`);
  return entry;
}

/** The source chains offered on one network family: testnet chains on testnet, mainnet chains otherwise. */
export function listUsdcxSourceChains(testnet: boolean): UsdcxSourceChain[] {
  return [...USDCX_SOURCE_CHAINS.values()].filter(entry => (entry.chain.testnet ?? false) === testnet);
}

/** The destinations offered on one network family: testnet chains on testnet, mainnet chains otherwise. */
export function listUsdcxDestinations(testnet: boolean): UsdcxDestination[] {
  return [...USDCX_DESTINATIONS.values()].filter(entry => (entry.chain.testnet ?? false) === testnet);
}

/** Direct deposits only: Arbitrum/Base use CCTP and have no local xReserve. */
export function getUsdcxContracts(chainId: number): { xReserve: Address; usdc: Address } {
  const xReserve = XRESERVE_ADDRESS.get(chainId);
  const usdc = CIRCLE_USDC_ADDRESS.get(chainId);
  if (!xReserve || !usdc) throw new Error(`USDCx contracts are not configured for chain ${chainId}`);
  return { xReserve, usdc };
}
export const CIRCLE_USDC_DECIMALS = 6;
export const CIRCLE_USDC_SYMBOL = 'USDC';

/**
 * Circle's remote-domain id for Miden. Circle assigned 10007 for testnet and
 * mainnet. A deposit to an unregistered domain reverts with `RemoteDomainNotRegistered`.
 */
export const USDCX_MIDEN_REMOTE_DOMAIN = 10007;

/** Deposits target Miden and the connected Miden account. */
export const USDCX_REMOTE_DOMAIN = USDCX_MIDEN_REMOTE_DOMAIN;

// The USDCx faucet is the chain's native asset: read its id through `requireUsdcxFaucetId` (`./withdrawal`).
export const USDCX_SYMBOL = 'USDCx';
export const USDCX_DECIMALS = 6;

/**
 * The stock burn script root of the Miden 0.17.1 standards, which the USDCx faucet allow-lists;
 * checked against the running SDK before sending, so an SDK on another protocol line sends nothing.
 */
export const USDCX_BURN_SCRIPT_ROOT = '0x3d951250cb118282a37b8ee9395f3e3b3c30fab4dbe8c6b0093acfeed3ba04af';
export const USDCX_BURN_TAG = 0x4255524e;
/** The withdrawal attachment's scheme: `StandardNoteAttachment::UsdcxBurn` in the 0.17.1 standards. */
export const USDCX_BURN_WITHDRAWAL_ATTACHMENT_SCHEME = 5;
export const USDCX_MIN_BURN_SLOT = 'miden::standards::faucets::policies::burn::min_burn_amount::min_burn_amount';

/** The fee ceiling passed to `depositToRemote`. Circle's fee for Miden is not confirmed yet. */
export const USDCX_DEPOSIT_MAX_FEE = 0n;
/** Circle confirmed that empty hook data is accepted for Miden. */
export const USDCX_DEPOSIT_HOOK_DATA: Hex = '0x';

/**
 * The parts of the xReserve ABI the wallet calls. Source: Circle's
 * `evm-xreserve-contracts` at a571cbe, `src/modules/x-reserve/*.sol`.
 */
export const XRESERVE_ABI = [
  {
    type: 'function',
    name: 'depositToRemote',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'value', type: 'uint256' },
      { name: 'remoteDomain', type: 'uint32' },
      { name: 'remoteRecipient', type: 'bytes32' },
      { name: 'localToken', type: 'address' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'hookData', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'isRemoteDomainRegistered',
    stateMutability: 'view',
    inputs: [{ name: 'remoteDomain', type: 'uint32' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'error',
    name: 'RemoteDomainNotRegistered',
    inputs: [{ name: 'remoteDomain', type: 'uint32' }]
  }
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
] as const;

export const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

export const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

/**
 * The CCTP V2 `TokenMessengerV2` entry point the executor route burns through: a standard transfer whose
 * mint recipient and destination caller are both the executor, with the xReserve deposit as hook data.
 */
export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' }
    ],
    outputs: []
  }
] as const;

/**
 * Circle's Generic Executor on Arc (`GenericExecutor.execute`): receives the attested CCTP message, which
 * mints to the executor, then hands the minted USDC to the handler named in the executor hook. Anyone may
 * call it, so the wallet does when Circle's forwarder does not.
 */
export const GENERIC_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'payload', type: 'bytes' },
      { name: 'proof', type: 'bytes' }
    ],
    outputs: []
  },
  {
    type: 'event',
    name: 'Executed',
    inputs: [
      { name: 'transport', type: 'bytes4', indexed: true },
      { name: 'version', type: 'uint8', indexed: false },
      { name: 'handler', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'bytes32', indexed: false }
    ]
  }
] as const;
