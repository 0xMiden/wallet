import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { auditNativeFileCapture, prepareNativeFileCapture } from './native-file-capture.mjs';
import { PrivatePerfetto } from './private-perfetto.mjs';

const END_MARKER_TIMEOUT_MS = 5_000;

function recordBoundary({ marker, requireProbe, useWalletProbe }) {
  const record = async () => {
    if (requireProbe) {
      if (useWalletProbe) {
        const probe = Reflect.get(globalThis, '__walletStressIdbProbe');
        if (typeof probe !== 'function') throw new Error('Required wallet IndexedDB probe is missing');
        await probe();
      } else {
        const database = await new Promise((resolve, reject) => {
          const open = indexedDB.open('playwright-native-trace-probe', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('probe');
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction('probe', 'readonly');
            transaction.objectStore('probe').count();
            transaction.oncomplete = resolve;
            transaction.onabort = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
      }
    }
    performance.mark(marker);
    performance.clearMarks(marker);
  };
  return record();
}

// At startup Chromium is still filling a private temporary file. The final
// packet audit runs after the browser closes and the file is renamed.
async function fileContainsMarkers(file, markers) {
  const labels = markers.map(marker => Buffer.from(marker));
  const pending = new Set(labels);
  const suffixSize = Math.max(...labels.map(label => label.length)) - 1;
  let suffix = Buffer.alloc(0);
  const initialBytes = (await stat(file)).size;
  if (!initialBytes) return false;
  for await (const chunk of createReadStream(file, { end: initialBytes - 1 })) {
    const bytes = suffix.length ? Buffer.concat([suffix, chunk]) : chunk;
    for (const label of pending) {
      if (bytes.includes(label)) pending.delete(label);
    }
    if (pending.size === 0) return true;
    suffix = bytes.subarray(Math.max(0, bytes.length - suffixSize));
  }
  return false;
}

export class NativeFileCaptureSession {
  static async prepare(dir, wallet) {
    if (process.platform !== 'linux') throw new Error('Direct native file capture requires Linux Chromium');
    const root = resolve(dir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const plan = await prepareNativeFileCapture(join(root, 'browser-0001'));
    const perfetto = await PrivatePerfetto.prepare(plan.file, process.env.STRESS_PERFETTO_BIN);
    return new NativeFileCaptureSession(root, wallet, plan, perfetto);
  }

  constructor(root, wallet, plan, perfetto) {
    this.root = root;
    this.wallet = wallet;
    this.plan = plan;
    this.perfetto = perfetto;
    this.args = ['--enable-features=EnablePerfettoSystemTracing'];
    this.env = perfetto.env;
    this.interrupted = false;
    this.verified = false;
    this.startedAt = 0;
    this.endedAt = 0;
  }

  markers(boundary) {
    return ['page', 'worker'].map(realm => `wallet.capture.run.${this.wallet}.${realm}.${boundary}`);
  }

  async log(event, fields = {}) {
    await appendFile(join(this.root, 'manifest.ndjson'),
      JSON.stringify({ event, timestamp: new Date().toISOString(), segment: 1, ...fields }) + '\n', { mode: 0o600 });
  }

  async start(page, worker, useWalletProbe = true) {
    const [pageMark, workerMark] = this.markers('start');
    await this.perfetto.start();
    await sleep(1_500);
    const limit = Date.now() + 20_000;
    do {
      this.perfetto.assertRunning();
      await Promise.all([
        page.evaluate(recordBoundary, { marker: pageMark, requireProbe: true, useWalletProbe }),
        worker.evaluate(recordBoundary, { marker: workerMark, requireProbe: true, useWalletProbe })
      ]);
      await sleep(1_000);
      if (await fileContainsMarkers(this.perfetto.pendingFile, [pageMark, workerMark])) {
        if (!useWalletProbe) {
          await page.evaluate(() => new Promise((resolve, reject) => {
            const remove = indexedDB.deleteDatabase('playwright-native-trace-probe');
            remove.onsuccess = resolve;
            remove.onerror = () => reject(remove.error);
          }));
        }
        this.startedAt = Date.now();
        this.verified = true;
        await this.log('verified', { startedAt: this.startedAt });
        return;
      }
      await sleep(500);
    } while (Date.now() < limit);
    throw new Error(`Wallet ${this.wallet} continuous capture startup markers are missing from the live file`);
  }

  assertHealthy() {
    if (!this.verified || this.interrupted || existsSync(this.plan.file)) {
      throw new Error(`Wallet ${this.wallet} continuous native capture is unavailable`);
    }
    this.perfetto.assertRunning();
  }

  interrupt() {
    this.interrupted = true;
  }

  async end(page, worker) {
    if (!this.verified || this.interrupted || this.endedAt) return;
    const [pageMark, workerMark] = this.markers('end');
    let timer;
    try {
      await Promise.race([
        Promise.all([
          page.evaluate(recordBoundary, { marker: pageMark, requireProbe: false }),
          worker.evaluate(recordBoundary, { marker: workerMark, requireProbe: false })
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Wallet capture end markers timed out')), END_MARKER_TIMEOUT_MS);
        })
      ]);
      this.endedAt = Date.now();
    } catch (error) {
      this.endMarkerError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async finish(contextClosed) {
    let stats;
    let problem;
    const required = [...this.markers('start'), ...this.markers('end')];
    try {
      // Save what Perfetto already recorded even if the browser could not mark the end.
      if (this.verified) await this.perfetto.save();
      if (!contextClosed || this.interrupted || !this.verified || !this.endedAt) {
        throw new Error(this.endMarkerError ?? 'Browser or workload closed with incomplete coverage');
      }
      stats = await auditNativeFileCapture(this.plan.file, `wallet.capture.run.${this.wallet}.`, true);
      if (!stats.streamingV2) throw new Error('Perfetto trace lacks the effective streaming buffer configuration');
      if (stats.flaggedLossPackets || stats.reportedBufferLoss) throw new Error('Perfetto reported lost trace packets');
      if (!required.every(mark => stats.markers.includes(mark))) throw new Error('Workload trace markers are missing');
      if (!stats.nativeEvents.includes('Transaction::CommitPhaseTwo.TransactionCompleteCallbacks')) {
        throw new Error('Required native IndexedDB events are missing');
      }
      await this.log('saved', { file: 'browser-0001/browser.pftrace', bytes: stats.bytes,
        startedAt: this.startedAt, endedAt: this.endedAt });
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Native trace audit failed';
      await this.log('capture-failed', { phase: 'finalization', reason: problem });
    } finally {
      await this.perfetto.close();
    }
    const complete = problem === undefined;
    await writeFile(join(this.root, 'summary.json'), JSON.stringify({
      format: 'perfetto-file', wallet: this.wallet, file: 'browser-0001/browser.pftrace',
      complete, verified: this.verified, finished: true, started: 1, saved: Number(complete),
      failures: Number(!complete), partial: !complete && existsSync(this.plan.file), problem, stats
    }) + '\n', { mode: 0o600 });
    return complete;
  }
}
