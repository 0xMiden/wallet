/* eslint-disable import/first */

const _g = globalThis as any;
_g.__connStore = {} as Record<string, any>;

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys) if (k in (globalThis as any).__connStore) {
        out[k] = (globalThis as any).__connStore[k];
      }
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__connStore, items);
    }
  })
}));

import { addConnectivityIssue, sendConnectivityIssue } from './connectivity-issues';

beforeEach(() => {
  for (const k of Object.keys(_g.__connStore)) delete _g.__connStore[k];
  (globalThis as any).chrome = {
    runtime: {
      sendMessage: jest.fn()
    }
  };
});

describe('addConnectivityIssue', () => {
  it('writes a true flag to storage under the connectivity-issues key', async () => {
    await addConnectivityIssue();
    expect(_g.__connStore['miden-connectivity-issues']).toBe(true);
  });
});

describe('sendConnectivityIssue', () => {
  it('posts a CONNECTIVITY_ISSUE message via chrome.runtime', async () => {
    await sendConnectivityIssue();
    expect((globalThis as any).chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONNECTIVITY_ISSUE',
        payload: expect.objectContaining({
          timestamp: expect.any(Number)
        })
      })
    );
  });
});
