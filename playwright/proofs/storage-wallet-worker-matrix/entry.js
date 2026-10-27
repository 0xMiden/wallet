import * as sdk from '@miden-sdk/miden-sdk/lazy';
import { MidenClientInterface, getRealmReaderClient } from 'lib/miden/sdk/miden-client-interface';
import { getCurrentWasmLockHold, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { nativeStorageName } from 'lib/miden/sdk/native-storage-policy';
import { initializeStorageHealth, getStorageHealth } from 'lib/miden/storage-health';
import { applyEndpointOverride } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

const hash = async text =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
const held = operation => withWasmClientLock(operation);

async function guardedAccount(client) {
  const owned = [];
  const own = value => {
    owned.push(value);
    return value;
  };
  try {
    const commitments = Array.from({ length: 3 }, () => {
      const key = own(sdk.AuthSecretKey.ecdsaWithRNG(crypto.getRandomValues(new Uint8Array(32))));
      return own(own(key.publicKey()).toCommitment()).toHex();
    });
    const config = own(
      new sdk.AuthGuardedMultisigConfig(
        commitments.slice(0, 2).map(value => sdk.Word.fromHex(value)),
        1,
        own(sdk.Word.fromHex(commitments[2])),
        1
      )
    );
    const thresholds = [
      '0x93dedb135fd5bb7112c07aacf4a5680ddc76e45ecf043bfc42ea735b6d971911',
      '0xa32cd13808fd8fb91adb3dceaed4d8faebc3bd80fa49c2903be4b8d7bf89ba77'
    ].map(root => new sdk.ProcedureThreshold(sdk.Word.fromHex(root), 2));
    const auth = own(sdk.createAuthGuardedMultisig(config.withProcThresholds(thresholds)).withSupportsAllTypes());
    const builder = own(
      new sdk.AccountBuilder(crypto.getRandomValues(new Uint8Array(32)))
        .storageMode(own(sdk.AccountStorageMode.private()))
        .withAuthComponent(auth)
        .withBasicWalletComponent()
    );
    const built = own(builder.buildWithoutSchemaCommitment());
    const account = own(built.account);
    await client.accounts.insert({ account, overwrite: false });
    return own(account.id()).toString();
  } finally {
    for (const value of owned.reverse()) {
      try {
        value.free();
      } catch {}
    }
  }
}

const matrixMode = process.env.WALLET_MATRIX_MODE;
const samples = 16;
const payloadBytes = 1024;

async function run(kind, workerMode = 'module', durability = 'strict') {
  let phase = 'initializing';
  let wallet;
  let actual;
  let raw;
  let reader;
  const checks = {};
  const observations = {};
  const digests = {};
  const timings = [];
  const transactions = [];
  let fault;
  const check = (name, passed) => {
    checks[name] = passed === true;
    if (!checks[name]) throw new Error(name);
  };
  const originalTransaction = IDBDatabase.prototype.transaction;
  const originalPut = IDBObjectStore.prototype.put;
  const nativeAbort = IDBTransaction.prototype.abort;
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = Reflect.apply(originalTransaction, this, args);
    const observation = {
      store: this.name,
      mode: args[1],
      requested: args[2]?.durability,
      actual: tx.durability,
      completed: false,
      aborted: false
    };
    transactions.push(observation);
    tx.addEventListener(
      'complete',
      () => {
        observation.completed = true;
      },
      { once: true }
    );
    tx.addEventListener(
      'abort',
      () => {
        observation.aborted = true;
      },
      { once: true }
    );
    return tx;
  };
  IDBObjectStore.prototype.put = function (...args) {
    const request = Reflect.apply(originalPut, this, args);
    const armed = fault;
    if (armed && !armed.claimed && this.name === 'settings' && this.transaction.db.name === armed.store) {
      armed.claimed = true;
      const tx = this.transaction;
      request.addEventListener(
        'success',
        () => {
          armed.requestSucceeded = true;
          if (armed.intentional) tx.abort();
          else Reflect.apply(nativeAbort, tx, []);
        },
        { once: true }
      );
    }
    return request;
  };
  const dispose = async () => {
    if (reader) {
      reader.terminate();
      await reader.waitForIdle();
      reader = undefined;
    }
    if (actual) {
      await actual.waitForIdle();
      if (wallet) wallet.free();
      await actual[Symbol.asyncDispose]();
      actual = undefined;
      wallet = undefined;
    }
    if (raw) {
      await raw.waitForIdle();
      await raw[Symbol.asyncDispose]();
      raw = undefined;
    }
  };
  try {
    await initializeStorageHealth();
    check('initiallyHealthy', getStorageHealth().status === 'healthy');
    await sdk.getWasmOrThrow();
    check('requestedWasmMode', matrixMode === 'st' || matrixMode === 'mt');
    check('crossOriginIsolated', globalThis.crossOriginIsolated === true);
    check('realWorkerSelector', sdk.WasmWebClient === sdk.MidenClient._WasmWebClient);
    sdk.WasmWebClient.workerMode = workerMode;
    observations.hardwareConcurrency = navigator.hardwareConcurrency;
    observations.isMultithreadedBuild = matrixMode === 'mt';
    const rpcUrl = location.origin;
    const endpoints = feeFaucetId =>
      applyEndpointOverride({
        rpcUrl,
        proverUrl: `${location.origin}/unused-prover`,
        noteTransportUrl: `${location.origin}/unused-transport`,
        faucetUrl: `${location.origin}/unused-faucet`,
        faucetApiUrl: `${location.origin}/unused-faucet-api`,
        explorerUrl: `${location.origin}/unused-explorer`,
        guardianUrl: '',
        allowNoGuardian: false,
        networkName: MIDEN_NETWORK_NAME.LOCALNET,
        presetName: 'localnet',
        feeFaucetId
      });
    phase = 'bootstrap-native-mock';
    raw = await sdk.MidenClient.createMock({ useWorker: false, indexedDb: { durability: 'strict' } });
    const fee = await raw.feeFaucetId();
    const feeFaucetId = fee.toString();
    fee.free();
    const accountId = kind === 'public-reader' ? await guardedAccount(raw) : undefined;
    const sourceName = await raw.storeIdentifier();
    await raw.waitForIdle();
    await raw[Symbol.asyncDispose]();
    raw = undefined;
    const dump = await sdk.exportStore(sourceName, { durability: 'strict' });
    digests.bootstrap = await hash(dump);
    endpoints(feeFaucetId);
    const targetName = await nativeStorageName(rpcUrl);
    check('distinctBootstrapNamespace', targetName !== sourceName);
    phase = 'bootstrap-supported-import';
    await sdk.importStore(targetName, dump, { durability: kind === 'durability' ? durability : 'strict' });
    phase = 'normal-wallet-create';
    if (kind === 'durability') {
      actual = await sdk.MidenClient.create({
        rpcUrl,
        feeFaucetId,
        autoSync: false,
        useWorker: true,
        ...(durability === 'strict' ? { indexedDb: { durability: 'strict' } } : {})
      });
      check('actualSdkClass', actual instanceof sdk.MidenClient);
    } else {
      wallet = await held(() => MidenClientInterface.create({ useWorker: true }));
      actual = wallet.client;
      check('actualWalletClass', wallet instanceof MidenClientInterface);
      check('actualSdkClass', actual instanceof sdk.MidenClient);
      check('normalNetwork', wallet.network === MIDEN_NETWORK_NAME.LOCALNET);
    }
    check('nativeNamespace', (await actual.storeIdentifier()) === targetName);
    const worker = await held(() =>
      actual._withInnerWebClient(async inner => {
        await inner.ready;
        check('actualMethodWorker', inner.useWorker === true && inner.worker instanceof Worker);
        check('selectedWorkerMode', inner.constructor.workerMode === workerMode);
        return inner.worker;
      })
    );
    check('workerReady', worker instanceof Worker);
    if (kind === 'public-reader') {
      phase = 'public-wallet-reader';
      check('guardedAccountPresent', typeof accountId === 'string');
      const notes = await held(() => {
        check('actualWalletHold', !!getCurrentWasmLockHold());
        return wallet.getConsumableNotes(accountId);
      });
      check('emptyGenuineStore', notes.length === 0);
      reader = await held(() => getRealmReaderClient());
      check('publicReaderSeparate', await held(() => actual._withInnerWebClient(async inner => inner !== reader)));
      check('publicReaderNoWorker', !(reader.worker instanceof Worker));
    }
    if (kind === 'late-commit-abort' || kind === 'intentional-abort') {
      phase = 'native-request-success-then-abort';
      const epoch = getStorageHealth().epoch;
      fault = { store: targetName, intentional: kind === 'intentional-abort', claimed: false, requestSucceeded: false };
      let acknowledged = false;
      let rejected = false;
      await held(() => actual.settings.set('proof-abort', new Uint8Array(payloadBytes))).then(
        () => {
          acknowledged = true;
        },
        () => {
          rejected = true;
        }
      );
      check('requestActuallySucceeded', fault.claimed && fault.requestSucceeded);
      check('sdkRefusedAcknowledgement', rejected && !acknowledged);
      const writes = transactions.filter(tx => tx.store === targetName && tx.mode === 'readwrite');
      check(
        'nativeTransactionAborted',
        writes.some(tx => tx.aborted && !tx.completed)
      );
      check(
        'abortHealthClassification',
        kind === 'intentional-abort'
          ? getStorageHealth().status === 'healthy' && getStorageHealth().epoch === epoch
          : getStorageHealth().status === 'unavailable' && getStorageHealth().epoch === epoch + 1
      );
      observations.requestSuccessBeforeAbort = true;
      observations.intentionalAbort = kind === 'intentional-abort';
      fault = undefined;
    }
    if (kind === 'durability') {
      phase = 'bounded-durability-measurement';
      const payload = new Uint8Array(payloadBytes);
      for (let index = 0; index < 2; index++) await held(() => actual.settings.set('proof-timing', payload));
      const start = transactions.length;
      for (let index = 0; index < samples; index++) {
        payload[0] = index;
        const began = performance.now();
        await held(() => actual.settings.set('proof-timing', payload));
        timings.push(performance.now() - began);
      }
      const writes = transactions.slice(start).filter(tx => tx.store === targetName && tx.mode === 'readwrite');
      check('allMeasuredWritesCommitted', writes.length === samples && writes.every(tx => tx.completed && !tx.aborted));
      check(
        'measuredDurability',
        writes.every(
          tx =>
            tx.actual === durability &&
            (durability === 'default'
              ? tx.requested === undefined || tx.requested === 'default'
              : tx.requested === 'strict')
        )
      );
      const readback = await held(() => actual.settings.get('proof-timing'));
      check(
        'finalReadbackMatches',
        readback instanceof Uint8Array &&
          readback.length === payloadBytes &&
          readback.every((value, index) => value === payload[index])
      );
      check(
        'finiteSamples',
        timings.length === samples && timings.every(value => Number.isFinite(value) && value >= 0)
      );
      observations.samples = samples;
      observations.warmups = 2;
      observations.payloadBytes = payloadBytes;
    }
    const writes = transactions.filter(tx => tx.store === targetName && tx.mode === 'readwrite');
    observations.readwriteCount = writes.length;
    if (kind !== 'durability')
      check(
        'walletWritesStrict',
        writes.length > 0 && writes.every(tx => tx.requested === 'strict' && tx.actual === 'strict')
      );
    if (kind !== 'late-commit-abort') check('healthRemainsHealthy', getStorageHealth().status === 'healthy');
    phase = 'cleanup';
    await dispose();
    check('cleanupComplete', !wallet && !actual && !reader && !raw);
    return {
      ok: true,
      phase: 'complete',
      kind,
      mode: matrixMode,
      workerMode,
      durability,
      checks,
      observations,
      digests,
      timings
    };
  } catch {
    try {
      await dispose();
    } catch {
      checks.cleanupComplete = false;
    }
    return { ok: false, phase, kind, mode: matrixMode, workerMode, durability, checks, observations, digests, timings };
  } finally {
    fault = undefined;
    IDBDatabase.prototype.transaction = originalTransaction;
    IDBObjectStore.prototype.put = originalPut;
  }
}

window.__WALLET_WORKER_MATRIX__ = { run };
