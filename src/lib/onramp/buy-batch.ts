import { Address as MidenAddress } from '@miden-sdk/miden-sdk/lazy';
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
  type TypedData
} from 'viem';

import { getOnramp } from 'lib/remote-config/values';

/**
 * The Calibur signed batch for a fiat buy: approve the Agglayer bridge, then bridge the token to the Miden account.
 *
 * This is a byte-identical twin of `backend/src/chain-testnet/calibur.ts` (the batch) and
 * `backend/src/chain-testnet/agglayer.ts` (its calls). The two packages do not share code. If you change the
 * batch, the types or the domain, change the twin at the same time, else the backend refuses every signature.
 * The golden digest in `buy-batch.test.ts` and in the backend test must stay equal.
 *
 * The chain and the Calibur contract (its address, EIP-712 domain and batch TTL) come from the bridge config's
 * `onramp` section (`getOnramp`), never from the API: the backend only echoes them, and the signers refuse an
 * order that names others.
 */

/** The Calibur nonce key of the on-ramp. The batch nonce is `key << 64 | sequence`. */
export const ONRAMP_NONCE_KEY = BigInt(keccak256(stringToHex('miden.onramp'))) >> 64n;
/** The Calibur nonce key of the off-ramp. Its own key, so a sell and a buy of one address never share a sequence. */
export const OFFRAMP_NONCE_KEY = BigInt(keccak256(stringToHex('miden.offramp'))) >> 64n;

// The Agglayer bridge on Sepolia and the Agglayer network ID of Miden testnet (not an EVM chain ID).
export const AGGLAYER_BRIDGE_ADDRESS: Address = '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582';
export const MIDEN_AGGLAYER_NETWORK_ID = 73;

export const CALIBUR_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)'
]);

export const BRIDGE_ASSET_ABI = parseAbi([
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) payable'
]);

const batchTypes = {
  SignedBatchedCall: [
    { name: 'batchedCall', type: 'BatchedCall' },
    { name: 'nonce', type: 'uint256' },
    { name: 'keyHash', type: 'bytes32' },
    { name: 'executor', type: 'address' },
    { name: 'deadline', type: 'uint256' }
  ],
  BatchedCall: [
    { name: 'calls', type: 'Call[]' },
    { name: 'revertOnFailure', type: 'bool' }
  ],
  Call: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' }
  ]
} satisfies TypedData;

export const MIDEN_ACCOUNT_HEX_PATTERN = /^0x[0-9a-fA-F]{30}$/;

/**
 * The EIP-712 domain of a batch: the config's Calibur domain on the on-ramp chain, verified by the account itself.
 * The salt is the one the account's `eip712Domain()` reports; the signers check that it names the config's Calibur.
 */
function caliburDomain(evmAddress: Address, salt: Hex) {
  const { chainId, calibur } = getOnramp();
  return { name: calibur.domainName, version: calibur.domainVersion, chainId, verifyingContract: evmAddress, salt };
}

/**
 * The hex account ID (lower case, `0x` + 30 hex) of a bech32 Miden address. The backend challenge and the batch
 * recipient use this form. It is the same conversion as `midenAddrToEvmAddr` in `lib/agglayer/contract.ts`.
 */
export function midenAccountIdToHex(bech32: string): string {
  const hex = MidenAddress.fromBech32(bech32).accountId().toString().toLowerCase();
  const prefixed = hex.startsWith('0x') ? hex : `0x${hex}`;
  if (!MIDEN_ACCOUNT_HEX_PATTERN.test(prefixed)) {
    throw new Error('Miden account ID is not 15 bytes');
  }
  return prefixed;
}

/**
 * The Agglayer destination address of a Miden account:
 * 4 zero bytes, the 15-byte account ID, 1 zero byte. Lower case.
 */
