const normalize = value => value?.replace(/^0x/i, '').toLowerCase();
const hash = async bytes =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
const GUARDIAN_SLOT = 'miden::standards::auth::guardian::pub_key';
const THRESHOLD_ROOTS = [
  '0x93dedb135fd5bb7112c07aacf4a5680ddc76e45ecf043bfc42ea735b6d971911',
  '0xa32cd13808fd8fb91adb3dceaed4d8faebc3bd80fa49c2903be4b8d7bf89ba77'
];

function detailsCommitment(sdk, body) {
  const handles = [];
  const own = handle => {
    handles.push(handle);
    return handle;
  };
  try {
    const recipient = own(body.recipient());
    const digest = own(recipient.digest());
    const assets = own(body.assets());
    const words = [];
    for (const asset of assets.assets()) {
      own(asset);
      const key = own(asset.vaultKey());
      const value = own(asset.intoWord());
      words.push(...key.toFelts(), ...value.toFelts());
    }
    const assetHash = own(sdk.Poseidon2.hashElements(new sdk.FeltArray(words)));
    const commitment = own(
      sdk.Poseidon2.hashElements(new sdk.FeltArray([...digest.toFelts(), ...assetHash.toFelts()]))
    );
    return normalize(commitment.toHex());
  } finally {
    for (const handle of handles.reverse()) handle.free();
  }
}

