import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { readMainnetFaucetMetadata, readMainnetMidenBlock } = createRequire(import.meta.url)(
  join(process.cwd(), 'node_modules/.cache/nightly-miden-read.cjs')
);
const rpcUrl = 'https://rpc.mainnet.miden.io';
const height = await readMainnetMidenBlock(rpcUrl);
assert.ok(Number.isSafeInteger(height) && height > 0, 'Missing live mainnet block height');
assert.deepEqual(await readMainnetFaucetMetadata('0xe69e6ca6e39df1b10c1e5399399feb', rpcUrl), {
  symbol: 'USDCX',
  decimals: 6
});
console.log(`Public mainnet SDK read: block ${height}, verified native USDCX/6. No wallet keys or writes.`);
