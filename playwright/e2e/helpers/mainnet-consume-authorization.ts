import type { Page } from '@playwright/test';

export interface MainnetConsumeAuthority { nonce: string; sha256: string; canonicalSha256: string }
export interface MainnetConsumeHandle { nonce: string; accountId: string; noteId: string; canonicalSha256: string }
export async function armMainnetConsumeAuthorization(
  _page: Page, _scope: Omit<MainnetConsumeHandle, 'nonce'>
): Promise<MainnetConsumeHandle> {
  throw new Error('Mainnet native consume coordination is not implemented');
}
export async function releaseMainnetConsumeAuthorization(
  _page: Page, _handle: MainnetConsumeHandle,
  _options: { checkpointPath: string; gatePath: string; signal: AbortSignal;
    persist: (authority: MainnetConsumeAuthority) => Promise<void> }
): Promise<void> {
  throw new Error('Mainnet native consume coordination is not implemented');
}
