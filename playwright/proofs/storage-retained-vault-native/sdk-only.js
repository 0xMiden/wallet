import * as sdk from '@miden-sdk/miden-sdk/lazy';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { nativeStorageName, nativeStoragePolicy } from 'lib/miden/sdk/native-storage-policy';
import { nativeNoteAcquisition } from 'lib/miden/sdk/native-note-acquisition';
import { initializeStorageHealth } from 'lib/miden/storage-health';
import { applyEndpointOverride, getEffectiveFeeFaucetId } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

const event = name => window.__sdkControlEvent(name).catch(() => {});
window.__sdkGenerateFee = async () => {
  await sdk.MidenClient.ready();
  const { prepareChain } = await import('./prepare-chain');
  try {
    const fixture = await prepareChain(sdk);
    for (const material of fixture.custody) material.secretBytes.fill(0);
    fixture.chain.fill(0);
    return { ok: true, fee: fixture.feeFaucetId };
  } catch (error) {
    const name = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof Error ? 'Error' : 'Other';
    const phases = ['sdk-load', 'initial-disposable-context', 'bootstrap', 'guarded-recipient-build', 'real-mockchain-mint', 'producer-authenticated-record'];
    return { ok: false, phase: phases.includes(window.__seedPhase) ? window.__seedPhase : 'unknown', errorClass: name };
  }
};
window.__sdkControl = async (variant, fee) => {
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
    presetName: 'localnet',
    feeFaucetId: variant === 'fee-present' ? fee : undefined
  });
  if (variant === 'fee-present' && getEffectiveFeeFaucetId() === fee) event('feePresent');
  else if (variant === 'fee-omitted' && getEffectiveFeeFaucetId() === undefined) event('feeOmitted');
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
      const client = await getMidenClient();
      created = client;
      event('factoryReturned');

    });
  } finally {
    wrapper.prototype.getWasmWebClient = original;
  }
};
