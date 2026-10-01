import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type SignedAuthorization
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import {
  CALIBUR_ABI,
  CALIBUR_DELEGATION,
  CALIBUR_RUNTIME_HASH,
  CALIBUR_SEPOLIA_ADDRESS,
  ONRAMP_NONCE_KEY,
  SEPOLIA_CHAIN_ID
} from './calibur.js';
import { ERC20_ABI } from './erc20.js';

/** The on-chain values that a prepare needs, read at one time. */
export interface AccountState {
  /** True when the EOA code is not the Calibur delegation (no code, or a different delegate). */
  needsAuthorization: boolean;
  /** The pending transaction count of the EOA. An authorization must use this nonce. */
  authorizationNonce: number;
  /** The Calibur sequence for `ONRAMP_NONCE_KEY`. */
  sequence: bigint;
  /** The `salt` of the Calibur `eip712Domain` of the EOA. */
  salt: Hex;
  /** The token balance of the EOA, in base units. */
  balance: bigint;
}

export type ReceiptStatus = 'success' | 'reverted' | null;

export interface RelayTransaction {
  /** The EOA. The relayer calls `execute` on it. */
  to: Address;
  data: Hex;
  authorization: SignedAuthorization | null;
}

export interface PreparedRelay {
  serializedTransaction: Hex;
  hash: Hex;
  /** The relayer nonce of the transaction. */
  nonce: number;
  /** True for an EIP-7702 (type 4) transaction. */
  type4: boolean;
}

/** The Sepolia access that the routes and the worker use. The tests give a fake. */
export interface Chain {
  /** The relayer address. It is the `executor` of each batch. */
  executor: Address;
  readAccount(evmAddress: Address, token: Address): Promise<AccountState>;
  readBalance(evmAddress: Address, token: Address): Promise<bigint>;
  /** Sign locally. This method must not broadcast. */
  prepareRelay(transaction: RelayTransaction, minimumNonce: number): Promise<PreparedRelay>;
  broadcastRelay(serializedTransaction: Hex): Promise<Hex>;
  /** Null when the node has no receipt yet. */
  getReceiptStatus(hash: Hex): Promise<ReceiptStatus>;
}

export interface SepoliaChainOptions {
  rpcUrl: string;
  relayerPrivateKey: Hex;
}

/** The Calibur implementation address in the last 20 bytes of the domain salt. */
function saltNamesCalibur(salt: Hex): boolean {
  return salt.slice(-40).toLowerCase() === CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase();
}

export function createSepoliaChain({ rpcUrl, relayerPrivateKey }: SepoliaChainOptions): Chain {
  const account = privateKeyToAccount(relayerPrivateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  function readBalance(evmAddress: Address, token: Address): Promise<bigint> {
    return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [evmAddress] });
  }

  async function readAccount(evmAddress: Address, token: Address): Promise<AccountState> {
    if (isAddressEqual(evmAddress, account.address)) {
      throw new Error('The relayer must be a different account from the buyer');
    }
    const [chainId, implementationCode, code, authorizationNonce, balance] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: CALIBUR_SEPOLIA_ADDRESS }),
      publicClient.getCode({ address: evmAddress }),
      publicClient.getTransactionCount({ address: evmAddress, blockTag: 'pending' }),
      readBalance(evmAddress, token)
    ]);
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error('The RPC is not Ethereum Sepolia');
    }
    if (implementationCode === undefined || keccak256(implementationCode) !== CALIBUR_RUNTIME_HASH) {
      throw new Error('The Calibur runtime is not the pinned Sepolia deployment');
    }
    // Any code that is not the Calibur delegation (none, or a different delegate) needs a new authorization.
    const delegated = code !== undefined && code.toLowerCase() === CALIBUR_DELEGATION;
    // A code override for eth_call also reads the storage that stays from an earlier delegation.
    // Thus do not assume sequence 0 or a zero salt for an EOA that is not delegated now.
    const stateOverride = delegated ? undefined : [{ address: evmAddress, code: implementationCode }];
    const [sequence, domain] = await Promise.all([
      publicClient.readContract({
        address: evmAddress,
        abi: CALIBUR_ABI,
        functionName: 'getSeq',
        args: [ONRAMP_NONCE_KEY],
        stateOverride
      }),
      publicClient.readContract({ address: evmAddress, abi: CALIBUR_ABI, functionName: 'eip712Domain', stateOverride })
    ]);
    const [, name, version, domainChainId, verifyingContract, salt] = domain;
    if (
      name !== 'Calibur' ||
      version !== '1.0.0' ||
      domainChainId !== BigInt(SEPOLIA_CHAIN_ID) ||
      !isAddressEqual(verifyingContract, evmAddress) ||
      !saltNamesCalibur(salt)
    ) {
      throw new Error('The Calibur signing domain is not the expected domain');
    }
    return { needsAuthorization: !delegated, authorizationNonce, sequence, salt, balance };
  }

  async function prepareRelay(
    { to, data, authorization }: RelayTransaction,
    minimumNonce: number
  ): Promise<PreparedRelay> {
    const authorizationList = authorization === null ? undefined : [authorization];
    // eth_estimateGas includes the authorization list, so it simulates the delegation and both calls together.
    // Do not use a plain eth_call on an EOA that is not delegated: it executes nothing and succeeds.
    const gas = await publicClient.estimateGas({ account, to, data, value: 0n, authorizationList });
    const pendingNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const nonce = Math.max(pendingNonce, minimumNonce);
    const request = await walletClient.prepareTransactionRequest({
      account,
      chain: sepolia,
      to,
      data,
      value: 0n,
      authorizationList,
      nonce,
      gas: gas + gas / 5n
    });
    const serializedTransaction = await walletClient.signTransaction(request);
    return { serializedTransaction, hash: keccak256(serializedTransaction), nonce, type4: authorization !== null };
  }

  async function getReceiptStatus(hash: Hex): Promise<ReceiptStatus> {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return receipt.status;
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async function broadcastRelay(serializedTransaction: Hex): Promise<Hex> {
    try {
      return await walletClient.sendRawTransaction({ serializedTransaction });
    } catch {
      // RPC errors can contain the signed bytes. Keep those bytes out of the log.
      throw new Error('Relay broadcast failed; the stored transaction will be retried');
    }
  }

  return {
    executor: account.address,
    readAccount,
    readBalance,
    prepareRelay,
    getReceiptStatus,
    broadcastRelay
  };
}
