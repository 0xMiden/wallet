/**
 * @jest-environment node
 */
import {
  ADVICE_ADDR,
  checkedPayScript,
  feeOnlyScript,
  includesBytes,
  payScript,
  wordLiteral,
  type CheckedParams,
  type PayParams
} from './custom-scripts';

const word = (digit: string) => `0x${digit.repeat(64)}`;
const PAY: PayParams = {
  recipientHex: word('1'),
  tag: 0xc0ffee,
  noteType: 1,
  assetIdHex: word('2'),
  assetValueHex: word('3')
};
const CHECKED: CheckedParams = { scriptArgHex: word('4'), adviceWordsHex: [word('5'), word('6')] };

// The VM keeps at least 16 elements, and a script the kernel reaches by dyncall must return with exactly 16
// (miden-protocol 0.17.1 asm/kernels/transaction/bin/main.masm:143-158). An instruction with no entry here fails the
// test, so a new one is counted on purpose.
const EFFECTS: ReadonlyArray<[RegExp, (token: string) => number]> = [
  [/^push\.0x[0-9a-fA-F]{64}$/, () => 4],
  [/^push\.\d+(\.\d+)*$/, token => token.split('.').length - 1],
  [/^(dupw|padw)$/, () => 4],
  [/^dropw$/, () => -4],
  [/^drop$/, () => -1],
  [/^assert_eqw\.err="[^"]*"$/, () => -8],
  [/^mem_loadw_le$/, () => -1],
  [/^adv\.push_mapval$/, () => 0],
  [/^exec\.mem::pipe_preimage_to_memory$/, () => -5],
  [/^mov(up|dn)\.\d+$/, () => 0],
  [/^call\.[a-z_]+::[a-z_]+$/, () => 0]
];

