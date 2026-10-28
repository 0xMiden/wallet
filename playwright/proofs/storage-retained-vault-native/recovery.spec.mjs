import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { createRecoveryService } from './service.mjs';

const phases = new Set([
  'initial',
  'wasm-ready',
  'genuine-chain-bootstrap',
  'generated-protocol-fixtures',
  'producer-response',
  'endpoint-override',
  'native-store-name',
  'native-wasm-lookup',
  'native-error-class',
  'native-acquisition-gate',
  'native-resolver',
  'native-distinct-store',
  'sdk-generated-request-images',
  'real-password-protector',
  'pre-loss-native-fixture',
  'pre-loss-import',
  'pre-loss-lock',
  'pre-loss-client',
  'sdk-create-worker',
  'sdk-create-other',
  'sdk-create-returned',
  'sdk-factory-worker-available',
  'sdk-factory-worker-absent',
  'sdk-factory-returned',
  'sdk-wasm-client-enter',
  'sdk-wasm-client-returned',
  'sdk-native-create-enter',
  'sdk-native-create-returned',
  'pre-loss-account-insert',
  'pre-loss-account-read',
  'pre-loss-note-read',
  'retained-vault-baseline',
  'orderly-sdk-disposal',
  'disposable-sdk-store-loss',
  'restart-real-vault',
  'detect-sdk-loss',
  'actual-missing-account-recovery'
]);
const checkNames = new Set([
  'distinctSdkStore',
  'producerBound',
  'initialHealthy',
  'nonExtractableVaultKey',
  'preLossRealAccount',
  'preLossAuthenticatedPrivate',
  'baselineEstablished',
  'retainedAccountFloor',
  'retainedPrivateScope',
  'deleteOnlySdk',
  'physicalSdkMissing',
  'sdkMissingBeforeRecovery',
  'continuityRefused',
  'unavailableAfterLoss',
  'encryptedJournalSurvived',
  'missingAccountGuardianBranch',
  'recoveredAccountVerified',
  'priorRequiredEvidenceRetained',
  'recovered',
  'healthyAfterRecovery',
  'rebuiltNativeAccount',
  'rebuiltAuthenticatedPrivate'
]);
function safeReport(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !phases.has(value.phase) ||
    !value.checks ||
    Object.entries(value.checks).some(([name, state]) => !checkNames.has(name) || typeof state !== 'boolean')
  )
    throw new Error('closed-report');
  return { phase: value.phase, checks: value.checks };
}
async function installPage(context, report, service) {
  const page = await context.newPage();
  await page.exposeBinding('__retainedStorageEvent', (_source, value) => {
    if (!Object.hasOwn(report.storageEvents, value)) throw new Error('storage-event-bound');
    report.storageEvents[value]++;
  });
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      window.__retainedStorageEvent('open').catch(() => {});
      if (window.__retainedNativeCreating) window.__retainedStorageEvent('nativeOpen').catch(() => {});
      const request = Reflect.apply(original, this, args);
      for (const [event, name] of [
        ['upgradeneeded', 'upgrade'],
        ['blocked', 'blocked'],
        ['success', 'success'],
        ['error', 'error']
      ]) request.addEventListener(event, () => window.__retainedStorageEvent(name).catch(() => {}));
      return request;
    };
    const originalDatabases = IDBFactory.prototype.databases;
    if (originalDatabases) IDBFactory.prototype.databases = function (...args) {
      const native = window.__retainedNativeCreating;
      if (native) window.__retainedStorageEvent('nativeDatabasesStart').catch(() => {});
      return Reflect.apply(originalDatabases, this, args).finally(() => {
        if (native) window.__retainedStorageEvent('nativeDatabasesEnd').catch(() => {});
      });
    };
    const originalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      window.__retainedStorageEvent('txStart').catch(() => {});
      const category = window.__retainedNativeCreating
        ? this.name === window.__retainedSdkStore ? 'sdk' : 'other'
        : null;
      if (category) window.__retainedStorageEvent(category + 'TxStart').catch(() => {});
      const transaction = Reflect.apply(originalTransaction, this, args);
      if (category) transaction.addEventListener('complete', () => window.__retainedStorageEvent(category + 'TxComplete').catch(() => {}));
      for (const [event, name] of [
        ['complete', 'txComplete'],
        ['abort', 'txAbort'],
        ['error', 'txError']
      ]) transaction.addEventListener(event, () => window.__retainedStorageEvent(name).catch(() => {}));
      return transaction;
    };
  });
  page.on('worker', worker => {
    report.workerEvents.started++;
    worker.on('close', () => report.workerEvents.closed++);
  });
  const workerAsset = url => {
    try {
      return /worker|\.wasm$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  };
  context.on('request', request => {
    if (workerAsset(request.url())) report.workerEvents.assetRequests++;
  });
  context.on('requestfailed', request => {
    if (workerAsset(request.url())) report.workerEvents.assetFailures++;
  });
  context.on('response', response => {
    if (workerAsset(response.url()) && response.status() === 404) report.workerEvents.assetNotFound++;
  });
  await page.exposeBinding('__retainedReportPhase', (_source, value) => {
    if (!phases.has(value)) throw new Error('phase-bound');
    report.phase = value;
    console.log('retained-proof-phase=' + value);
  });
  await page.goto(`${service.origin}/st/`);
  await page.waitForFunction(() => typeof window.__retainedProof?.prepare === 'function');
  return page;
}
for (const variant of ['fresh-sdk', 'isolated-callbacks']) {
  const includePrivate = variant !== 'post-fixture';
  test(`st/main/comparison/${variant}`, async ({
    browser
  }, testInfo) => {
    const binary = process.env.RECOVERY_FIXTURE_PRODUCER;
    if (!binary) throw new Error('producer-required');
    const service = await createRecoveryService(
      resolve(process.env.RECOVERY_PROOF_BUILD_ROOT || 'proof-dist/retained'),
      binary
    );
    const context = await browser.newContext();
    const password = randomBytes(32).toString('base64url');
    const report = {
      schema: 1,
      includePrivate,
      stage: 'initial',
      prepare: null,
      recover: null,
      outsideRequests: 0,
      workerEvents: { started: 0, closed: 0, assetRequests: 0, assetFailures: 0, assetNotFound: 0 },
      storageEvents: { open: 0, upgrade: 0, blocked: 0, success: 0, error: 0, txStart: 0, txComplete: 0, txAbort: 0, txError: 0, sdkTxStart: 0, sdkTxComplete: 0, otherTxStart: 0, otherTxComplete: 0, nativeMarker: 0, nativeOpen: 0, nativeDatabasesStart: 0, nativeDatabasesEnd: 0, nativeHeartbeat: 0, diagnosticStorageFailure: 0, diagnosticAcquisition: 0 },
      phase: 'initial',
      service: null
    };
    try {
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== service.origin) {
          report.outsideRequests++;
          return route.abort();
        }
        return route.continue();
      });
      const page = await installPage(context, report, service);
      report.stage = 'prepare';
      const setup = await page.evaluate(async ({ password }) => {
        try {
          return { ok: true, value: await window.__retainedProof.prepare(password, false, true) };
        } catch {
          return { ok: false, phase: window.__retainedPhase || 'initial' };
        }
      }, { password });
      report.phase = setup.ok ? 'sdk-generated-request-images' : setup.phase;
      expect(setup.ok, `setup:${report.phase}`).toBe(true);
      let comparisonContext;
      try {
        let comparisonPage = page;
        if (includePrivate) {
          comparisonContext = await browser.newContext();
          await comparisonContext.route('**/*', route => {
            if (new URL(route.request().url()).origin !== service.origin) {
              report.outsideRequests++;
              return route.abort();
            }
            return route.continue();
          });
          comparisonPage = await installPage(comparisonContext, report, service);
        }
        report.stage = 'compare';
        const result = await comparisonPage.evaluate(async ({ feeFaucetId, fresh, directSdk, isolatedCallbacks }) => {
          try {
            return { ok: true, value: await window.__retainedProof.compareClient(feeFaucetId, fresh, directSdk, isolatedCallbacks) };
          } catch {
            return { ok: false, phase: window.__retainedPhase || 'initial' };
          }
        }, { feeFaucetId: setup.value.feeFaucetId, fresh: includePrivate, directSdk: true, isolatedCallbacks: variant === 'isolated-callbacks' });
        report.phase = result.ok ? result.value.phase : result.phase;
        expect(result.ok, `compare:${report.phase}`).toBe(true);
        report.prepare = { phase: result.value.phase, checks: result.value.checks };
        expect(report.prepare.checks.comparisonCreated).toBe(true);
        report.stage = 'complete';
      } finally {
        if (comparisonContext) await comparisonContext.close();
      }
    } finally {
      report.service = service.summary();
      if (!phases.has(report.phase)) report.phase = 'initial';
      await testInfo.attach('closed-recovery-observations', {
        body: JSON.stringify(report),
        contentType: 'application/json'
      });
      await context.close();
      await service.close();
    }
  });
}
