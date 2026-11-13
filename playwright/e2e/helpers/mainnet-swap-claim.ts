import type { Note } from '@miden-sdk/miden-sdk';
import type { TestMainnetSwapScope } from '../../../src/lib/miden/sdk/test-send-request';

export interface MainnetSwapPaybackScope extends TestMainnetSwapScope {
  noteId: string;
  orderId: string;
}

export function inspectMainnetSwapPayback(
  _original: Note,
  _payback: Note,
  _scope: MainnetSwapPaybackScope
): bigint {
  return 0n;
}
