import { AccountId, BasicFungibleFaucetComponent, Endpoint, RpcClient } from '@miden-sdk/miden-sdk';

import { withRpcTimeout } from '../../../src/lib/miden-chain/rpc-timeout';

function publicRpc(rpcUrl: string): RpcClient {
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new Error('Invalid public mainnet RPC URL'); }
  if (rpcUrl.length > 2048 || rpcUrl.trim() !== rpcUrl || url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash) throw new Error('Invalid public mainnet RPC URL');
  return new RpcClient(new Endpoint(rpcUrl));
}

export async function readMainnetMidenBlock(rpcUrl: string): Promise<number> {
  const rpc = publicRpc(rpcUrl);
  const header = await withRpcTimeout(() => rpc.getBlockHeaderByNumber(undefined), 'mainnet header', { retries: 0 });
  const height = Number(header.blockNum());
  if (!Number.isSafeInteger(height) || height <= 0) throw new Error('Invalid live mainnet block height');
  return height;
}

export async function readMainnetFaucetMetadata(
  faucetId: string, rpcUrl: string
): Promise<{ symbol: string; decimals: number }> {
  if (!/^0x[0-9a-f]{30}$/i.test(faucetId)) throw new Error('Invalid mainnet faucet identity');
  const rpc = publicRpc(rpcUrl);
  const details = await withRpcTimeout(() => rpc.getAccountDetails(AccountId.fromHex(faucetId)), 'mainnet faucet', { retries: 0 });
  const account = details.account();
  if (!account) throw new Error('Mainnet faucet has no public account state');
  const faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
  return { symbol: faucet.symbol().toString(), decimals: faucet.decimals() };
}
