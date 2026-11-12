import type { Page } from '@playwright/test';
import type { TestMainnetSendScope } from '../../../src/lib/miden/sdk/test-send-request';

export interface MainnetSendHandle extends TestMainnetSendScope { nonce: string }
export interface MainnetSendAuthority { nonce: string; noteId: string; sha256: string; canonicalSha256: string }

export async function armMainnetSendAuthorization(
  _page: Pick<Page, 'evaluate'>, _scope: TestMainnetSendScope
): Promise<MainnetSendHandle> {
  throw new Error('Native send authorization coordinator is not implemented');
}

export async function releaseMainnetSendAuthorization(
  _page: Pick<Page, 'evaluate'>, _handle: MainnetSendHandle,
  _options: { checkpointPath: string; gatePath: string; signal: AbortSignal;
    persist: (authority: MainnetSendAuthority) => Promise<void> }
): Promise<void> {
  throw new Error('Native send authorization coordinator is not implemented');
}
