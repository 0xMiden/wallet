import {
  type Felts4,
  MIDEN_NAME_COMMITMENT_TAG,
  accountKeyFelts,
  commitmentPreimage,
  decodeDomainFelts,
  encodeDomainFelts,
  feltsEqual,
  formatMidenName,
  isZeroFelts,
  looksLikeMidenName,
  normalizeMidenNameInput,
  priceKeyFelts,
  REGISTRY_NOTE_ACTION,
  registerNoteInputs,
  registryNoteInputs,
  statusKeyFelts,
  validateMidenLabel
} from './encoding';
import { MidenNameInvalidLabelError } from './errors';

const REGISTRY = { prefix: 0xead81800958e7a11n, suffix: 0x2d45bdcf852fa600n };
const TOKEN = { prefix: 0x18101fa522c174b1n, suffix: 0x65efd4f70a038500n };
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Small deterministic PRNG so that the round-trip test is stable. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('encodeDomainFelts', () => {
  it('matches the on-chain fixture for "miden"', () => {
    expect(encodeDomainFelts('miden')).toEqual([0n, 0n, 60213692685n, 5n]);
  });

  it('matches the on-chain fixture for "zzqxjv9q1kk"', () => {
    expect(encodeDomainFelts('zzqxjv9q1kk')).toEqual([0n, 185277457n, 10157331770841626n, 11n]);
  });

  it('puts chars 14..20 in felt 0 for a 21-char label', () => {
    const felts = encodeDomainFelts('aaaaaaabbbbbbbccccccc');
    // 'c' = 3 in each of the 7 bytes.
    expect(felts[0]).toBe(0x03030303030303n);
    expect(felts[1]).toBe(0x02020202020202n);
    expect(felts[2]).toBe(0x01010101010101n);
    expect(felts[3]).toBe(21n);
  });

  it('encodes digits as 27..36', () => {
    expect(encodeDomainFelts('0')).toEqual([0n, 0n, 27n, 1n]);
    expect(encodeDomainFelts('9')).toEqual([0n, 0n, 36n, 1n]);
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(22), 'too-long'],
    ['Alice', 'invalid-chars'],
    ['al-ice', 'invalid-chars'],
    ['al.ice', 'invalid-chars'],
    ['ali ce', 'invalid-chars']
  ])('throws for %p (%s)', (label, reason) => {
    expect(() => encodeDomainFelts(label)).toThrow(MidenNameInvalidLabelError);
    let thrown: MidenNameInvalidLabelError | undefined;
    try {
      encodeDomainFelts(label);
    } catch (error) {
      if (error instanceof MidenNameInvalidLabelError) thrown = error;
    }
    expect(thrown?.reason).toBe(reason);
  });
});

describe('decodeDomainFelts', () => {
  it('round-trips 200 random labels', () => {
    const random = prng(7);
    for (let i = 0; i < 200; i++) {
      const length = 1 + Math.floor(random() * 21);
      let label = '';
      for (let j = 0; j < length; j++) {
        label += ALPHABET.charAt(Math.floor(random() * ALPHABET.length));
      }
      expect(decodeDomainFelts(encodeDomainFelts(label))).toBe(label);
    }
  });

  it('decodes the fixtures', () => {
    expect(decodeDomainFelts([0n, 0n, 60213692685n, 5n])).toBe('miden');
    expect(decodeDomainFelts([0n, 185277457n, 10157331770841626n, 11n])).toBe('zzqxjv9q1kk');
  });

  it.each<[string, Felts4]>([
    ['zero word', [0n, 0n, 0n, 0n]],
    ['length above 21', [0n, 0n, 1n, 22n]],
    ['code outside 1..36', [0n, 0n, 37n, 1n]],
    ['zero code inside the label', [0n, 0n, 0n, 1n]],
    ['code after the end of the label', [0n, 0n, 0x0101n, 1n]],
    ['bits above the 7 codes', [0n, 0n, (1n << 56n) | 1n, 1n]],
    ['code in a felt after the label', [0n, 1n, 1n, 1n]]
  ])('returns null for a %s', (_name, felts) => {
    expect(decodeDomainFelts(felts)).toBeNull();
  });
});

