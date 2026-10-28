import * as sdk from '@miden-sdk/miden-sdk/lazy';

const event = name => window.__sdkControlEvent(name).catch(() => {});
window.__sdkControl = async () => {
  await sdk.MidenClient.ready();
  const wrapper = sdk.MidenClient._WasmWebClient;
  const original = wrapper.prototype.getWasmWebClient;
  wrapper.prototype.getWasmWebClient = async function (...args) {
    const native = await Reflect.apply(original, this, args);
    const create = native.createClientWithExternalKeystore;
    native.createClientWithExternalKeystore = async function (...values) {
      window.__sdkNative = true;
      event('nativeEntry');
      const heartbeat = setInterval(() => event('heartbeat'), 1000);
      try {
        return await Reflect.apply(create, this, values);
      } finally {
        clearInterval(heartbeat);
        native.createClientWithExternalKeystore = create;
      }
    };
    return native;
  };
  const refuse = async () => { throw new Error('control-refused'); };
  try {
    const client = await sdk.MidenClient.create({
      rpcUrl: location.origin,
      noteTransportUrl: `${location.origin}/notes`,
      noteTransportMaxRetries: 0,
      proverUrl: `${location.origin}/prover`,
      autoSync: false,
      useWorker: true,
      indexedDb: { durability: 'strict', onFailure: () => event('failureCallback') },
      noteAcquisitionLimits: { maxNotes: 256, maxNoteFileBytes: 2097152, maxTotalNoteFileBytes: 2097152 },
      beforeNoteAcquisition: refuse,
      keystore: { getKey: refuse, insertKey: refuse, sign: refuse }
    });
    event('factoryReturned');
    client.terminate();
  } finally {
    wrapper.prototype.getWasmWebClient = original;
  }
};
