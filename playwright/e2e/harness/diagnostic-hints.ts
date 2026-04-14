import type { TestFailureReport } from './types';

/**
 * Compute diagnostic hints from a failure report.
 * These give an AI agent a starting hypothesis for root cause analysis.
 */
export function computeDiagnosticHints(report: TestFailureReport): string[] {
  const hints: string[] = [];

  // Timeout detection
  if (report.timing.wasTimeout) {
    hints.push(
      `TIMEOUT: Test hit timeout at step "${report.failedAtStep.name}" ` +
        `after ${report.timing.totalDurationMs}ms.`
    );
  }

  // Network failures
  if (report.failedNetworkRequests.length > 0) {
    const rpcFailures = report.failedNetworkRequests.filter(r => r.url.includes('rpc'));
    const transportFailures = report.failedNetworkRequests.filter(r => r.url.includes('transport'));

    if (rpcFailures.length > 0) {
      hints.push(
        `NETWORK: ${rpcFailures.length} RPC request(s) failed. The Miden node may be down or unreachable.`
      );
    }
    if (transportFailures.length > 0) {
      hints.push(
        `TRANSPORT: ${transportFailures.length} note transport request(s) failed. Private note delivery may be impacted.`
      );
    }
  }

  // WASM concurrency
  const wasmErrors = report.browserErrors.filter(
    e => e.message.includes('recursive use of an object') || e.message.includes('wasm')
  );
  if (wasmErrors.length > 0) {
    hints.push(
      'WASM: Detected WASM client concurrency errors ("recursive use of an object"). ' +
        'This is a known issue -- see CLAUDE.md section "WASM Client Concurrency".'
    );
  }

  // UI selector issues
  if (report.failureCategory === 'ui_element_not_found') {
    hints.push(
      `UI: A Playwright selector timed out at step "${report.failedAtStep.name}". ` +
        'Check if the page is in the expected state (onboarding vs main app) and if test-id attributes are present. ' +
        'Current URL: check stateAtFailure for both wallets.'
    );
  }

  // CLI failures
  const failedCli = report.recentCliCommands.filter(c => c.exitCode !== 0);
  if (failedCli.length > 0) {
    for (const cmd of failedCli) {
      hints.push(
        `CLI: "${cmd.command.split(/\s+/).slice(0, 4).join(' ')}" exited with code ${cmd.exitCode}. ` +
          `stderr: ${cmd.stderr.slice(0, 200)}`
      );
    }
  }

  // Slow sync detection
  const syncEvents = report.recentEvents.filter(
    e => e.category === 'blockchain_state' && e.message.includes('Waiting')
  );
  if (syncEvents.length > 10) {
    hints.push(
      `SLOW SYNC: ${syncEvents.length} sync poll attempts recorded. ` +
        'Blockchain sync may be slow due to network congestion or node lag.'
    );
  }

  // Extension crash
  if (report.failureCategory === 'extension_crash') {
    hints.push(
      'CRASH: The extension appears to have crashed. Check browserErrors for details. ' +
        'This may be caused by WASM OOM or service worker termination.'
    );
  }

  // Service worker status at failure
  const walletAState = report.stateAtFailure?.walletA;
  const walletBState = report.stateAtFailure?.walletB;
  if (walletAState?.serviceWorkerStatus === 'inactive' || walletBState?.serviceWorkerStatus === 'inactive') {
    hints.push(
      'SERVICE WORKER: One or more extension service workers are inactive at failure time. ' +
        'This could mean the extension crashed or was unloaded by Chrome.'
    );
  }

  // Balance mismatch
  if (
    report.failureCategory === 'assertion_value_mismatch' &&
    report.error.message.includes('balance')
  ) {
    hints.push(
      'BALANCE: Balance assertion failed. This is likely a sync timing issue -- ' +
        'the wallet may not have synced the latest blockchain state. ' +
        'Check the polling attempts in recentEvents.'
    );
  }

  if (hints.length === 0) {
    hints.push(
      `UNKNOWN: No specific diagnostic pattern matched for failure category "${report.failureCategory}". ` +
        'Review the timeline.ndjson and browser console logs for more context.'
    );
  }

  return hints;
}
