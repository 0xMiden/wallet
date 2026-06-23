import * as fs from 'fs';

/**
 * Store-at-a-time source of IndexedDB data. Implemented structurally by
 * ChromeWalletPage. The streamer below pulls ONE store at a time so peak
 * memory stays bounded — the old whole-DB-in-one-string dump OOM-killed long
 * stress runs (see streamIndexedDBToFile).
 */
export interface IdbDumpSource {
  /** Enumerate every (db, store) on the origin. Cheap — loads no row data. */
  listIndexedDBStores(): Promise<Array<{ db: string; version: number; store: string }>>;
  /**
   * Read ONE object store as a JSON array string (binary/BigInt wrapped),
   * capped at `maxRows`. `truncated` is true when the cap was hit and rows
   * may have been dropped.
   */
  dumpIndexedDBStore(
    db: string,
    store: string,
    maxRows: number
  ): Promise<{ json: string; count: number; truncated: boolean }>;
}

export interface IdbDumpResult {
  file: string;
  storesDumped: number;
  storesFailed: number;
  entriesDumped: number;
  truncatedStores: string[];
  errors: Array<{ db: string; store: string; message: string }>;
}

interface StreamOpts {
  /** Hard ceiling on rows pulled per store, bounding peak in-page memory. */
  maxRowsPerStore?: number;
}

const DEFAULT_MAX_ROWS_PER_STORE = 200_000;

/**
 * Stream every IndexedDB store to `filePath` as a single JSON object, ONE
 * store at a time. Peak memory is bounded to a single store's rows — the old
 * `Promise.all([A.dumpIndexedDB(), B.dumpIndexedDB()])` path serialized BOTH
 * full DBs into in-page strings at once and tripped the OOM killer on the
 * stress runner.
 *
 * Partial progress is preserved: a store that throws (including the page
 * dying mid-dump) is recorded as `{ "__error": ... }` in place of its array,
 * and the file is always closed as valid JSON containing every store dumped
 * before the failure.
 *
 * Output shape:
 *   {
 *     "<db>": { "version": N, "stores": { "<store>": [ ...rows ] } },
 *     "__meta": { storesDumped, storesFailed, entriesDumped, truncatedStores, errors }
 *   }
 */
export async function streamIndexedDBToFile(
  source: IdbDumpSource,
  filePath: string,
  opts: StreamOpts = {}
): Promise<IdbDumpResult> {
  const maxRows = opts.maxRowsPerStore ?? DEFAULT_MAX_ROWS_PER_STORE;
  const result: IdbDumpResult = {
    file: filePath,
    storesDumped: 0,
    storesFailed: 0,
    entriesDumped: 0,
    truncatedStores: [],
    errors: []
  };

  // List first — if this throws, nothing has been written yet, so just
  // propagate to the caller (which logs and moves on).
  const stores = await source.listIndexedDBStores();

  // Group by db, preserving discovery order for both dbs and stores.
  const byDb = new Map<string, { version: number; stores: string[] }>();
  for (const s of stores) {
    let entry = byDb.get(s.db);
    if (!entry) {
      entry = { version: s.version, stores: [] };
      byDb.set(s.db, entry);
    }
    entry.stores.push(s.store);
  }

  const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
  let streamError: Error | null = null;
  out.on('error', e => {
    streamError = e as Error;
  });
  // Await each write's flush callback so buffering stays bounded to ~one
  // chunk even when the consumer (disk) is slower than the producer.
  const write = (chunk: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (streamError) {
        reject(streamError);
        return;
      }
      out.write(chunk, err => (err ? reject(err) : resolve()));
    });

  try {
    await write('{\n');
    let firstDb = true;
    for (const [db, { version, stores: storeNames }] of byDb) {
      await write(
        `${firstDb ? '' : ',\n'}${JSON.stringify(db)}: {\n"version": ${JSON.stringify(version)},\n"stores": {\n`
      );
      firstDb = false;
      let firstStore = true;
      for (const store of storeNames) {
        await write(`${firstStore ? '' : ',\n'}${JSON.stringify(store)}: `);
        firstStore = false;
        try {
          const { json, count, truncated } = await source.dumpIndexedDBStore(db, store, maxRows);
          await write(json);
          result.storesDumped += 1;
          result.entriesDumped += count;
          if (truncated) result.truncatedStores.push(`${db}/${store}`);
        } catch (e) {
          result.storesFailed += 1;
          const message = e instanceof Error ? e.message : String(e);
          result.errors.push({ db, store, message });
          // Keep the file valid JSON: error sentinel in place of the array.
          await write(JSON.stringify({ __error: message }));
        }
      }
      await write('\n}\n}');
    }
    await write(
      `${byDb.size ? ',\n' : ''}"__meta": ${JSON.stringify({
        storesDumped: result.storesDumped,
        storesFailed: result.storesFailed,
        entriesDumped: result.entriesDumped,
        truncatedStores: result.truncatedStores,
        errors: result.errors
      })}\n}\n`
    );
  } finally {
    await new Promise<void>(resolve => out.end(resolve));
  }

  return result;
}
