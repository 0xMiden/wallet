import * as fs from 'fs';
import * as path from 'path';

import type { TimelineRecorder } from './timeline-recorder';
import type { SnapshotCaps, WalletSnapshot } from './types';

/**
 * Capture wallet state via platform-neutral capabilities. The fixture supplies
 * caps that close over the platform-specific page/context (Chrome
 * Page+BrowserContext, iOS CdpSession), so this module never imports
 * Playwright or any other runtime.
 */
export async function captureWalletSnapshot(
  caps: SnapshotCaps,
  walletLabel: 'A' | 'B',
  stepIndex: number,
  stepName: string
): Promise<WalletSnapshot> {
  let walletState: WalletSnapshot['walletState'];
  let balances: WalletSnapshot['balances'];

  try {
    const storeData = await caps.readStore();
    if (storeData) {
      const status = storeData.status;
      walletState = {
        status: status === 2 ? 'Ready' : status === 1 ? 'Locked' : String(status ?? 'Idle'),
        accountCount: storeData.accounts?.length ?? 0,
        currentAccountPublicKey: storeData.currentAccount?.publicKey ?? null,
        currentAccountName: storeData.currentAccount?.name ?? null,
      };

      if (storeData.balances) {
        const allBalances: NonNullable<WalletSnapshot['balances']> = [];
        for (const tokenList of Object.values(storeData.balances) as unknown[]) {
          if (Array.isArray(tokenList)) {
            for (const token of tokenList as Array<Record<string, unknown>>) {
              allBalances.push({
                faucetId: String(token.faucetId ?? ''),
                symbol: String(token.symbol ?? 'Unknown'),
                amount: String(token.amount ?? token.balance ?? '0'),
              });
            }
          }
        }
        if (allBalances.length > 0) balances = allBalances;
      }
    }
  } catch {
    // readStore may fail if the page is navigating or closed
  }

  let serviceWorkerStatus: WalletSnapshot['serviceWorkerStatus'];
  if (caps.serviceWorkerStatus) {
    try {
      serviceWorkerStatus = await caps.serviceWorkerStatus();
    } catch {
      serviceWorkerStatus = 'not_found';
    }
  }

  let currentUrl = '';
  try {
    currentUrl = await caps.currentUrl();
  } catch {
    // page closed, leave empty
  }

  return {
    capturedAt: new Date().toISOString(),
    wallet: walletLabel,
    stepIndex,
    stepName,
    platform: caps.platform,
    runtimeVersion: caps.runtimeVersion,
    extensionId: caps.extensionId,
    walletState,
    balances,
    currentUrl,
    serviceWorkerStatus,
  };
}

/**
 * Capture and save a wallet snapshot to disk, emitting a timeline event.
 */
export async function captureAndSaveSnapshot(
  caps: SnapshotCaps,
  walletLabel: 'A' | 'B',
  stepIndex: number,
  stepName: string,
  outputDir: string,
  timeline: TimelineRecorder
): Promise<string> {
  const snapshot = await captureWalletSnapshot(caps, walletLabel, stepIndex, stepName);

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
