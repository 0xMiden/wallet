import * as sdk from '@miden-sdk/miden-sdk/lazy';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { nativeStorageName, nativeStoragePolicy } from 'lib/miden/sdk/native-storage-policy';
import { nativeNoteAcquisition } from 'lib/miden/sdk/native-note-acquisition';
import { initializeStorageHealth } from 'lib/miden/storage-health';
import { applyEndpointOverride, getEffectiveFeeFaucetId } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

const event = name => window.__sdkControlEvent(name).catch(() => {});
window.__sdkControl = async variant => {
  await sdk.MidenClient.ready();
  applyEndpointOverride({
    rpcUrl: location.origin,
    noteTransportUrl: `${location.origin}/notes`,
    proverUrl: `${location.origin}/prover`,
    faucetUrl: `${location.origin}/faucet`,
    faucetApiUrl: `${location.origin}/faucet`,
    explorerUrl: `${location.origin}/explorer`,
    guardianUrl: `${location.origin}/guardian`,
    allowNoGuardian: false,
    networkName: MIDEN_NETWORK_NAME.LOCALNET,
    presetName: 'localnet'
  });
  if (getEffectiveFeeFaucetId() === undefined) event('feeOmitted');
  else throw new Error('unexpected-fee-faucet');
  await initializeStorageHealth();
  const store = await nativeStorageName(location.origin);
  const wrapper = sdk.MidenClient._WasmWebClient;
  const original = wrapper.prototype.getWasmWebClient;
  wrapper.prototype.getWasmWebClient = async function (...args) {
    const native = await Reflect.apply(original, this, args);
    const create = native.createClientWithExternalKeystore;
    native.createClientWithExternalKeystore = async function (...values) {
      window.__sdkNative = true;
      event('nativeEntry');
      const heartbeat = setInterval(() => event('heartbeat'), 1000);
      try { return await Reflect.apply(create, this, values); }
      finally { clearInterval(heartbeat); native.createClientWithExternalKeystore = create; }
    };
    return native;
  };
  const refuse = async () => { throw new Error('control-refused'); };
  let created;
  try {
    await withWasmClientLock(async () => {
      const client = variant === 'wallet-factory' ? await getMidenClient() : await sdk.MidenClient.create({
        rpcUrl: location.origin,
        noteTransportUrl: `${location.origin}/notes`,
        noteTransportMaxRetries: 0,
        proverUrl: `${location.origin}/prover`,
        autoSync: false,
        useWorker: true,
        indexedDb: nativeStoragePolicy(store, () => true),
        ...nativeNoteAcquisition(MIDEN_NETWORK_NAME.LOCALNET, () => true, () => created),
        keystore: { getKey: refuse, insertKey: refuse, sign: refuse }
      });
      created = client;
      event('factoryReturned');
      if (variant !== 'wallet-factory') client.terminate();
    });
  } finally {
    wrapper.prototype.getWasmWebClient = original;
  }
};
