import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createRecoveryService } from './service.mjs';

test('st/main/cross-realm-storage-stop', async ({ browser }, testInfo) => {
  const binary = process.env.RECOVERY_FIXTURE_PRODUCER;
  if (!binary) throw new Error('producer-required');
  const service = await createRecoveryService(resolve(process.env.RECOVERY_PROOF_BUILD_ROOT || 'proof-dist/retained'), binary);
  const context = await browser.newContext();
  const password = randomBytes(32).toString('base64url');
  const report = { schema: 1, includePrivate: false, stage: 'initial', prepare: null, recover: null, outsideRequests: 0, phase: 'initial', service: null,
    workerEvents: { started: 0, closed: 0, assetRequests: 0, assetFailures: 0, assetNotFound: 0 },
    storageEvents: { open: 0, upgrade: 0, blocked: 0, success: 0, error: 0, txStart: 0, txComplete: 0, txAbort: 0, txError: 0, sdkTxStart: 0, sdkTxComplete: 0, otherTxStart: 0, otherTxComplete: 0, nativeMarker: 0, nativeOpen: 0, nativeDatabasesStart: 0, nativeDatabasesEnd: 0, nativeHeartbeat: 0 } };
  const phases = new Set(['initial','wasm-ready','genuine-chain-bootstrap','generated-protocol-fixtures','producer-response','endpoint-override','native-store-name','native-wasm-lookup','native-error-class','native-acquisition-gate','native-resolver','native-distinct-store','sdk-generated-request-images','real-password-protector','pre-loss-native-fixture','pre-loss-import','pre-loss-lock','pre-loss-client','sdk-create-worker','sdk-create-other','sdk-create-returned','sdk-factory-worker-available','sdk-factory-worker-absent','sdk-factory-returned','sdk-wasm-client-enter','sdk-wasm-client-returned','sdk-native-create-enter','sdk-native-create-returned','pre-loss-account-insert','pre-loss-account-read','retained-vault-baseline','cross-realm-ready','second-realm-setup','second-realm-ready']);
  const checks = {};
  async function pageReady() {
    const page = await context.newPage();
    await page.exposeBinding('__retainedStorageEvent', () => {});
    await page.exposeBinding('__retainedReportPhase', (_source, value) => { if (!phases.has(value)) throw new Error('closed-phase'); report.phase = value; });
    await page.goto(`${service.origin}/st/`);
    await page.waitForFunction(() => typeof window.__retainedProof?.prepare === 'function');
    return page;
  }
  async function invoke(page, operation, argument) {
    return page.evaluate(async ({ operation, argument }) => {
      try { return { ok: true, value: await window.__retainedProof[operation](argument) }; }
      catch { return { ok: false, phase: window.__retainedPhase || 'initial' }; }
    }, { operation, argument });
  }
  try {
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== service.origin) { report.outsideRequests++; return route.abort(); }
      return route.continue();
    });
    const first = await pageReady();
    report.stage = 'prepare';
    const prepared = await first.evaluate(async password => {
      try { return { ok: true, value: await window.__retainedProof.prepare(password, false) }; }
      catch { return { ok: false, phase: window.__retainedPhase || 'initial' }; }
    }, password);
    if (!prepared.ok) report.phase = prepared.phase;
    expect(prepared.ok, `first:${report.phase}`).toBe(true);
    checks.firstReady = prepared.value.phase === 'cross-realm-ready' && Object.values(prepared.value.checks).every(Boolean);
    const second = await pageReady();
    const attached = await invoke(second, 'attach', password);
    if (!attached.ok) report.phase = attached.phase;
    expect(attached.ok, `second:${report.phase}`).toBe(true);
    checks.secondReady = attached.value.phase === 'second-realm-ready' && Object.values(attached.value.checks).every(Boolean);
    checks.twoDistinctRealms = first !== second;
    expect(checks.firstReady && checks.secondReady && checks.twoDistinctRealms).toBe(true);
    report.prepare = { phase: 'second-realm-ready', checks: { ...checks } };
    const cancelled = await invoke(first, 'injectedWalletWrite', 'AbortError');
    expect(cancelled.ok).toBe(true);
    checks.abortInjected = cancelled.value.injected;
    checks.abortRejected = cancelled.value.rejected;
    checks.abortLocalHealthy = cancelled.value.healthy;
    checks.abortPeerHealthy = await second.evaluate(() => window.__retainedProof.status() === 'healthy');
    report.recover = { phase: 'second-realm-ready', checks: { ...checks } };
    expect(checks.abortInjected && checks.abortRejected && checks.abortLocalHealthy && checks.abortPeerHealthy).toBe(true);
    const failed = await invoke(first, 'injectedWalletWrite', 'QuotaExceededError');
    expect(failed.ok).toBe(true);
    checks.quotaInjected = failed.value.injected;
    checks.quotaRejected = failed.value.rejected;
    checks.quotaLocalUnavailable = failed.value.unavailable;
    report.recover = { phase: 'second-realm-ready', checks: { ...checks } };
    expect(checks.quotaInjected && checks.quotaRejected && checks.quotaLocalUnavailable).toBe(true);
    await second.waitForFunction(() => window.__retainedProof.status() === 'unavailable', null, { timeout: 5000 });
    checks.peerUnavailable = true;
    const blocked = await invoke(second, 'blockedWrites');
    expect(blocked.ok).toBe(true);
    Object.assign(checks, blocked.value);
    expect(Object.values(checks).every(Boolean)).toBe(true);
    expect(report.outsideRequests).toBe(0);
    report.recover = { phase: 'second-realm-ready', checks: { ...checks } };
    report.stage = 'complete';
  } finally {
    report.service = service.summary();
    await testInfo.attach('closed-recovery-observations', { body: JSON.stringify(report), contentType: 'application/json' });
    await context.close();
    await service.close();
  }
});
