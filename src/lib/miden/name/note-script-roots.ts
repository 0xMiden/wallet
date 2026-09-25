/**
 * MAST roots and sizes of the Miden Name note scripts (contract v0.16).
 *
 * The serialized scripts are large, so they are NOT in the bundle. They live
 * in `public/miden-name/note-scripts.json` and `script.ts` fetches them when
 * they are needed. The roots stay here as constants, because the guard and the
 * quote read them without the bytes, and because the loader compares the root
 * of the fetched bytes against these values before it returns a script.
 *
 * Both roots are on the registry's `allowed_note_scripts` allowlist.
 */

/** Path of the note-script asset, relative to the web root of every platform. */
export const MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH = 'miden-name/note-scripts.json';

/** Register-domain note script: sends the price to the registry. */
export const REGISTER_DOMAIN_SCRIPT_ROOT_HEX = '0xdbac2a368df5d0b87e94f46f7e8a82323fde81c585a2e30d56c3fda8782cb6a2';
export const REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH = 16810;

/**
 * Registry note script: carries the domain NFA back to the registry with an
 * action (3 = update the records, 4..6 = clear them).
 */
export const REGISTRY_SCRIPT_ROOT_HEX = '0xb862b950ebffdba6e2ae3f8b0764580a20f8ee817b42a76372b8a2f63887ca05';
export const REGISTRY_SCRIPT_BYTE_LENGTH = 23180;
