import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const dexie = await readFile('node_modules/dexie/dist/dexie.mjs');
const server = createServer((request, response) => {
  if (request.url === '/dexie.mjs') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(dexie);
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Disposable storage measurement</title>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { default: Dexie } = await import('/dexie.mjs');
    const original = IDBDatabase.prototype.transaction;
    const observed = [];
    IDBDatabase.prototype.transaction = function (...args) {
      if (args[1] === 'readwrite') observed.push(args[2]?.durability ?? 'default');
      return Reflect.apply(original, this, args);
    };
    const names = ['disposable-strict', 'disposable-default'];
    const databases = [new Dexie(names[0], { chromeTransactionDurability: 'strict', modifyChunkSize: 25 }),
      new Dexie(names[1], { modifyChunkSize: 25 })];
    for (const db of databases) {
      db.version(1).stores({ transactions: 'id,accountId,initiatedAt,type', metadata: 'id' });
      await db.open();
    }
    const samples = { strict: [], default: [] };
    const payload = 'x'.repeat(1024);
    try {
      for (let round = 0; round < 120; round++) {
        const order = round % 2 === 0 ? [0, 1] : [1, 0];
        for (const i of order) {
          const db = databases[i];
          const start = performance.now();
          await db.transaction('rw', db.table('transactions'), db.table('metadata'), async () => {
            await db.table('transactions').put({ id: round, accountId: 'disposable', initiatedAt: round, type: 'send', payload });
            await db.table('metadata').put({ id: 'generation', generation: round });
          });
          const elapsed = performance.now() - start;
          if (round >= 20) samples[i === 0 ? 'strict' : 'default'].push(elapsed);
        }
      }
      const valid = await Promise.all(databases.map(async db =>
        (await db.table('transactions').count()) === 120 && (await db.table('metadata').get('generation'))?.generation === 119));
      return { samples, valid, observed };
    } finally {
      IDBDatabase.prototype.transaction = original;
      for (const db of databases) { db.close(); await db.delete(); }
    }
  });
  if (!result.valid.every(Boolean) || result.samples.strict.length !== 100 || result.samples.default.length !== 100 ||
      !result.observed.includes('strict') || !result.observed.includes('default') ||
      Object.values(result.samples).flat().some(value => !Number.isFinite(value) || value < 0)) throw new Error('measurement-invalid');
  const report = { source: process.env.WALLET_SOURCE, browser: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent),
    dexieSha256: createHash('sha256').update(dexie).digest('hex'), warmupPerMode: 20, sampleCountPerMode: 100,
    timing: 'wall time through committed Dexie two-table transaction, milliseconds', payloadBytes: 1024,
    strictTransactionCalls: result.observed.filter(value => value === 'strict').length,
    defaultTransactionCalls: result.observed.filter(value => value === 'default').length, samplesMs: result.samples };
  await writeFile('durability-distribution.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
