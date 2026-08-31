import PQueue from 'p-queue';

import { AssetMetadata } from './types';

const tokensBaseMetadataWriteQueue = new PQueue({ concurrency: 1 });

export async function updateTokensBaseMetadata(
  toSet: Record<string, AssetMetadata>,
  readMetadata: () => Promise<Record<string, AssetMetadata> | null>,
  writeMetadata: (metadata: Record<string, AssetMetadata>) => Promise<void>
): Promise<void> {
  await tokensBaseMetadataWriteQueue.add(async () => {
    const cached = (await readMetadata()) ?? {};
    await writeMetadata({ ...cached, ...toSet });
  });
}
