import type { Page, TestInfo } from '@playwright/test';

const stages = new Set([
  'after-actual-async-dispose',
  'after-bootstrap-idle',
  'after-dispose',
  'after-health-initialize',
  'after-raw-async-dispose',
  'after-reader-idle',
  'after-wallet-idle',
  'after-wasm-ready',
  'asset-http-failure',
  'asset-request-failed',
  'before-actual-async-dispose',
  'before-bootstrap-idle',
  'before-dispose',
  'before-health-initialize',
  'before-raw-async-dispose',
  'before-reader-idle',
  'before-wallet-idle',
  'before-wasm-ready',
  'bootstrap-native-mock',
  'bootstrap-supported-import',
  'bounded-durability-measurement',
  'case-finished',
  'case-start',
  'cleanup',
  'initializing',
  'native-request-success-then-abort',
  'normal-wallet-create',
  'page-error',
  'public-wallet-reader',
  'worker-close',
  'worker-open'
]);

export async function installMatrixProgress(page: Page, caseId: string) {
  const started = Date.now();
  let sequence = 0;
  let latest = 'case-start';
  const publish = (stage: string) => {
    if (!stages.has(stage) || sequence >= 96) return;
    latest = stage;
    console.info(
      'MATRIX_PROGRESS ' + JSON.stringify({ caseId, sequence: sequence++, stage, elapsedMs: Date.now() - started })
    );
  };
  const isAsset = (url: string) => {
    try {
      return /(?:worker|\.wasm|workerHelpers|wbg_rayon)/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  };
  await page.exposeBinding('__WALLET_MATRIX_PROGRESS__', (source, value: unknown) => {
    if (source.frame === page.mainFrame() && typeof value === 'string') publish(value);
  });
  page.on('worker', worker => {
    publish('worker-open');
    worker.on('close', () => publish('worker-close'));
  });
  page.on('pageerror', () => publish('page-error'));
  page.on('requestfailed', request => {
    if (isAsset(request.url())) publish('asset-request-failed');
  });
  page.on('response', response => {
    if (response.status() >= 400 && isAsset(response.url())) publish('asset-http-failure');
  });
  publish('case-start');
  return {
    finish(status: TestInfo['status']) {
      console.info(
        'MATRIX_TERMINAL ' + JSON.stringify({ caseId, latest, sequence, status, elapsedMs: Date.now() - started })
      );
    }
  };
}