export function midenAccountHexToEvmAddress(midenAccountHex: string): Address {
  if (!MIDEN_ACCOUNT_HEX_PATTERN.test(midenAccountHex)) {
    throw new Error('midenAccountHex is not a 15-byte hex account ID');
  }
  return `0x${'00'.repeat(4)}${midenAccountHex.slice(2).toLowerCase()}00`;
}

export interface BuyBatchInput {
  /** The EOA that delegates to Calibur. It is the verifying contract of the domain. */
  evmAddress: Address;
  midenAccountHex: string;
  token: Address;
  /** Token base units. */
  amount: bigint;
  batchNonce: bigint;
  /** The `salt` of the Calibur `eip712Domain`. */
  salt: Hex;
  /** The only account that can execute the batch. */
  executor: Address;
  /** Unix time in seconds. */
  deadline: bigint;
}

export function buildBuyBatch(input: BuyBatchInput) {
  return {
    batchedCall: {
      calls: [
        {
          to: input.token,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [AGGLAYER_BRIDGE_ADDRESS, input.amount]
          })
        },
        {
          to: AGGLAYER_BRIDGE_ADDRESS,
          value: 0n,
          data: encodeFunctionData({
            abi: BRIDGE_ASSET_ABI,
            functionName: 'bridgeAsset',
            args: [
              MIDEN_AGGLAYER_NETWORK_ID,
              midenAccountHexToEvmAddress(input.midenAccountHex),
              input.amount,
              input.token,
              true,
              '0x'
            ]
          })
        }
      ],
      revertOnFailure: true
    },
    nonce: input.batchNonce,
    // The zero key hash selects the root key: the EOA key itself.
    keyHash: zeroHash,
    executor: input.executor,
    deadline: input.deadline
  };
}

export function buyBatchTypedData(input: BuyBatchInput) {
  const primaryType: 'SignedBatchedCall' = 'SignedBatchedCall';
  return {
    domain: caliburDomain(input.evmAddress, input.salt),
    types: batchTypes,
    primaryType,
    message: buildBuyBatch(input)
  };
}

export function buyBatchDigest(input: BuyBatchInput): Hex {
  return hashTypedData(buyBatchTypedData(input));
}

/** The calldata of `execute` on the EOA. The wrapped signature is `abi.encode(bytes signature, bytes hookData)`. */
export function encodeBuyExecution(input: BuyBatchInput, signature: Hex): Hex {
  return encodeFunctionData({
    abi: CALIBUR_ABI,
    functionName: 'execute',
    args: [buildBuyBatch(input), encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [signature, '0x'])]
  });
}

/**
 * The Calibur signed batch for a sell: one ERC-20 `transfer` of the token to Transak's deposit address.
 * Twin of `buildSellBatch` in `backend/src/chain-testnet/offramp.ts`. Same domain and types as the buy batch.
 */
export interface SellBatchInput {
  /** The EOA that delegates to Calibur. It is the verifying contract of the domain. */
  evmAddress: Address;
  token: Address;
  /** Transak's deposit address of the order. */
  depositAddress: Address;
  /** Token base units. */
  amount: bigint;
  batchNonce: bigint;
  salt: Hex;
  executor: Address;
  /** Unix time in seconds. */
  deadline: bigint;
}

export function buildSellBatch(input: SellBatchInput) {
  return {
    batchedCall: {
      calls: [
        {
          to: input.token,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'transfer',
            args: [input.depositAddress, input.amount]
          })
        }
      ],
      revertOnFailure: true
    },
    nonce: input.batchNonce,
    keyHash: zeroHash,
    executor: input.executor,
    deadline: input.deadline
  };
}

export function sellBatchTypedData(input: SellBatchInput) {
  const primaryType: 'SignedBatchedCall' = 'SignedBatchedCall';
  return {
    domain: caliburDomain(input.evmAddress, input.salt),
    types: batchTypes,
    primaryType,
    message: buildSellBatch(input)
  };
}

export function sellBatchDigest(input: SellBatchInput): Hex {
  return hashTypedData(sellBatchTypedData(input));
}
