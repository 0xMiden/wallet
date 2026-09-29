import 'dotenv/config';

import { loadConfig } from './config.js';
import { createApp } from './index.js';
import { createTransakClient, type FetchLike } from './transak.js';
import { createUserIpResolver } from './user-ip.js';

const config = loadConfig(process.env);
const globalFetch: FetchLike = (url, init) => fetch(url, init);
const transak = createTransakClient({
  apiKey: config.transakApiKey,
  apiSecret: config.transakApiSecret,
  env: config.transakEnv,
  fetch: globalFetch,
  now: Date.now
});
const resolveUserIp = createUserIpResolver(globalFetch);

createApp({ config, transak, resolveUserIp, now: Date.now }).listen(config.port, () => {
  console.log(`Miden Wallet backend (${config.transakEnv}) on port ${config.port}`);
});
