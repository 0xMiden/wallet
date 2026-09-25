import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { USDCX_FAUCET_ID_BECH32 } from '../../../../src/lib/usdcx/constant';

import { expect, test } from '../../fixtures/two-wallets';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { readBridgedSendRows } from '../../helpers/bridge';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../../helpers/public-faucet';

const run = promisify(execFile);
const helperRepo = process.env.USDCX_TESTNET_REPO;

async function chainEvidence(
  rpcUrl: string,
  noteId?: string,
  sender?: string
): Promise<{ supply: string; noteId?: string; status?: string }> {
  const { stdout } = await run(
    process.execPath,
    [
      join(__dirname, '../../helpers/usdcx-chain-evidence.mjs'),
      rpcUrl,
      USDCX_FAUCET_ID_BECH32,
      ...(noteId && sender ? [noteId, sender] : [])
    ],
    { timeout: 30_000 }
  );
  return JSON.parse(stdout);
}

test.describe('USDCx burn against the deployed testnet faucet', () => {
  test.skip(
    !helperRepo || (process.env.E2E_NETWORK ?? 'testnet') !== 'testnet',
    'requires USDCX_TESTNET_REPO with a funded, deployed test faucet'
  );
  test.setTimeout(600_000);

  for (const guardian of [false, true]) {
    test(`${guardian ? 'Guardian' : 'standard'} wallet publishes a burn and the faucet consumes it`, async ({
      walletA,
      envConfig
    }) => {
      if (!helperRepo) throw new Error('USDCX_TESTNET_REPO is required');
      const { address } = guardian
        ? await walletA.createGuardianWallet(envConfig.guardianUrl)
        : await walletA.createNewWallet();
      const nativeFaucet = publicFaucetApiUrl('testnet');
      if (!nativeFaucet) throw new Error('Testnet MIDEN faucet is required');
      await mintFromPublicFaucet(nativeFaucet, address);
      await run(
        join(helperRepo, 'target/release/xusdc-testnet'),
        [
          'mint',
          '--request-id',
          `wallet-burn-${guardian ? 'guardian' : 'standard'}-${Date.now()}`,
          '--recipient',
          address,
          '--amount',
          '2'
        ],
        { cwd: helperRepo, timeout: 300_000 }
      );
      await waitForPendingNoteTotal(walletA.page, 'USDCX', 2_000_000n, { decimals: 6, timeoutMs: 180_000 });
      await walletA.claimAllNotes(180_000);
      await waitForVaultBalance(walletA.page, 'USDCX', 2_000_000n, { decimals: 6, timeoutMs: 120_000 });

      const { page, extensionId } = walletA;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
      const flow = page.getByTestId('send-flow');
      await flow.getByTestId('send-recipient-input').fill('0x1111111111111111111111111111111111111111');
      await page.getByTestId('send-network-sepolia').click();
      await flow.getByTestId('send-recipient-confirm').click();
      await flow.getByTestId('send-token-selector').click();
      await page.getByTestId('send-token-USDCX').click();
      await flow.getByTestId('send-amount-input').fill('1');
      await flow.getByTestId('send-amount-confirm').click();
      await flow.getByTestId('bridge-route-usdcx').click();
      await page.screenshot({ path: test.info().outputPath('usdcx-route.png') });
      await flow.getByTestId('bridge-route-confirm').click();
      await expect(page.getByTestId('send-review-submit')).toBeEnabled();
      await page.screenshot({ path: test.info().outputPath('usdcx-review-light.png') });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await page.screenshot({ path: test.info().outputPath('usdcx-review-dark.png') });
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      const before = await chainEvidence(envConfig.rpcUrl);
      await page.getByTestId('send-review-submit').click();
      await page.waitForURL(/generating-transaction/);

      await expect
        .poll(
          async () => {
            const row = (await readBridgedSendRows(page)).find(r => r.extraInputs?.provider === 'usdcx');
            return row?.status === 3 ? (row.rawError ?? row.error) : row?.extraInputs?.usdcxBurn?.phase;
          },
          { timeout: 240_000, intervals: [3000] }
        )
        .toBe('confirmed');
      const rows = (await readBridgedSendRows(page)).filter(r => r.extraInputs?.provider === 'usdcx');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.transactionId).toMatch(/^0x[0-9a-f]+$/);
      expect(rows[0]?.outputNoteIds).toEqual([rows[0]?.extraInputs?.usdcxBurn?.noteId]);
      expect(rows[0]?.extraInputs?.usdcxBurn?.destinationDomain).toBe(0);
      const after = await chainEvidence(envConfig.rpcUrl, rows[0]?.extraInputs?.usdcxBurn?.noteId, address);
      expect(BigInt(before.supply) - BigInt(after.supply)).toBe(1_000_000n);
      await test
        .info()
        .attach('burn-chain-evidence', {
          body: JSON.stringify({ before, after, transactionId: rows[0]?.transactionId }),
          contentType: 'application/json'
        });
      await page.getByRole('button', { name: 'View in Activities' }).click();
      await page.getByRole('button', { name: /^Burn USDCx Via/ }).click();
      await expect(page.getByTestId('history-status-pill')).toHaveText('Burn confirmed');
      await page.screenshot({ path: test.info().outputPath('usdcx-burn-confirmed.png') });
      await page.reload();
      await expect(page.getByTestId('history-status-pill')).toHaveText('Burn confirmed');
      await waitForVaultBalance(page, 'USDCX', 1_000_000n, { decimals: 6, timeoutMs: 120_000 });
    });
  }
});
