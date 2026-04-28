/* eslint-disable import/first */

const _g = globalThis as any;
_g.__connStore = {} as Record<string, any>;

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async (keys: string[]) => {
      const out: Record<string, any> = {};
      for (const k of keys)
        if (k in (globalThis as any).__connStore) {
          out[k] = (globalThis as any).__connStore[k];
        }
      return out;
    },
    set: async (items: Record<string, any>) => {
      Object.assign((globalThis as any).__connStore, items);
    }
  })
}));

import { act, renderHook } from '@testing-library/react';

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

// useConnectivityIssues is a thin wrapper around useStorage; exercising it
// via useStorage's real suspense path is flaky with @testing-library/react.
// Stub useStorage at the module level and drive the hook through that — we
// only need to prove the wrapper forwards state + dismisses correctly.
describe('useConnectivityIssues', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const conn = require('./connectivity-issues');

  // We re-import the module under a mock of useStorage so the hook is
  // covered without the suspense machinery.
  let useHook: typeof conn.useConnectivityIssues;
  let setStored: (v: boolean) => void;
  let storedValue = false;
  let setValue: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    setValue = jest.fn(async (v: boolean) => {
      storedValue = v;
    });
    setStored = (v: boolean) => {
      storedValue = v;
    };
    jest.doMock('../front', () => ({
      useStorage: jest.fn(() => [storedValue, setValue]),
      putToStorage: jest.fn(async () => {})
    }));
    // Re-require after mocking so the hook picks up the stubbed useStorage.
    const reloaded = require('./connectivity-issues');
    useHook = reloaded.useConnectivityIssues;
  });

  it('returns the stored flag and dispatches false on dismiss', () => {
    setStored(true);
    const { result } = renderHook(() => useHook());

    const [value, dismiss] = result.current;
    expect(value).toBe(true);

    act(() => {
      dismiss();
    });
    expect(setValue).toHaveBeenCalledWith(false);
  });

  it('returns the default false when nothing is stored', () => {
    setStored(false);
    const { result } = renderHook(() => useHook());
    expect(result.current[0]).toBe(false);
  });
});
