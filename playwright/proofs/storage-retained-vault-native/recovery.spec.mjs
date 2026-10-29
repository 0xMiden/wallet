import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createRecoveryService } from './service.mjs';

test('st/main/retained-vault/journal-entry-capacity', async ({ browser }, testInfo) => {
  const binary = process.env.RECOVERY_FIXTURE_PRODUCER;
  if (!binary) throw new Error('producer-required');
  const service = await createRecoveryService(resolve(process.env.RECOVERY_PROOF_BUILD_ROOT || 'proof-dist/retained'), binary);
  const context = await browser.newContext();
  const password = randomBytes(32).toString('base64url');
  const report = { schema: 1, includePrivate: false, stage: 'initial', prepare: null, recover: null, outsideRequests: 0, phase: 'initial', service: null,
    workerEvents: { started: 0, closed: 0, assetRequests: 0, assetFailures: 0, assetNotFound: 0 },
    storageEvents: { open: 0, upgrade: 0, blocked: 0, success: 0, error: 0, txStart: 0, txComplete: 0, txAbort: 0, txError: 0, sdkTxStart: 0, sdkTxComplete: 0, otherTxStart: 0, otherTxComplete: 0, nativeMarker: 0, nativeOpen: 0, nativeDatabasesStart: 0, nativeDatabasesEnd: 0, nativeHeartbeat: 0 } };
  const phases = new Set(['initial','wasm-ready','genuine-chain-bootstrap','generated-protocol-fixtures','producer-response','endpoint-override','native-store-name','native-wasm-lookup','native-error-class','native-acquisition-gate','native-resolver','native-distinct-store','sdk-generated-request-images','real-password-protector','pre-loss-native-fixture','pre-loss-import','pre-loss-lock','pre-loss-client','sdk-create-worker','sdk-create-other','sdk-create-returned','sdk-factory-worker-available','sdk-factory-worker-absent','sdk-factory-returned','sdk-wasm-client-enter','sdk-wasm-client-returned','sdk-native-create-enter','sdk-native-create-returned','pre-loss-account-insert','pre-loss-account-read','retained-vault-baseline','capacity-baseline','capacity-refusal']);
  try {
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== service.origin) { report.outsideRequests++; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    await page.exposeBinding('__retainedStorageEvent', () => {});
    await page.exposeBinding('__retainedReportPhase', (_source, value) => { if (!phases.has(value)) throw new Error('closed-phase'); report.phase = value; });
    await page.goto(`${service.origin}/st/`);
    await page.waitForFunction(() => typeof window.__retainedProof?.prepare === 'function');
    report.stage = 'prepare';
    const result = await page.evaluate(async password => {
      try { return { ok: true, value: await window.__retainedProof.prepare(password, false) }; }
      catch { return { ok: false, phase: window.__retainedPhase || 'initial' }; }
    }, password);
    if (!result.ok) report.phase = result.phase;
    expect(result.ok, `journal:${report.phase}`).toBe(true);
    if (!result.value || !phases.has(result.value.phase) || Object.values(result.value.checks).some(value => typeof value !== 'boolean')) throw new Error('closed-result');
    report.prepare = { phase: result.value.phase, checks: { ...result.value.checks } };
    report.recover = { phase: result.value.phase, checks: { ...result.value.checks } };
    expect(Object.values(result.value.checks).every(Boolean)).toBe(true);
    expect(report.outsideRequests).toBe(0);
    expect(service.summary().submitCalls).toBe(0);
    report.stage = 'complete';
  } finally {
    report.service = service.summary();
    await testInfo.attach('closed-recovery-observations', { body: JSON.stringify(report), contentType: 'application/json' });
    await context.close();
    await service.close();
  }
});
