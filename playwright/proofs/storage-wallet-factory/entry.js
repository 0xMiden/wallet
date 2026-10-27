import * as sdk from '@miden-sdk/miden-sdk/lazy';
import { MidenClientInterface, getRealmReaderClient } from 'lib/miden/sdk/miden-client-interface';
import { getCurrentWasmLockHold, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { nativeStorageName } from 'lib/miden/sdk/native-storage-policy';
import {
  initializeStorageHealth,
  getStorageHealth,
  markStorageUnavailable,
  withStorageRecoveryAccess
} from 'lib/miden/storage-health';
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

async function run(scenario) {
  let phase = 'wallet-module-ready';
  let wallet;
  let raw;
  let reader;
  const checks = {};
  const observations = {};
  const digests = {};
  const transactions = [];
  const check = (name, value) => {
    checks[name] = value === true;
    if (!checks[name]) throw new Error('FACTORY_CHECK');
  };
  const descriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'transaction');
  const originalTransaction = IDBDatabase.prototype.transaction;
  Object.defineProperty(IDBDatabase.prototype, 'transaction', {
    ...descriptor,
    value: function (...args) {
      const transaction = Reflect.apply(originalTransaction, this, args);
      transactions.push({
        name: this.name,
        mode: transaction.mode,
        requested: args[2]?.durability,
        actual: transaction.durability
      });
      return transaction;
    }
  });
  const observe = (name, storeName, requireWrite) => {
    const own = transactions.filter(transaction => transaction.name === storeName);
    const writes = own.filter(transaction => transaction.mode === 'readwrite');
    check(`${name}.realTransactions`, own.length > 0);
    if (requireWrite) check(`${name}.realWrites`, writes.length > 0);
    check(
      `${name}.strictWrites`,
      writes.every(transaction => transaction.requested === 'strict' && transaction.actual === 'strict')
    );
    observations[`${name}.readwriteSeen`] = writes.length > 0;
    observations[`${name}.transactionCount`] = own.length;
  };
  try {
    await initializeStorageHealth();
    check('initiallyHealthy', getStorageHealth().status === 'healthy');
    await sdk.getWasmOrThrow();
    const rpcUrl = `${location.origin}/factory-rpc`;
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
    await endpoints(undefined);
    if (scenario === 'mock-create' || scenario === 'mock-recovery-create') {
      phase = scenario;
      if (scenario === 'mock-recovery-create') {
        markStorageUnavailable('continuity', { backend: 'wallet', operation: 'validate' });
        const epoch = getStorageHealth().epoch;
        await withStorageRecoveryAccess(epoch, Date.now() + 4990, async capability => {
          wallet = await held(() => MidenClientInterface.createForRecovery(capability, { useWorker: true }));
          check(
            'recovery.remainsUnavailable',
            getStorageHealth().status === 'unavailable' && getStorageHealth().epoch === epoch
          );
        });
      } else wallet = await held(() => MidenClientInterface.create({ useWorker: true }));
      check('mock.actualNetwork', wallet.network === 'mock');
      check(
        'mock.actualNoWorker',
        await held(() => wallet.client._withInnerWebClient(async inner => !(inner.worker instanceof Worker)))
      );
      const store = await wallet.client.storeIdentifier();
      check('mock.nativeNamespace', store === (await nativeStorageName(rpcUrl, true)));
      observe('mock', store, true);
    } else if (scenario === 'mock-standalone-export' || scenario === 'mock-standalone-import') {
      phase = 'standalone-mock-create';
      wallet = await held(() => MidenClientInterface.create({ useWorker: false }));
      const store = await wallet.client.storeIdentifier();
      const before = await held(() => wallet.exportDb());
      check('standalone.realExport', typeof before === 'string' && before.length > 0);
      digests.export = await hash(before);
      transactions.length = 0;
      phase = scenario;
      if (scenario === 'mock-standalone-import') {
        await held(() => wallet.importDb(before));
        const after = await held(() => wallet.exportDb());
        check('standalone.exactRoundtrip', JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(after)));
        digests.imported = await hash(after);
        observe('standaloneImport', store, true);
      } else {
        const after = await held(() => wallet.exportDb());
        check('standalone.sameData', JSON.stringify(JSON.parse(before)) === JSON.stringify(JSON.parse(after)));
        observe('standaloneExport', store, false);
      }
      check('standalone.healthUnchanged', getStorageHealth().status === 'healthy');
    } else {
      phase = 'supported-genesis-source';
      raw = await sdk.MidenClient.createMock({ useWorker: false, indexedDb: { durability: 'strict' } });
      const fee = await raw.feeFaucetId();
      const feeFaucetId = fee.toString();
      fee.free();
      const accountId = scenario === 'preseeded-public-reader' ? await guardedAccount(raw) : undefined;
      const sourceName = await raw.storeIdentifier();
      await raw.waitForIdle();
      await raw[Symbol.asyncDispose]();
      raw = undefined;
      const dump = await sdk.exportStore(sourceName, { durability: 'strict' });
      digests.genesisSource = await hash(dump);
      await endpoints(feeFaucetId);
      const targetName = await nativeStorageName(rpcUrl);
      check('preseed.distinctNativeNamespace', targetName !== sourceName);
      phase = 'supported-genesis-target-import';
      transactions.length = 0;
      await sdk.importStore(targetName, dump, { durability: 'strict' });
      observe('preseedImport', targetName, true);
      transactions.length = 0;
      phase = 'actual-normal-create';
      wallet = await held(() => MidenClientInterface.create({ useWorker: false }));
      check('normal.actualNetwork', wallet.network === MIDEN_NETWORK_NAME.LOCALNET);
      check('normal.actualNamespace', (await wallet.client.storeIdentifier()) === targetName);
      check(
        'normal.actualNoWorker',
        await held(() => wallet.client._withInnerWebClient(async inner => !(inner.worker instanceof Worker)))
      );
      const genesis = await held(() => wallet.genesisHeader());
      check('normal.genuineGenesisPresent', genesis instanceof Uint8Array && genesis.length > 0);
      digests.genesisHeader = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', genesis)))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
      if (scenario === 'preseeded-public-reader') {
        phase = 'actual-public-reader-path';
        check('reader.genuineGuardedAccount', typeof accountId === 'string' && accountId.length > 0);
        const records = await held(async () => {
          check('reader.realWalletHold', getCurrentWasmLockHold() !== null);
          return wallet.getConsumableNotes(accountId);
        });
        check('reader.emptyGenuineStore', records.length === 0);
        reader = await held(() => getRealmReaderClient());
        check('reader.actualNoWorker', !(reader.worker instanceof Worker));
        check(
          'reader.separateRawClient',
          await held(() => wallet.client._withInnerWebClient(async inner => inner !== reader))
        );
      }
      observe('normal', targetName, false);
      check('normal.healthUnchanged', getStorageHealth().status === 'healthy');
    }
    check('actualWalletClass', wallet instanceof MidenClientInterface);
    check('oneActualSdkClass', wallet.client instanceof sdk.MidenClient);
    phase = 'cleanup';
    if (reader) {
      reader.terminate();
      await reader.waitForIdle();
      reader = undefined;
    }
    if (wallet) {
      const actual = wallet.client;
      await actual.waitForIdle();
      wallet.free();
      await actual[Symbol.asyncDispose]();
      wallet = undefined;
    }
    return {
      ok: true,
      phase: 'complete',
      checks,
      observations,
      digests,
      variant: process.env.MIDEN_USE_MOCK_CLIENT === 'true' ? 'mock' : 'normal',
      sdkBuild: 'st'
    };
  } catch {
    return { ok: false, phase, checks, observations, digests, sdkBuild: 'st' };
  } finally {
    if (descriptor) Object.defineProperty(IDBDatabase.prototype, 'transaction', descriptor);
    if (reader) {
      reader.terminate();
      await reader.waitForIdle().catch(() => {});
    }
    if (wallet) {
      const actual = wallet.client;
      await actual.waitForIdle().catch(() => {});
      wallet.free();
      await actual[Symbol.asyncDispose]().catch(() => {});
    }
    if (raw) {
      await raw.waitForIdle().catch(() => {});
      await raw[Symbol.asyncDispose]().catch(() => {});
    }
  }
}

Object.assign(globalThis.walletFactoryProof, { ready: true, failed: false, phase: 'ready', run });
