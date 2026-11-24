/**
 * Loads the Miden Name register-domain note script.
 *
 * The serialized script is a static asset (`public/miden-name/note-scripts.json`),
 * not part of the bundle: it is about 23 KB of base64. The asset is fetched
 * once per realm and cached; a failed fetch is not cached, so the next call
 * tries again. The root and size in `note-script-roots.ts` are the source of
 * truth: the loader refuses an asset whose root or size differs, and refuses
 * deserialized bytes whose MAST root differs.
 */

import { NoteScript } from '@miden-sdk/miden-sdk/lazy';

import { MidenNameScriptAssetError, MidenNameScriptMismatchError } from './errors';
import {
  MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH,
  REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH,
  REGISTER_DOMAIN_SCRIPT_ROOT_HEX
} from './note-script-roots';

const REGISTER_DOMAIN_LABEL = 'register-domain';

interface SerializedNoteScript {
  root: string;
  byteLength: number;
  serializedBase64: string;
}

let registerDomainAssetPromise: Promise<SerializedNoteScript> | undefined;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Narrow a JSON value to a plain object without an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSerializedNoteScript(value: unknown): value is SerializedNoteScript {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.root === 'string' &&
    typeof record.byteLength === 'number' &&
    typeof record.serializedBase64 === 'string'
  );
}

function parseRegisterDomainAsset(value: unknown): SerializedNoteScript {
  if (!isRecord(value)) {
    throw new MidenNameScriptAssetError('the asset is not a JSON object');
  }
  const entry = value.registerDomain;
  if (!isSerializedNoteScript(entry)) {
    throw new MidenNameScriptAssetError('the "registerDomain" entry is missing or malformed');
  }
  if (entry.root.toLowerCase() !== REGISTER_DOMAIN_SCRIPT_ROOT_HEX.toLowerCase()) {
    throw new MidenNameScriptMismatchError(REGISTER_DOMAIN_SCRIPT_ROOT_HEX, entry.root, REGISTER_DOMAIN_LABEL);
  }
  if (entry.byteLength !== REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH) {
    throw new MidenNameScriptAssetError(
      `the "registerDomain" entry declares ${entry.byteLength} bytes, expected ${REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH}`
    );
  }
  return entry;
}

async function fetchRegisterDomainAsset(): Promise<SerializedNoteScript> {
  const url = `/${MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new MidenNameScriptAssetError(`HTTP ${response.status} for ${url}`);
  }
  return parseRegisterDomainAsset(await response.json());
}

function getRegisterDomainAsset(): Promise<SerializedNoteScript> {
  if (!registerDomainAssetPromise) {
    registerDomainAssetPromise = fetchRegisterDomainAsset().catch(error => {
      // Do not cache a failure: a transient fetch error must not poison the realm.
      registerDomainAssetPromise = undefined;
      throw error;
    });
  }
  return registerDomainAssetPromise;
}

/**
 * Deserialize the register-domain note script and verify its MAST root matches
 * the pinned registry root. Each call returns a NEW `NoteScript`, because a
 * wasm call that takes the script moves it into Rust.
 *
 * Throws MidenNameScriptMismatchError when the root is not the expected root.
 * The caller must load the SDK WASM before it calls this function.
 */
export async function loadRegisterDomainScript(): Promise<NoteScript> {
  const entry = await getRegisterDomainAsset();
  const bytes = base64ToBytes(entry.serializedBase64);
  if (bytes.length !== REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH) {
    throw new MidenNameScriptAssetError(
      `the "registerDomain" payload decodes to ${bytes.length} bytes, expected ${REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH}`
    );
  }
  const script = NoteScript.deserialize(bytes);
  const actualRoot = script.root().toHex().toLowerCase();
  const expectedRoot = REGISTER_DOMAIN_SCRIPT_ROOT_HEX.toLowerCase();
  if (actualRoot !== expectedRoot) {
    script.free();
    throw new MidenNameScriptMismatchError(expectedRoot, actualRoot, REGISTER_DOMAIN_LABEL);
  }
  return script;
}

/** Drop the cached asset. For tests only. */
export function resetMidenNameNoteScriptsCacheForTests(): void {
  registerDomainAssetPromise = undefined;
}
