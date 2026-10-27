// @ts-nocheck
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

let server;
let origin;
const root = resolve(import.meta.dirname, "../dist");

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>IndexedDB safety</title>");
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader(
        "Content-Type",
        extname(file) === ".wasm" ? "application/wasm" : "text/javascript"
      );
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const workerProbe = `
const originalIdbTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (...args) {
  const tx = originalIdbTransaction.apply(this, args);
  if (tx.mode === "readwrite") self.postMessage({ storageProbe: { durability: tx.durability, storeName: this.name } });
  return tx;
};
`;

async function prepare(page, build, entry, workerMode) {
  await page.route(
    "**/workers/web-client-methods-worker*.js",
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: workerProbe + (await response.text()),
      });
    }
  );
  await page.goto(origin);
  return page.evaluate(
    async ({ build, entry, workerMode }) => {
      const main = [];
      const worker = [];
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        if (tx.mode === "readwrite") main.push(tx.durability);
        return tx;
      };
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            if (data.storageProbe) worker.push(data.storageProbe.durability);
          });
        }
      };
      const sdk = await import(`/${build}/${entry}.js`);
      sdk.WasmWebClient.workerMode = workerMode;
      const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      // Mock validator keys are independent of the client seed. Persist one
      // genesis before the worker's independently created mock can race it.
      const bootstrap = await sdk.MockWebClient.createClient(
        undefined,
        undefined,
        seed,
        undefined,
        { durability: "strict" },
        false
      );
      const chain = await bootstrap.serializeMockChain();
      const transport = await bootstrap.serializeMockNoteTransportNode();
      bootstrap.terminate();
      await bootstrap.waitForIdle();
      const order = [];
      const failures = [];
      const client = await sdk.MockWebClient.createClient(
        chain,
        transport,
        seed,
        undefined,
        {
          durability: "strict",
          onFailure: (failure) => {
            failures.push(failure);
            order.push("failure");
          },
        }
      );
      await client.setSetting("browser-durability", new Uint8Array([1, 2, 3]));
      const stored = Array.from(await client.getSetting("browser-durability"));
      await client.syncState();
      window.storageTest = { client, sdk, main, worker, failures, order };
      return { stored, main, worker, isolated: crossOriginIsolated };
    },
    { build, entry, workerMode }
  );
}

for (const build of ["st", "mt"]) {
  for (const entry of ["index", "eager"]) {
    for (const workerMode of ["classic", "module"]) {
      test(`${build}/${entry} ${workerMode}: strict main and worker transactions`, async ({
        page,
        browserName,
      }) => {
        test.skip(
          build === "mt" && browserName === "webkit",
          "Threaded WASM requires the Chromium CI capability"
        );
        const result = await prepare(page, build, entry, workerMode);
        expect(result.stored).toEqual([1, 2, 3]);
        expect(result.main.length).toBeGreaterThan(0);
        expect(result.worker.length).toBeGreaterThan(0);
        expect(result.main.every((value) => value === "strict")).toBe(true);
        expect(result.worker.every((value) => value === "strict")).toBe(true);
        if (build === "mt") expect(result.isolated).toBe(true);
        await page.evaluate(() => window.storageTest.client.terminate());
      });
    }
  }
}

