import {
  type Address,
  type Hex,
  type TypedData,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroHash
} from 'viem';
import { sepolia } from 'viem/chains';
import { boolean, mixed, number, object, string, type InferType } from 'yup';

import {
  getUsdcxContracts,
  ERC20_APPROVE_ABI,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from './constant';
import { midenAccountHexToXReserveRecipient } from './recipient';

const { usdc: CIRCLE_USDC_SEPOLIA_ADDRESS, xReserve: XRESERVE_SEPOLIA_ADDRESS } = getUsdcxContracts(sepolia.id);

// Uniswap's deployment table at b0c563e6dfbd4ecacde36b37775bf66c5db6612e (v1.1.0).
// Runtime hash read on Sepolia; checked before every prepare/relay, never supplied by the API.
export const CALIBUR_SEPOLIA_ADDRESS: Address = '0x00000cAbFc76478C1537dd418aB00967cBbE4AE6';
export const CALIBUR_RUNTIME_HASH: Hex = '0xd8f2157116f6901840d009511732cb247c1ced614af48351f1c1e5d52deea1eb';
export const CALIBUR_DELEGATION: Hex = `0xef0100${CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase()}`;
export const RELAY_TEST_AMOUNT = 1_000_000n; // Exactly 1 USDC (6 decimals).
export const RELAY_TEST_TTL_SECONDS = 600;
export const ONRAMP_NONCE_KEY = BigInt(keccak256(stringToHex('miden.onramp'))) >> 64n;

export const CALIBUR_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
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

export const addressSchema = mixed<Address>(
  (value): value is Address => typeof value === 'string' && isAddress(value, { strict: false })
).required();

const hexSchema = (bytes: number) =>
  mixed<Hex>(
    (value): value is Hex => typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  ).required();
const safeInteger = () => number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required();
const nonceSchema = string()
  .matches(/^(0|[1-9][0-9]{0,77})$/)
  .test('onramp-nonce', 'Invalid on-ramp nonce', value => !!value && BigInt(value) >> 64n === ONRAMP_NONCE_KEY)
  .required();
const saltSchema = hexSchema(32).test(
  'implementation',
  'Unexpected Calibur implementation',
  value => !!value && value.slice(-40).toLowerCase() === CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase()
);

export const prepareSchema = object({
  chainId: number().oneOf([sepolia.id]).required(),
  calibur: addressSchema.oneOf([CALIBUR_SEPOLIA_ADDRESS]),
  evmAddress: addressSchema,
  executor: addressSchema,
  delegated: boolean().required(),
  authorizationNonce: safeInteger(),
  batchNonce: nonceSchema,
  salt: saltSchema,
  deadline: safeInteger()
}).noUnknown();

export const authorizationSchema = object({
  address: addressSchema.oneOf([CALIBUR_SEPOLIA_ADDRESS]),
  chainId: number().oneOf([sepolia.id]).required(),
  nonce: safeInteger(),
  r: hexSchema(32),
  s: hexSchema(32),
  yParity: number().oneOf([0, 1]).required()
}).noUnknown();

// Calldata is reconstructed on both ends, never accepted from the API or caller.
export const relayRequestSchema = object({
  evmAddress: addressSchema,
  midenAccountHex: string().matches(/^0x[0-9a-fA-F]{30}$/).required(),
  executor: addressSchema,
  batchNonce: nonceSchema,
  salt: saltSchema,
  deadline: safeInteger(),
  signature: hexSchema(65),
  authorization: authorizationSchema.optional().default(undefined)
}).noUnknown();

export const relayResponseSchema = object({ txHash: hexSchema(32) }).noUnknown();
export type RelayPreparation = InferType<typeof prepareSchema>;
export type RelayRequest = InferType<typeof relayRequestSchema>;
export type RelayBatchInput = Pick<RelayRequest, 'evmAddress' | 'midenAccountHex' | 'executor' | 'batchNonce' | 'salt' | 'deadline'>;

export function buildRelayBatch(input: RelayBatchInput) {
  const recipient = midenAccountHexToXReserveRecipient(input.midenAccountHex);
  return {
    batchedCall: {
      calls: [
        {
          to: CIRCLE_USDC_SEPOLIA_ADDRESS,
          value: 0n,
          data: encodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            functionName: 'approve',
            args: [XRESERVE_SEPOLIA_ADDRESS, RELAY_TEST_AMOUNT]
          })
        },
        {
          to: XRESERVE_SEPOLIA_ADDRESS,
          value: 0n,
          data: encodeFunctionData({
            abi: XRESERVE_ABI,
            functionName: 'depositToRemote',
            args: [RELAY_TEST_AMOUNT, USDCX_REMOTE_DOMAIN, recipient, CIRCLE_USDC_SEPOLIA_ADDRESS,
              USDCX_DEPOSIT_MAX_FEE, USDCX_DEPOSIT_HOOK_DATA]
          })
        }
      ],
      revertOnFailure: true
    },
    nonce: BigInt(input.batchNonce),
    keyHash: zeroHash,
    executor: input.executor,
    deadline: BigInt(input.deadline)
  };
}

export function relayTypedData(input: RelayBatchInput) {
  const primaryType: 'SignedBatchedCall' = 'SignedBatchedCall';
  return {
    domain: {
      name: 'Calibur',
      version: '1.0.0',
      chainId: sepolia.id,
      verifyingContract: input.evmAddress,
      salt: input.salt
    },
    types: batchTypes,
    primaryType,
    message: buildRelayBatch(input)
  };
}

export function encodeRelayExecution(input: RelayRequest): Hex {
  return encodeFunctionData({
    abi: CALIBUR_ABI,
    functionName: 'execute',
    args: [buildRelayBatch(input), encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [input.signature, '0x'])]
  });
}
