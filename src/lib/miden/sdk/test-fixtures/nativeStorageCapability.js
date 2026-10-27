class NoteAcquisitionRetentionError extends Error {
  constructor() {
    super('Note acquisition retention failed');
    this.name = 'NoteAcquisitionRetentionError';
  }
}

function nativeStorageWasm(storeName = 'test-store') {
  return {
    WebClient: class {
      installNoteAcquisitionGate() {}
    },
    resolveStoreName: jest.fn(() => storeName)
  };
}

function nativeStorageCapability(storeName = 'test-store') {
  return {
    NoteAcquisitionRetentionError,
    getWasmOrThrow: jest.fn(async () => nativeStorageWasm(storeName))
  };
}

module.exports = { nativeStorageCapability, nativeStorageWasm };
