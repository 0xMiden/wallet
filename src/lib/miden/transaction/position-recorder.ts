import { ITransaction } from '../db/types';

export function rowFlows(_row: ITransaction): Map<string, { arrived: bigint; departed: bigint }> {
  return new Map();
}

export async function recordPositionEvents(_txId: string): Promise<void> {}