function finalDepth(masm: string): number {
  const body = /pub proc main\n([\s\S]*)\nend\n$/.exec(masm)?.[1];
  if (body === undefined) throw new Error('no main procedure');
  const tokens = body.replace(/#[^\n]*/g, '').match(/[a-z_]+\.err="[^"]*"|\S+/g) ?? [];
  let depth = 16;
  for (const token of tokens) {
    const effect = EFFECTS.find(([pattern]) => pattern.test(token));
    if (effect === undefined) throw new Error(`no stack effect for ${token}`);
    depth = Math.max(16, depth + effect[1](token));
  }
  return depth;
}

function position(masm: string): (text: string) => number {
  return text => {
    const index = masm.indexOf(text);
    if (index < 0) throw new Error(`${text} is not in the script`);
    return index;
  };
}

describe('custom transaction scripts', () => {
  it.each([
    ['pay', payScript(PAY)],
    ['pay-checked', checkedPayScript(PAY, CHECKED)],
    ['fee-only', feeOnlyScript()]
  ])('%s returns from the kernel dyncall with 16 elements on the stack', (_kind, masm) => {
    expect(finalDepth(masm)).toBe(16);
  });

  it('calls only the basic-wallet procedures both account kinds carry', () => {
    const calls = (masm: string) => masm.match(/call\.\S+/g) ?? [];
    const pay = ['call.note_creator::create_note', 'call.basic_wallet::move_asset_to_note'];
    expect(calls(payScript(PAY))).toEqual(pay);
    expect(calls(checkedPayScript(PAY, CHECKED))).toEqual(pay);
    expect(calls(feeOnlyScript())).toEqual([]);
  });

  it('pushes the note record in the order create_note and move_asset_to_note read it', () => {
    const at = position(payScript(PAY));
    // [tag, note_type, RECIPIENT, pad(10)]: the recipient goes in first, the tag last.
    expect(at(`push.${PAY.recipientHex}\n`)).toBeLessThan(at(`push.${PAY.noteType}\n`));
    expect(at(`push.${PAY.noteType}\n`)).toBeLessThan(at(`push.${PAY.tag}\n`));
    expect(at(`push.${PAY.tag}\n`)).toBeLessThan(at('call.note_creator::create_note'));
    // [ASSET_ID, ASSET_VALUE, note_idx, pad(7)]: the value goes in first, the id on top.
    expect(at('call.note_creator::create_note')).toBeLessThan(at(`push.${PAY.assetValueHex}\n`));
    expect(at(`push.${PAY.assetValueHex}\n`)).toBeLessThan(at(`push.${PAY.assetIdHex}\n`));
    expect(at(`push.${PAY.assetIdHex}\n`)).toBeLessThan(at('call.basic_wallet::move_asset_to_note'));
  });

  it('checks the script argument, then both advice words, before it pays', () => {
    const at = position(checkedPayScript(PAY, CHECKED));
    expect(at(`push.${CHECKED.scriptArgHex}\n`)).toBeLessThan(at('adv.push_mapval'));
    expect(at('adv.push_mapval')).toBeLessThan(at(`push.${ADVICE_ADDR} mem_loadw_le`));
    expect(at(`push.${ADVICE_ADDR} mem_loadw_le`)).toBeLessThan(at(`push.${CHECKED.adviceWordsHex[0]}\n`));
    expect(at(`push.${CHECKED.adviceWordsHex[0]}\n`)).toBeLessThan(at(`push.${ADVICE_ADDR + 4} mem_loadw_le`));
    expect(at(`push.${ADVICE_ADDR + 4} mem_loadw_le`)).toBeLessThan(at(`push.${CHECKED.adviceWordsHex[1]}\n`));
    expect(at(`push.${CHECKED.adviceWordsHex[1]}\n`)).toBeLessThan(at('call.note_creator::create_note'));
  });

  it('emits every word exactly as Word.toHex() renders it', () => {
    const masm = checkedPayScript(PAY, CHECKED);
    for (const hex of [
      PAY.recipientHex,
      PAY.assetIdHex,
      PAY.assetValueHex,
      CHECKED.scriptArgHex,
      ...CHECKED.adviceWordsHex
    ]) {
      expect(masm).toContain(`push.${hex}\n`);
    }
  });

  it('refuses a word the assembler would read differently or not at all', () => {
    expect(() => wordLiteral(word('a').slice(2), 'w')).toThrow(/0x-prefixed/);
    expect(() => wordLiteral(word('a').slice(0, 65), 'w')).toThrow(/0x-prefixed/);
    // Felt 0 at the modulus 2^64 - 2^32 + 1 (little-endian digits 01000000ffffffff), then one below it.
    const firstFelt = (digits: string) => `0x${digits}${'0'.repeat(48)}`;
    expect(() => wordLiteral(firstFelt('01000000ffffffff'), 'w')).toThrow(/field modulus/);
    expect(wordLiteral(firstFelt('00000000ffffffff'), 'w')).toBe(firstFelt('00000000ffffffff'));
    expect(() => wordLiteral(`0x${'0'.repeat(48)}01000000ffffffff`, 'w')).toThrow(/felt 3/);
  });

  it('refuses a tag outside u32 and a note type that is neither private nor public', () => {
    for (const tag of [-1, 1.5, 2 ** 32]) expect(() => payScript({ ...PAY, tag })).toThrow(/u32/);
    expect(() => payScript({ ...PAY, noteType: 2 })).toThrow(/note type 2/);
  });
});

describe('includesBytes', () => {
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

  it('finds a run at the start, in the middle and at the end', () => {
    for (const needle of [
      [1, 2],
      [2, 3, 4],
      [4, 5],
      [1, 2, 3, 4, 5]
    ]) {
      expect(includesBytes(bytes, Uint8Array.from(needle))).toBe(true);
    }
  });

  it('misses a run that is absent, out of order or longer than the bytes', () => {
    for (const needle of [
      [2, 4],
      [5, 4],
      [1, 2, 3, 4, 5, 6]
    ]) {
      expect(includesBytes(bytes, Uint8Array.from(needle))).toBe(false);
    }
  });

  it('refuses an empty needle, which every request would contain', () => {
    expect(() => includesBytes(bytes, new Uint8Array())).toThrow(/empty/);
  });
});
