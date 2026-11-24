/**
 * The test dApp's own transaction scripts (spec section 5), as MASM the page compiles with `client.compile.txScript`,
 * which links the standards library dynamically (miden-standards 0.17.1 src/code_builder/mod.rs:271-277). They call
 * only the two basic-wallet procedures both account kinds carry (asm/components/wallets/basic_wallet/basic_wallet.masm),
 * with the stack layout the standard send_notes script uses (asm/standards/tx_scripts/send_notes/wallet.masm:98-147).
 * Pure strings, so they are unit-tested without the SDK.
 */

export type ScriptKind = 'pay' | 'pay-checked' | 'fee-only';

/** What a pay script needs from the note the dApp predicted, each as its SDK accessor renders it. */
export interface PayParams {
  /** `NoteRecipient.digest().toHex()`. */
  recipientHex: string;
  /** `NoteTag.asU32()`. */
  tag: number;
  /** The `NoteType` felt: 0 private, 1 public (miden-protocol 0.17.1 src/note/note_type.rs:29-30). */
  noteType: number;
  /** `FungibleAsset.vaultKey().toHex()` and `.intoWord().toHex()`: the ASSET_ID and ASSET_VALUE words. */
  assetIdHex: string;
  assetValueHex: string;
}

/** X8b: the script argument and the two advice words it keys. */
export interface CheckedParams {
  scriptArgHex: string;
  adviceWordsHex: readonly [string, string];
}

/** Word-aligned, in the script's own memory context, where web-sdk's tested custom script pipes its advice. */
export const ADVICE_ADDR = 1000;
const FELT_MODULUS = 0xffff_ffff_0000_0001n;

/**
 * A word literal exactly as `Word.toHex()` writes it. The assembler reads each felt from 16 little-endian hex digits
 * and pushes element 0 on top (miden-assembly-syntax 0.35.0 src/parser/cst/fragments.rs:1395-1420), the order
 * `mem_loadw_le` loads and the kernel hands the script argument in.
 */
export function wordLiteral(hex: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${what} is not a 0x-prefixed 64-digit hex word: ${hex}`);
  for (let felt = 0; felt < 4; felt += 1) {
    const bytes = hex.slice(2 + felt * 16, 18 + felt * 16).match(/../g) ?? [];
    const value = bytes.reduceRight((sum, byte) => (sum << 8n) | BigInt(`0x${byte}`), 0n);
    if (value >= FELT_MODULUS) throw new Error(`${what} felt ${felt} is not below the field modulus: ${hex}`);
  }
  return hex;
}

function u32(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${what} is not a u32: ${value}`);
  return value;
}

const WALLET_USES = [
  'use miden::standards::note::note_creator',
  'use miden::standards::wallets::basic as basic_wallet'
];

function transactionScript(uses: readonly string[], lines: readonly string[]): string {
  const header = uses.length === 0 ? '' : `${uses.join('\n')}\n\n`;
  const body = ['# => [SCRIPT_ARG, pad(12)]', ...lines].map(line => `    ${line}`).join('\n');
  return `${header}@transaction_script\npub proc main\n${body}\nend\n`;
}

// Leaves the 16 elements it found: create_note (note_creator.masm:17-18), then move_asset_to_note (basic.masm:45-46),
// re-padding between the calls as send_notes does.
function payLines(p: PayParams): string[] {
  if (p.noteType !== 0 && p.noteType !== 1)
    throw new Error(`note type ${p.noteType} is neither private (0) nor public (1)`);
  return [
    '# create_note: [tag, note_type, RECIPIENT, pad(10)] => [note_idx, pad(15)]',
    'push.0.0.0.0 push.0.0.0.0 push.0.0',
    `push.${wordLiteral(p.recipientHex, 'recipient')}`,
    `push.${p.noteType}`,
    `push.${u32(p.tag, 'tag')}`,
    'call.note_creator::create_note',
    '# => [note_idx, pad(15), REST(16)]',
    'movdn.15 dropw dropw dropw drop drop drop',
    'push.0.0.0.0 push.0.0.0 movup.7',
    '# move_asset_to_note: [ASSET_ID, ASSET_VALUE, note_idx, pad(7)] => [pad(16)]',
    `push.${wordLiteral(p.assetValueHex, 'asset value')}`,
    `push.${wordLiteral(p.assetIdHex, 'asset id')}`,
    'call.basic_wallet::move_asset_to_note',
    'dropw dropw dropw dropw',
    '# => [REST(16)]'
  ];
}

// The script argument keys two words in the advice map; piping them to memory asserts they hash to it.
function checkLines(c: CheckedParams): string[] {
  return [
    `dupw push.${wordLiteral(c.scriptArgHex, 'script argument')}`,
    'assert_eqw.err="script argument is not the word the dApp built"',
    'adv.push_mapval',
    `push.${ADVICE_ADDR} push.2`,
    'exec.mem::pipe_preimage_to_memory drop',
    '# => [pad(16)]',
    `padw push.${ADVICE_ADDR} mem_loadw_le`,
    `push.${wordLiteral(c.adviceWordsHex[0], 'advice word 0')}`,
    'assert_eqw.err="advice word 0 is not the word the dApp built"',
    `padw push.${ADVICE_ADDR + 4} mem_loadw_le`,
    `push.${wordLiteral(c.adviceWordsHex[1], 'advice word 1')}`,
    'assert_eqw.err="advice word 1 is not the word the dApp built"'
  ];
}

/** X8a: pays the predicted note's recipient through the basic wallet. */
export function payScript(p: PayParams): string {
  return transactionScript(WALLET_USES, payLines(p));
}

/** X8b: asserts the script argument and the advice words it keys, then pays as X8a does. */
export function checkedPayScript(p: PayParams, c: CheckedParams): string {
  return transactionScript(['use miden::core::mem', ...WALLET_USES], [...checkLines(c), ...payLines(p)]);
}

/** X8c: moves nothing, so the transaction is the auth procedure's nonce bump and fee. */
export function feeOnlyScript(): string {
  return transactionScript([], ['dropw', '# => [pad(16)]']);
}

/** Whether `needle` occurs in `haystack`: the page's only view of a recipient a request declared. */
export function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) throw new Error('an empty needle is in every request');
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((byte, index) => haystack[start + index] === byte)) return true;
  }
  return false;
}
