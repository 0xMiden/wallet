import type { Address, Chain, Hex } from 'viem';
import { arbitrum, arbitrumSepolia, arc, base, baseSepolia, mainnet, sepolia } from 'viem/chains';

import { ARC_TESTNET } from 'lib/walletconnect/config';

// E2E-only: the bridge-in harness runs the deposit on a local Anvil fork of Sepolia. Arc's USDC calls
// chain precompiles that Anvil does not have, so an Arc fork reverts every transfer; Sepolia's USDC
// is a plain ERC-20 and its xReserve is the same contract at the same address. Inert in production:
// the flag is baked in only by the e2e build, and only when `MIDEN_E2E_TEST` is also on.
const E2E_USDCX_CHAIN = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.MIDEN_E2E_USDCX_CHAIN ?? '').trim() : '';

/** USDCx uses Arc Testnet; ERC-20 USDC has 6 decimals, unlike native gas USDC (18). */
export const USDCX_CHAIN: Chain = E2E_USDCX_CHAIN === 'sepolia' ? sepolia : ARC_TESTNET;
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

/** Arc deposits target Miden and the connected Miden account. */
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
/** Circle domains are not EVM chain ids or Miden remote-domain ids. */
export const USDCX_WITHDRAWAL_DESTINATION = { chainId: USDCX_CHAIN.id, domain: 26 };

/** The fee ceiling passed to `depositToRemote`. Circle's fee for Miden is not confirmed yet. */
export const USDCX_DEPOSIT_MAX_FEE = 0n;
/** Circle confirmed that empty hook data is accepted for Miden. */
export const USDCX_DEPOSIT_HOOK_DATA: Hex = '0x';

export const XRESERVE_ATTESTATION_API_TESTNET = 'https://xreserve-api-testnet.circle.com';
export const XRESERVE_ATTESTATION_API_MAINNET = 'https://xreserve-api.circle.com';
/** Circle's testnet attestation service also serves deposits on Arc Testnet. */
export const XRESERVE_ATTESTATION_API = XRESERVE_ATTESTATION_API_TESTNET;

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

export const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;
