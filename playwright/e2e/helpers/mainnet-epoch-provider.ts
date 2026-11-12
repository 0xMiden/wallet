import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { EpochIntentSDKConfig } from '@epoch-protocol/epoch-intents-sdk';
import { createWalletClient, custom, getAddress } from 'viem';
import { arbitrum, mainnet } from 'viem/chains';

type ReadOnlySdk = typeof import('../../../scripts/helpers/mainnet-epoch-readonly-sdk');

export function epochReadOnlyProvider(serviceUrl: string, chainId: number, actor: string): {
  config: EpochIntentSDKConfig;
  sdk: ReadOnlySdk;
} {
  const url = new URL(serviceUrl);
  if (serviceUrl.length > 512 || serviceUrl.trim() !== serviceUrl || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash)
    throw new Error('Epoch qualification requires a real HTTPS provider');
  // Bundle the installed SDK's extensionless imports; expose no funded methods.
  const sdk: ReadOnlySdk = createRequire(join(process.cwd(), 'package.json'))(
    join(process.cwd(), 'node_modules/.cache/nightly-epoch-readonly-sdk.cjs')
  );
  if (![1, 42161, sdk.MIDEN_VIRTUAL_CHAIN_ID].includes(chainId))
    throw new Error('Unsupported mainnet Epoch source chain');
  const chain = chainId === sdk.MIDEN_VIRTUAL_CHAIN_ID ? { ...mainnet, id: chainId } : chainId === 1 ? mainnet : arbitrum;
  const walletClient = createWalletClient({
    account: getAddress(actor), chain,
    transport: custom({ request: async () => { throw new Error('Epoch quote transport is read-only; EVM RPC is forbidden'); } }, { retryCount: 0 })
  });
  return { config: { apiBaseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, walletClient }, sdk };
}
