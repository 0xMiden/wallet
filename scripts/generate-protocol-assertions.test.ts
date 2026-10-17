/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertionTable,
  cratesBuiltInto,
  errorCode,
  inlineName,
  moduleMessages,
  sourcesRecord
} from './generate-protocol-assertions.mjs';

const crateWith = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'masm-crate-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};

it('derives the code the VM prints from the message, as miden-core does', () => {
  expect(
    errorCode('conversion info loaded from the advice map does not match the commitment provided via the auth args')
  ).toBe(15404814807981965102n);
  expect(errorCode('invalid public key commitment')).toBe(17772623450895643168n);
});

it('reads named, referenced and inline messages, and none in a comment', () => {
  const source = [
    '# const ERR_COMMENTED = "commented out"',
    'const ERR_NAMED = "named message" # a trailing "comment"',
    'const LEAF = "named without the prefix"',
    'const UNUSED = "a string nothing asserts with"',
    'proc check',
    '    assert.err=ERR_NAMED',
    '    assert_eqw.err=LEAF',
    '    u32assertw.err="inline # not a comment"',
    '    # assertz.err="commented inline"',
    'end'
  ].join('\n');
  expect(moduleMessages(source)).toEqual([
    { name: 'ERR_NAMED', message: 'named message' },
    { name: 'LEAF', message: 'named without the prefix' },
    { name: undefined, message: 'inline # not a comment' }
  ]);
});

it('refuses a message with an escape, whose hashed text it cannot know', () => {
  expect(() => moduleMessages('proc p\n    assert.err="say \\"no\\""\nend')).toThrow('escape');
});

it.each([
  ['miden-core-lib', 'start_ptr must be <= end_ptr', 'CORE_LIB_START_PTR_MUST_BE_LE_END_PTR'],
  ['miden-core-lib', 'u256 divmod: q*b + r != a', 'CORE_LIB_U256_DIVMOD_Q_TIMES_B_PLUS_R_NE_A'],
  ['miden-core-lib', 'maybe_key_ptr-8 is not u32', 'CORE_LIB_MAYBE_KEY_PTR_MINUS_8_IS_NOT_U32'],
  ['miden-core-lib', "the relation's fixed height", 'CORE_LIB_THE_RELATIONS_FIXED_HEIGHT'],
  ['miden-protocol', 'proof-of-work check failed', 'PROTOCOL_PROOF_OF_WORK_CHECK_FAILED'],
  ['miden-core-lib', 'kernel witness length must fit in a u32', 'CORE_LIB_KERNEL_WITNESS_LENGTH_MUST_FIT_IN_A_U32']
])('names an inline %s message %j by its crate and words', (crate, message, name) => {
  expect(inlineName(crate, message)).toBe(name);
});

it.each([
  ['invalid insert: already at maximum size of 8192', 'CORE_LIB_INVALID_INSERT_ALREADY_AT_MAXIMUM_SIZE'],
  ['invalid leaf: larger than maximum size of 8192', 'CORE_LIB_INVALID_LEAF_LARGER_THAN_MAXIMUM_SIZE']
])('names %j, whose digits crash scrubbing would redact, by its fixed override', (message, name) => {
  expect(inlineName('miden-core-lib', message)).toBe(name);
});

it('keeps a named constant over an inline twin, and the first constant of a shared message', () => {
  const inline = crateWith({
    'asm/a.masm': 'proc a\n    assert.err="shared"\n    assert.err="only inline"\nend\n',
    'tests/t.masm': 'const ERR_TEST_ONLY = "never shipped"\n'
  });
  const named = crateWith({
    'asm/attachments/x.masm': 'const ERR_FIRST = "shared"\n',
    'asm/fees/y.masm': 'const ERR_SECOND = "shared"\n'
  });
  const table = assertionTable([
    ['miden-core-lib', inline],
    ['miden-standards', named]
  ]);
  expect(table).toEqual(
    new Map([
      [String(errorCode('shared')), 'ERR_FIRST'],
      [String(errorCode('only inline')), 'CORE_LIB_ONLY_INLINE']
    ])
  );
});

it('refuses one name for two codes', () => {
  const crate = crateWith({
    'asm/a.masm': 'const ERR_SAME = "first"\n',
    'asm/b.masm': 'const ERR_SAME = "second"\n'
  });
  expect(() => assertionTable([['miden-standards', crate]])).toThrow('ERR_SAME names two codes');
});

it('reads the crate versions a wasm names in its source paths', () => {
  const wasm = Buffer.from(
    '\0/registry/src/index/miden-protocol-0.17.1/src/lib.rs\0miden-assembly-syntax-cst-0.35.0/src/a.rs' +
      '\0miden-tx-0.17.0-rc.5/src/b.rs\0miden-protocol-0.17.1/asm\0/build/miden-client-d9ae34fb2ceeda2e/out/rpc',
    'latin1'
  );
  expect(cratesBuiltInto(wasm)).toEqual(
    new Map([
      ['miden-protocol', new Set(['0.17.1'])],
      ['miden-assembly-syntax-cst', new Set(['0.35.0'])],
      ['miden-tx', new Set(['0.17.0-rc.5'])]
    ])
  );
});

it('records beside the release and crates it read the digest of those and the table it wrote', () => {
  const crates = { 'miden-core-lib': '0.35.0', 'miden-protocol': '0.17.1' };
  const table = '{\n  "1": "ERR_ONE"\n}\n';
  const sha256 = createHash('sha256')
    .update(JSON.stringify({ sdk: '0.17.3', crates }))
    .update(table)
    .digest('hex');
  expect(sourcesRecord('0.17.3', crates, table)).toBe(
    `${JSON.stringify({ sdk: '0.17.3', crates, sha256 }, null, 2)}\n`
  );
  expect(sourcesRecord('0.17.3', crates, `${table} `)).not.toContain(sha256);
  expect(sourcesRecord('0.17.4', crates, table)).not.toContain(sha256);
  expect(sourcesRecord('0.17.3', { ...crates, 'miden-protocol': '0.17.2' }, table)).not.toContain(sha256);
});
