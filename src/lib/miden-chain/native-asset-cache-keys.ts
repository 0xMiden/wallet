/**
 * Versioned names of the native-asset caches in the platform key-value store. An entry's key is
 * `<name>:<scope>`, and bumping a version here discards every entry written under the old one.
 *
 * The E2E harness reads these entries back through the extension's storage and imports these names
 * to do it, so this module stays free of imports and side effects.
 */
export const NATIVE_ASSET_ID_CACHE = 'native_asset_id:v4';
export const NATIVE_ASSET_META_CACHE = 'native_asset_meta:v5';
export const NATIVE_ASSET_FEE_CACHE = 'native_asset_fee:v2';

export const NATIVE_ASSET_SYNCED_ID_CACHE = 'native_asset_synced_id:v1';
