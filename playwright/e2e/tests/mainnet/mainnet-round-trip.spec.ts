import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  defaultAccountSecretsPath,
  defaultInviteCodesPath,
  readInviteCodes,
  writeAccountSecrets
} from '../../../../scripts/e2e-mainnet-accounts';
import { getEnvironmentConfig } from '../../config/environments';
import { expect, test } from '../../fixtures/two-wallets';
import type { GuardianAwareWalletPage } from '../../fixtures/two-wallets';
import {
  fromBaseUnits,
  pendingNoteTotal,
  vaultBalanceByFaucetId,
  waitForPendingNoteTotal,
  walletDiscoveredBaseFee,
  walletDiscoveredNativeFaucetId
} from '../../helpers/balance-truth';
import { landedVaultSample, roundTripReserve, TX_FEE_MULTIPLE } from '../../helpers/mainnet-bridge-plan';

const SEND_BASE_UNITS = 1n;

test.use({ injectFeeFaucet: false });
test.describe.configure({ mode: 'serial' });
test.skip(process.env.E2E_NETWORK !== 'mainnet', 'this spec spends long-lived mainnet accounts');

type NativeHolding = { faucetId: string; symbol: string; decimals: number; base: bigint };

async function nativeHolding(page: Page): Promise<NativeHolding> {
  const faucetId = await walletDiscoveredNativeFaucetId(page);
  if (!faucetId) throw new Error('the wallet has not discovered the native fee asset');
  const described = await page.evaluate(id => {
    const state = (
      window as unknown as {
        __TEST_STORE__?: {
          getState(): {
            balances?: Record<string, Array<{ tokenId?: string; metadata?: { symbol?: string; decimals?: number } }>>;
            assetsMetadata?: Record<string, { symbol?: string; decimals?: number }>;
          };
        };
      }
    ).__TEST_STORE__?.getState?.();
    let symbol = '';
    let decimals = Number.NaN;
    for (const list of Object.values(state?.balances ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const token of list) {
        if (token?.tokenId !== id) continue;
        const cached = state?.assetsMetadata?.[id];
        symbol = String(token?.metadata?.symbol ?? cached?.symbol ?? '');
        decimals = Number(token?.metadata?.decimals ?? cached?.decimals);
      }
    }
    return { symbol, decimals };
  }, faucetId);
  if (!described.symbol || !Number.isInteger(described.decimals) || described.decimals < 0) {
    throw new Error(`native asset ${faucetId} has no symbol or decimals`);
  }
  return {
    faucetId,
    symbol: described.symbol,
    decimals: described.decimals,
    base: await vaultBalanceByFaucetId(page, faucetId)
  };
}

async function discoveredFee(page: Page): Promise<number> {
  await expect.poll(async () => walletDiscoveredBaseFee(page), { timeout: 120_000 }).not.toBeNull();
  const fee = await walletDiscoveredBaseFee(page);
  if (fee === null || fee < 1) throw new Error(`fee discovery returned ${fee}; refusing to send`);
  return fee;
}

/** Same empty read `claimAllNotes` uses to skip Accept All. */
async function syncDataHasNotes(page: Page): Promise<boolean> {
  const pending = await page.evaluate(async () => {
    const storage = await new Promise<any>(resolve => {
      chrome.storage.local.get(['miden_sync_data'], resolve);
    });
    const notes = storage?.miden_sync_data?.notes;
    return Array.isArray(notes) ? notes.length : 0;
  });
  return pending > 0;
}

test.describe('registration', () => {
  test.skip(process.env.E2E_MAINNET_BOOTSTRAP !== '1', 'set E2E_MAINNET_BOOTSTRAP=1 to register the accounts once');

  test('register the two long-lived mainnet accounts', async ({ walletA, walletB }) => {
    test.setTimeout(1_200_000);
    const codes = readInviteCodes(
      readFileSync(process.env.E2E_MAINNET_INVITE_CODES ?? defaultInviteCodesPath(), 'utf8')
    );
    const out = process.env.E2E_MAINNET_SECRETS_OUT ?? defaultAccountSecretsPath();
    const plain = await walletA.createOnChainWallet(undefined, codes.plain);
    writeAccountSecrets(out, { plain: { address: plain.address, seed: plain.seedPhrase.join(' ') } });
    const guardian = await walletB.createGuardianWallet(getEnvironmentConfig().guardianUrl, undefined, codes.guardian);
    const keyPair = await walletB.revealHotKey();
    writeAccountSecrets(out, {
      plain: { address: plain.address, seed: plain.seedPhrase.join(' ') },
      guardian: { address: guardian.address, seed: guardian.seedPhrase.join(' '), keyPair }
    });
    expect(plain.address).toMatch(/^m[a-z]{1,4}1/i);
    expect(guardian.address).toMatch(/^m[a-z]{1,4}1/i);
    console.log(`plain ${plain.address}`);
    console.log(`guardian ${guardian.address}`);
  });
});

