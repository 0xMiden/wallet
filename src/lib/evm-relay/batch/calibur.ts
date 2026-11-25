import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
  zeroHash,
  type Address,
  type Hex,
  type TypedData
} from 'viem';

/**
 * The Uniswap Calibur "signed batched call". The EOA delegates to Calibur through EIP-7702 and signs one batch with
 * its own key (the root key). The relayer calls `execute` on the EOA and pays the gas.
 */

/** One call of a Calibur batch. */
export interface BatchCall {
  to: Address;
  value: bigint;
  data: Hex;
}

/** The Calibur deployment that a chain uses. The caller checks `runtimeHash` against the code on chain. */
export interface CaliburPin {
  address: Address;
  /** The keccak256 hash of the Calibur runtime code. */
  runtimeHash: Hex;
  /** The `name` of the Calibur EIP-712 domain. */
  domainName: string;
  /** The `version` of the Calibur EIP-712 domain. */
  domainVersion: string;
}

/** The values of a batch that do not depend on its calls. */
export interface BatchEnvelope {
  chainId: number;
  /** The EOA that delegates to Calibur. It is the verifying contract of the domain. */
  evmAddress: Address;
  /** The only account that can execute the batch. */
  executor: Address;
  /** The Calibur nonce: `key << 64 | sequence` (see `batchNonceOf`). */
  batchNonce: bigint;
  /** The `salt` of the Calibur `eip712Domain` of the EOA. */
  salt: Hex;
  /** Unix time in seconds. */
  deadline: bigint;
}

/**
 * The `SignedBatchedCall` struct of Calibur. It is a type alias, not an interface: viem needs a message type that
 * fits `Record<string, unknown>`, and only a type alias gets an implicit index signature.
 */
export type SignedBatchedCall = {
  batchedCall: { calls: BatchCall[]; revertOnFailure: boolean };
  nonce: bigint;
  keyHash: Hex;
  executor: Address;
  deadline: bigint;
};

export const CALIBUR_ABI = parseAbi([
  'struct Call { address to; uint256 value; bytes data; }',
  'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
  'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
  'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
  'function getSeq(uint256 key) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)'
]);

/** The EIP-712 types of a Calibur batch. */
export const BATCH_TYPES = {
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

/** The batch struct. The zero key hash selects the root key, and every call must succeed. */
export function buildSignedBatch(envelope: BatchEnvelope, calls: BatchCall[]): SignedBatchedCall {
  return {
    batchedCall: { calls, revertOnFailure: true },
    nonce: envelope.batchNonce,
    keyHash: zeroHash,
    executor: envelope.executor,
    deadline: envelope.deadline
  };
}

/** The EIP-712 typed data that the EOA signs. */
export function batchTypedData(pin: CaliburPin, envelope: BatchEnvelope, calls: BatchCall[]) {
  const primaryType: 'SignedBatchedCall' = 'SignedBatchedCall';
  return {
    domain: {
      name: pin.domainName,
      version: pin.domainVersion,
      chainId: envelope.chainId,
      verifyingContract: envelope.evmAddress,
      salt: envelope.salt
    },
    types: BATCH_TYPES,
    primaryType,
    message: buildSignedBatch(envelope, calls)
  };
}

/** The EIP-712 digest of a batch. */
export function batchDigest(pin: CaliburPin, envelope: BatchEnvelope, calls: BatchCall[]): Hex {
  return hashTypedData(batchTypedData(pin, envelope, calls));
}

/** The wrapped signature of `execute`: `abi.encode(bytes signature, bytes hookData)` with empty hook data. */
export function wrapSignature(signature: Hex): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [signature, '0x']);
}

/** The calldata of `execute` on the EOA. */
export function encodeExecution(envelope: BatchEnvelope, calls: BatchCall[], signature: Hex): Hex {
  return encodeFunctionData({
    abi: CALIBUR_ABI,
    functionName: 'execute',
    args: [buildSignedBatch(envelope, calls), wrapSignature(signature)]
  });
}

/** The address that signed the batch. The relayer compares it with `envelope.evmAddress`. */
export function recoverBatchSigner(
  pin: CaliburPin,
  envelope: BatchEnvelope,
  calls: BatchCall[],
  signature: Hex
): Promise<Address> {
  return recoverTypedDataAddress({ ...batchTypedData(pin, envelope, calls), signature });
}

/** The EIP-7702 code of an EOA that delegates to Calibur: `0xef0100` and the address, lower case. */
export function caliburDelegationCode(pin: CaliburPin): Hex {
  return `0xef0100${pin.address.slice(2).toLowerCase()}`;
}

/** True when the account code is the delegation to this Calibur. The case of the hex does not matter. */
export function isCaliburDelegation(code: Hex, pin: CaliburPin): boolean {
  return code.toLowerCase() === caliburDelegationCode(pin);
}
