import PQueue from 'p-queue';

import { AssetMetadata } from './types';

export const TOKENS_BASE_METADATA_STORAGE_KEY = 'tokens_base_metadata';
export const TOKENS_METADATA_SCHEMA_STORAGE_KEY = 'tokens_base_metadata_schema';

/**
 * The shape version of the records under `tokens_base_metadata`.
 * Version 2 reads the name and the description from the faucet.
 * Older records copy the symbol into the name.
 */
export const TOKENS_METADATA_SCHEMA_VERSION = 2;

export const TOKENS_METADATA_MAX_ENTRIES = 512;
export const TOKENS_METADATA_MAX_BYTES = 1_048_576;
export const TOKENS_METADATA_ENTRY_MAX_BYTES = 16_384;
const encoder = new TextEncoder();

function stableMetadata(metadata: Record<string, AssetMetadata>): string {
  return JSON.stringify(
    Object.entries(metadata)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [
        id,
        Object.entries(value)
          .filter(([, field]) => field !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
      ])
  );
}

function boundedMetadata(cached: Record<string, AssetMetadata>, incoming: Record<string, AssetMetadata>) {
  const merged = new Map(Object.entries(cached));
  for (const [id, metadata] of Object.entries(incoming)) {
    merged.delete(id);
    merged.set(id, metadata);
  }
  const retained: [string, AssetMetadata][] = [];
  let bytes = 2;
  for (const [id, metadata] of [...merged].reverse()) {
    const entryBytes = encoder.encode(JSON.stringify({ [id]: metadata })).byteLength;
    const nextBytes = bytes + entryBytes - 2 + (retained.length > 0 ? 1 : 0);
    if (entryBytes > TOKENS_METADATA_ENTRY_MAX_BYTES || nextBytes > TOKENS_METADATA_MAX_BYTES) continue;
    retained.push([id, metadata]);
    bytes = nextBytes;
    if (retained.length === TOKENS_METADATA_MAX_ENTRIES) break;
  }
  return Object.fromEntries(retained.reverse());
}

const tokensBaseMetadataWriteQueue = new PQueue({ concurrency: 1 });

// The check runs one time in each realm. A failed check clears this value, so the next call tries again.
let schemaCheck: Promise<void> | null = null;

export async function updateTokensBaseMetadata(
  toSet: Record<string, AssetMetadata>,
  readMetadata: () => Promise<Record<string, AssetMetadata> | null>,
  writeMetadata: (metadata: Record<string, AssetMetadata>) => Promise<void>
): Promise<void> {
  await tokensBaseMetadataWriteQueue.add(async () => {
    const cached = (await readMetadata()) ?? {};
    const next = boundedMetadata(cached, toSet);
    if (stableMetadata(cached) !== stableMetadata(next)) await writeMetadata(next);
  });
}

/**
 * Clears the token metadata cache when its records are older than the current shape.
 * Run it before a read of the cache. The cache fills again on demand.
 *
 * The check runs in the write queue, so a merge of the old cache cannot start before the clear.
 * After the first success in a realm, a call costs nothing.
 */
export function ensureTokensMetadataSchema(
  read: (key: string) => Promise<number | null>,
  write: (key: string, value: Record<string, AssetMetadata> | number) => Promise<void>
): Promise<void> {
  schemaCheck ??= tokensBaseMetadataWriteQueue
    .add(async () => {
      const version = await read(TOKENS_METADATA_SCHEMA_STORAGE_KEY);
      // Storage is not typed, so the check also refuses a value that is not a number.
      if (typeof version === 'number' && version >= TOKENS_METADATA_SCHEMA_VERSION) return;
      await write(TOKENS_BASE_METADATA_STORAGE_KEY, {});
      // The old `detailed_asset_metadata_*` keys stay. The storage API cannot list keys, and nothing reads them.
      await write(TOKENS_METADATA_SCHEMA_STORAGE_KEY, TOKENS_METADATA_SCHEMA_VERSION);
    })
    .catch(error => {
      schemaCheck = null;
      throw error;
    });
  return schemaCheck;
}
