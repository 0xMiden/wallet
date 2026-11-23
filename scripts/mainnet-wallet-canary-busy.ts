import { MainnetWalletCanaryLedger } from '../playwright/e2e/helpers/mainnet-wallet-canary-ledger';
import { canaryInteger } from '../playwright/e2e/helpers/mainnet-wallet-canary-plan';
import {
  walletCanarySourceFromEnvironment,
  writeWalletCanaryReport
} from '../playwright/e2e/reporting/wallet-canary-report';

function recordBusySlot() {
  const source = walletCanarySourceFromEnvironment();
  const ledger = new MainnetWalletCanaryLedger({
    directory: process.env.MAINNET_CANARY_STATE_DIR ?? '',
    account: process.env.MAINNET_CANARY_ACCOUNT ?? '',
    dailyFeeBaseUnits: canaryInteger(process.env.MAINNET_CANARY_DAILY_FEE_BASE_UNITS, 'daily native fee limit'),
    dailyLossUsdMicros: canaryInteger(process.env.MAINNET_CANARY_DAILY_LOSS_USD_MICROS, 'daily loss limit'),
    maxPrincipalUsdMicros: canaryInteger(process.env.MAINNET_CANARY_MAX_PRINCIPAL_USD_MICROS, 'order principal limit')
  });
  try {
    const blocked = ledger.recordRunnerBusy(process.env.MAINNET_CANARY_SLOT ?? '', source.runId, source.runAttempt);
    if (!blocked?.lineageId) return;
    const { slotStart, lineageId } = blocked;
    writeWalletCanaryReport(process.env.MAINNET_CANARY_REPORT_DIR ?? '', {
      source,
      original: { runId: source.runId, runAttempt: source.runAttempt, slotStart, lineageId },
      slot: {
        slotStart,
        status: 'blocked',
        reason: 'busy_wallet',
        admittedAt: null,
        submittedAt: null,
        usableReceiptAt: null,
        claimMode: null,
        runId: source.runId,
        runAttempt: source.runAttempt
      },
      observations: [],
      pair: null,
      terms: null
    });
  } finally {
    ledger.close();
  }
}

try {
  recordBusySlot();
} catch {
  console.error('Wallet canary lock contention could not be projected safely.');
  process.exitCode = 1;
}
