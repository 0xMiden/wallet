import {
  type WalletClient,
  createWalletClient,
  hashTypedData,
  http,
  serializeTransaction,
  stringToHex,
  toHex
} from 'viem';
import { toAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { useWalletStore } from 'lib/store';
import { SignEvmOperation } from 'lib/shared/types';

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

  return createWalletClient({
    account,
    chain: sepolia,
    transport: http(sepolia.rpcUrls.default.http[0] ?? '')
  });
}
