import type { Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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

type AssetObservation = {
  category: 'rayon-helper' | 'method-worker' | 'wasm' | 'worker-other';
  httpStatus: number | null;
  pathShape: 'mode-assets-assets' | 'mode-assets' | 'mode-other' | 'outside-mode';
  pathnameSha256: string;
  serverRelativeSha256: string;
  serverPathWithinRoot: boolean;
  serverFileExists: boolean;
  queryPresent: boolean;
  hashPresent: boolean;
  sameOrigin: boolean;
};

export async function installMatrixProgress(page: Page, caseId: string, buildRoot: string) {
  const started = Date.now();
  let sequence = 0;
  let latest = 'case-start';
  const publish = (stage: string, asset?: AssetObservation) => {
    if (!stages.has(stage) || sequence >= 96) return;
    latest = stage;
    console.info(
      'MATRIX_PROGRESS ' +
        JSON.stringify({
          caseId,
          sequence: sequence++,
          stage,
          elapsedMs: Date.now() - started,
          ...(asset ? { asset } : {})
        })
    );
  };
  const isAsset = (url: string) => {
    try {
      return /(?:worker|\.wasm|workerHelpers|wbg_rayon)/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  };
  const assetObservation = (rawUrl: string, httpStatus: number | null): AssetObservation => {
    const url = new URL(rawUrl);
    const serverPath = resolve(buildRoot, `.${url.pathname}`);
    const serverPathWithinRoot = serverPath.startsWith(buildRoot);
    let serverFileExists = false;
    if (serverPathWithinRoot) {
      try {
        serverFileExists = statSync(serverPath).isFile();
      } catch {
        serverFileExists = false;
      }
    }
    return {
      category: /workerHelpers|wbg_rayon/i.test(url.pathname)
        ? 'rayon-helper'
        : /web-client-methods-worker/i.test(url.pathname)
          ? 'method-worker'
          : /\.wasm$/i.test(url.pathname)
            ? 'wasm'
            : 'worker-other',
      httpStatus,
      pathShape: /^\/(st|mt)\/assets\/assets\//.test(url.pathname)
        ? 'mode-assets-assets'
        : /^\/(st|mt)\/assets\//.test(url.pathname)
          ? 'mode-assets'
          : /^\/(st|mt)\//.test(url.pathname)
            ? 'mode-other'
            : 'outside-mode',
      pathnameSha256: createHash('sha256').update(url.pathname).digest('hex'),
      serverRelativeSha256: createHash('sha256').update(relative(buildRoot, serverPath)).digest('hex'),
      serverPathWithinRoot,
      serverFileExists,
      queryPresent: url.search.length > 0,
      hashPresent: url.hash.length > 0,
      sameOrigin: url.origin === new URL(page.url()).origin
    };
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
    if (isAsset(request.url())) publish('asset-request-failed', assetObservation(request.url(), null));
  });
  page.on('response', response => {
    if (response.status() >= 400 && isAsset(response.url())) {
      publish('asset-http-failure', assetObservation(response.url(), response.status()));
    }
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
