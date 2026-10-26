import type { BlockHeader, RpcClient } from '@miden-sdk/miden-sdk';
import { execFile } from 'child_process';
import sharp from 'sharp';
import { promisify } from 'util';

import {
  NATIVE_ASSET_META_CACHE,
  NATIVE_ASSET_SYNCED_ID_CACHE
} from '../../../src/lib/miden-chain/native-asset-cache-keys';
import { expect, test } from '../fixtures/two-wallets';
import {
  fromBaseUnits,
  vaultBalanceByFaucetId,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../helpers/balance-truth';
import { hexFaucetToBech32 } from '../helpers/faucet-address';
import { discoverFeeFaucetId } from '../helpers/fee-faucet';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../helpers/public-faucet';

test.use({ injectFeeFaucet: false });
test.skip(process.env.E2E_NETWORK !== 'devnet', 'USDCX is the current devnet fee asset');

test('devnet discovers and values its USDCX fee asset without an override', async ({
  walletA,
  walletB,
  envConfig
}, info) => {
  test.setTimeout(300_000);

  await walletA.page.context().route('https://api.binance.com/api/v3/**', route => route.fulfill({ json: [] }));
  await walletA.page.reload();
  expect((await walletA.dumpChromeStorage()).fee_faucet_id).toBeUndefined();

  const { address } = await walletA.createNewWallet();
  const recipient = (await walletB.createNewWallet()).address;
  const faucetId = await hexFaucetToBech32(walletA, await discoverFeeFaucetId(envConfig.rpcUrl));
  const scope = `${envConfig.rpcUrl}|devnet`;

  await expect.poll(() => walletDiscoveredNativeFaucetId(walletA.page)).toBe(faucetId);
  await expect
    .poll(async () => (await walletA.dumpChromeStorage())[`${NATIVE_ASSET_SYNCED_ID_CACHE}:${scope}`])
    .toBe(faucetId);
  await expect
    .poll(async () => (await walletA.dumpChromeStorage())[`${NATIVE_ASSET_META_CACHE}:${scope}`])
    .toMatchObject({ faucetId, symbol: 'USDCX', decimals: 6 });
  expect((await walletA.dumpChromeStorage()).fee_faucet_id).toBeUndefined();

  await mintFromPublicFaucet(publicFaucetApiUrl('devnet')!, address);
  // Funding is a precondition. The wallet must consume the native note itself,
  // without the harness's claim helper synthesizing faucet metadata.
  await expect.poll(() => vaultBalanceByFaucetId(walletA.page, faucetId), { timeout: 150_000 }).not.toBe(0n);
  await expect
    .poll(() =>
      walletA.page.evaluate(id => {
        const state = Reflect.get(window, '__TEST_STORE__')?.getState();
        const rows = Object.values(state?.balances ?? {}).flat() as Array<{
          tokenId: string;
          fiatPrice: number;
          metadata: { symbol: string; decimals: number; scaleIsUnknown?: boolean };
        }>;
        const token = rows.find(row => row.tokenId === id);
        return {
          priceSymbols: Object.keys(state?.tokenPrices ?? {}),
          token: token && {
            fiatPrice: token.fiatPrice,
            symbol: token.metadata.symbol,
            decimals: token.metadata.decimals,
            scaleIsUnknown: Boolean(token.metadata.scaleIsUnknown)
          }
        };
      }, faucetId)
    )
    .toEqual({
      priceSymbols: [],
      token: { fiatPrice: 1, symbol: 'USDCX', decimals: 6, scaleIsUnknown: false }
    });

  await walletA.prepareSendReview({
    recipientAddress: recipient,
    amount: '1',
    tokenId: faucetId,
    isPrivate: false
  });
  await expect(walletA.page.getByTestId('review-amount')).toContainText('1 USDCX');
  await expect(walletA.page.getByTestId('review-amount').locator('p')).toHaveText('≈ $1.00 USD');

  const headerMethod = 'getBlockHeaderByNumber' satisfies keyof RpcClient;
  const feeMethod = 'verificationBaseFee' satisfies keyof BlockHeader;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { RpcClient, Endpoint } from '@miden-sdk/miden-sdk';
       const header = await new RpcClient(new Endpoint(process.argv[1])).${headerMethod}(undefined);
       console.log(JSON.stringify({ baseFee: header.${feeMethod}() }));`,
      envConfig.rpcUrl
    ],
    { timeout: 45_000 }
  );
  const { baseFee } = JSON.parse(stdout) as { baseFee: number };
  expect(typeof baseFee).toBe('number');
  expect(Number.isSafeInteger(baseFee) && baseFee >= 0).toBe(true);
  await expect.poll(() => walletDiscoveredBaseFee(walletA.page)).toBe(baseFee);
  const feeLabel = walletA.page.getByText('Max network fee', { exact: true });
  await expect(feeLabel).toHaveCount(baseFee > 0 ? 1 : 0);
  await expect
    .poll(async () => (await feeLabel.locator('..').allTextContents()).map(text => text.replace(/\s/g, '')))
    .toEqual(baseFee > 0 ? [`Maxnetworkfee${fromBaseUnits(BigInt(baseFee * 30), 6)}USDCX`] : []);

  const screenshotPath = info.outputPath('usdcx-send-review.png');
  const screenshot = await walletA.page.screenshot({ path: screenshotPath });
  await sharp(screenshot).resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).toFile(screenshotPath);
  await info.attach('USDCX Send review', { path: screenshotPath, contentType: 'image/png' });
});
