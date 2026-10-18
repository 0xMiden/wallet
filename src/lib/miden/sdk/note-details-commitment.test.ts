/* eslint-disable import/first -- the jest.mock() factory must be registered before the module under test is imported. */
/**
 * Which words the details commitment hashes and in which order (#1389), over a fake SDK whose hash spells out what it
 * was given and answers in upper-case hex. The real Poseidon2 composition is pinned by
 * note-details-commitment.real-sdk.test.ts.
 */
jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const fakeHash = (name: string) => ({ toFelts: () => [name], toHex: () => `0X${name.toUpperCase()}` });
  return {
    FeltArray: function FeltArray(items: string[]) {
      return { items };
    },
    Poseidon2: { hashElements: (array: { items: string[] }) => fakeHash(`h(${array.items.join(',')})`) }
  };
});

import { normalizedCommitment, noteDetailsCommitment, type NoteDetailsParts } from './note-details-commitment';

const word = (name: string) => ({ toFelts: () => [name], toHex: () => `0x${name}` });
const asset = (name: string) => ({ vaultKey: () => word(`${name}-key`), intoWord: () => word(`${name}-value`) });
const details = (...assets: ReturnType<typeof asset>[]) =>
  ({
    recipient: () => ({ digest: () => word('recipient') }),
    assets: () => ({ assets: () => assets })
  }) as unknown as NoteDetailsParts;

describe('noteDetailsCommitment', () => {
  it('hashes the recipient digest, then the commitment to every asset key and value in note order', () => {
    expect(noteDetailsCommitment(details(asset('a'), asset('b')))).toBe('h(recipient,h(a-key,a-value,b-key,b-value))');
  });

  it('hashes an asset-less note over an empty assets commitment', () => {
    expect(noteDetailsCommitment(details())).toBe('h(recipient,h())');
  });
});

describe('normalizedCommitment', () => {
  it.each([
    ['0xABcd', 'abcd'],
    ['0XAB', 'ab'],
    ['abcd', 'abcd']
  ])('spells %s as %s', (hex, normalized) => {
    expect(normalizedCommitment(hex)).toBe(normalized);
  });
});
