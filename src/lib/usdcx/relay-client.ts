import { type Address, type Hash, isAddressEqual } from 'viem';
import { sepolia } from 'viem/chains';

import { buildVaultEvmWalletClient } from 'lib/epoch/evm-account';

import {
  CALIBUR_SEPOLIA_ADDRESS,
  RELAY_TEST_TTL_SECONDS,
  type RelayRequest,
  prepareSchema,
  relayResponseSchema,
  relayTypedData
} from './relay-protocol';

async function readResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Relayer HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

export async function submitRelayTest(
  apiUrl: string,
  midenAccountPublicKey: string,
  midenAccountHex: string,
  evmAddress: Address
): Promise<Hash> {
  const baseUrl = apiUrl.replace(/\/$/, '');
  const prepareResponse = await fetch(`${baseUrl}/onramp/prepare?evmAddress=${evmAddress}`);
  const preparation = prepareSchema.validateSync(await readResponse(prepareResponse), { strict: true });
  const now = Math.floor(Date.now() / 1000);
  if (!isAddressEqual(preparation.evmAddress, evmAddress) || preparation.deadline <= now ||
      preparation.deadline > now + RELAY_TEST_TTL_SECONDS + 60) {
    throw new Error('Invalid relayer preparation');
  }

  const client = buildVaultEvmWalletClient(midenAccountPublicKey, evmAddress);
  if (!client.account) throw new Error('EVM signing account unavailable');
  const input = { ...preparation, midenAccountHex };
  const signature = await client.signTypedData({ account: client.account, ...relayTypedData(input) });
  let authorization: RelayRequest['authorization'];
  if (!preparation.delegated) {
    const signed = await client.signAuthorization({
      account: client.account,
      contractAddress: CALIBUR_SEPOLIA_ADDRESS,
      chainId: sepolia.id,
      nonce: preparation.authorizationNonce,
      executor: preparation.executor
    });
    if (signed.yParity === undefined) throw new Error('Missing authorization signature parity');
    authorization = {
      address: CALIBUR_SEPOLIA_ADDRESS,
      chainId: sepolia.id,
      nonce: signed.nonce,
      r: signed.r,
      s: signed.s,
      yParity: signed.yParity
    };
  }
  const request: RelayRequest = {
    evmAddress,
    midenAccountHex,
    executor: preparation.executor,
    batchNonce: preparation.batchNonce,
    salt: preparation.salt,
    deadline: preparation.deadline,
    signature,
    authorization
  };
  const response = await fetch(`${baseUrl}/onramp/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  return relayResponseSchema.validateSync(await readResponse(response), { strict: true }).txHash;
}