export async function prepareChain(sdk) {
  const build = 'st';
  const useWorker = false;
  const custody = [];
  let phase = 'sdk-load';
  window.__seedPhase = phase;
  let client;
  let bootstrap;
  const checks = {};
  const observations = {};
  const digests = {};
  const ownedDatabases = new Set();
  const handles = [];
  const own = handle => {
    handles.push(handle);
    return handle;
  };
  const check = (name, value) => {
    checks[name] = value === true;
    if (!checks[name]) throw new Error('AUTH_CHECK');
  };
  const databaseNames = async () => (await indexedDB.databases()).map(entry => entry.name).filter(Boolean);
  async function drainAndTerminate() {
    if (!client) return;
    await client.waitForIdle();
    await client[Symbol.asyncDispose]();
    client = undefined;
  }
  async function destroyOwnedSdkStores() {
    await drainAndTerminate();
    const names = await databaseNames();
    check(
      `disposableOwnership.${ownedDatabases.size}`,
      names.every(name => ownedDatabases.has(name))
    );
    for (const name of ownedDatabases) {
      await new Promise((done, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => done();
        request.onerror = () => reject(new Error('AUTH_DELETE_FAILED'));
        request.onblocked = () => reject(new Error('AUTH_DELETE_BLOCKED'));
      });
    }
    check(`emptyStores.${Object.keys(checks).length}`, (await databaseNames()).length === 0);
  }
  try {
    phase = 'initial-disposable-context';
    window.__seedPhase = phase;
    check('freshContext', (await databaseNames()).length === 0);
    check('isolation', build !== 'mt' || crossOriginIsolated);
    sdk.WasmWebClient.workerMode = 'module';
    phase = 'bootstrap';
    window.__seedPhase = phase;
    bootstrap = await sdk.MockWebClient.createClient(
      undefined,
      undefined,
      crypto.getRandomValues(new Uint8Array(32)),
      undefined,
      { durability: 'strict' },
      false
    );
    let chain = await bootstrap.serializeMockChain();
    let transport = await bootstrap.serializeMockNoteTransportNode();
    bootstrap.terminate();
    await bootstrap.waitForIdle();
    bootstrap = undefined;
    const acquisitions = [];
    async function createClient() {
      client = await sdk.MidenClient.createMock({
        serializedMockChain: chain,
        serializedNoteTransport: transport,
        useWorker,
        indexedDb: { durability: 'strict' },
        noteAcquisitionLimits: { maxNotes: 4, maxNoteFileBytes: 65536, maxTotalNoteFileBytes: 262144 },
        beforeNoteAcquisition: async item => {
          acquisitions.push({
            bytes: item.noteFileBytes.slice(),
            variant: item.variant,
            source: item.source,
            details: item.detailsCommitment,
            id: item.noteId,
            nullifier: item.nullifier,
            tag: item.tag,
            after: item.afterBlockNum
          });
        }
      });
      check(
        `workerRoute.${Object.keys(checks).length}`,
        (await client._withInnerWebClient(async inner => inner.worker instanceof Worker)) === useWorker
      );
      for (const name of await databaseNames()) ownedDatabases.add(name);
    }
    await createClient();
    phase = 'guarded-recipient-build';
    window.__seedPhase = phase;
    const keyCommitment = () => {
      const key = own(sdk.AuthSecretKey.ecdsaWithRNG(crypto.getRandomValues(new Uint8Array(32))));
      const pubkey = own(key.publicKey());
      custody.push({ publicBytes: pubkey.serialize().slice(), secretBytes: key.serialize().slice() });
      return own(pubkey.toCommitment()).toHex();
    };
    const approvers = [keyCommitment(), keyCommitment()];
    const guardian = keyCommitment();
    const base = own(
      new sdk.AuthGuardedMultisigConfig(
        approvers.map(value => sdk.Word.fromHex(value)),
        1,
        own(sdk.Word.fromHex(guardian)),
        1
      )
    );
    const config = own(
      base.withProcThresholds(THRESHOLD_ROOTS.map(root => new sdk.ProcedureThreshold(sdk.Word.fromHex(root), 2)))
    );
    const component = own(sdk.createAuthGuardedMultisig(config).withSupportsAllTypes());
    const builder = own(
      new sdk.AccountBuilder(crypto.getRandomValues(new Uint8Array(32)))
        .storageMode(own(sdk.AccountStorageMode.private()))
        .withAuthComponent(component)
        .withBasicWalletComponent()
    );
    const built = own(builder.buildWithoutSchemaCommitment());
    const account = own(built.account);
    const accountId = own(account.id()).toString();
    const accountBytes = account.serialize().slice();
    const storage = own(account.storage());
    const guardianReadback = own(storage.getItem(GUARDIAN_SLOT));
    check('genuineGuardianSlot', normalize(guardianReadback?.toHex()) === normalize(guardian));
    check('undeployedRecipient', own(account.nonce()).asInt() === 0n);
    const accountCommitment = own(account.to_commitment()).toHex();
    await client.accounts.insert({ account, overwrite: false });
    phase = 'real-mockchain-mint';
    window.__seedPhase = phase;
    const faucet = own(
      await client.accounts.create({
        type: sdk.FaucetType.FungibleFaucet,
        storage: 'private',
        symbol: 'DAG',
        decimals: 8,
        maxSupply: 10000000n
      })
    );
    await client.proveBlock();
    await client.proveBlock();
    await client.syncChain();
    const faucetId = own(faucet.id());
    const recipientId = own(sdk.AccountId.fromHex(accountId));
    const mint = await client._withInnerWebClient(async inner => {
      const request = await inner.newMintTransactionRequest(recipientId, faucetId, sdk.NoteType.Private, 1n);
      try {
        const requestBytes = request.serialize().slice();
        const tx = await inner.submitNewTransaction(faucetId, request);
        try {
          return { requestBytes, transactionId: tx.toHex() };
        } finally {
          tx.free();
        }
      } finally {
        request.free();
      }
    });
    await client.proveBlock();
    await client.syncChain();
    phase = 'producer-authenticated-record';
    window.__seedPhase = phase;
    const records = await client.notes.list({ status: 'committed' });
    records.forEach(own);
    check('oneProducerRecord', records.length === 1);
    const record = records[0];
    check('producerAuthenticationData', record.isAuthenticated() && record.state() === sdk.InputNoteState.Committed);
    const noteId = normalize(own(record.id()).toString());
    const nullifier = normalize(record.nullifier());
    const noteDetails = own(record.details());
    const commitment = detailsCommitment(sdk, noteDetails);
    const input = own(record.toInputNote());
    const full = own(sdk.NoteFile.fromInputNote(input));
    const fullBytes = full.serialize().slice();
    const request = own(sdk.TransactionRequest.deserialize(mint.requestBytes));
    const anchor = own(await client.transactions.captureAnchor(request));
    const header = own(anchor.blockHeader());
    const trustedRoot = own(header.noteRoot()).toHex();
    const block = header.blockNum();
    check('nondefaultCommittedBlock', block > 1);
    const metadata = own(record.metadata());
    const tag = own(metadata.tag()).asU32();
    check('nondefaultActualTag', tag !== 0);
    const ordinaryAfter = block - 1;
    const futureAfter = block + 100;
    const expected = own(sdk.NoteFile.fromExpectedNote(noteDetails, own(new sdk.NoteTag(tag)), ordinaryAfter));
    const future = own(sdk.NoteFile.fromExpectedNote(noteDetails, own(new sdk.NoteTag(tag)), futureAfter));
    const expectedBytes = expected.serialize().slice();
    const futureBytes = future.serialize().slice();
    function verifyCanonical(readback, prefix) {
      const local = [];
      const hold = value => {
        if (value) local.push(value);
        return value;
      };
      try {
        const proof = hold(readback.inclusionProof());
        const location = hold(proof?.location());
        const path = hold(proof?.notePath());
        const leaf = hold(readback.commitment());
        const id = hold(readback.id());
        const details = hold(readback.details());
        const root = hold(sdk.Word.fromHex(trustedRoot));
        check(
          `${prefix}.identity`,
          normalize(id?.toString()) === noteId &&
            normalize(readback.nullifier()) === nullifier &&
            detailsCommitment(sdk, details) === commitment
        );
        check(`${prefix}.committed`, readback.isAuthenticated() && readback.state() === sdk.InputNoteState.Committed);
        check(`${prefix}.proofBlock`, location?.blockNum() === block);
        check(
          `${prefix}.merkleProof`,
          path !== undefined && leaf !== undefined && path.verify(BigInt(location.blockNoteTreeIndex()), leaf, root)
        );
        const file = hold(sdk.NoteFile.fromInputNote(hold(readback.toInputNote())));
        return file.serialize().slice();
      } finally {
        for (const handle of local.reverse()) handle.free();
      }
    }
    verifyCanonical(record, 'producer');

    const finalChain = await client.serializeMockChain();
    const database = await sdk.exportStore(await client.storeIdentifier());
    const feeFaucetId = await client.feeFaucetId();
    check('boundedChain', finalChain.length > 0 && finalChain.length <= 16 * 1024 * 1024);
    check('boundedDatabase', typeof database === 'string' && database.length <= 16 * 1024 * 1024);
    check('custodyCount', custody.length === 3);
    return {
      chain: Array.from(finalChain),
      database,
      accountId,
      accountBytes: Array.from(accountBytes),
      accountCommitment,
      guardianCommitment: guardianReadback.toHex(),
      feeFaucetId,
      custody: custody.map(item => ({
        publicBytes: Array.from(item.publicBytes),
        secretBytes: Array.from(item.secretBytes)
      })),
      noteId,
      noteDetailsId: commitment,
      fullBytes: Array.from(fullBytes),
      expectedBytes: Array.from(expectedBytes),
      block,
      checks,
      digests
    };
  } finally {
    if (client) {
      await client.waitForIdle().catch(() => {});
      await client[Symbol.asyncDispose]().catch(() => {});
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
