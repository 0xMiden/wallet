import * as fs from 'fs';
import * as path from 'path';

import type { BrowserContext, Page } from '@playwright/test';

import type { TimelineRecorder } from './timeline-recorder';
import type { WalletSnapshot } from './types';

/**
 * Capture wallet state from the extension page via page.evaluate().
 * Requires the extension to be built with MIDEN_E2E_TEST=true,
 * which exposes window.__TEST_STORE__ (Zustand store).
 */
export async function captureWalletSnapshot(
  page: Page,
  walletLabel: 'A' | 'B',
  extensionId: string,
  stepIndex: number,
  stepName: string,
  context: BrowserContext
): Promise<WalletSnapshot> {
  let walletState: WalletSnapshot['walletState'];
  let balances: WalletSnapshot['balances'];

  try {
    const storeData = await page.evaluate(() => {
      const store = (window as any).__TEST_STORE__;
      if (!store) return null;
      const s = store.getState();
      return {
        status: s.status,
        accounts: s.accounts?.map((a: any) => ({
          publicKey: a.publicKey,
          name: a.name,
        })),
        currentAccount: s.currentAccount
          ? { publicKey: s.currentAccount.publicKey, name: s.currentAccount.name }
          : null,
        balances: s.balances,
      };
    });

    if (storeData) {
      walletState = {
        status: storeData.status === 2 ? 'Ready' : storeData.status === 1 ? 'Locked' : 'Idle',
        accountCount: storeData.accounts?.length ?? 0,
        currentAccountPublicKey: storeData.currentAccount?.publicKey ?? null,
        currentAccountName: storeData.currentAccount?.name ?? null,
      };

      // Map balances from the store (keyed by address -> array of token balances)
      if (storeData.balances) {
        const allBalances: WalletSnapshot['balances'] = [];
        for (const tokenList of Object.values(storeData.balances) as any[]) {
          if (Array.isArray(tokenList)) {
            for (const token of tokenList) {
              allBalances.push({
                faucetId: token.faucetId ?? '',
                symbol: token.symbol ?? 'Unknown',
                amount: String(token.amount ?? token.balance ?? '0'),
              });
            }
          }
        }
        if (allBalances.length > 0) {
          balances = allBalances;
        }
      }
    }
  } catch {
    // page.evaluate may fail if page is navigating or closed
  }

  // Determine service worker status
  let serviceWorkerStatus: WalletSnapshot['serviceWorkerStatus'] = 'not_found';
  try {
    const workers = context.serviceWorkers();
    const extensionWorker = workers.find(w => new URL(w.url()).host === extensionId);
    serviceWorkerStatus = extensionWorker ? 'active' : 'inactive';
  } catch {
    // ignore
  }

  return {
    capturedAt: new Date().toISOString(),
    wallet: walletLabel,
    stepIndex,
    stepName,
    extensionId,
    walletState,
    balances,
    currentUrl: page.url(),
    serviceWorkerStatus,
  };
}

/**
 * Capture and save a wallet snapshot to disk, emitting a timeline event.
 */
export async function captureAndSaveSnapshot(
  page: Page,
  walletLabel: 'A' | 'B',
  extensionId: string,
  stepIndex: number,
  stepName: string,
  context: BrowserContext,
  outputDir: string,
  timeline: TimelineRecorder
): Promise<string> {
  const snapshot = await captureWalletSnapshot(page, walletLabel, extensionId, stepIndex, stepName, context);

  const snapshotsDir = path.join(outputDir, 'state-snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const filename = `step-${stepIndex}-${stepName}-wallet-${walletLabel.toLowerCase()}.json`;
  const filePath = path.join(snapshotsDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));

  timeline.emit({
    category: 'state_snapshot',
    severity: 'info',
    wallet: walletLabel,
    message: `State snapshot: wallet ${walletLabel} at step "${stepName}"`,
    data: {
      status: snapshot.walletState?.status,
      accountCount: snapshot.walletState?.accountCount,
      serviceWorkerStatus: snapshot.serviceWorkerStatus,
      filePath: filename,
    },
  });

  return filename;
}
