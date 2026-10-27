import { captureRecoveryNotes, decodeRecoveryCapture } from './capture';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteType: { Private: 0, Public: 1 },
  NoteFile: {
    fromInputNote: (note: { bytes: Uint8Array }) => ({ serialize: () => note.bytes, free: () => {} }),
    fromOutputNote: (note: { bytes: Uint8Array }) => ({ serialize: () => note.bytes, free: () => {} })
  }
}));

const input = {
  id: () => ({ toString: () => 'input' }),
  bytes: new Uint8Array([1, 7, 255]),
  note: () => ({ metadata: () => ({ noteType: () => 0 }), free: () => {} })
};
const output = {
  id: () => ({ toString: () => 'private-output' }),
  bytes: new Uint8Array([3, 9, 250]),
  metadata: () => ({ noteType: () => 0 }),
  intoFull: () => ({ free: () => {} })
};
const result = (privateBody = true) =>
  Object.assign(Object.create(null), {
    executedTransaction: () => ({
      inputNotes: () => ({ notes: () => [input] }),
      userOutputNotes: () => [{ ...output, intoFull: () => (privateBody ? { free: () => {} } : undefined) }]
    })
  });

it('retains actual input and private user-output NoteFile bytes before submit', () => {
  expect(captureRecoveryNotes(result(), new Uint8Array([4, 5]), () => true)).toEqual({
    requestBytes: new Uint8Array([4, 5]),
    notes: [
      { kind: 'note', id: 'input', provenance: 'input', format: 'full', noteFile: input.bytes },
      { kind: 'note', id: 'private-output', provenance: 'output', format: 'full', noteFile: output.bytes }
    ]
  });
});

it('refuses a private output whose body is unavailable', () => {
  expect(() => captureRecoveryNotes(result(false), new Uint8Array([4]), () => true)).toThrow(/body unavailable/);
});

it('does not read borrowed notes after the execution hold was lost', () => {
  const read = jest.fn();
  expect(() =>
    captureRecoveryNotes(
      Object.assign(Object.create(null), { executedTransaction: read }),
      new Uint8Array([4]),
      () => false
    )
  ).toThrow(/poisoned/);
  expect(read).not.toHaveBeenCalled();
});

it('validates transported note bytes and refuses unknown secret-shaped fields', () => {
  expect(
    decodeRecoveryCapture({
      requestBytes: [4],
      notes: [{ kind: 'note', id: 'input', provenance: 'input', noteFile: [1, 7, 255] }]
    }).notes[0]?.noteFile
  ).toEqual(input.bytes);
  expect(() =>
    decodeRecoveryCapture({
      requestBytes: [4],
      notes: [{ kind: 'note', id: 'input', provenance: 'input', noteFile: [256] }]
    })
  ).toThrow();
  expect(() => decodeRecoveryCapture({ requestBytes: [4], notes: [], secretKey: [1] })).toThrow();
});

it.each(['input', 'output'])('Task4C3 capture excludes a known-public %s while preserving private bytes', direction => {
  const publicInput = {
    ...input,
    id: () => ({ toString: () => 'public-input' }),
    note: () => ({ metadata: () => ({ noteType: () => 1 }), free: () => {} })
  };
  const publicOutput = {
    ...output,
    id: () => ({ toString: () => 'public-output' }),
    metadata: () => ({ noteType: () => 1 })
  };
  const executed = Object.assign(Object.create(null), {
    executedTransaction: () => ({
      inputNotes: () => ({ notes: () => (direction === 'input' ? [input, publicInput] : [input]) }),
      userOutputNotes: () => (direction === 'output' ? [output, publicOutput] : [output])
    })
  });
  expect(captureRecoveryNotes(executed, new Uint8Array([4, 5]), () => true)).toEqual({
    requestBytes: new Uint8Array([4, 5]),
    notes: [
      { kind: 'note', id: 'input', provenance: 'input', format: 'full', noteFile: input.bytes },
      { kind: 'note', id: 'private-output', provenance: 'output', format: 'full', noteFile: output.bytes }
    ]
  });
});

it('Task4C3 public-only capture preserves the prebroadcast request with no private bodies', () => {
  const executed = Object.assign(Object.create(null), {
    executedTransaction: () => ({
      inputNotes: () => ({ notes: () => [] }),
      userOutputNotes: () => [{ ...output, metadata: () => ({ noteType: () => 1 }) }]
    })
  });
  expect(captureRecoveryNotes(executed, new Uint8Array([7, 8, 9]), () => true)).toEqual({
    requestBytes: new Uint8Array([7, 8, 9]),
    notes: []
  });
});
