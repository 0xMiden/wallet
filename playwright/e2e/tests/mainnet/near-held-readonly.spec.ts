import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { test } from '../../fixtures/two-wallets';
import { fromBaseUnits, vaultBalanceByFaucetId } from '../../helpers/balance-truth';
import { restoreMainnetLoopGuardian } from '../../helpers/mainnet-loop-wallet';
import { loadMainnetNearCheckpoint } from '../../helpers/mainnet-near-checkpoint';
import { loadMainnetOneClickSetup } from '../../helpers/mainnet-one-click-config';
import { selectMainnetOneClickAssets } from '../../helpers/mainnet-one-click-ui';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fees(value: unknown, platform: string | undefined) {
  if (value === undefined) return { shape: 'absent' };
  if (!Array.isArray(value) || value.length > 3) return { shape: 'invalid' };
  return {
    shape: 'list',
    entries: value.map((entry: unknown) => {
      if (!record(entry) || typeof entry.recipient !== 'string' || typeof entry.fee !== 'number' ||
          !Number.isSafeInteger(entry.fee) || entry.fee < 0 || entry.fee > 1000) return { valid: false };
      return { valid: true, platform: platform !== undefined && entry.recipient === platform, bps: entry.fee };
    })
  };
}

test.use({ injectFeeFaucet: false });
test('observe exact browser dry quote fee fields without opening Review or arming the SDK', async ({ walletB }) => {
  test.setTimeout(600_000);
  const path = 'test-results/original-near/roundtrip.json';
  const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex');
  const expectedHash = '1cba9da167d4223b46d41f5d92894cb25406b6aa7abf8ba12cbf1e93ebd465b5';
  assert.equal(hash(), expectedHash);
  const state = loadMainnetNearCheckpoint(path);
  assert.ok(state && state.phase === 'unspent');
  assert.equal(state.sendAuthority, undefined);
  await restoreMainnetLoopGuardian(walletB, process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR ?? '');
  assert.equal(await walletB.getAccountAddress(), state.account);
  await walletB.triggerSync(true);
  await walletB.refreshBalancesLanded(90_000);
  const before = await vaultBalanceByFaucetId(walletB.page, state.native.faucetId);
  assert.equal(before, 18835663n);
  const setup = await loadMainnetOneClickSetup(fetch, fetch, walletB.extensionId);
  assert.ok(setup);
  assert.equal(setup.config.serviceUrl, state.serviceUrl);
  const native = setup.assets.find(asset => asset.assetId === state.nativeAssetId);
  const evm = setup.assets.find(asset => asset.assetId === state.evmAssetId);
  assert.ok(native && evm);
  const endpoint = `${setup.config.serviceUrl.replace(/\/+$/, '')}/v0/quote`;
  const platform = setup.config.feePolicy?.platformRecipient;
  const report: Record<string, unknown> = { stage: 'waiting-for-dry-quote', policy: setup.config.feePolicy?.kind,
    platformMinimumBps: setup.config.feePolicy?.minimumPlatformFeeBps,
    configuredFees: fees(setup.config.appFees, platform) };
  try {
    await walletB.navigateTo('/swap');
    const pending = walletB.page.waitForResponse(response => {
      if (response.url() !== endpoint || response.request().method() !== 'POST') return false;
      const body: unknown = response.request().postDataJSON();
      return record(body) && body.dry === true && body.originAsset === native.assetId &&
        body.destinationAsset === evm.assetId && body.amount === state.principal &&
        body.refundTo === state.account && body.recipient === state.evm.account;
    }, { timeout: 120_000 });
    void pending.catch(() => {});
    const amount = fromBaseUnits(BigInt(state.principal), 6);
    await selectMainnetOneClickAssets(walletB.page, { payNetwork: 'miden', payAssetId: native.assetId,
      receiveNetwork: evm.blockchain, receiveAssetId: evm.assetId, amount, externalAddress: state.evm.account });
    await walletB.page.getByTestId('one-click-pay-amount').fill(amount);
    const response = await pending;
    const sent: unknown = response.request().postDataJSON();
    report.requestedFees = fees(record(sent) ? sent.appFees : undefined, platform);
    report.httpStatus = response.status();
    const body: unknown = await response.json();
    const quoteRequest = record(body) ? body.quoteRequest : undefined;
    report.quoteRequestPresent = record(quoteRequest);
    report.returnedFees = fees(record(quoteRequest) ? quoteRequest.appFees : undefined, platform);
    report.stage = 'dry-quote-fees-observed';
    assert.ok(response.ok() && record(quoteRequest) && quoteRequest.dry === true);
    await walletB.triggerSync(true);
    await walletB.refreshBalancesLanded(90_000);
    report.nativeBalanceUnchanged = (await vaultBalanceByFaucetId(walletB.page, state.native.faucetId)) === before;
    assert.equal(report.nativeBalanceUnchanged, true);
  } finally {
    report.checkpointUnchanged = hash() === expectedHash;
    writeFileSync('test-results/near-held-diagnostic.json', JSON.stringify(report), { mode: 0o600 });
    assert.equal(report.checkpointUnchanged, true);
  }
});
