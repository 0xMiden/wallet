const TAG = 71;
const AFTER = 9;
const normalize = value => value?.replace(/^0x/i, '').toLowerCase();
const equal = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const digest = async bytes =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

async function countInputNotes() {
  const db = await new Promise((done, reject) => {
    const request = indexedDB.open('mock_client_db');
    request.onsuccess = () => done(request.result);
    request.onerror = () => reject(new Error('CODEC_DATABASE_OPEN'));
  });
  try {
    return await new Promise((done, reject) => {
      const request = db.transaction('inputNotes').objectStore('inputNotes').count();
      request.onsuccess = () => done(request.result);
      request.onerror = () => reject(new Error('CODEC_DATABASE_COUNT'));
    });
  } finally {
    db.close();
  }
}

function fields(sdk, file) {
  const owned = [];
  const own = handle => {
    if (handle) owned.push(handle);
    return handle;
  };
  try {
    const note = own(file.note());
    const details = own(file.noteDetails());
    const identifier = own(file.noteId());
    const tag = own(file.noteTag());
    const proof = own(file.inclusionProof());
    const metadata = own(note?.metadata());
    const sender = own(metadata?.sender());
    const metadataTag = own(metadata?.tag());
    const body = note ?? details;
    let commitment;
    if (body) {
      const recipient = own(body.recipient());
      const recipientDigest = own(recipient.digest());
      const assets = own(body.assets());
      const words = [];
      for (const asset of assets.assets()) {
        own(asset);
        const key = own(asset.vaultKey());
        const value = own(asset.intoWord());
        words.push(...key.toFelts(), ...value.toFelts());
      }
      const assetDigest = own(sdk.Poseidon2.hashElements(new sdk.FeltArray(words)));
      const combined = own(
        sdk.Poseidon2.hashElements(new sdk.FeltArray([...recipientDigest.toFelts(), ...assetDigest.toFelts()]))
      );
      commitment = normalize(combined.toHex());
    }
    return {
      detailsCommitment: commitment,
      noteId: normalize(identifier?.toString()),
      nullifier: normalize(file.nullifier()),
      tag: tag?.asU32() ?? metadataTag?.asU32(),
      afterBlockNum: file.afterBlockNum(),
      proofPresent: proof !== undefined && proof !== null,
      metadata: metadata
        ? {
            sender: normalize(sender.toString()),
            noteType: metadata.noteType(),
            tag: metadataTag.asU32()
          }
        : undefined
    };
  } finally {
    for (const handle of owned.reverse()) handle.free();
  }
}

