import type { ITransaction } from '../db/types';

export async function checkpointProviderReceipt(_row: ITransaction): Promise<void> {
  throw new Error('Provider receipt checkpoint unavailable');
}