describe('label helpers', () => {
  it('normalizes input', () => {
    expect(normalizeMidenNameInput('  Alice.MIDEN ')).toBe('alice');
    expect(normalizeMidenNameInput('bob')).toBe('bob');
    expect(normalizeMidenNameInput('.miden')).toBe('');
  });

  it('validates labels', () => {
    expect(validateMidenLabel('alice')).toBeNull();
    expect(validateMidenLabel('a'.repeat(21))).toBeNull();
    expect(validateMidenLabel('')).toBe('empty');
    expect(validateMidenLabel('a'.repeat(22))).toBe('too-long');
    expect(validateMidenLabel('_')).toBe('invalid-chars');
  });

  it('recognizes .miden names only', () => {
    expect(looksLikeMidenName('alice.miden')).toBe(true);
    expect(looksLikeMidenName(' Alice.Miden ')).toBe(true);
    expect(looksLikeMidenName('alice')).toBe(false);
    expect(looksLikeMidenName('.miden')).toBe(false);
    expect(looksLikeMidenName('al-ice.miden')).toBe(false);
    expect(looksLikeMidenName('mtst1qy35qfqdmczq8pzc5ht2hsl0kqyqqqqqqqqq')).toBe(false);
  });

  it('formats a label', () => {
    expect(formatMidenName('alice')).toBe('alice.miden');
  });

  it('compares felts', () => {
    expect(feltsEqual([1n, 2n, 3n, 4n], [1n, 2n, 3n, 4n])).toBe(true);
    expect(feltsEqual([1n, 2n, 3n, 4n], [1n, 2n, 3n, 5n])).toBe(false);
    expect(isZeroFelts([0n, 0n, 0n, 0n])).toBe(true);
    expect(isZeroFelts([0n, 0n, 0n, 1n])).toBe(false);
  });
});

describe('key and preimage layouts', () => {
  it('builds the commitment preimage with the suffix BEFORE the prefix', () => {
    const domainWord = encodeDomainFelts('miden');
    expect(commitmentPreimage(domainWord, REGISTRY)).toEqual([
      ...MIDEN_NAME_COMMITMENT_TAG,
      ...domainWord,
      0n,
      0n,
      REGISTRY.suffix,
      REGISTRY.prefix
    ]);
    expect(MIDEN_NAME_COMMITMENT_TAG).toEqual([31013299120531821n, 30803248544050529n, 54383671667041n, 20n]);
  });

  it('builds register note inputs with the prefix BEFORE the suffix', () => {
    const domainWord = encodeDomainFelts('zzqxjv9q1kk');
    expect(registerNoteInputs(REGISTRY, domainWord, 62_068)).toEqual([
      REGISTRY.prefix,
      REGISTRY.suffix,
      domainWord[0],
      domainWord[1],
      domainWord[2],
      domainWord[3],
      62_068n
    ]);
  });

  it.each([-1, 1.5, 0x1_0000_0000])('refuses a reclaim height of %p', height => {
    expect(() => registerNoteInputs(REGISTRY, encodeDomainFelts('a'), height)).toThrow(RangeError);
  });

  it('accepts the u32 bounds as the reclaim height', () => {
    expect(registerNoteInputs(REGISTRY, encodeDomainFelts('a'), 0)[6]).toBe(0n);
    expect(registerNoteInputs(REGISTRY, encodeDomainFelts('a'), 0xffff_ffff)[6]).toBe(0xffff_ffffn);
  });

  it('builds registry note inputs as the register layout plus the action', () => {
    const target = { prefix: 0x1111n, suffix: 0x2200n };
    const domainWord = encodeDomainFelts('alice');
    expect(REGISTRY_NOTE_ACTION.updateRecords).toBe(3n);
    expect(registryNoteInputs(target, domainWord, 1300, REGISTRY_NOTE_ACTION.updateRecords)).toEqual([
      target.prefix,
      target.suffix,
      domainWord[0],
      domainWord[1],
      domainWord[2],
      domainWord[3],
      1300n,
      3n
    ]);
  });

  it('refuses a registry note reclaim height that does not fit in a u32', () => {
    expect(() => registryNoteInputs(REGISTRY, encodeDomainFelts('a'), 0x1_0000_0000, 3n)).toThrow(RangeError);
  });

  it('clamps the price key length at 5', () => {
    expect(priceKeyFelts(9, TOKEN)).toEqual([5n, 0n, TOKEN.suffix, TOKEN.prefix]);
    expect(priceKeyFelts(5, TOKEN)).toEqual([5n, 0n, TOKEN.suffix, TOKEN.prefix]);
    expect(priceKeyFelts(3, TOKEN)).toEqual([3n, 0n, TOKEN.suffix, TOKEN.prefix]);
  });

  it('builds the status key from the first two commitment felts', () => {
    expect(statusKeyFelts([7n, 8n, 9n, 10n])).toEqual([7n, 8n, 0n, 0n]);
  });

  it('builds the account key as [0, 0, suffix, prefix]', () => {
    expect(accountKeyFelts(REGISTRY)).toEqual([0n, 0n, REGISTRY.suffix, REGISTRY.prefix]);
  });
});