export async function runCodecCase({ build, useWorker, scenario }) {
  let phase = 'sdk-load';
  let client;
  let bootstrap;
  let active;
  let callbacks = 0;
  const handles = [];
  const checks = {};
  const digests = [];
  const own = handle => {
    handles.push(handle);
    return handle;
  };
  const check = (name, value) => {
    checks[name] = value === true;
    if (!checks[name]) throw new Error('CODEC_CHECK');
  };
  try {
    const sdk = await import(`/${build}/index.js`);
    phase = 'bootstrap';
    check('isolation', build !== 'mt' || crossOriginIsolated);
    sdk.WasmWebClient.workerMode = 'module';
    const seed = crypto.getRandomValues(new Uint8Array(32));
    bootstrap = await sdk.MockWebClient.createClient(
      undefined,
      undefined,
      seed,
      undefined,
      { durability: 'strict' },
      false
    );
    const serializedMockChain = await bootstrap.serializeMockChain();
    const serializedNoteTransport = await bootstrap.serializeMockNoteTransportNode();
    bootstrap.terminate();
    await bootstrap.waitForIdle();
    bootstrap = undefined;
    phase = 'client-create';
    client = await sdk.MidenClient.createMock({
      serializedMockChain,
      serializedNoteTransport,
      useWorker,
      indexedDb: { durability: 'strict' },
      noteAcquisitionLimits: { maxNotes: 1, maxNoteFileBytes: 65536, maxTotalNoteFileBytes: 65536 },
      beforeNoteAcquisition: async item => {
        callbacks++;
        if (!active) throw new Error('CODEC_UNEXPECTED_CALLBACK');
        active.copied = {
          bytes: item.noteFileBytes.slice(),
          variant: item.variant,
          source: item.source,
          batchIndex: item.batchIndex,
          batchCount: item.batchCount,
          detailsCommitment: item.detailsCommitment,
          noteId: item.noteId,
          nullifier: item.nullifier,
          tag: item.tag,
          afterBlockNum: item.afterBlockNum,
          metadata: item.metadata ? { ...item.metadata } : undefined
        };
        active.original = item.noteFileBytes;
        active.entered.resolve();
        await active.release.promise;
        throw new Error('CODEC_INTENTIONAL_REFUSAL');
      }
    });
    const actualWorker = await client._withInnerWebClient(async inner => inner.worker instanceof Worker);
    check('workerRoute', actualWorker === useWorker);
    if (scenario === 'missing-file') {
      phase = 'empty-codec-control';
      let refused = false;
      try {
        own(sdk.NoteFile.deserialize(new Uint8Array()));
      } catch {
        refused = true;
      }
      check('emptyDecoderRefused', refused);
      check('noCallbackForMissingFile', callbacks === 0);
      check('missingFileNoRows', (await countInputNotes()) === 0);
    } else {
      phase = 'fixture-construction';
      const recipient = own(
        new sdk.NoteRecipient(
          own(new sdk.Word(new BigUint64Array([91n, 0n, 0n, 0n]))),
          own(sdk.NoteScript.p2id()),
          own(new sdk.NoteStorage(own(new sdk.FeltArray())))
        )
      );
      let details = own(new sdk.NoteDetails(own(new sdk.NoteAssets()), recipient));
      let expected = own(sdk.NoteFile.fromExpectedNote(details, own(new sdk.NoteTag(TAG)), AFTER));
      let full;
      if (scenario === 'committed' || scenario === 'alternate-refusal') {
        const sender = own(await client.accounts.create({ seed: crypto.getRandomValues(new Uint8Array(32)) }));
        const recipientAccount = own(
          await client.accounts.create({ seed: crypto.getRandomValues(new Uint8Array(32)) })
        );
        const faucet = own(
          await client.accounts.create({
            type: sdk.FaucetType.FungibleFaucet,
            storage: 'private',
            symbol: 'DAG',
            decimals: 8,
            maxSupply: 10000000n
          })
        );
        const senderId = own(sender.id());
        const recipientId = own(recipientAccount.id());
        const faucetId = own(faucet.id());
        const note = own(
          sdk.Note.createP2IDNote(
            senderId,
            recipientId,
            own(new sdk.NoteAssets([own(new sdk.FungibleAsset(faucetId, 1n))])),
            sdk.NoteType.Private,
            own(new sdk.NoteAttachment())
          )
        );
        const proof = own(sdk.NoteInclusionProof.mockAtBlock(0));
        full = own(sdk.NoteFile.fromInputNote(own(sdk.InputNote.authenticated(note, proof))));
        if (scenario === 'alternate-refusal') {
          const fullNote = own(full.note());
          details = own(new sdk.NoteDetails(own(fullNote.assets()), own(fullNote.recipient())));
          expected = own(sdk.NoteFile.fromExpectedNote(details, own(new sdk.NoteTag(TAG)), AFTER));
          check(
            'alternate.sameFullDetails',
            fields(sdk, full).detailsCommitment === fields(sdk, expected).detailsCommitment
          );
        }
      }
      async function observe(file, receiptFile, control) {
        phase = `prepare-${control}`;
        const incoming = file.serialize().slice();
        const decoded = own(sdk.NoteFile.deserialize(incoming));
        const prepared = decoded.serialize().slice();
        const receipt = receiptFile.serialize().slice();
        const expectedFields = fields(sdk, decoded);
        const receiptFields = fields(sdk, receiptFile);
        active = { entered: deferred(), release: deferred(), copied: undefined, original: undefined };
        const current = active;
        let settled = false;
        const baseline = await countInputNotes();
        const pending = client.notes
          .import(decoded)
          .then(
            () => false,
            error => error?.code === 'NOTE_ACQUISITION_REJECTED'
          )
          .finally(() => {
            settled = true;
          });
        try {
          phase = `callback-${control}`;
          await Promise.race([
            current.entered.promise,
            pending.then(() => {
              throw new Error('CODEC_CALLBACK_ABSENT');
            })
          ]);
          check(`${control}.awaited`, settled === false);
          check(`${control}.noRowsWhileHeld`, (await countInputNotes()) === baseline);
          const candidate = current.copied;
          current.original[0] ^= 255;
          check(`${control}.canonicalIncoming`, equal(incoming, prepared));
          check(`${control}.canonicalCandidate`, equal(prepared, candidate.bytes));
          check(`${control}.independentCopy`, !equal(current.original, candidate.bytes));
          const receiptMatch = equal(receipt, candidate.bytes);
          check(`${control}.receiptComparison`, receiptMatch === (control === 'expected' || control === 'committed'));
          check(
            `${control}.sourceAndBatch`,
            candidate.source === 'import' && candidate.batchIndex === 0 && candidate.batchCount === 1
          );
          check(`${control}.details`, normalize(candidate.detailsCommitment) === expectedFields.detailsCommitment);
          check(
            `${control}.identifiers`,
            normalize(candidate.noteId) === expectedFields.noteId &&
              normalize(candidate.nullifier) === expectedFields.nullifier
          );
          if (control === 'expected' || control === 'hint') {
            check(`${control}.variant`, candidate.variant === 'expectedNote');
            check(
              `${control}.hints`,
              candidate.tag === (control === 'hint' ? TAG + 1 : TAG) &&
                candidate.afterBlockNum === (control === 'hint' ? AFTER + 1 : AFTER)
            );
            check(
              `${control}.absentFullFields`,
              candidate.noteId === undefined && candidate.nullifier === undefined && candidate.metadata === undefined
            );
            if (control === 'hint')
              check(
                'hint.sameDetailsChangedHints',
                normalize(candidate.detailsCommitment) === receiptFields.detailsCommitment &&
                  candidate.tag !== TAG &&
                  candidate.afterBlockNum !== AFTER
              );
          } else if (control === 'committed') {
            check('committed.variantAndProof', candidate.variant === 'committed' && expectedFields.proofPresent);
            check(
              'committed.metadata',
              candidate.metadata !== undefined &&
                normalize(candidate.metadata.sender) === expectedFields.metadata.sender &&
                candidate.metadata.noteType === expectedFields.metadata.noteType &&
                candidate.metadata.tag === expectedFields.metadata.tag &&
                candidate.tag === expectedFields.tag &&
                candidate.afterBlockNum === undefined
            );
            check(
              'committed.attachmentsBoundByBytes',
              typeof candidate.metadata.attachmentsCommitment === 'string' &&
                /^(0x)?[0-9a-f]{64}$/i.test(candidate.metadata.attachmentsCommitment)
            );
          } else {
            check('id.variantMismatch', candidate.variant === 'noteId' && candidate.variant !== 'expectedNote');
            check('id.noPrivateBody', candidate.detailsCommitment === undefined && candidate.metadata === undefined);
          }
          digests.push({
            control,
            incoming: await digest(incoming),
            prepared: await digest(prepared),
            candidate: await digest(candidate.bytes),
            receipt: await digest(receipt)
          });
        } finally {
          current.release.resolve();
        }
        phase = `refusal-${control}`;
        check(`${control}.nativeRefusal`, await pending);
        check(`${control}.settledAfterRelease`, settled);
        check(`${control}.unchangedRows`, (await countInputNotes()) === baseline);
        active = undefined;
      }
      if (scenario === 'expected-hints') await observe(expected, expected, 'expected');
      else if (scenario === 'committed') await observe(full, full, 'committed');
      else {
        const fullId = own(full.noteId());
        await observe(own(sdk.NoteFile.fromNoteId(fullId)), expected, 'id');
        const changed = own(sdk.NoteFile.fromExpectedNote(details, own(new sdk.NoteTag(TAG + 1)), AFTER + 1));
        await observe(changed, expected, 'hint');
        check('alternate.exactlyTwoCallbacks', callbacks === 2);
      }
    }
    phase = 'cleanup';
    await client.waitForIdle();
    client.terminate();
    client = undefined;
    return { ok: true, phase: 'complete', checks, digests };
  } catch {
    return { ok: false, phase, checks, digests };
  } finally {
    active?.release.resolve();
    if (client) {
      await client.waitForIdle().catch(() => {});
      client.terminate();
    }
    if (bootstrap) {
      bootstrap.terminate();
      await bootstrap.waitForIdle().catch(() => {});
    }
    for (const handle of handles.reverse()) {
      try {
        handle.free();
      } catch {}
    }
  }
}
