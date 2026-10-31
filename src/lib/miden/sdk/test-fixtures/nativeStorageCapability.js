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

class NoteFileFixture {
  constructor(properties) {
    Object.assign(this, properties);
  }

  note() {
    return undefined;
  }

  noteDetails() {
    return {
      recipient: () => ({ digest: () => ({ toFelts: () => [] }) }),
      assets: () => ({ assets: () => [] }),
      free() {}
    };
  }

  noteId() {
    return undefined;
  }

  serialize() {
    return new Uint8Array([1]);
  }
}

function noteFileFixture(properties = {}) {
  return new NoteFileFixture(properties);
}

function noteAcquisitionPrimitives() {
  return {
    FeltArray: jest.fn(elements => ({ elements })),
    Poseidon2: {
      hashElements: jest.fn(() => ({ toHex: () => '12'.repeat(32), toFelts: () => [] }))
    }
  };
}

module.exports = { nativeStorageCapability, nativeStorageWasm, noteFileFixture, noteAcquisitionPrimitives };
