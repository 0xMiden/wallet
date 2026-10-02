/**
 * MAST root and size of the Miden Name register-domain note script (contract
 * v0.16 with auto-publication).
 *
 * The serialized script is large, so it is NOT in the bundle. It lives in
 * `public/miden-name/note-scripts.json` and `script.ts` fetches it when it is
 * needed. The root stays here as a constant, because the guard and the quote
 * read it without the bytes, and because the loader compares the root of the
 * fetched bytes against this value before it returns a script.
 *
 * The root is on the registry's `allowed_note_scripts` allowlist.
 */

/** Path of the note-script asset, relative to the web root of every platform. */
export const MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH = 'miden-name/note-scripts.json';

/**
 * Register-domain note script: sends the price to the registry. When the
 * registry consumes the note it mints the name NFA AND writes the registry
 * records in the same transaction, then delivers the NFA in a P2ID note.
 */
export const REGISTER_DOMAIN_SCRIPT_ROOT_HEX = '0x70cea6528f7ea6883f6597744b59e62bb45e02c052c149a91bcca2a37a552286';
export const REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH = 17253;
