import type { BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';

/** Re-register the unpacked build before testing so a reused profile cannot start with its previous worker. */
export async function reloadUnpackedExtension(
  context: BrowserContext,
  previousWorker: Worker,
  extensionPath: string
): Promise<Worker> {
  const workerUrl = previousWorker.url();
  const extensionId = new URL(workerUrl).host;
  const browser = context.browser();
  if (!browser) throw new Error('Reloading an unpacked extension requires a persistent Chromium context');
  const session = await browser.newBrowserCDPSession();
  try {
    const [worker] = await Promise.all([
      context.waitForEvent('serviceworker', {
        predicate: candidate => candidate !== previousWorker && candidate.url() === workerUrl,
        timeout: 60_000
      }),
      (async () => {
        // Explicitly load the selected files without uninstalling the extension or clearing profile storage.
        const loaded = await session.send('Extensions.loadUnpacked', { path: path.resolve(extensionPath) });
        if (loaded.id !== extensionId) throw new Error('Reloading the unpacked build changed its extension identity');
      })()
    ]);
    if (!context.serviceWorkers().includes(worker))
      throw new Error('The replacement extension worker closed during startup');
    return worker;
  } finally {
    await session.detach().catch(() => {});
  }
}
