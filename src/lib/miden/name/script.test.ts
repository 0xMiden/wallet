import { readFileSync } from 'fs';
import { join } from 'path';

import { MidenNameScriptAssetError, MidenNameScriptMismatchError } from './errors';
import {
  MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH,
  REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH,
  REGISTER_DOMAIN_SCRIPT_ROOT_HEX,
  REGISTRY_SCRIPT_BYTE_LENGTH,
  REGISTRY_SCRIPT_ROOT_HEX
} from './note-script-roots';
import {
  loadMidenNameNoteScriptBytes,
  loadRegisterDomainScript,
  loadRegistryNoteScript,
  type MidenNameNoteScriptName,
  resetMidenNameNoteScriptsCacheForTests
} from './script';
import { NoteScript } from './test-support/fake-sdk';

jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
jest.mock('lib/miden/metadata/defaults', () => ({ getAssetUrl: jest.fn((path: string) => `/${path}`) }));

interface AssetEntry {
  root: string;
  byteLength: number;
  serializedBase64: string;
}

interface Asset {
  contractVersion: string;
  registerDomain: AssetEntry;
  registry: AssetEntry;
}

const ASSET_URL = `/${MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH}`;
const ASSET_FILE = join(__dirname, '..', '..', '..', '..', 'public', MIDEN_NAME_NOTE_SCRIPTS_ASSET_PATH);

function readAsset(): Asset {
  return JSON.parse(readFileSync(ASSET_FILE, 'utf8'));
}

function fakeScript(rootHex: string) {
  return { root: () => ({ toHex: () => rootHex }), free: jest.fn() };
}

const mockFetch = jest.fn<Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>, [string]>();

function serveAsset(body: unknown, status = 200) {
  mockFetch.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  resetMidenNameNoteScriptsCacheForTests();
  NoteScript.deserialize.mockReset();
  mockFetch.mockReset();
  Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });
  serveAsset(readAsset());
});

describe('the note-scripts asset', () => {
  it('carries the register-domain and registry scripts at the pinned roots and sizes', () => {
    const asset = readAsset();
    expect(asset.contractVersion).toBe('0.16');
    expect(asset.registerDomain.root).toBe(REGISTER_DOMAIN_SCRIPT_ROOT_HEX);
    expect(asset.registerDomain.byteLength).toBe(REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH);
    expect(atob(asset.registerDomain.serializedBase64).length).toBe(16_810);
    expect(asset.registry.root).toBe(REGISTRY_SCRIPT_ROOT_HEX);
    expect(asset.registry.byteLength).toBe(REGISTRY_SCRIPT_BYTE_LENGTH);
    expect(atob(asset.registry.serializedBase64).length).toBe(23_180);
  });

  it('decodes both payloads to serialized MAST forests', async () => {
    const names: MidenNameNoteScriptName[] = ['registerDomain', 'registry'];
    for (const name of names) {
      const bytes = await loadMidenNameNoteScriptBytes(name);
      expect(bytes).toBeInstanceOf(Uint8Array);
      // "MAST" magic of a serialized MAST forest.
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x41, 0x53, 0x54]);
    }
  });
});

describe('loadRegisterDomainScript', () => {
  it('fetches the asset once, deserializes the bytes and returns the script when the root matches', async () => {
    const script = fakeScript(REGISTER_DOMAIN_SCRIPT_ROOT_HEX.toUpperCase().replace('0X', '0x'));
    NoteScript.deserialize.mockReturnValue(script);

    await expect(loadRegisterDomainScript()).resolves.toBe(script);
    await expect(loadRegisterDomainScript()).resolves.toBe(script);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(ASSET_URL);
    const bytes = NoteScript.deserialize.mock.calls[0]?.[0];
    expect(bytes?.length).toBe(REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH);
    expect(script.free).not.toHaveBeenCalled();
  });

  it('throws and frees the script when the deserialized root does not match', async () => {
    const script = fakeScript('0x' + '00'.repeat(32));
    NoteScript.deserialize.mockReturnValue(script);

    await expect(loadRegisterDomainScript()).rejects.toBeInstanceOf(MidenNameScriptMismatchError);
    expect(script.free).toHaveBeenCalledTimes(1);
  });
});

describe('loadRegistryNoteScript', () => {
  it('returns the registry script when its root matches', async () => {
    const script = fakeScript(REGISTRY_SCRIPT_ROOT_HEX);
    NoteScript.deserialize.mockReturnValue(script);

    await expect(loadRegistryNoteScript()).resolves.toBe(script);
    expect(NoteScript.deserialize.mock.calls[0]?.[0]?.length).toBe(REGISTRY_SCRIPT_BYTE_LENGTH);
  });
});

describe('asset validation', () => {
  it('reports an HTTP failure and does not cache it', async () => {
    serveAsset(null, 404);
    await expect(loadMidenNameNoteScriptBytes('registry')).rejects.toBeInstanceOf(MidenNameScriptAssetError);

    serveAsset(readAsset());
    await expect(loadMidenNameNoteScriptBytes('registry')).resolves.toBeInstanceOf(Uint8Array);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a body that is not an object', async () => {
    serveAsset('nope');
    await expect(loadMidenNameNoteScriptBytes('registry')).rejects.toThrow('not a JSON object');
  });

  it('refuses a missing or malformed entry', async () => {
    const asset = readAsset();
    serveAsset({ ...asset, registry: { root: asset.registry.root } });
    await expect(loadMidenNameNoteScriptBytes('registry')).rejects.toThrow('"registry" entry is missing or malformed');
  });

  it('refuses an entry whose declared root is not the pinned root', async () => {
    const asset = readAsset();
    serveAsset({ ...asset, registry: { ...asset.registry, root: '0x' + 'ab'.repeat(32) } });
    await expect(loadMidenNameNoteScriptBytes('registry')).rejects.toBeInstanceOf(MidenNameScriptMismatchError);
  });

  it('refuses an entry whose declared size is not the pinned size', async () => {
    const asset = readAsset();
    serveAsset({ ...asset, registerDomain: { ...asset.registerDomain, byteLength: 1 } });
    await expect(loadMidenNameNoteScriptBytes('registerDomain')).rejects.toThrow('declares 1 bytes');
  });

  it('refuses a payload that decodes to another size', async () => {
    const asset = readAsset();
    serveAsset({ ...asset, registerDomain: { ...asset.registerDomain, serializedBase64: 'TUFTVA==' } });
    await expect(loadMidenNameNoteScriptBytes('registerDomain')).rejects.toThrow('decodes to 4 bytes');
  });
});
