import {
  type WalletClient,
  createWalletClient,
  hashTypedData,
  http,
  parseSignature,
  serializeTransaction,
  stringToHex,
  toHex
} from 'viem';
import { toAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { hashAuthorization } from 'viem/utils';

import { SEPOLIA_RPC_URL } from 'lib/agglayer/constant';
import { SignEvmOperation } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';

/**
 * Viem WalletClient whose account is the wallet-derived EVM identity of the
 * given Miden account (`WalletAccount.evmAddress`). Every signing callback
 * round-trips through intercom to the vault (`Vault.signEvm`), which decrypts
 * only the 32-byte EVM leaf key transiently per call — no key material ever
 * reaches the frontend.
 *
 * BigInt-bearing viem structures don't survive intercom JSON, so transactions
 * are pre-serialized and typed data is pre-hashed here; only 0x-hex strings
 * cross the wire.
 *
 * Transport is plain HTTP against Sepolia (the LocalAccount signs locally; the
 * RPC only ever sees signed payloads), matching buildEpochReadOnlyWalletClient.
 * This is the write-capable client the Epoch withdraw path needs
 * (`withdrawToken` / `initateDepositWithdrawal` / `disableForcedWithdrawal`
 * all do `walletClient.writeContract` from the position-owner address).
 */
export function buildVaultEvmWalletClient(midenAccountPublicKey: string, evmAddress: `0x${string}`): WalletClient {
  const signEvm = (operation: SignEvmOperation) => useWalletStore.getState().signEvm(midenAccountPublicKey, operation);

  const account = toAccount({
    address: evmAddress,
    async sign({ hash }) {
      return signEvm({ op: 'typed-data', digest: hash });
    },
    async signAuthorization(authorization) {
      const address =
        'contractAddress' in authorization && authorization.contractAddress
          ? authorization.contractAddress
          : authorization.address;
      const unsignedAuthorization = {
        address,
        chainId: authorization.chainId,
        nonce: authorization.nonce
      };
      const signature = await signEvm({
        op: 'typed-data',
        digest: hashAuthorization(unsignedAuthorization)
      });
      return { ...unsignedAuthorization, ...parseSignature(signature) };
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      return signEvm({ op: 'transaction', serializedTransaction: await serializer(transaction) });
    },
    async signTypedData(parameters) {
      return signEvm({ op: 'typed-data', digest: hashTypedData(parameters) });
    },
    async signMessage({ message }) {
      const messageHex =
        typeof message === 'string'
          ? stringToHex(message)
          : typeof message.raw === 'string'
            ? message.raw
            : toHex(message.raw);
      return signEvm({ op: 'message', messageHex });
    }
  });

  // E2E-only: honor the local Anvil RPC override so the gasless withdraw path's
  // on-chain reads/receipt-waits hit the hermetic node instead of hanging on
  // real Sepolia. Inert in production (E2E_EVM_RPC_URL is baked only by the e2e
  // build), where this resolves to the same default Sepolia RPC as before.
  const e2eRpc = process.env.MIDEN_E2E_TEST === 'true' ? (process.env.E2E_EVM_RPC_URL ?? '').trim() : '';
  // viem's sepolia default RPC is thirdweb's rate-limited endpoint (429s under
  // light write traffic) — always use our own default instead.
  const evmRpcUrl = e2eRpc || SEPOLIA_RPC_URL;

  // Override the CHAIN's default rpcUrls too, not just the transport: the Epoch
  // SDK builds its OWN publicClients from `walletClient.chain.rpcUrls.default`
  // (e.g. getWalletGaslessStatus reads the 7702 delegation there), so the chain
  // must point at the same RPC as the transport or those reads hit viem's
  // thirdweb default. Mirrors `withE2eRpc` in client.ts (the deposit path).
  const chain = { ...sepolia, rpcUrls: { ...sepolia.rpcUrls, default: { http: [evmRpcUrl] } } };

  return createWalletClient({
    account,
    chain,
    transport: http(evmRpcUrl)
  });
}
