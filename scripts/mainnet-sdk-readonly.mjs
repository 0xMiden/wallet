import assert from 'node:assert/strict';
import { AccountId, BasicFungibleFaucetComponent, Endpoint, RpcClient } from '@miden-sdk/miden-sdk';

const rpc = new RpcClient(new Endpoint('https://rpc.mainnet.miden.io'));
let timeout;
try {
  const [header, details] = await Promise.race([
    (async () => {
      const header = await rpc.getBlockHeaderByNumber(undefined);
      const details = await rpc.getAccountDetails(AccountId.fromHex('0xe69e6ca6e39df1b10c1e5399399feb'));
      return [header, details];
    })(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Public mainnet SDK read timed out')), 20_000); })
  ]);
  const height = Number(header.blockNum());
  assert.ok(Number.isSafeInteger(height) && height > 0, 'Missing live mainnet block height');
  const account = details.account();
  assert.ok(account, 'Verified native faucet has no public account state');
  const faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
  assert.equal(faucet.symbol().toString(), 'USDCX');
  assert.equal(faucet.decimals(), 6);
  console.log(`Public mainnet SDK read: block ${height}, verified native USDCX/6. No wallet keys or writes.`);
} finally {
  clearTimeout(timeout);
}
