import * as sdk from '@miden-sdk/miden-sdk/lazy';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { Vault } from 'lib/miden/back/vault';
import { encryptAndSaveMany, savePlain } from 'lib/miden/back/safe-storage';
import * as Passworder from 'lib/miden/passworder';
import * as Repo from 'lib/miden/repo';
import { getMidenClient, resetMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { nativeStorageName } from 'lib/miden/sdk/native-storage-policy';
import { RECOVERY_JOURNAL_KEYS } from 'lib/miden/recovery/journal';
import { decryptRecoveryDataFile, RECOVERY_DATA_FILE_MAX_BYTES } from 'lib/miden/recovery/external-file';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import { getWasmOrThrow, NoteAcquisitionRetentionError } from '@miden-sdk/miden-sdk/lazy';
import { initializeStorageHealth, getStorageHealth } from 'lib/miden/storage-health';
import { applyEndpointOverride, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { WalletType } from 'screens/onboarding/types';
import { ITransactionStatus } from 'lib/miden/db/types';
import { requeueFailedTransaction } from 'lib/miden/transaction/retry';

import { prepareChain } from './prepare-chain';

let vault;
let sdkStore;
let phase = 'initial';
const checks = {};
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const check = (name, value) => {
  checks[name] = value === true;
  if (!checks[name]) throw new Error(name);
};
const progress = value => {
  phase = value;
  window.__retainedPhase = value;
  window.__retainedReportPhase?.(value).catch(() => {});
};
const guard = () => {
  if (location.hostname !== '127.0.0.1' || location.protocol !== 'http:' || !location.pathname.startsWith('/st/'))
    throw new Error('disposable-origin');
};
const control = async (action, body) => {
  const response = await fetch(`/__fixture/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('fixture-control');
  return response.json();
};
async function endpoints(feeFaucetId) {
  progress('endpoint-override');
  await applyEndpointOverride({
    rpcUrl: location.origin,
    proverUrl: `${location.origin}/prover`,
    noteTransportUrl: `${location.origin}/notes`,
    faucetUrl: `${location.origin}/faucet`,
    faucetApiUrl: `${location.origin}/faucet`,
    explorerUrl: `${location.origin}/explorer`,
    guardianUrl: `${location.origin}/guardian`,
    allowNoGuardian: false,
    networkName: MIDEN_NETWORK_NAME.LOCALNET,
    presetName: 'localnet',
    feeFaucetId
  });
  check('endpointBound', getEffectiveRpcUrl() === location.origin);
  progress('native-wasm-lookup');
  const wasm = await getWasmOrThrow();
  progress('native-error-class');
  check('nativeErrorClass', typeof NoteAcquisitionRetentionError === 'function');
  progress('native-acquisition-gate');
  check('nativeAcquisitionGate', typeof wasm.WebClient?.prototype?.installNoteAcquisitionGate === 'function');
  progress('native-resolver');
  check('nativeResolver', typeof wasm.resolveStoreName === 'function');
  progress('native-store-name');
  sdkStore = await nativeStorageName(location.origin);
  window.__retainedSdkStore = sdkStore;
  progress('native-distinct-store');
  check('distinctSdkStore', sdkStore !== Repo.db.name && sdkStore !== 'mock_client_db');
}
async function prepare(password, includePrivate) {
  guard();
  progress('wasm-ready');
  await ensureSdkWasmReady();
  progress('genuine-chain-bootstrap');
  const fixture = await prepareChain(sdk);
  progress('generated-protocol-fixtures');
  const generated = await control('produce', {
    chain: fixture.chain,
    accountId: fixture.accountId,
    accountBytes: fixture.accountBytes,
    accountCommitment: fixture.accountCommitment
  });
  fixture.chain.fill(0);
  progress('producer-response');
  check('producerBound', generated.headers > 0 && generated.headers <= 32 && generated.accountProof === true);
  await endpoints(fixture.feeFaucetId);
  progress('sdk-generated-request-images');
  const endpoint = new sdk.Endpoint(location.origin);
  const rpc = new sdk.RpcClient(endpoint);
  const id = sdk.AccountId.fromHex(fixture.accountId);
  try {
    for (let height = 0; height < generated.headers; height++) {
      for (const proof of [false, true]) {
        await control('learn', { kind: 'header', height });
        const response = await rpc.getBlockHeaderByNumber(height, proof);
        if (height === fixture.block && !proof) {
          const root = response.noteRoot();
          check('noteHeaderMatchesFixture', root.toHex() === fixture.trustedNoteRoot);
          root.free();
        }
        response.free();
      }
    }
    await control('learn', { kind: 'header', height: generated.headers - 1 });
    const tip = await rpc.getBlockHeaderByNumber(undefined, false);
    tip.free();
    await control('learn', { kind: 'account' });
    const proof = await rpc.getAccountProof(id);
    proof.free();
    const nullifier = sdk.Word.fromHex('0x' + fixture.nullifier);
    try {
      const prefix = Number(nullifier.toU64s()[3] >> 48n);
      await control('learn', { kind: 'nullifier' });
      const updates = await rpc.syncNullifiers(new Uint16Array([prefix]), fixture.block, generated.headers - 1);
      check('learnedEmptyNullifiers', updates.length === 0);
      updates.forEach(update => update.free());
    } finally {
      nullifier.free();
    }
  } finally {
    id.free();
    rpc.free();
  }
  await control('seal', {});
  await initializeStorageHealth();
  check('initialHealthy', getStorageHealth().status === 'healthy');
  progress('real-password-protector');
  const raw = Passworder.generateVaultKey();
  const key = await Passworder.importVaultKey(raw);
  check('nonExtractableVaultKey', key.extractable === false);
  await savePlain('vault_key_password', await Passworder.encryptVaultKeyWithPassword(raw, password));
  raw.fill(0);
  const hot = fixture.custody[0],
    cold = fixture.custody[1];
  const hotPublic = hex(new Uint8Array(hot.publicBytes).slice(1));
  const coldPublic = hex(new Uint8Array(cold.publicBytes).slice(1));
  const account = {
    publicKey: fixture.accountId,
    name: 'Disposable recovery',
    type: WalletType.Guardian,
    hdIndex: -1,
    authScheme: 'ecdsa',
    hotPublicKey: hotPublic,
    coldPublicKey: coldPublic,
    requiresHotKeyRotation: true,
    guardianEndpoint: `${location.origin}/guardian`,
    guardianOperatorCommitment: fixture.guardianCommitment,
    guardianEpoch: 0
  };
  await encryptAndSaveMany(
    [
      ['vault_check', crypto.randomUUID()],
      ['vault_accounts', [account]],
      ['vault_settings', {}],
      ['vault_mnemonic', generateMnemonic(wordlist)],
      ['vault_ownmnemonic', false],
      ['vault_curraccpubkey', fixture.accountId],
      ['vault_accouldsecretkey_' + coldPublic, hex(cold.secretBytes)]
    ],
    key
  );
  for (const material of fixture.custody) material.secretBytes.fill(0);
  vault = await Vault.setup(password);
  await Repo.db.open();
  progress('pre-loss-native-fixture');
  progress('pre-loss-import');
  if (includePrivate) await sdk.importStore(sdkStore, fixture.database, { durability: 'strict' });
  progress('pre-loss-lock');
  await withWasmClientLock(async () => {
    const originalCreate = sdk.MidenClient.create;
    sdk.MidenClient.create = async function (...args) {
      progress(args[0]?.useWorker === true ? 'sdk-create-worker' : 'sdk-create-other');
      const wrapper = sdk.MidenClient._WasmWebClient;
      const originalFactory = wrapper.createClientWithExternalKeystore;
      const originalWasm = wrapper.prototype.getWasmWebClient;
      wrapper.createClientWithExternalKeystore = async function (...values) {
        progress(typeof Worker === 'function' ? 'sdk-factory-worker-available' : 'sdk-factory-worker-absent');
        const result = await Reflect.apply(originalFactory, this, values);
        progress('sdk-factory-returned');
        return result;
      };
      wrapper.prototype.getWasmWebClient = async function (...values) {
        progress('sdk-wasm-client-enter');
        const result = await Reflect.apply(originalWasm, this, values);
        progress('sdk-wasm-client-returned');
        const originalNativeCreate = result.createClientWithExternalKeystore;
        result.createClientWithExternalKeystore = async function (...nativeArgs) {
          window.__retainedNativeCreating = true;
          window.__retainedStorageEvent('nativeMarker').catch(() => {});
          progress('sdk-native-create-enter');
          const heartbeat = setInterval(() => window.__retainedStorageEvent('nativeHeartbeat').catch(() => {}), 1000);
          try {
            const client = await Reflect.apply(originalNativeCreate, this, nativeArgs);
            progress('sdk-native-create-returned');
            return client;
          } finally {
            clearInterval(heartbeat);
            result.createClientWithExternalKeystore = originalNativeCreate;
          }
        };
        return result;
      };
      try {
        const result = await Reflect.apply(originalCreate, this, args);
        progress('sdk-create-returned');
        return result;
      } finally {
        wrapper.createClientWithExternalKeystore = originalFactory;
        wrapper.prototype.getWasmWebClient = originalWasm;
        sdk.MidenClient.create = originalCreate;
      }
    };
    progress('pre-loss-client');
    const wallet = await getMidenClient();
    if (!includePrivate) {
      progress('pre-loss-account-insert');
      const parsed = sdk.Account.deserialize(new Uint8Array(fixture.accountBytes));
      try {
        await wallet.client.accounts.insert({ account: parsed, overwrite: false });
      } finally {
        parsed.free();
      }
    }
    progress('pre-loss-account-read');
    const accountReadback = await wallet.getAccount(fixture.accountId);
    check('preLossRealAccount', accountReadback !== null && accountReadback !== undefined);
    accountReadback?.free();
    if (includePrivate) {
      progress('pre-loss-note-read');
      const note = await wallet.getInputNote('0x' + fixture.noteId);
      check('preLossAuthenticatedPrivate', note?.isAuthenticated() === true);
      note?.free();
    }
  });
  fixture.database = '';
  progress('retained-vault-baseline');
  check('baselineEstablished', await vault.verifyStorageContinuity(true));
  const syntheticId = 'disposable-submitted-attempt';
  const attemptId = 'disposable-attempt';
  const requestBytes = new Uint8Array([1, 2, 3]);
  const evidence = {
    transactionId: '0x' + '11'.repeat(32),
    initialCommitment: '0x' + '22'.repeat(32),
    finalCommitment: '0x' + '33'.repeat(32),
    initialNonce: '1',
    refBlock: 1,
    refBlockCommitment: '0x' + '44'.repeat(32),
    outputNoteIds: [],
    nullifiers: [],
    expirationBlock: 30
  };
  await Repo.transactions.add({
    id: syntheticId,
    accountId: fixture.accountId,
    type: 'send',
    status: ITransactionStatus.Unconfirmed,
    initiatedAt: 1,
    displayIcon: 'SEND',
    mayHaveSubmitted: true,
    attemptId,
    submitEvidence: [{ attemptId, capturedAt: 1, source: 'stage', ...evidence }]
  });
  await vault.retainTransactionRecovery(syntheticId, { requestBytes, notes: [] }, evidence, attemptId);
  progress('external-file-baseline');
  const prior = await vault.readRecoveryJournal();
  check('priorAttemptVerified', prior?.entries.some(entry => entry.kind === 'transaction' && entry.id === syntheticId && entry.mayHaveSubmitted === true && entry.row?.submitEvidence?.length === 1) === true);
  const provider = getStorageProvider();
  const before = JSON.stringify(await provider.get(RECOVERY_JOURNAL_KEYS));
  const floorKey = await digest(new TextEncoder().encode('vault_recoverycontinuity'));
  const beforeFloor = JSON.stringify((await provider.get([floorKey]))[floorKey]);
  check('independentFloorPresent', typeof beforeFloor === 'string' && beforeFloor.length > 0);
  const filePassword = crypto.randomUUID();
  progress('external-file-export');
  const content = await Vault.exportRecoveryData(filePassword, password);
  check('encryptedFileBounded', new TextEncoder().encode(content).length <= RECOVERY_DATA_FILE_MAX_BYTES && !content.includes(syntheticId) && !content.includes(attemptId));
  const opened = await decryptRecoveryDataFile(content, filePassword);
  check('correctPasswordRoundTrip', (await digest(new TextEncoder().encode(JSON.stringify(opened)))) === (await digest(new TextEncoder().encode(JSON.stringify(prior)))));
  progress('external-file-wrong-password');
  let wrongPasswordRefused = false;
  try { await Vault.importRecoveryData(content, filePassword + '-wrong', getStorageHealth().epoch, password); }
  catch (error) { wrongPasswordRefused = error instanceof Error && error.name === 'RecoveryDataFileError' && error.code === 'password'; }
  check('wrongPasswordRefused', wrongPasswordRefused);
  check('wrongPasswordUnchanged', JSON.stringify(await provider.get(RECOVERY_JOURNAL_KEYS)) === before && getStorageHealth().status === 'healthy');
  progress('disposable-journal-store-loss');
  await provider.remove(RECOVERY_JOURNAL_KEYS);
  const missing = await provider.get(RECOVERY_JOURNAL_KEYS);
  check('onlyJournalKeysMissing', RECOVERY_JOURNAL_KEYS.every(key => missing[key] === undefined) && (await indexedDB.databases()).some(item => item.name === Repo.db.name) && (await indexedDB.databases()).some(item => item.name === sdkStore));
  check('independentFloorSurvived', JSON.stringify((await provider.get([floorKey]))[floorKey]) === beforeFloor);
  check('missingJournalRefused', (await vault.verifyStorageContinuity(false)) === false && getStorageHealth().status === 'unavailable');
  const incident = getStorageHealth();
  progress('external-file-import');
  const imported = await Vault.importRecoveryData(content, filePassword, incident.epoch, password);
  check('encryptedFileImported', imported.imported === true);
  check('importDidNotResume', getStorageHealth().status === 'unavailable' && getStorageHealth().epoch === incident.epoch);
  const retained = await vault.readRecoveryJournal();
  check('importedScopeAndEvidence', retained?.scope.network === prior.scope.network && retained.scope.walletGeneration === prior.scope.walletGeneration && retained.scope.sdkGeneration === prior.scope.sdkGeneration && retained.sequence >= prior.sequence && retained.entries.some(entry => entry.kind === 'transaction' && entry.id === syntheticId && entry.mayHaveSubmitted === true && entry.row?.submitEvidence?.length === 1));
  progress('external-file-bounded-recovery');
  check('boundedRecoverySucceeded', (await vault.recoverStorage()) === true && getStorageHealth().status === 'healthy');
  const restored = await Repo.transactions.get(syntheticId);
  check('syntheticEvidenceRestored', restored?.status === ITransactionStatus.Unconfirmed && restored.mayHaveSubmitted === true && restored.submitEvidence?.length === 1 && restored.requestBytes?.length === 3 && restored.requestBytes.every((value, index) => value === [1, 2, 3][index]));
  const summary = await control('summary', {});
  check('noSubmissionOrRefusal', summary.submitCalls === 0 && summary.refusedRequests === 0);
  return { phase, checks: { ...checks } };
}
async function recover(password) {
  guard();
  progress('restart-real-vault');
  await ensureSdkWasmReady();
  const state = await control('read-state', {});
  await endpoints(state.feeFaucetId);
  check('sdkMissingBeforeRecovery', !(await indexedDB.databases()).some(item => item.name === sdkStore));
  await initializeStorageHealth();
  vault = await Vault.setup(password);
  progress('detect-sdk-loss');
  check('continuityRefused', (await vault.verifyStorageContinuity(false)) === false);
  check('unavailableAfterLoss', getStorageHealth().status === 'unavailable');
  const before = await vault.readRecoveryJournal();
  check(
    'encryptedJournalSurvived',
    (await digest(new TextEncoder().encode(JSON.stringify(before)))) === state.journalDigest
  );
  progress('actual-missing-account-recovery');
  const observed = [];
  const recovered = await vault.recoverStorage(value => {
    observed.push({
      phase: value.phase,
      verifiedAccounts: value.verifiedAccounts,
      verifiedInputs: value.verifiedInputs
    });
  });
  const service = await control('summary', {});
  check('missingAccountGuardianBranch', service.guardianReads > 0 && service.accountReads > 0);
  check(
    'recoveredAccountVerified',
    observed.some(value => value.verifiedAccounts === 1)
  );
  const after = await vault.readRecoveryJournal();
  check(
    'priorRequiredEvidenceRetained',
    after !== null &&
      after.sequence >= before.sequence &&
      before.entries.every(entry => after.entries.some(next => JSON.stringify(next) === JSON.stringify(entry)))
  );
  checks.recovered = recovered === true;
  checks.healthyAfterRecovery = getStorageHealth().status === 'healthy';
  if (recovered) {
    const row = await Repo.transactions.get('disposable-submitted-attempt');
    check('submissionRestored', row?.status === ITransactionStatus.Unconfirmed && row.mayHaveSubmitted === true &&
      row.restoredFromJournal === true && row.submitEvidence?.length === 1 &&
      row.submitEvidence[0].attemptId === 'disposable-attempt' && row.submitEvidence[0].transactionId === '0x' + '11'.repeat(32) &&
      row.requestBytes?.length === 3 && row.requestBytes.every((value, index) => value === [1, 2, 3][index]));
    const reconciliation = await vault.reconcileStorageRecovery();
    const unresolved = await Repo.transactions.get('disposable-submitted-attempt');
    check('unknownReconciledWithoutRetry', reconciliation.reconciled === 0 && unresolved?.status === ITransactionStatus.Unconfirmed &&
      unresolved.mayHaveSubmitted === true && unresolved.submitEvidence?.length === 1);
    let refused = false;
    try { await requeueFailedTransaction('disposable-submitted-attempt'); } catch { refused = true; }
    const afterRetry = await Repo.transactions.get('disposable-submitted-attempt');
    check('retryRefused', refused && afterRetry?.status === ITransactionStatus.Unconfirmed && afterRetry.mayHaveSubmitted === true);
    const afterJournal = await vault.readRecoveryJournal();
    check('submissionEvidenceRetained', afterJournal?.entries.some(entry => entry.kind === 'transaction' &&
      entry.id === 'disposable-submitted-attempt' && entry.mayHaveSubmitted === true && entry.row?.submitEvidence?.length === 1) === true);
    await withWasmClientLock(async () => {
      const wallet = await getMidenClient();
      const account = await wallet.getAccount(state.accountId);
      check('rebuiltNativeAccount', account !== null && account !== undefined);
      account?.free();
      if (state.includePrivate) {
        const note = await wallet.getInputNote('0x' + state.noteId);
        check('rebuiltAuthenticatedPrivate', note?.isAuthenticated() === true);
        note?.free();
      }
    });
  }
  const noteStages = ['Entered', 'Deserialized', 'ExistingRead', 'AcquireEntered', 'AcquireReturned', 'ReadbackReturned', 'PreparedEntered', 'GenerationRead', 'PreparedReady', 'ImportEntered', 'NativeCallback', 'CandidateCopied', 'ReceiptCallback', 'ReceiptMatched', 'ReceiptReturned', 'CallbackReturned', 'ImportResolved', 'ImportRejected', 'ErrorString', 'ErrorObject', 'Errorstorage', 'Errornetwork', 'Errornote', 'Errordatabase', 'Errortransaction', 'Errordeserialize', 'Errorblock', 'Errorheader', 'Errorinvalid', 'Errorproof', 'ErrorRootMismatch', 'ErrorAcceptHeader']
    .map(stage => Reflect.get(globalThis, '__noteRestore' + stage) === true);
  return { phase, checks: { ...checks }, progress: observed, service, noteStages };
}
window.__retainedProof = { prepare, recover };
