/**
 * Loads the Miden Name note scripts.
 *
 * The serialized scripts are a static asset (`public/miden-name/note-scripts.json`),
 * not part of the bundle: together they are about 50 KB of base64. The asset
 * is fetched once per realm and cached; a failed fetch is not cached, so the
 * next call tries again. The roots and sizes in `note-script-roots.ts` are the
 * source of truth: the loader refuses an asset whose root or size differs, and
 * refuses deserialized bytes whose MAST root differs.
 */

import { NoteScript } from '@miden-sdk/miden-sdk/lazy';

import { getAssetUrl } from 'lib/miden/metadata/defaults';

import { MidenNameScriptAssetError, MidenNameScriptMismatchError } from './errors';
import {
  MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH,
  REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH,
  REGISTER_DOMAIN_SCRIPT_ROOT_HEX,
  REGISTRY_SCRIPT_BYTE_LENGTH,
  REGISTRY_SCRIPT_ROOT_HEX
} from './note-script-roots';

export type MidenNameNoteScriptName = 'registerDomain' | 'registry';

interface SerializedNoteScript {
  root: string;
  byteLength: number;
  serializedBase64: string;
}

type NoteScriptsAsset = Record<MidenNameNoteScriptName, SerializedNoteScript>;

interface ExpectedNoteScript {
  rootHex: string;
  byteLength: number;
  label: string;
}

const EXPECTED: Record<MidenNameNoteScriptName, ExpectedNoteScript> = {
  registerDomain: {
    rootHex: REGISTER_DOMAIN_SCRIPT_ROOT_HEX,
    byteLength: REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH,
    label: 'register-domain'
  },
  registry: { rootHex: REGISTRY_SCRIPT_ROOT_HEX, byteLength: REGISTRY_SCRIPT_BYTE_LENGTH, label: 'registry' }
};

let assetPromise: Promise<NoteScriptsAsset> | undefined;

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

function parseNoteScriptEntry(record: Record<string, unknown>, name: MidenNameNoteScriptName): SerializedNoteScript {
  const entry = record[name];
  if (!isSerializedNoteScript(entry)) {
    throw new MidenNameScriptAssetError(`the "${name}" entry is missing or malformed`);
  }
  const expected = EXPECTED[name];
  if (entry.root.toLowerCase() !== expected.rootHex.toLowerCase()) {
    throw new MidenNameScriptMismatchError(expected.rootHex, entry.root, expected.label);
  }
  if (entry.byteLength !== expected.byteLength) {
    throw new MidenNameScriptAssetError(
      `the "${name}" entry declares ${entry.byteLength} bytes, expected ${expected.byteLength}`
    );
  }
  return entry;
}

function parseNoteScriptsAsset(value: unknown): NoteScriptsAsset {
  if (!isRecord(value)) {
    throw new MidenNameScriptAssetError('the asset is not a JSON object');
  }
  return {
    registerDomain: parseNoteScriptEntry(value, 'registerDomain'),
    registry: parseNoteScriptEntry(value, 'registry')
  };
}

async function fetchNoteScriptsAsset(): Promise<NoteScriptsAsset> {
  const url = getAssetUrl(MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH);
  const response = await fetch(url);
  if (!response.ok) {
    throw new MidenNameScriptAssetError(`HTTP ${response.status} for ${url}`);
  }
  return parseNoteScriptsAsset(await response.json());
}

function getNoteScriptsAsset(): Promise<NoteScriptsAsset> {
  if (!assetPromise) {
    assetPromise = fetchNoteScriptsAsset().catch(error => {
      // Do not cache a failure: a transient fetch error must not poison the realm.
      assetPromise = undefined;
      throw error;
    });
  }
  return assetPromise;
}

/**
 * Return the serialized bytes of a note script. The bytes are checked against
 * the declared size; the MAST root is checked when the bytes are deserialized.
 */
export async function loadMidenNameNoteScriptBytes(name: MidenNameNoteScriptName): Promise<Uint8Array> {
  const asset = await getNoteScriptsAsset();
  const bytes = base64ToBytes(asset[name].serializedBase64);
  const expected = EXPECTED[name];
  if (bytes.length !== expected.byteLength) {
    throw new MidenNameScriptAssetError(
      `the "${name}" payload decodes to ${bytes.length} bytes, expected ${expected.byteLength}`
    );
  }
  return bytes;
}

/**
 * Deserialize a note script and make sure that its MAST root is the root that
 * the registry allows. Each call returns a NEW `NoteScript`, because a wasm
 * call that takes the script moves it into Rust.
 *
 * Throws MidenNameScriptMismatchError when the root is not the expected root.
 * The caller must load the SDK WASM before it calls this function.
 */
export async function loadMidenNameNoteScript(name: MidenNameNoteScriptName): Promise<NoteScript> {
  const bytes = await loadMidenNameNoteScriptBytes(name);
  const expected = EXPECTED[name];
  const script = NoteScript.deserialize(bytes);
  const actualRoot = script.root().toHex().toLowerCase();
  const expectedRoot = expected.rootHex.toLowerCase();
  if (actualRoot !== expectedRoot) {
    script.free();
    throw new MidenNameScriptMismatchError(expectedRoot, actualRoot, expected.label);
  }
  return script;
}

/** The register-domain note script (sends the price to the registry). */
export function loadRegisterDomainScript(): Promise<NoteScript> {
  return loadMidenNameNoteScript('registerDomain');
}

/** The registry note script (carries the NFA back with an action code). */
export function loadRegistryNoteScript(): Promise<NoteScript> {
  return loadMidenNameNoteScript('registry');
}

/** Drop the cached asset. For tests only. */
export function resetMidenNameNoteScriptsCacheForTests(): void {
  assetPromise = undefined;
}