for (const route of ["main", "worker"]) {
  test(`native Chromium quota failure reaches ${route} callback before rejection`, async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "CDP quota override is Chromium-only"
    );
    await prepare(page, "st", "index", "module");
    await page.evaluate(async () => {
      await window.storageTest.client.proveBlock();
      await window.storageTest.client.proveBlock();
      window.storageTest.failures.length = 0;
      window.storageTest.order.length = 0;
      window.storageTest.quotaProbe = await new Promise((resolve, reject) => {
        const request = indexedDB.open("quota-calibration", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("probe");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1 });
    try {
      const quota = await cdp.send("Storage.getUsageAndQuota", { origin });
      expect(quota.overrideActive).toBe(true);
      expect(quota.quota).toBe(1);
      // Chromium caches bucket headroom for 30 seconds. Wait for native quota
      // enforcement with at most 40 KiB of payload, without faking errors.
      const calibration = await page.evaluate(async () => {
        const db = window.storageTest.quotaProbe;
        for (let attempt = 0; attempt < 40; attempt++) {
          const errorName = await new Promise((resolve) => {
            const tx = db.transaction("probe", "readwrite");
            let cause;
            const request = tx
              .objectStore("probe")
              .add(crypto.getRandomValues(new Uint8Array(1024)), attempt);
            request.onerror = () => {
              cause = request.error?.name;
            };
            tx.oncomplete = () => resolve(undefined);
            tx.onabort = () => resolve(cause ?? tx.error?.name ?? "AbortError");
          });
          if (errorName) return { errorName, attempts: attempt + 1 };
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return { errorName: "QuotaNotEnforced", attempts: 40 };
      });
      expect(calibration.errorName).toBe("QuotaExceededError");
      expect(
        await page.evaluate(() => ({
          failures: window.storageTest.failures,
          order: window.storageTest.order,
        }))
      ).toEqual({ failures: [], order: [] });
      const result = await page.evaluate(async (route) => {
        const { client, failures, order } = window.storageTest;
        let rejected = false;
        try {
          if (route === "main")
            await client.setSetting("quota-growth", new Uint8Array(256 * 1024));
          else await client.syncState();
        } catch {
          rejected = true;
          order.push("rejection");
        }
        return { rejected, failures, order };
      }, route);
      expect(result.rejected).toBe(true);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures.every((failure) => failure.kind === "quota")).toBe(
        true
      );
      expect(result.order[0]).toBe("failure");
      expect(result.order.at(-1)).toBe("rejection");
      for (const failure of result.failures)
        expect(Object.keys(failure).sort()).toEqual([
          "backend",
          "errorName",
          "eventId",
          "kind",
          "operation",
          "phase",
          "storeName",
        ]);
    } finally {
      await cdp.send("Storage.overrideQuotaForOrigin", { origin });
      await page.evaluate(() => {
        window.storageTest.quotaProbe.close();
        window.storageTest.client.terminate();
      });
      await cdp.detach();
    }
  });
}

test("standalone export and import retain strict policy without live client holders", async ({
  page,
}) => {
  await prepare(page, "st", "index", "module");
  const result = await page.evaluate(async () => {
    const { client, sdk, main } = window.storageTest;
    const dump = await sdk.exportStore("mock_client_db", {
      durability: "strict",
    });
    client.terminate();
    await client.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    main.length = 0;
    await sdk.importStore("mock_client_db", dump, { durability: "strict" });
    const restored = JSON.parse(
      await sdk.exportStore("mock_client_db", { durability: "strict" })
    );
    return {
      restored: JSON.stringify(restored) === JSON.stringify(JSON.parse(dump)),
      transactions: main,
    };
  });
  expect(result.restored).toBe(true);
  expect(result.transactions.length).toBeGreaterThan(0);
  expect(result.transactions.every((value) => value === "strict")).toBe(true);
});

for (const build of ["st", "mt"]) {
  for (const useWorker of [false, true]) {
    test(`${build} notes paging decodes partial records with useWorker:${useWorker}`, async ({
      page,
      browserName,
    }) => {
      test.skip(
        build === "mt" && browserName === "webkit",
        "Threaded WASM requires the Chromium CI capability"
      );
      await prepare(page, build, "index", "module");
      const result = await page.evaluate(async (useWorker) => {
        const { client: previous, sdk } = window.storageTest;
        const serializedMockChain = await previous.serializeMockChain();
        const serializedNoteTransport =
          await previous.serializeMockNoteTransportNode();
        previous.terminate();
        await previous.waitForIdle();
        const client = await sdk.MidenClient.createMock({
          serializedMockChain,
          serializedNoteTransport,
          useWorker,
          seed: new Uint8Array(32).fill(1),
          indexedDb: { durability: "strict" },
        });
        await client.sync();
        for (let index = 1; index <= 3; index++) {
          const serial = new sdk.Word(
            new BigUint64Array([BigInt(index), 0n, 0n, 0n])
          );
          const recipient = new sdk.NoteRecipient(
            serial,
            sdk.NoteScript.p2id(),
            new sdk.NoteStorage(new sdk.FeltArray())
          );
          const details = new sdk.NoteDetails(new sdk.NoteAssets(), recipient);
          await client.notes.import(sdk.NoteFile.fromNoteDetails(details));
        }
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("mock_client_db");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const write = (table, mutate) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(table, "readwrite");
            mutate(tx.objectStore(table));
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
          });
        const rejects = async (fn) => {
          try {
            await fn();
            return false;
          } catch {
            return true;
          }
        };
        try {
          const rows = await new Promise((resolve, reject) => {
            const request = db
              .transaction("inputNotes")
              .objectStore("inputNotes")
              .getAll(undefined, 4);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const cursor = rows[0].detailsCommitment;
          const filtered = await client.notes.listPage({
            states: ["consumed"],
            limit: 1,
          });
          // These calls overlap unless the raw fallback joins the main WASM queue.
          const [first, all, setting] = await Promise.all([
            client.notes.listPage({ states: ["expected"], limit: 1 }),
            client.notes.listPage(),
            client.settings.get("browser-durability"),
          ]);
          const selected = await client.notes.list({
            detailsCommitments: [
              rows[1].detailsCommitment,
              sdk.Word.fromHex(rows[2].detailsCommitment),
            ],
          });
          const validation = await client._withInnerWebClient(
            async (inner) => ({
              worker: !!inner.worker,
              field: await rejects(() =>
                inner.wasmWebClient.getInputNotesPage(
                  new Uint8Array(),
                  `0x${"ff".repeat(32)}`,
                  1
                )
              ),
              fraction: await rejects(() =>
                inner.wasmWebClient.getInputNotesPage(
                  new Uint8Array(),
                  undefined,
                  1.5
                )
              ),
              state: await rejects(() =>
                inner.wasmWebClient.getInputNotesPage(
                  new Uint8Array([9]),
                  undefined,
                  1
                )
              ),
            })
          );
          await write("inputNotes", (store) => store.delete(cursor));
          const rest = await client.notes.listPage({
            afterDetailsCommitment: cursor,
            limit: 2,
          });
          await write("inputNotes", (store) =>
            store.put({ ...rows[1], state: new Uint8Array([255]) })
          );
          const corruptRejected = await rejects(() => client.notes.listPage());
          await write("inputNotes", (store) => store.put(rows[1]));
          await write("notesScripts", (store) => store.clear());
          const missingScriptRejected = await rejects(() =>
            client.notes.listPage()
          );
          return {
            rawCount: rows.length,
            partial: all.notes.every(
              (note) => note.id() == null && note.metadata() == null
            ),
            allCount: all.notes.length,
            firstCount: first.notes.length,
            firstCursor: first.nextCursor,
            filtered: {
              count: filtered.notes.length,
              cursor: filtered.nextCursor,
              exhausted: filtered.exhausted,
            },
            cursor,
            selectedCount: selected.length,
            selectedSerials: selected
              .map((note) => note.details().recipient().serialNum().toHex())
              .sort(),
            expectedSerials: all.notes
              .slice(1)
              .map((note) => note.details().recipient().serialNum().toHex())
              .sort(),
            restCount: rest.notes.length,
            restExhausted: rest.exhausted,
            setting: Array.from(setting),
            validation,
            corruptRejected,
            missingScriptRejected,
          };
        } finally {
          db.close();
          client.terminate();
        }
      }, useWorker);
      expect(result.rawCount).toBe(3);
      expect(result.partial).toBe(true);
      expect(result.allCount).toBe(3);
      expect(result.firstCount).toBe(1);
      expect(result.firstCursor).toBe(result.cursor);
      expect(result.filtered).toEqual({
        count: 0,
        cursor: result.cursor,
        exhausted: false,
      });
      expect(result.selectedCount).toBe(2);
      expect(result.selectedSerials).toEqual(result.expectedSerials);
      expect(result.restCount).toBe(2);
      expect(result.restExhausted).toBe(true);
      expect(result.setting).toEqual([1, 2, 3]);
      expect(result.validation).toEqual({
        worker: useWorker,
        field: true,
        fraction: true,
        state: true,
      });
      expect(result.corruptRejected).toBe(true);
      expect(result.missingScriptRejected).toBe(true);
    });
  }
}

for (const useWorker of [false, true]) {
  test(`native acquisition refusal preserves input notes worker=${useWorker}`, async ({
    page,
  }) => {
    await prepare(page, "st", "index", "module");
    const result = await page.evaluate(async (useWorker) => {
      const { client: previous, sdk } = window.storageTest;
      const serializedMockChain = await previous.serializeMockChain();
      const serializedNoteTransport =
        await previous.serializeMockNoteTransportNode();
      previous.terminate();
      await previous.waitForIdle();
      let candidate;
      const client = await sdk.MidenClient.createMock({
        serializedMockChain,
        serializedNoteTransport,
        useWorker,
        beforeNoteAcquisition: async (item) => {
          candidate = item;
          throw new Error("private retention diagnostic must not escape");
        },
        noteAcquisitionLimits: {
          maxNotes: 1,
          maxNoteFileBytes: 65536,
          maxTotalNoteFileBytes: 65536,
        },
      });
      const recipient = new sdk.NoteRecipient(
        new sdk.Word(new BigUint64Array([91n, 0n, 0n, 0n])),
        sdk.NoteScript.p2id(),
        new sdk.NoteStorage(new sdk.FeltArray())
      );
      const file = sdk.NoteFile.fromNoteDetails(
        new sdk.NoteDetails(new sdk.NoteAssets(), recipient)
      );
      let error;
      try {
        await client.notes.import(file);
      } catch (value) {
        error = { code: value.code, message: value.message };
      }
      const notes = await client.notes.list();
      await client.waitForIdle();
      client.terminate();
      return {
        error,
        count: notes.length,
        candidate: candidate && {
          variant: candidate.variant,
          source: candidate.source,
          bytes: candidate.noteFileBytes instanceof Uint8Array,
          metadataAbsent: candidate.metadata === undefined,
          noteIdAbsent: candidate.noteId === undefined,
          batchIndex: candidate.batchIndex,
          batchCount: candidate.batchCount,
        },
      };
    }, useWorker);
    expect(result.error?.code).toBe("NOTE_ACQUISITION_REJECTED");
    expect(result.error?.message).not.toContain("private retention diagnostic");
    expect(result.count).toBe(0);
    expect(result.candidate).toEqual({
      variant: "expectedNote",
      source: "import",
      bytes: true,
      metadataAbsent: true,
      noteIdAbsent: true,
      batchIndex: 0,
      batchCount: 1,
    });
  });
}

for (const build of ["st", "mt"]) {
  test(`awaited worker transport retention preserves cursors ${build}`, async ({
    page,
    browserName,
  }) => {
    test.skip(
      build === "mt" && browserName === "webkit",
      "Threaded WASM requires the Chromium CI capability"
    );
    await prepare(page, build, "index", "module");
    const result = await page.evaluate(async () => {
      const { client: previous, sdk } = window.storageTest;
      const serializedMockChain = await previous.serializeMockChain();
      const serializedNoteTransport =
        await previous.serializeMockNoteTransportNode();
      previous.terminate();
      await previous.waitForIdle();
      const receipts = [];
      let accept = false;
      let release;
      const receipt = new Promise((resolve) => {
        release = resolve;
      });
      let entered;
      const observed = new Promise((resolve) => {
        entered = resolve;
      });
      const client = await sdk.MidenClient.createMock({
        serializedMockChain,
        serializedNoteTransport,
        useWorker: true,
        beforeNoteAcquisition: async (candidate) => {
          receipts.push({
            operationId: candidate.operationId,
            source: candidate.source,
            variant: candidate.variant,
            bytes: candidate.noteFileBytes instanceof Uint8Array,
            metadataAbsent: candidate.metadata === undefined,
          });
          entered();
          await receipt;
          if (!accept) throw new Error("refused");
        },
        noteAcquisitionLimits: {
          maxNotes: 2,
          maxNoteFileBytes: 65536,
          maxTotalNoteFileBytes: 131072,
        },
      });
      const sender = await client.accounts.create({
        seed: new Uint8Array(32).fill(1),
      });
      const recipient = await client.accounts.create({
        seed: new Uint8Array(32).fill(2),
      });
      const faucet = await client.accounts.create({
        type: sdk.FaucetType.FungibleFaucet,
        storage: "private",
        symbol: "DAG",
        decimals: 8,
        maxSupply: 10000000n,
      });
      await client._withInnerWebClient(async (inner) => {
        const note = sdk.Note.createP2IDNote(
          sender.id(),
          recipient.id(),
          new sdk.NoteAssets([new sdk.FungibleAsset(faucet.id(), 1n)]),
          sdk.NoteType.Private,
          new sdk.NoteAttachment()
        );
        await inner.sendPrivateNote(
          note,
          sdk.Address.fromAccountId(recipient.id(), "BasicWallet"),
          sdk.NoteInclusionProof.mockAtBlock(0)
        );
      });
      let settled = false;
      const pending = client
        .syncNoteTransport()
        .then(
          () => "accepted",
          (error) => error.code
        )
        .finally(() => {
          settled = true;
        });
      await observed;
      // Inspect IndexedDB directly instead of re-entering the locked client.
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("mock_client_db");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve, reject) => {
        const request = db
          .transaction("inputNotes")
          .objectStore("inputNotes")
          .count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const beforeAck = { settled, count };
      release();
      const refusal = await pending;
      const afterRefusal = (await client.notes.list()).length;
      accept = true;
      await client.syncNoteTransport();
      const afterRetry = (await client.notes.list()).length;
      await client.waitForIdle();
      client.terminate();
      return { beforeAck, refusal, afterRefusal, afterRetry, receipts };
    });
    expect(result.beforeAck).toEqual({ settled: false, count: 0 });
    expect(result.refusal).toBe("NOTE_ACQUISITION_REJECTED");
    expect(result.afterRefusal).toBe(0);
    expect(result.afterRetry).toBe(1);
    expect(result.receipts).toHaveLength(2);
    for (const receipt of result.receipts) {
      expect(receipt.operationId).toContain("syncNoteTransportMock-");
      expect(receipt.source).toBe("noteTransport");
      expect(receipt.bytes).toBe(true);
      expect(receipt.variant).toBe("expectedNote");
      expect(receipt.metadataAbsent).toBe(true);
    }
    expect(result.receipts[0].operationId).not.toBe(
      result.receipts[1].operationId
    );
  });
}

for (const mode of ["limit", "retention", "invalid", "retired"]) {
  test(`direct acquisition boundary ${mode}`, async ({ page }) => {
    await prepare(page, "st", "index", "module");
    const result = await page.evaluate(async (mode) => {
      const { client: previous, sdk } = window.storageTest;
      const serializedMockChain = await previous.serializeMockChain();
      const serializedNoteTransport =
        await previous.serializeMockNoteTransportNode();
      previous.terminate();
      await previous.waitForIdle();
      let calls = 0;
      let entered;
      const observed = new Promise((resolve) => {
        entered = resolve;
      });
      const client = await sdk.MidenClient.createMock({
        serializedMockChain,
        serializedNoteTransport,
        useWorker: false,
        beforeNoteAcquisition: (candidate) => {
          calls++;
          if (!(candidate.noteFileBytes instanceof Uint8Array))
            throw new Error("not copied");
          if (mode === "invalid") return;
          if (mode === "retention")
            return Promise.reject(new sdk.NoteAcquisitionRetentionError());
          entered();
          return new Promise(() => {});
        },
        noteAcquisitionLimits: {
          maxNotes: mode === "limit" ? 0 : 1,
          maxNoteFileBytes: 65536,
          maxTotalNoteFileBytes: 65536,
        },
      });
      const recipient = new sdk.NoteRecipient(
        new sdk.Word(new BigUint64Array([93n, 0n, 0n, 0n])),
        sdk.NoteScript.p2id(),
        new sdk.NoteStorage(new sdk.FeltArray())
      );
      const file = sdk.NoteFile.fromNoteDetails(
        new sdk.NoteDetails(new sdk.NoteAssets(), recipient)
      );
      const pending = client.notes.import(file).then(
        () => "accepted",
        (error) => error.code
      );
      if (mode === "retired") {
        await observed;
        client.terminate();
      }
      const code = await pending;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("mock_client_db");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve) => {
        const request = db
          .transaction("inputNotes")
          .objectStore("inputNotes")
          .count();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      if (mode !== "retired") {
        await client.waitForIdle();
        client.terminate();
      }
      return { code, count, calls };
    }, mode);
    expect(result.count).toBe(0);
    expect(result.calls).toBe(mode === "limit" ? 0 : 1);
    expect(result.code).toBe(
      mode === "limit"
        ? "NOTE_ACQUISITION_LIMIT_EXCEEDED"
        : mode === "retention"
          ? "NOTE_ACQUISITION_RETENTION_FAILED"
          : "NOTE_ACQUISITION_REJECTED"
    );
  });
}

test("raw worker awaits a copied candidate decision before import writes", async ({
  page,
}) => {
  await prepare(page, "st", "index", "module");
  const result = await page.evaluate(async () => {
    const { client: previous } = window.storageTest;
    const chain = await previous.serializeMockChain();
    const transport = await previous.serializeMockNoteTransportNode();
    previous.terminate();
    await previous.waitForIdle();
    const source = `
      self.onmessage = async ({ data }) => {
        if (!data.moduleUrl) return;
        let phase = "initialize";
        try {
        const sdk = await import(data.moduleUrl);
        await sdk.MidenClient.ready();
        phase = "create";
        const client = new sdk.WebClient();
        await client.createMockClient(undefined, data.chain, data.transport);
        phase = "install";
        await client.installNoteAcquisitionGate((candidate) => new Promise((resolve) => {
          self.addEventListener("message", function acknowledge({ data }) {
            if (data.operationId !== "raw-import-1") return;
            self.removeEventListener("message", acknowledge);
            resolve(data.decision);
          });
          self.postMessage({ kind: "candidate", operationId: "raw-import-1",
            bytes: candidate.noteFileBytes instanceof Uint8Array, variant: candidate.variant,
            metadataAbsent: candidate.metadata === undefined });
        }), { maxNotes: 1, maxNoteFileBytes: 65536, maxTotalNoteFileBytes: 65536 });
        const recipient = new sdk.NoteRecipient(new sdk.Word(new BigUint64Array([95n, 0n, 0n, 0n])),
          sdk.NoteScript.p2id(), new sdk.NoteStorage(new sdk.FeltArray()));
        const file = sdk.NoteFile.fromNoteDetails(new sdk.NoteDetails(new sdk.NoteAssets(), recipient));
        let code;
        try { await client.importNoteFile(file); } catch (error) { code = error.code; }
        phase = "readback";
        const count = (await client.getInputNotes(new sdk.NoteFilter(sdk.NoteFilterTypes.All))).length;
        client.free();
        self.postMessage({ kind: "done", code, count });
        } catch { self.postMessage({ kind: "failed", phase }); }
      };
    `;
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" })
    );
    const worker = new Worker(url, { type: "module" });
    try {
      return await new Promise((resolve, reject) => {
        let candidate;
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data.kind === "candidate") {
            candidate = data;
            worker.postMessage({
              operationId: data.operationId,
              decision: "rejected",
            });
          } else if (data.kind === "failed") {
            reject(new Error(`Raw worker fixture failed during ${data.phase}`));
          } else resolve({ candidate, code: data.code, count: data.count });
        };
        worker.postMessage({
          moduleUrl: `${location.origin}/st/index.js`,
          chain,
          transport,
        });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  });
  expect(result.candidate).toEqual({
    kind: "candidate",
    operationId: "raw-import-1",
    bytes: true,
    variant: "expectedNote",
    metadataAbsent: true,
  });
  expect(result.code).toBe("NOTE_ACQUISITION_REJECTED");
  expect(result.count).toBe(0);
});