async function exchange(
  sender: GuardianAwareWalletPage,
  recipient: GuardianAwareWalletPage,
  holding: NativeHolding,
  perTx: bigint
): Promise<void> {
  const amount = fromBaseUnits(SEND_BASE_UNITS, holding.decimals);
  const senderAddress = await sender.getAccountAddress();
  const recipientAddress = await recipient.getAccountAddress();
  const senderBefore = await vaultBalanceByFaucetId(sender.page, holding.faucetId);
  const recipientBefore = await vaultBalanceByFaucetId(recipient.page, holding.faucetId);
  expect(senderBefore, `${senderAddress} cannot cover one ${holding.symbol} send`).toBeGreaterThanOrEqual(
    SEND_BASE_UNITS + perTx
  );
  await sender.sendTokens({
    recipientAddress,
    amount,
    isPrivate: false,
    tokenId: holding.faucetId
  });
  await waitForPendingNoteTotal(recipient.page, holding.symbol, SEND_BASE_UNITS, {
    timeoutMs: 180_000,
    decimals: holding.decimals,
    diagnoseFrom: sender.page
  });
  const drop = senderBefore - (await vaultBalanceByFaucetId(sender.page, holding.faucetId));
  expect(drop, `${senderAddress} ${holding.symbol} debit`).toBeGreaterThanOrEqual(SEND_BASE_UNITS);
  expect(drop, `${senderAddress} ${holding.symbol} debit above the fee budget`).toBeLessThanOrEqual(
    SEND_BASE_UNITS + perTx
  );
  await recipient.claimAllNotes();
  await expect.poll(async () => pendingNoteTotal(recipient.page, holding.symbol), { timeout: 180_000 }).toBe(0n);
  const gained = (await vaultBalanceByFaucetId(recipient.page, holding.faucetId)) - recipientBefore;
  expect(gained, `${recipientAddress} gained more than the payment`).toBeLessThanOrEqual(SEND_BASE_UNITS);
  expect(gained, `${recipientAddress} lost more than the fee budget claiming`).toBeGreaterThanOrEqual(
    SEND_BASE_UNITS - perTx
  );
}

test.describe('nightly round trip', () => {
  test.skip(process.env.E2E_MAINNET_BOOTSTRAP === '1', 'registration does not spend');

  test('plain and guardian exchange one base unit of the native asset', async ({ walletA, walletB }) => {
    test.setTimeout(2_700_000);
    const seed = process.env.E2E_MAINNET_PLAIN_SEED;
    const keyPair = process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR;
    if (!seed || !keyPair) throw new Error('E2E_MAINNET_PLAIN_SEED or E2E_MAINNET_GUARDIAN_KEY_PAIR is unset');

    const plain = await walletA.importOnChainWallet(seed.trim().split(/\s+/));
    await walletB.recoverGuardianFromHotKey(keyPair.trim());
    const guardianAddress = await walletB.getAccountAddress();

    await walletA.triggerSync(true);
    await walletB.triggerSync(true);
    // A top-up sits in Pending until the account consumes it, and the vault check below does not
    // count Pending. The product wallet cannot claim for the plain account, so this job consumes
    // both accounts before it judges the balance. The leftover claim is already inside the
    // reserve; subtract it only when that wallet had notes to drain, so a skip cannot pass one
    // transaction budget below the two-night figure.
    const fundingConsumePaidA = await syncDataHasNotes(walletA.page);
    await walletA.claimAllNotes(600_000);
    const fundingConsumePaidB = await syncDataHasNotes(walletB.page);
    await walletB.claimAllNotes(600_000);
    const fee = await discoveredFee(walletA.page);
    const oneTx = TX_FEE_MULTIPLE * BigInt(fee);
    const requiredA = roundTripReserve(SEND_BASE_UNITS, BigInt(fee), fundingConsumePaidA);
    const requiredB = roundTripReserve(SEND_BASE_UNITS, BigInt(fee), fundingConsumePaidB);
    const faucetId = await walletDiscoveredNativeFaucetId(walletA.page);
    if (!faucetId) throw new Error('the wallet has not discovered the native fee asset');
    // fetchBalances returns immediately when a read for that account is already running, so one
    // refresh after the claim can still see the pre-claim vault. A non-land resolves the sentinel
    // so this poll continues.
    await expect
      .poll(
        () =>
          landedVaultSample(
            () => walletA.refreshBalances(),
            () => vaultBalanceByFaucetId(walletA.page, faucetId)
          ),
        { timeout: 60_000, message: `plain ${plain.address} native balance stayed short of ${requiredA}` }
      )
      .toBeGreaterThanOrEqual(requiredA);
    await expect
      .poll(
        () =>
          landedVaultSample(
            () => walletB.refreshBalances(),
            () => vaultBalanceByFaucetId(walletB.page, faucetId)
          ),
        { timeout: 60_000, message: `guardian ${guardianAddress} native balance stayed short of ${requiredB}` }
      )
      .toBeGreaterThanOrEqual(requiredB);
    const plainHolding = await nativeHolding(walletA.page);
    const guardianHolding = await nativeHolding(walletB.page);
    expect(guardianHolding.faucetId).toBe(plainHolding.faucetId);

    const before = {
      plain: await vaultBalanceByFaucetId(walletA.page, plainHolding.faucetId),
      guardian: await vaultBalanceByFaucetId(walletB.page, plainHolding.faucetId)
    };
    await exchange(walletA, walletB, plainHolding, oneTx);
    await exchange(walletB, walletA, plainHolding, oneTx);
    const after = {
      plain: await vaultBalanceByFaucetId(walletA.page, plainHolding.faucetId),
      guardian: await vaultBalanceByFaucetId(walletB.page, plainHolding.faucetId)
    };

    mkdirSync('test-results', { recursive: true });
    writeFileSync(
      'test-results/mainnet-spend.json',
      `${JSON.stringify(
        {
          asset: plainHolding.faucetId,
          symbol: plainHolding.symbol,
          sentBaseUnits: SEND_BASE_UNITS.toString(),
          verificationBaseFee: fee,
          plain: { address: plain.address, before: before.plain.toString(), after: after.plain.toString() },
          guardian: { address: guardianAddress, before: before.guardian.toString(), after: after.guardian.toString() }
        },
        null,
        2
      )}\n`
    );
  });
});
